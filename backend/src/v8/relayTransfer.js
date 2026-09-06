'use strict';

/**
 * V8's money path: send an EXACT amount of ETH from the v8main wallet to each named
 * v8bundle wallet, THROUGH RELAY.
 *
 * WHY RELAY AT ALL, WHEN BOTH ENDS ARE ON THE SAME CHAIN. Not to bridge — to break the
 * edge. A direct send from main to a bundle wallet draws a line anyone reading the chain
 * can follow, and every bundle wallet funded that way shares one obvious funder. With
 * Relay the main wallet pays a quoted DEPOSIT ADDRESS and a SOLVER pays the bundle
 * wallet: two transactions with no counterparty in common. originChainId and
 * destinationChainId are both config.chainId — an ordinary same-chain order. Breaking
 * that edge is the whole of what this tab does, so there is deliberately no direct-send
 * fallback anywhere in it.
 *
 * EXACT_OUTPUT, not EXACT_INPUT: the operator asks for an amount that must ARRIVE. The
 * solver fee therefore rides on top, on the sender's side, and the deposit Relay quotes
 * is larger than the amount requested.
 *
 * DELIBERATELY A SEPARATE IMPLEMENTATION, not a call into relay/funding.js, v3/relay.js
 * or v7/relay.js — the tab-isolation rule. Every tab owns its own money path so no tab
 * can break another's, and unmounting routes/v8.js removes this one whole. The pacing
 * DISCIPLINE below is copied from relay/funding.js on purpose; the code is V8's.
 *
 * THE PACING, AND WHY IT IS NOT OPTIONAL. Relay's public API rate-limits /quote per IP
 * with a small budget — measured against the live endpoint from this server, about five
 * quotes land and then every further request returns HTTP 429 "Could not process request.
 * Please try again later.", AND continuing to send while blocked keeps the block alive
 * (each 429 re-arms the penalty). An API key does NOT lift it on this chain. That budget
 * is shared with everything else this box asks of Relay — v3..v7 and the seasoning
 * campaigns — so a many-wallet run must not fire its quotes in a burst. They go out ONE
 * at a time by default with a wide gap, and a 429 is met with a LONG, GROWING backoff so
 * the bucket can refill, never a fast retry that would just re-arm the block. Every knob
 * is env-tunable (V8_RELAY_QUOTE_*), falling back to the server-wide RELAY_QUOTE_*
 * defaults. Timing only: amounts, deposits and send order are unchanged by it.
 *
 * NOTHING IS THROWN AWAY ON ONE FAILURE. A run over 50 wallets that died on wallet 7
 * would leave the operator with no record of what wallets 1-6 did, which on a money path
 * is the worst possible outcome. Every target is attempted inside its own try/catch and
 * EVERY target appears in results[] — with a hash, or with an error naming what happened.
 */

const { formatEther, getAddress, isAddress, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees, gasCost } = require('../evm/fees');
const v8roles = require('./roles');

const NATIVE = '0x0000000000000000000000000000000000000000';

// Relay's quoted maxFeePerGas can go stale between the quote and the broadcast on this
// chain, and a stale ceiling gets the deposit rejected before it reaches the mempool.
// Relay's fee fields are dropped and the ceiling re-read from the chain with this much
// headroom at send time — the same +50% the other relay paths use.
const FEE_BUMP_PCT = 50;

// A Relay deposit is a plain value send; this is what a sweep budgets for its own gas.
const DEPOSIT_GAS = 50_000n;

// The signed deposit VALUE comes entirely from Relay's quote (depositStep only checks it
// is from the payer, on this chain, to a non-empty address, and positive). A same-chain
// EXACT_OUTPUT deposit is the delivered amount plus a MARGINAL solver fee, so a quote
// asking for far more than the requested amount is wrong or hostile — and, unbounded,
// could sign the main wallet's whole balance away to an address the quote chose. Cap the
// deposit at this multiple of the requested amount: a legitimate fee is nowhere near it.
const MAX_DEPOSIT_MULTIPLE = 2n;

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// How many quotes may go out back-to-back (1 = strictly serial), the pause between them,
// how many times a transient refusal is retried, and the base backoff that grows with
// each attempt. Read at call time rather than at module load, so a deployment can retune
// without a restart and so tests can drive them.
function pacing(deps = {}) {
  return {
    batchSize: Math.max(
      1,
      Number(deps.quoteBatchSize ?? envNum('V8_RELAY_QUOTE_BATCH_SIZE', config.relayQuoteBatchSize))
    ),
    gapMs: Math.max(0, Number(deps.quoteGapMs ?? envNum('V8_RELAY_QUOTE_GAP_MS', config.relayQuoteGapMs))),
    retries: Math.max(0, Number(deps.quoteRetries ?? envNum('V8_RELAY_QUOTE_RETRIES', config.relayQuoteRetries))),
    backoffMs: Math.max(
      0,
      Number(deps.quoteBackoffMs ?? envNum('V8_RELAY_QUOTE_BACKOFF_MS', config.relayQuote429BackoffMs))
    ),
  };
}

// A transient Relay refusal (the shared per-IP 429, a gateway blip) is worth waiting out.
// A specific one — a bad address, an unsupported route — is surfaced on the first try
// rather than retried into.
const RELAY_TRANSIENT_RE =
  /try again later|could not process|rate.?limit|too many|timeout|temporar|\b(?:429|502|503|504)\b/i;

function isRetryableQuoteError(err) {
  if (err && err.retryable === true) return true;
  return RELAY_TRANSIENT_RE.test(String((err && err.message) || ''));
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function wei(value) {
  return BigInt(value || 0);
}

function relayUrl(path) {
  return `${config.relayApiUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

// Present a normal browser client, and authenticate with the API key when one is set.
// The User-Agent is belt-and-braces from when the bare Node fetch agent drew generic
// refusals that curl on the same host did not.
function relayHeaders() {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  if (config.relayApiKey) headers['x-api-key'] = config.relayApiKey;
  return headers;
}

async function relayRequest(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(relayUrl(path), {
    method,
    headers: relayHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || json.error || `Relay returned ${res.status}`);
    err.status = res.status;
    // A 429 or a 5xx never became an order, so it is safe to ask again. A 4xx that is not
    // 429 is a real rejection and must not be retried into.
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return json;
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
    // A refund goes back to the wallet that PAID, not to whoever asked: if the order
    // cannot fill, the ETH must land where the operator will look for it.
    refundTo: getAddress(from),
  };
}

async function quoteDeposit(body, deps = {}) {
  return relayRequest('/quote/v2', { method: 'POST', body, fetchImpl: deps.fetch });
}

/**
 * Pull the deposit transaction out of a quote, refusing five ways — cheap checks that all
 * run before anything is signed, each naming what it found.
 */
function depositStep(quote, { expectedFrom } = {}) {
  const step = (quote?.steps || []).find((s) => s.id === 'deposit');
  const item = step?.items?.find((i) => i.kind === 'transaction' || i.data) || step?.items?.[0];
  const data = item?.data;

  if (!step || !data) throw new Error('Relay quote did not include a deposit transaction');
  if (Number(data.chainId) !== Number(config.chainId)) {
    throw new Error(`Relay returned origin chain ${data.chainId}; this server can only sign chain ${config.chainId}`);
  }
  if (expectedFrom && getAddress(data.from) !== getAddress(expectedFrom)) {
    throw new Error(`Relay returned a deposit from ${data.from}, expected ${expectedFrom}`);
  }
  if (!data.to) throw new Error('Relay quote did not include a deposit address');
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

/** Relay's own fee fields are DROPPED and the ceiling re-read from the chain — see FEE_BUMP_PCT. */
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
 * Resolve one { walletId | address, amountEth } to a live v8bundle wallet and a positive
 * wei amount.
 *
 * THIS IS THE REFUSAL. A target that is not one of THIS tab's bundle wallets is rejected
 * here, before anything is quoted or signed — so a stray or hostile id can never make the
 * main wallet pay an address the tab does not own. It is matched against the v8bundle set
 * only: a v8main id, another tab's wallet, or an address that is in the keystore under a
 * different role all miss, and throw.
 */
function resolveTarget(target, ks) {
  const wallets = v8roles.bundle(ks);
  const byId = new Map(wallets.map((w) => [String(w.id), w]));
  const byAddr = new Map(wallets.map((w) => [getAddress(w.address), w]));
  const wallet =
    target.walletId != null
      ? byId.get(String(target.walletId))
      : target.address != null && isAddress(String(target.address))
        ? byAddr.get(getAddress(String(target.address)))
        : null;
  if (!wallet) {
    throw new Error(`${target.walletId ?? target.address ?? '(nothing)'} is not a ${v8roles.ROLES.bundle} wallet`);
  }
  const raw = String(target.amountEth ?? target.amount ?? '').trim();
  if (!raw || !/^\d*\.?\d+$/.test(raw)) throw new Error(`wallet ${wallet.id} needs an amount in ETH`);
  const amountWei = parseEther(raw);
  if (amountWei <= 0n) throw new Error(`wallet ${wallet.id} needs a positive amount`);
  return { wallet, amountWei };
}

/**
 * Validate a whole targets[] list UP FRONT — before a single quote is asked for — so a
 * bad wallet id, a zero amount or a duplicate is refused once, at the door, rather than
 * halfway through a paced run that has already spent money.
 *
 * NO CAP. It would be natural to bound this list the way routes/wallets.js bounds v1's
 * and v2's bundles at 31, and it would be wrong: that 31 is the length of the pons
 * factory's snipe-tax exemption list minus the forwarder's own recipient — a LAUNCH
 * constraint. V8 has no launch and no exemption list, so there is nothing for a cap to
 * protect. A 200-wallet fan-out is a long, well-paced run, not an error.
 */
function planTargets(targets, ks) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');
  v8roles.main(ks); // throws with a useful message when there is no source wallet yet
  const seen = new Set();
  return targets.map((t) => {
    const { wallet, amountWei } = resolveTarget(t || {}, ks);
    if (seen.has(wallet.id)) throw new Error(`wallet ${wallet.id} is listed twice`);
    seen.add(wallet.id);
    return {
      walletId: wallet.id,
      address: getAddress(wallet.address),
      amountWei,
      amountEth: formatEther(amountWei),
    };
  });
}

/**
 * ONE Relay order: `amountWei` lands at `toAddress`, paid for by `fromWallet`.
 *
 * The primitive both the fan-out below and v8/sweep.js are built on — the fan-out sends
 * main → bundle, the sweep sends bundle → main, and neither keeps its own copy of the
 * quote/verify/sign discipline. Throws on any failure; the callers decide what a failure
 * means for the rest of their run.
 *
 * @param {object}  input.fromWallet a keystore wallet record — the payer
 * @param {string}  input.toAddress  where the ETH must land
 * @param {bigint}  input.amountWei  how much must LAND, not how much is spent
 * @param {bigint} [input.reserveWei] already committed by this run but perhaps not yet
 *   mined; subtracted from the payer's balance before the affordability check, so a paced
 *   run cannot over-commit the main wallet by reading a balance that still counts ETH
 *   three broadcast deposits ago already spent.
 */
async function relayOnce({ fromWallet, toAddress, amountWei, reserveWei = 0n }, deps = {}) {
  const rpc = deps.rpc || provider;
  const ks = deps.keystore;
  const relayQuote = deps.relayQuote || ((body) => quoteDeposit(body, deps));
  const getFeesFn = deps.getFeesFn || getFees;
  const dryRun = deps.dryRun ?? config.dryRun;
  const sleepFn = deps.sleepFn || sleep;
  const { retries, backoffMs } = pacing(deps);

  const amount = typeof amountWei === 'bigint' ? amountWei : parseEther(String(amountWei || 0));
  if (amount <= 0n) throw new Error('a Relay transfer needs a positive amount');
  if (!ks && !dryRun) throw new Error('keystore is required');

  const from = getAddress(fromWallet.address);
  const to = getAddress(toAddress);

  // Retry the QUOTE, and only the quote. It runs before anything is signed or broadcast,
  // so asking again moves no money and cannot double-send. The deposit broadcast below is
  // NEVER retried.
  let quote;
  for (let attempt = 0; ; attempt += 1) {
    try {
      quote = await relayQuote(quoteBody({ from, recipient: to, amountWei: amount }));
      break;
    } catch (err) {
      if (attempt >= retries || !isRetryableQuoteError(err)) throw err;
      await sleepFn(backoffMs * (attempt + 1));
    }
  }

  const deposit = depositStep(quote, { expectedFrom: from });
  const depositWei = wei(deposit.tx.value);
  if (depositWei > amount * MAX_DEPOSIT_MULTIPLE) {
    throw new Error(
      `Relay quoted a ${formatEther(depositWei)} ETH deposit to deliver only ${formatEther(amount)} ETH — ` +
        `refusing (more than ${MAX_DEPOSIT_MULTIPLE}x the amount; the quote looks wrong)`
    );
  }

  const fees = await getFeesFn(FEE_BUMP_PCT);
  const maxGas = gasCost(fees, gasLimitOf(deposit.tx));

  // Checked before signing rather than discovered from a failed broadcast.
  const balance = BigInt(await rpc.getBalance(from));
  const available = balance - BigInt(reserveWei || 0n);
  if (available < depositWei + maxGas) {
    throw new Error(
      `${from} has ${formatEther(balance)} ETH (${formatEther(available)} uncommitted) but this Relay transfer ` +
        `needs ${formatEther(depositWei + maxGas)} (deposit ${formatEther(depositWei)} + max gas)`
    );
  }

  const entry = {
    from,
    to,
    amountWei: amount,
    amountEth: formatEther(amount),
    depositWei,
    depositEth: formatEther(depositWei),
    committedWei: depositWei + maxGas,
    requestId: deposit.requestId,
    depositAddress: deposit.depositAddress,
    check: deposit.check,
    fees: publicFees(quote),
    details: publicDetails(quote),
  };

  if (dryRun) return { ...entry, hash: null, simulated: true };

  const nonce = await rpc.getTransactionCount(from, 'pending');
  try {
    const sent = await ks.signer(fromWallet.id, rpc).sendTransaction(normaliseTx(deposit.tx, nonce, fees));
    return { ...entry, hash: sent.hash };
  } catch (err) {
    throw new Error(`Relay deposit from ${from} failed: ${rpcMessage(err)}`);
  }
}

/**
 * Fan ETH out from v8main to every named v8bundle wallet, one Relay order each.
 *
 * Serial by default and paced — see the header. Every target is reported: results[] has
 * one entry per target, in the order asked for, each carrying either a `hash` or an
 * `error`, so a run that fails in the middle still says exactly what moved.
 *
 * @returns {{mode:string, from:string, totalDepositEth:string, results:object[]}}
 */
async function transfer(targets, deps = {}) {
  const ks = deps.keystore;
  if (!ks) throw new Error('keystore is required');

  const sleepFn = deps.sleepFn || sleep;
  const { batchSize, gapMs } = pacing(deps);

  const from = v8roles.main(ks);
  const planned = planTargets(targets, ks); // refuses non-v8bundle targets before any quote

  const results = [];
  let committed = 0n;
  let totalDeposit = 0n;

  for (let i = 0; i < planned.length; i += 1) {
    const target = planned[i];

    // The gap that keeps the run under Relay's per-IP quote budget. batchSize > 1 lets a
    // deployment with a lifted limit send a few back-to-back before pausing; the default
    // of 1 pauses between every order.
    if (i > 0 && i % batchSize === 0) await sleepFn(gapMs);

    const entry = {
      walletId: target.walletId,
      address: target.address,
      amountEth: target.amountEth,
      requestId: null,
      depositAddress: null,
      hash: null,
      error: null,
    };

    try {
      const sent = await relayOnce(
        { fromWallet: from, toAddress: target.address, amountWei: target.amountWei, reserveWei: committed },
        deps
      );
      committed += sent.committedWei;
      totalDeposit += sent.depositWei;
      results.push({
        ...entry,
        requestId: sent.requestId,
        depositAddress: sent.depositAddress,
        depositEth: sent.depositEth,
        hash: sent.hash,
        ...(sent.simulated ? { simulated: true } : {}),
        fees: sent.fees,
        details: sent.details,
      });
    } catch (err) {
      // ISOLATED. One wallet's rate limit, bad quote or failed broadcast does not end the
      // run or erase what the earlier wallets did — it is recorded against this wallet and
      // the next one is attempted.
      results.push({ ...entry, error: err?.shortMessage || err?.message || String(err) });
    }
  }

  return {
    mode: 'relay-solver',
    from: getAddress(from.address),
    totalDepositEth: formatEther(totalDeposit),
    results,
  };
}

/** Where an order got to. The requestId comes back on each result. */
async function status(requestId, deps = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(requestId || ''))) {
    throw new Error('requestId must be a 32-byte hex string');
  }
  return relayRequest(`/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { fetchImpl: deps.fetch });
}

module.exports = {
  NATIVE,
  FEE_BUMP_PCT,
  DEPOSIT_GAS,
  MAX_DEPOSIT_MULTIPLE,
  quoteBody,
  quoteDeposit,
  depositStep,
  planTargets,
  resolveTarget,
  relayOnce,
  transfer,
  status,
  isRetryableQuoteError,
  _private: { normaliseTx, gasLimitOf, publicFees, publicDetails, pacing },
};
