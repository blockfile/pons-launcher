'use strict';

const https = require('https');
const { JsonRpcProvider, FetchRequest } = require('ethers');
const config = require('../config');

// Every buy in a bundle is broadcast at the same instant. Node opens a fresh
// connection per concurrent request unless an agent keeps them alive, and each
// new one costs a TCP + TLS handshake — 3-4 round trips at the one moment that
// matters. Measured against a node 6ms away: 25 concurrent calls took 196ms on
// a cold pool, ~2 blocks of this chain, versus ~6ms on a warm one.
//
// Only https gets the agent: an https.Agent handed to http.request throws, and
// a local dev node over plain http needs no pooling anyway.
const keepAlive = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  // One socket per bundle wallet, with room to spare. The bundle is capped by
  // wallet count, not by this.
  maxSockets: 64,
  maxFreeSockets: 64,
});
if (/^https:/i.test(config.rpcUrl)) {
  FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc({ agent: keepAlive }));
}

// The public Robinhood Chain RPC intermittently answers a perfectly valid
// eth_call with `-32601 Method not found` (load-balanced across heterogeneous
// nodes). Retry those transient JSON-RPC errors instead of letting one blip
// fail a preflight — or worse, a launch.
const TRANSIENT_CODES = new Set([-32601, -32603, -32005, -32000]);
const TRANSIENT_RE = /method not found|timeout|rate.?limit|temporar|try again|too many|busy|overloaded/i;

function isTransient(errObj) {
  if (!errObj) return false;
  if (TRANSIENT_CODES.has(errObj.code)) return true;
  return TRANSIENT_RE.test(String(errObj.message || ''));
}

// A refusal that proves the request never reached the sequencer: the provider
// rejected it on the way in, on quota grounds, before doing anything with it.
// This is the ONLY class of broadcast failure that is safe to retry — see the
// attempts logic below.
// Deliberately narrow. A bare /exceeded/ would also match evaluation-stage
// rejections, and the whole point of this predicate is that matching it means
// the transaction was never seen.
const RATE_LIMIT_CODES = new Set([-32005, -32007, -32029]);
const RATE_LIMIT_RE =
  /rate.?limit|request limit|limit reached|limit exceeded|too many requests|429|quota|credits?\b/i;

function isRateLimited(errObj) {
  if (!errObj) return false;
  if (RATE_LIMIT_CODES.has(errObj.code)) return true;
  const text = `${errObj.message || ''} ${errObj.shortMessage || ''} ${
    (errObj.info && errObj.info.responseStatus) || ''
  }`;
  return RATE_LIMIT_RE.test(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RetryJsonRpcProvider extends JsonRpcProvider {
  async _send(payload) {
    // A broadcast is never retried on a generic failure: a re-sent raw
    // transaction that already landed comes back as "already known"/nonce-used
    // and would look like a failure.
    //
    // The one exception is an explicit rate-limit refusal. That answer proves
    // the provider dropped the request at the door and the sequencer never saw
    // it, so re-sending cannot double-broadcast — and NOT re-sending silently
    // costs a bundle wallet its buy, which is the failure this exists to stop.
    // Backoff is short here: being a block late still beats not buying at all.
    const method = Array.isArray(payload) ? null : payload && payload.method;
    const broadcast = method === 'eth_sendRawTransaction';
    const attempts = broadcast ? 3 : 4;
    const retryable = broadcast ? isRateLimited : isTransient;
    const backoff = (n) => (broadcast ? 40 * n : 300 * n);

    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const resp = await super._send(payload);
        const arr = Array.isArray(resp) ? resp : [resp];
        if (arr.some((r) => r && r.error && retryable(r.error)) && attempt < attempts) {
          await sleep(backoff(attempt));
          continue;
        }
        return resp;
      } catch (err) {
        lastErr = err;
        // A thrown error on a read is retried as it always was (a dropped
        // socket carries no error code to match on). A broadcast is retried
        // only when the throw itself says "rate limited".
        const retryThrown = broadcast ? isRateLimited(err) : true;
        if (attempt < attempts && retryThrown) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}

// Pinning the chain id skips the eth_chainId round-trip; batchMaxCount:1 sends
// every call as its own request (some RH RPC nodes mishandle batch arrays).
const provider = new RetryJsonRpcProvider(config.rpcUrl, config.chainId, {
  staticNetwork: true,
  batchMaxCount: 1,
});

/**
 * Open `count` connections before a broadcast burst, so the burst itself pays
 * one round trip per transaction instead of a handshake per transaction.
 *
 * Issued as concurrent requests on purpose: with an empty pool, N simultaneous
 * requests force the agent to open N sockets, which then sit in its free list
 * for the broadcasts that follow milliseconds later. `send` is used rather than
 * a provider method because ethers serves getBlockNumber from a 250ms cache —
 * a cached answer opens no socket and warms nothing.
 */
async function warmPool(count, rpc = provider) {
  await Promise.allSettled(
    Array.from({ length: count }, () => rpc.send('eth_blockNumber', []))
  );
}

module.exports = { provider, RetryJsonRpcProvider, warmPool, keepAlive, isRateLimited, isTransient };
