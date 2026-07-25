'use strict';

const { JsonRpcProvider } = require('ethers');
const config = require('../config');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RetryJsonRpcProvider extends JsonRpcProvider {
  async _send(payload) {
    // Never retry a broadcast: a re-sent raw transaction that already landed
    // comes back as "already known"/nonce-used and would look like a failure.
    const method = Array.isArray(payload) ? null : payload && payload.method;
    const attempts = method === 'eth_sendRawTransaction' ? 1 : 4;

    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const resp = await super._send(payload);
        const arr = Array.isArray(resp) ? resp : [resp];
        if (arr.some((r) => r && r.error && isTransient(r.error)) && attempt < attempts) {
          await sleep(300 * attempt);
          continue;
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (attempt < attempts) {
          await sleep(300 * attempt);
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

module.exports = { provider, RetryJsonRpcProvider };
