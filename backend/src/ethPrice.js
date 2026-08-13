'use strict';

// The native token's USD price, fetched SERVER-SIDE.
//
// The browser cannot fetch a price API directly — CORS blocks it and any key
// would sit in the client — so the console asks the backend, which asks the
// exchange. Robinhood Chain's gas token is ETH, so this is ETH/USD.
//
// Cached for a minute: a launch does not need sub-minute price accuracy, and the
// dollar figure is advisory anyway — the ETH figures beside it are the exact
// ones the curve fixes. Two sources, tried in order, so one being down does not
// take the price out; a stale cache is served rather than nothing when both are.

const SOURCES = [
  {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
    pick: (j) => Number(j && j.data && j.data.amount),
  },
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
    pick: (j) => Number(j && j.ethereum && j.ethereum.usd),
  },
];

const TTL_MS = 60_000;
let cache = { usd: null, source: null, at: 0 };

/**
 * @returns {Promise<{usd:number, source:string, at:number, stale?:boolean}>}
 * @throws if no source is reachable and there is no cached value
 */
async function ethPriceUsd({ now = Date.now, fetchImpl = fetch } = {}) {
  if (cache.usd && now() - cache.at < TTL_MS) return { ...cache };

  for (const s of SOURCES) {
    try {
      const res = await fetchImpl(s.url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const usd = s.pick(await res.json());
      if (Number.isFinite(usd) && usd > 0) {
        cache = { usd, source: s.name, at: now() };
        return { ...cache };
      }
    } catch (_err) {
      // Try the next source. A price outage must never surface as a 500 to the
      // console — the field stays editable and the launch is unaffected.
    }
  }

  if (cache.usd) return { ...cache, stale: true };
  throw new Error('no price source reachable');
}

// Test-only reset so a suite does not inherit a warm cache.
function _resetCache() {
  cache = { usd: null, source: null, at: 0 };
}

module.exports = { ethPriceUsd, _resetCache };
