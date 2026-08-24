'use strict';

// The pons swap-zap client — the one new outbound call the ETH-zap bundle mode
// makes.
//
// A pons v2 curve can be priced in a NON-ETH pair token (SPCX, an RWA, USDG).
// Normally a bundle wallet buying such a token has to hold the pair token. The
// zap removes that: pons exposes a 0x-style swap endpoint that, given ETH in and
// the launched token as the buy target, returns a single transaction the taker
// EOA sends — ETH → pair → curve.buy — with recipient baked in as the taker. So
// a wallet holding only ETH buys a non-ETH-paired token in one transaction.
//
// TWO facts decide how this is used, and they are why the quote is fetched at
// FIRE time rather than prepare time:
//
//   1. Per-taker. The returned `data` bakes recipient = taker, so ONE quote is
//      fetched per wallet, each with that wallet as the taker. The snipe-tax
//      exemption is keyed on the recipient, and the launch declares the bundle
//      wallets exempt — so the taker of each zap buy MUST be the wallet itself.
//   2. Short-lived and post-launch. The route calls curve.buy on the token's
//      curve, which must already exist, and carries a ~6-minute deadline. A quote
//      can therefore only be fetched after the launch confirms, and must be sent
//      promptly.
//
// No key handling and no signing live here — this only asks for the transaction.
// bundle/fireV2.js signs the returned {to,data,value} with the wallet's own
// keystore signer and broadcasts it, exactly as it does every other buy.

const { getAddress } = require('ethers');
const config = require('../../config');

// The endpoint answers within a couple of seconds normally; cap it so a hung
// pons worker cannot stall the post-launch buy burst indefinitely. A wallet
// whose quote times out is skipped (fireV2 records the reason), never retried in
// place — the deadline is ticking.
const DEFAULT_TIMEOUT_MS = 12_000;

function zapUrl() {
  // Read live rather than closed over at import, so a test (or a redeploy) can
  // point PONS_ZAP_URL somewhere else without reloading the module.
  return process.env.PONS_ZAP_URL || config.zapUrl;
}

/**
 * POST one body to the zap endpoint and return the parsed JSON, or throw a
 * message an operator can read. A `.error` in the body (e.g. "No route right
 * now.") is surfaced by the callers, not here — here only transport and HTTP
 * status are judged.
 */
async function postZap(body, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(zapUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(
      timedOut ? `pons zap endpoint timed out after ${timeoutMs}ms` : `pons zap endpoint unreachable: ${err.message}`
    );
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(`pons zap quote failed: ${detail}`);
  }
  return json;
}

/**
 * A sendable ETH→token buy for ONE taker. Native ETH in (sellToken:null), the
 * launched token out.
 *
 * @param {object} input
 * @param {string} input.buyToken the launched token address
 * @param {string|bigint} input.sellAmountWei ETH to spend, in wei
 * @param {string} input.taker the wallet that will send AND receive — its
 *   exemption is what keeps the buy untaxed, so it is never anything else
 * @param {number} [input.slippageBps]
 * @param {object} [deps] { fetch, timeoutMs } — injectable for tests
 * @returns {Promise<{to:string,data:string,value:string}>} directly sendable
 */
async function getZapBuyTx({ buyToken, sellAmountWei, taker, slippageBps = config.zapSlippageBps }, deps = {}) {
  if (!buyToken) throw new Error('getZapBuyTx: buyToken is required');
  if (!taker) throw new Error('getZapBuyTx: taker is required');
  const amount = BigInt(sellAmountWei);
  if (amount <= 0n) throw new Error('getZapBuyTx: sellAmountWei must be positive');

  const body = {
    // null = native ETH in. Anything else would be an ERC-20 sell, which needs
    // an approve the zap mode deliberately does not use.
    sellToken: null,
    buyToken: getAddress(buyToken),
    sellAmountWei: amount.toString(),
    taker: getAddress(taker),
    slippageBps: Number(slippageBps),
    // Asks for the full transaction, not just a price — the bakes-in-recipient
    // route the wallet actually sends.
    intent: 'quote',
  };

  const json = await postZap(body, { fetchImpl: deps.fetch, timeoutMs: deps.timeoutMs });
  if (!json || !json.quote) {
    // The documented shape of a no-route answer: no `.quote`, a `.error` string.
    throw new Error(`pons zap: no quote — ${(json && json.error) || 'endpoint returned no route'}`);
  }
  const tx = json.quote.transaction;
  if (!tx || !tx.to || !tx.data) {
    throw new Error('pons zap: quote carried no sendable transaction (missing to/data)');
  }
  return {
    to: getAddress(tx.to),
    data: tx.data,
    // Native ETH in, so value is the ETH the taker sends. Normalise to a decimal
    // string so the signer treats it as a BigInt, never as hex-vs-decimal.
    value: BigInt(tx.value ?? 0).toString(),
  };
}

/**
 * A price PREVIEW, no taker and no `intent`, for a pre-launch estimate. Cheap and
 * best-effort: the route still calls curve.buy on a curve that does not exist
 * until the launch confirms, so this can legitimately return `.error` before
 * launch — callers treat a throw here as "no preview", never as a launch blocker.
 *
 * @returns {Promise<{buyAmount:string}>}
 */
async function getZapPrice({ buyToken, sellAmountWei, slippageBps = config.zapSlippageBps }, deps = {}) {
  if (!buyToken) throw new Error('getZapPrice: buyToken is required');
  const amount = BigInt(sellAmountWei);
  if (amount <= 0n) throw new Error('getZapPrice: sellAmountWei must be positive');

  const body = {
    sellToken: null,
    buyToken: getAddress(buyToken),
    sellAmountWei: amount.toString(),
    slippageBps: Number(slippageBps),
  };
  const json = await postZap(body, { fetchImpl: deps.fetch, timeoutMs: deps.timeoutMs });
  // A price preview answers under `.price` (no taker); a firm quote under
  // `.quote`. Accept either so this doubles as a routability probe.
  const priced = (json && (json.price || json.quote)) || null;
  if (!priced) {
    throw new Error(`pons zap: no price — ${(json && json.error) || 'endpoint returned no route'}`);
  }
  return { buyAmount: String(priced.buyAmount ?? '') };
}

/**
 * Poll the price preview until the aggregator can route to `buyToken`, or time
 * out. A freshly-launched curve is not indexed by the zap aggregator for a beat
 * or two after the launch confirms, so a quote fetched immediately answers "No
 * route right now." — the bundle must WAIT for the route to appear, then blast,
 * rather than firing once and giving up. Resolves as soon as a route exists;
 * throws only if none appears within `timeoutMs`.
 *
 * A tiny fixed probe amount is used only to test routability; the real per-wallet
 * amounts are quoted afterwards.
 *
 * @param {object} input { buyToken, sellAmountWei?, slippageBps? }
 * @param {object} [deps] { fetch, timeoutMs?, intervalMs?, now?, sleep? }
 * @returns {Promise<{waitedMs:number}>}
 */
async function waitForZapRoute(
  { buyToken, sellAmountWei = '1000000000000000', slippageBps = config.zapSlippageBps },
  deps = {}
) {
  const timeoutMs = deps.timeoutMs ?? 45_000;
  const intervalMs = deps.intervalMs ?? 1_500;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  let lastErr = 'no route';
  // Each probe is a short-timeout price call; the OUTER budget is timeoutMs.
  for (;;) {
    try {
      await getZapPrice({ buyToken, sellAmountWei, slippageBps }, { fetch: deps.fetch, timeoutMs: 6_000 });
      return { waitedMs: now() - started };
    } catch (err) {
      lastErr = err.message;
    }
    if (now() - started + intervalMs >= timeoutMs) {
      throw new Error(`pons zap: no route for the launched token after ${timeoutMs}ms (${lastErr})`);
    }
    await sleep(intervalMs);
  }
}

module.exports = { getZapBuyTx, getZapPrice, waitForZapRoute, zapUrl };
