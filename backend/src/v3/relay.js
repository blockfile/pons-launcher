'use strict';

/**
 * V3's Relay client: move ETH from one wallet we hold to another address, on
 * this chain, through a Relay solver.
 *
 * DELIBERATELY NOT A REFACTOR OF relay/funding.js. That file is v2's funding
 * path and works; extracting a shared core out of it would put a diff on a
 * money path this feature was told not to touch, and "the behaviour is
 * identical" is a claim, not a guarantee. This is the second implementation of
 * the same idea, and the duplication is the price of the two never being able
 * to break each other.
 *
 * WHY RELAY AT ALL, WHEN BOTH ENDS ARE ON THE SAME CHAIN:
 *
 * Not to bridge. The transfer exists to break the edge. A direct send from the
 * seller to the buyer draws a line between them that anyone reading the chain
 * can follow, and that line is the whole tell this strategy exists to avoid.
 * With Relay the seller pays a deposit address and a SOLVER pays the buyer —
 * two transactions with no counterparty in common. originChainId and
 * destinationChainId are both config.chainId, which Relay handles as an
 * ordinary same-chain order.
 *
 * EXACT_OUTPUT, not EXACT_INPUT: the buyer needs a known amount to buy with, so
 * what matters is what ARRIVES. The fee comes off the sender's side, and the
 * deposit Relay quotes is therefore larger than the amount requested.
 */

const { formatEther, getAddress, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees, gasCost } = require('../evm/fees');

const NATIVE = '0x0000000000000000000000000000000000000000';

// The same headroom v2's funding path settled on. See refreshFees below for
// what it is protecting against.
const FEE_BUMP_PCT = 50;

function wei(value) {
  return BigInt(value || 0);
}

function relayUrl(path) {
  return `${config.relayApiUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function relayRequest(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  // The Relay API key (config.relayApiKey) lifts the shared per-IP /quote rate
  // limit from ~5-per-window to 50/min. Sent when configured; anonymous otherwise.
  if (config.relayApiKey) headers['x-api-key'] = config.relayApiKey;
  const res = await fetchImpl(relayUrl(path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || json.error || `Relay returned ${res.status}`);
    err.status = res.status;
    // A 429 (the shared per-IP /quote rate limit — "Could not process request.
    // Please try again later.") or a 5xx is transient: the request never became
    // an order, so a caller may safely retry it. A 4xx that is not 429 is a real
    // rejection and must not be retried into.
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return json;
}

// Whether a thrown quote error is worth retrying: the flag relayRequest attaches,
// or — for an injected relayQuote in tests, or an error that lost the flag — the
// message shapes Relay uses for its rate limit.
function isRetryableQuoteError(err) {
  if (err && err.retryable === true) return true;
  return /could not process request|try again later|rate.?limit|too many|\b429\b/i.test(
    String((err && err.message) || '')
  );
}

/** The order: exactly `amountWei` lands at `recipient`, and `from` pays for it. */
function quoteBody({ from, recipient, amountWei }) {
  return {
    user: getAddress(from),
    recipient: getAddress(recipient),
    originChainId: Number(config.chainId),
    destinationChainId: Number(config.chainId),
    originCurrency: NATIVE,
    destinationCurrency: NATIVE,
    amount: amountWei.toString(),
    tradeType: 'EXACT_OUTPUT',
    useDepositAddress: true,
    strict: true,
    // A refund goes back to the wallet that paid, not to whoever asked. If the
    // order cannot be filled, the ETH must land where the engine will look for
    // it — otherwise a failed cycle strands funds somewhere nothing reads.
    refundTo: getAddress(from),
  };
}

async function quoteDeposit(body, deps = {}) {
  return relayRequest('/quote/v2', { method: 'POST', body, fetchImpl: deps.fetch });
}

/**
 * Pull the deposit transaction out of a quote, and refuse four ways.
 *
 * Every one of these has caught something real on the v2 path. They are cheap,
 * they run before anything is signed, and each names what it found — a quote
 * that fails here is a Relay-side surprise, and the operator needs to know
 * which one rather than reading a signature failure three steps later.
 */
function depositStep(quote, { expectedFrom } = {}) {
  const step = (quote?.steps || []).find((s) => s.id === 'deposit');
  const item = step?.items?.find((i) => i.kind === 'transaction' || i.data) || step?.items?.[0];
  const data = item?.data;

  if (!step || !data) throw new Error('Relay quote did not include a deposit transaction');
  if (Number(data.chainId) !== Number(config.chainId)) {
    throw new Error(
      `Relay returned origin chain ${data.chainId}; this server can only sign chain ${config.chainId}`
    );
  }
  if (expectedFrom && getAddress(data.from) !== getAddress(expectedFrom)) {
    throw new Error(`Relay returned a deposit from ${data.from}, expected ${expectedFrom}`);
  }
  if (wei(data.value) <= 0n) throw new Error('Relay quote did not include a positive deposit amount');

  return {
    tx: data,
    requestId: step.requestId || null,
    check: item.check || null,
    depositAddress: getAddress(step.depositAddress || data.to),
  };
}

function gasLimitOf(tx) {
  return wei(tx.gas || tx.gasLimit || 0);
}

/**
 * Relay's own fee fields are DROPPED and re-read from the chain.
 *
 * Relay quotes a concrete maxFeePerGas. On this chain the base fee can tick
 * between the quote and the broadcast, and when it does, the deposit is
 * rejected before it ever reaches the mempool — the failure looks like Relay
 * being down and is not. Keep Relay's recipient, value and calldata, which are
 * the parts that make the order an order; take the ceiling from the chain.
 */
function normaliseTx(tx, nonce, fees) {
  return {
    to: getAddress(tx.to),
    data: tx.data || '0x',
    value: wei(tx.value),
    gasLimit: gasLimitOf(tx),
    nonce,
    chainId: Number(tx.chainId),
    ...fees,
  };
}

function publicFees(quote) {
  const out = {};
  for (const [key, value] of Object.entries(quote?.fees || {})) {
    out[key] = {
      amount: value?.amount?.toString?.() || '0',
      amountFormatted: value?.amountFormatted || null,
      amountUsd: value?.amountUsd || null,
      symbol: value?.currency?.symbol || null,
    };
  }
  return out;
}

function publicDetails(quote) {
  return {
    operation: quote?.details?.operation || null,
    timeEstimate: quote?.details?.timeEstimate ?? null,
    solver: quote?.protocol?.v2?.orderData?.solver || null,
    orderId: quote?.protocol?.v2?.orderId || null,
  };
}

/**
 * Send `amountWei` from a wallet we hold to any address, through Relay.
 *
 * @param {object} input
 * @param {object} input.fromWallet a keystore wallet record — the payer
 * @param {string} input.toAddress where the ETH must land
 * @param {bigint} input.amountWei how much must LAND, not how much is spent
 * @param {object} [deps] injectable; nothing here touches a network when supplied
 */
async function transfer({ fromWallet, toAddress, amountWei }, deps = {}) {
  const rpc = deps.rpc || provider;
  const ks = deps.keystore;
  const relayQuote = deps.relayQuote || ((body) => quoteDeposit(body, deps));
  const getFeesFn = deps.getFeesFn || getFees;
  const dryRun = deps.dryRun ?? config.dryRun;

  const amount = typeof amountWei === 'bigint' ? amountWei : parseEther(String(amountWei || 0));
  if (amount <= 0n) throw new Error('transfer needs a positive amount');
  if (!ks && !dryRun) throw new Error('keystore is required');

  const from = getAddress(fromWallet.address);
  const to = getAddress(toAddress);

  // Retry the QUOTE — and ONLY the quote — through Relay's rate limit. This runs
  // before any deposit is signed or sent, so re-requesting it moves nothing and
  // cannot double-send; a rate-limited cycle recovers on its own instead of
  // halting the run for a manual resume. A non-retryable rejection, or the last
  // attempt, still throws and halts. The deposit broadcast below is NEVER retried.
  const sleepFn = deps.sleepFn || sleep;
  const retries = Math.max(0, Number(deps.quoteRetries ?? config.v3RelayQuoteRetries));
  const backoffMs = Math.max(0, Number(deps.quoteBackoffMs ?? config.v3RelayQuoteBackoffMs));
  let quote;
  for (let attempt = 0; ; attempt++) {
    try {
      quote = await relayQuote(quoteBody({ from, recipient: to, amountWei: amount }));
      break;
    } catch (err) {
      if (attempt >= retries || !isRetryableQuoteError(err)) throw err;
      await sleepFn(backoffMs * 2 ** attempt);
    }
  }
  const deposit = depositStep(quote, { expectedFrom: from });

  const fees = await getFeesFn(FEE_BUMP_PCT);
  const depositWei = wei(deposit.tx.value);
  const maxGas = gasCost(fees, gasLimitOf(deposit.tx));

  // Checked before signing rather than after a revert, because the caller is a
  // running chain: a cycle that discovers this from a failed broadcast has
  // already sold the tokens that were meant to pay for it.
  const balance = await rpc.getBalance(from);
  if (balance < depositWei + maxGas) {
    throw new Error(
      `${from} has ${formatEther(balance)} ETH but this Relay transfer needs ` +
        `${formatEther(depositWei + maxGas)} (deposit ${formatEther(depositWei)} + max gas)`
    );
  }

  const entry = {
    from,
    to,
    amountWei: amount,
    amountEth: formatEther(amount),
    depositWei,
    depositEth: formatEther(depositWei),
    requestId: deposit.requestId,
    depositAddress: deposit.depositAddress,
    check: deposit.check,
    fees: publicFees(quote),
    details: publicDetails(quote),
  };

  if (dryRun) return { ...entry, hash: null, simulated: true };

  const nonce = await rpc.getTransactionCount(from, 'pending');
  try {
    const sent = await ks
      .signer(fromWallet.id, rpc)
      .sendTransaction(normaliseTx(deposit.tx, nonce, fees));
    return { ...entry, hash: sent.hash };
  } catch (err) {
    throw new Error(`Relay deposit from ${from} failed: ${rpcMessage(err)}`);
  }
}

/** Where an order got to. The requestId comes back from transfer(). */
async function status(requestId, deps = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(requestId || ''))) {
    throw new Error('requestId must be a 32-byte hex string');
  }
  return relayRequest(`/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, {
    fetchImpl: deps.fetch,
  });
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Wait for a broadcast deposit to actually FILL, so an order that never settles
 * is reported instead of passed off as a success.
 *
 * transfer() returns the moment the deposit is broadcast — but broadcasting is
 * not delivery. A deposit whose order is never filled (Relay had no solver, the
 * order expired, the request never registered under the rate limiter) leaves the
 * ETH stranded at the deposit address, refundable but silent. Polling the status
 * turns that silence into a `filled: false` the caller can surface with the
 * requestId and deposit address needed to recover it. Read-only and best-effort:
 * a status endpoint that errors is treated as "not yet", never as a failure of
 * the transfer that already happened.
 *
 * @returns {Promise<{filled: boolean|null, status: string}>}
 */
async function confirmFill(requestId, { tries = 15, gapMs = 3000, statusFn = status } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(requestId || ''))) return { filled: null, status: 'unknown' };
  for (let i = 0; i < tries; i += 1) {
    let st = null;
    try {
      const s = await statusFn(requestId);
      st = s?.status || s?.data?.status || null;
    } catch {
      st = null; // transient status read — keep waiting, do not fail the transfer
    }
    if (st === 'success') return { filled: true, status: st };
    if (st === 'refund' || st === 'refunded' || st === 'failure') return { filled: false, status: st };
    if (i < tries - 1) await sleep(gapMs);
  }
  return { filled: false, status: 'pending' };
}

module.exports = {
  NATIVE,
  FEE_BUMP_PCT,
  quoteBody,
  depositStep,
  transfer,
  status,
  confirmFill,
  isRetryableQuoteError,
  _private: { normaliseTx, gasLimitOf, publicFees, publicDetails },
};
