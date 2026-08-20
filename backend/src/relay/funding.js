'use strict';

// Relay.link solver funding for the active pons v2 launcher.
//
// This is deliberately NOT wired into the old funding.disperse helper. v1 keeps
// sending directly from dev/disperser, while this path creates strict
// exact-output Relay deposit orders whose destination is a v2 bundle wallet.
// The deposit transaction goes to Relay; the fill that lands in the bundle
// wallet comes from whichever solver Relay chooses.

const { formatEther, getAddress, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees, gasCost } = require('../evm/fees');
const { devWalletFor, bundleWalletsFor } = require('../wallets/variants');

const NATIVE = '0x0000000000000000000000000000000000000000';
const MAX_TARGETS = 31;
const RELAY_FEE_BUMP_PCT = 50;

// Relay's public API rate-limits per IP with a small budget — measured against
// the live endpoint from the server: about five quotes land, then every further
// request returns HTTP 429 "Could not process request. Please try again later.",
// AND continuing to send while blocked keeps the block alive (each 429 refreshes
// the penalty). That budget is shared with everything else this box asks of Relay
// — v3 and the seasoning campaigns — so a many-wallet run cannot fire its quotes
// in a burst. They go out one (by default) at a time with a wide gap, and a 429
// is met with a LONG backoff so the bucket can refill, never a fast retry that
// would just re-arm the block. Pace is env-tunable (RELAY_QUOTE_BATCH_SIZE /
// _GAP_MS / _RETRIES / _BACKOFF_MS). Timing only: amounts, deposits and send
// order are unchanged.
const QUOTE_BATCH_SIZE = config.relayQuoteBatchSize;
const QUOTE_BATCH_GAP_MS = config.relayQuoteGapMs;
const QUOTE_RETRIES = config.relayQuoteRetries;
const QUOTE_BACKOFF_MS = config.relayQuote429BackoffMs;
const RELAY_TRANSIENT_RE = /try again later|could not process|rate.?limit|too many|timeout|temporar|\b(?:429|502|503|504)\b/i;

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// Run each planned target through `quoteOne`, at most `size` at a time, pausing
// `gapMs` between batches. Order is preserved: batches run in order and each
// batch's results keep their in-batch order, so the returned array matches
// `planned` — which the nonce assignment downstream relies on.
async function quoteInBatches(planned, quoteOne, { size = QUOTE_BATCH_SIZE, gapMs = QUOTE_BATCH_GAP_MS } = {}) {
  const out = [];
  for (let i = 0; i < planned.length; i += size) {
    const batch = planned.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(quoteOne))));
    if (i + size < planned.length) await sleep(gapMs);
  }
  return out;
}

// Retry a single quote on a transient Relay refusal (a 429 "try again later", a
// gateway error) with a GROWING, DELIBERATELY LONG backoff — the rate limiter
// stays tripped while it is being hit, so the retry has to wait out the window,
// not poke at it. A specific error — an invalid address, an unsupported route —
// is surfaced on the first try, not retried.
async function withQuoteRetry(fn, { retries = QUOTE_RETRIES, backoffMs = QUOTE_BACKOFF_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !RELAY_TRANSIENT_RE.test(err?.message || '')) throw err;
      await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

function wei(value) {
  return BigInt(value || 0);
}

function relayUrl(path) {
  return `${config.relayApiUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function relayRequest(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(relayUrl(path), {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // Relay's edge is stricter with an unidentified client than with a browser
      // or curl. The bare Node fetch agent has drawn generic "could not process"
      // refusals where the identical request from curl on the SAME host returns a
      // quote — so present a normal browser User-Agent.
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || json.error || `Relay returned ${res.status}`);
  }
  return json;
}

function quoteBody({ from, recipient, amountWei, chainId = config.chainId }) {
  return {
    user: getAddress(from),
    recipient: getAddress(recipient),
    originChainId: Number(chainId),
    destinationChainId: Number(config.chainId),
    originCurrency: NATIVE,
    destinationCurrency: NATIVE,
    amount: amountWei.toString(),
    tradeType: 'EXACT_OUTPUT',
    useDepositAddress: true,
    strict: true,
    refundTo: getAddress(from),
  };
}

async function quoteDeposit(input, deps = {}) {
  return relayRequest('/quote/v2', {
    method: 'POST',
    body: quoteBody(input),
    fetchImpl: deps.fetch,
  });
}

function depositStep(quote, { expectedFrom, expectedChainId = config.chainId } = {}) {
  const step = (quote.steps || []).find((s) => s.id === 'deposit');
  const item = step?.items?.find((i) => i.kind === 'transaction' || i.data) || step?.items?.[0];
  const data = item?.data;
  if (!step || !data) throw new Error('Relay quote did not include a deposit transaction');
  if (Number(data.chainId) !== Number(expectedChainId)) {
    throw new Error(`Relay returned origin chain ${data.chainId}; this server can only sign chain ${expectedChainId}`);
  }
  if (expectedFrom && getAddress(data.from) !== getAddress(expectedFrom)) {
    throw new Error(`Relay returned a deposit from ${data.from}, expected ${expectedFrom}`);
  }
  if (!data.to) throw new Error('Relay quote did not include a deposit address');
  if (wei(data.value) <= 0n) throw new Error('Relay quote did not include a positive deposit amount');

  return {
    step,
    item,
    tx: data,
    requestId: step.requestId || null,
    check: item.check || null,
    depositAddress: getAddress(step.depositAddress || data.to),
  };
}

function normaliseTx(tx, nonce, fees = {}) {
  return {
    to: getAddress(tx.to),
    data: tx.data || '0x',
    value: wei(tx.value),
    gasLimit: wei(tx.gas || tx.gasLimit || 0),
    nonce,
    chainId: Number(tx.chainId),
    ...fees,
  };
}

function gasLimitOf(tx) {
  return wei(tx.gas || tx.gasLimit || 0);
}

function publicFees(quote) {
  const out = {};
  for (const [key, value] of Object.entries(quote.fees || {})) {
    out[key] = {
      amount: value?.amount?.toString?.() || '0',
      amountFormatted: value?.amountFormatted || null,
      amountUsd: value?.amountUsd || null,
      symbol: value?.currency?.symbol || null,
      chainId: value?.currency?.chainId ?? null,
    };
  }
  return out;
}

function publicDetails(quote) {
  return {
    operation: quote.details?.operation || null,
    timeEstimate: quote.details?.timeEstimate ?? null,
    rate: quote.details?.rate || null,
    totalImpact: quote.details?.totalImpact || null,
    currencyIn: {
      amount: quote.details?.currencyIn?.amount || null,
      amountFormatted: quote.details?.currencyIn?.amountFormatted || null,
      amountUsd: quote.details?.currencyIn?.amountUsd || null,
      chainId: quote.details?.currencyIn?.currency?.chainId ?? null,
    },
    currencyOut: {
      amount: quote.details?.currencyOut?.amount || null,
      amountFormatted: quote.details?.currencyOut?.amountFormatted || null,
      amountUsd: quote.details?.currencyOut?.amountUsd || null,
      chainId: quote.details?.currencyOut?.currency?.chainId ?? null,
    },
    solver: quote.protocol?.v2?.orderData?.solver || null,
    orderId: quote.protocol?.v2?.orderId || null,
  };
}

function planTargets(targets, ks) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');
  if (targets.length > MAX_TARGETS) throw new Error(`v2 relay funding is capped at ${MAX_TARGETS} wallets`);

  const bundles = new Map(bundleWalletsFor(ks, 'v2').map((w) => [w.id, w]));
  const seen = new Set();
  return targets.map((t) => {
    if (seen.has(t.walletId)) throw new Error(`wallet ${t.walletId} is listed twice`);
    seen.add(t.walletId);
    const wallet = bundles.get(t.walletId);
    if (!wallet) throw new Error(`wallet ${t.walletId} is not a v2 bundle wallet`);
    const amount = parseEther(String(t.amountEth || 0));
    if (amount <= 0n) throw new Error(`wallet ${t.walletId} needs a positive amount`);
    return {
      walletId: wallet.id,
      address: getAddress(wallet.address),
      amountWei: amount,
      amountEth: formatEther(amount),
    };
  });
}

async function fundV2Bundle(
  targets,
  {
    keystore: ks,
    relayQuote = quoteDeposit,
    rpc = provider,
    dryRun = config.dryRun,
    getFeesFn = getFees,
    quoteBatchSize = QUOTE_BATCH_SIZE,
    quoteBatchGapMs = QUOTE_BATCH_GAP_MS,
    quoteRetries = QUOTE_RETRIES,
    quoteBackoffMs = QUOTE_BACKOFF_MS,
  } = {}
) {
  if (!ks) throw new Error('keystore is required');

  const dev = devWalletFor(ks, 'v2');
  const planned = planTargets(targets, ks);
  const signer = ks.signer(dev.id, rpc);

  // Quote in small batches so a many-wallet run does not fire every request at
  // Relay in the same instant and trip its rate limiter — see the note on
  // QUOTE_BATCH_SIZE above.
  const quoted = await quoteInBatches(
    planned,
    async (target) => {
      const quote = await withQuoteRetry(
        () =>
          relayQuote({
            from: dev.address,
            recipient: target.address,
            amountWei: target.amountWei,
            chainId: config.chainId,
          }),
        { retries: quoteRetries, backoffMs: quoteBackoffMs }
      );
      const deposit = depositStep(quote, { expectedFrom: dev.address, expectedChainId: config.chainId });
      return { target, quote, deposit };
    },
    { size: quoteBatchSize, gapMs: quoteBatchGapMs }
  );

  // Relay quotes a concrete deposit transaction, including fee fields. On this
  // chain the base fee can tick between quote and broadcast; using Relay's
  // stale maxFeePerGas caused every deposit to be rejected before it reached the
  // mempool. Keep Relay's recipient/value/data, but refresh the fee ceiling at
  // send time with the same kind of headroom the launch path uses.
  const refreshedFees = await getFeesFn(RELAY_FEE_BUMP_PCT);
  const totalDeposit = quoted.reduce((sum, q) => sum + wei(q.deposit.tx.value), 0n);
  const totalMaxGas = quoted.reduce((sum, q) => sum + gasCost(refreshedFees, gasLimitOf(q.deposit.tx)), 0n);
  const balance = await rpc.getBalance(dev.address);
  if (balance < totalDeposit + totalMaxGas) {
    throw new Error(
      `v2 dev wallet has ${formatEther(balance)} ETH but Relay deposits need up to ` +
        `${formatEther(totalDeposit + totalMaxGas)} (deposits + max gas)`
    );
  }

  if (dryRun) {
    return {
      protocol: 'v2',
      mode: 'relay-solver',
      simulated: true,
      from: dev.address,
      totalDepositEth: formatEther(totalDeposit),
      results: quoted.map(({ target, quote, deposit }) => ({
        walletId: target.walletId,
        address: target.address,
        amountEth: target.amountEth,
        requestId: deposit.requestId,
        depositAddress: deposit.depositAddress,
        depositEth: formatEther(wei(deposit.tx.value)),
        hash: null,
        simulated: true,
        check: deposit.check,
        fees: publicFees(quote),
        details: publicDetails(quote),
      })),
    };
  }

  let nonce = await rpc.getTransactionCount(dev.address, 'pending');
  const results = await Promise.all(
    quoted.map(async ({ target, quote, deposit }) => {
      const thisNonce = nonce++;
      const entry = {
        walletId: target.walletId,
        address: target.address,
        amountEth: target.amountEth,
        requestId: deposit.requestId,
        depositAddress: deposit.depositAddress,
        depositEth: formatEther(wei(deposit.tx.value)),
        check: deposit.check,
        fees: publicFees(quote),
        details: publicDetails(quote),
      };
      try {
        const sent = await signer.sendTransaction(normaliseTx(deposit.tx, thisNonce, refreshedFees));
        return { ...entry, hash: sent.hash };
      } catch (err) {
        return { ...entry, error: rpcMessage(err) };
      }
    })
  );

  return {
    protocol: 'v2',
    mode: 'relay-solver',
    from: dev.address,
    totalDepositEth: formatEther(totalDeposit),
    results,
  };
}

async function status(requestId, deps = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(requestId || ''))) {
    throw new Error('requestId must be a 32-byte hex string');
  }
  return relayRequest(`/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, {
    fetchImpl: deps.fetch,
  });
}

module.exports = {
  NATIVE,
  quoteBody,
  depositStep,
  fundV2Bundle,
  quoteDeposit,
  status,
  _private: { planTargets, normaliseTx, gasLimitOf, publicDetails, publicFees },
};
