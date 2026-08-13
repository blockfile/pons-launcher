'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ethPriceUsd, _resetCache } = require('./ethPrice');

const ok = (body) => ({ ok: true, json: async () => body });

test('returns the price from the first working source', async () => {
  _resetCache();
  const fetchImpl = async () => ok({ data: { amount: '1889.11' } });
  const p = await ethPriceUsd({ fetchImpl });
  assert.equal(p.usd, 1889.11);
  assert.equal(p.source, 'coinbase');
});

test('falls back to the second source when the first fails', async () => {
  _resetCache();
  const fetchImpl = async (url) => {
    if (url.includes('coinbase')) throw new Error('coinbase down');
    return ok({ ethereum: { usd: 1900 } });
  };
  const p = await ethPriceUsd({ fetchImpl });
  assert.equal(p.usd, 1900);
  assert.equal(p.source, 'coingecko');
});

test('caches within the TTL rather than refetching every call', async () => {
  _resetCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return ok({ data: { amount: '1800' } });
  };
  const now = () => 1_000_000;
  await ethPriceUsd({ fetchImpl, now });
  await ethPriceUsd({ fetchImpl, now });
  assert.equal(calls, 1, 'the second call should be served from cache');
});

test('serves a STALE cached price rather than nothing when all sources are down', async () => {
  _resetCache();
  let t = 1_000_000;
  await ethPriceUsd({ fetchImpl: async () => ok({ data: { amount: '1850' } }), now: () => t });
  t += 120_000; // past the TTL
  const p = await ethPriceUsd({ fetchImpl: async () => { throw new Error('down'); }, now: () => t });
  assert.equal(p.usd, 1850);
  assert.equal(p.stale, true);
});

test('negative cache: during an outage it does not refetch on every call', async () => {
  _resetCache();
  let calls = 0;
  const down = async () => {
    calls++;
    throw new Error('down');
  };
  let t = 1_000_000;
  await assert.rejects(() => ethPriceUsd({ fetchImpl: down, now: () => t }));
  const afterFirst = calls; // both sources tried once
  await assert.rejects(() => ethPriceUsd({ fetchImpl: down, now: () => t + 5_000 }));
  assert.equal(calls, afterFirst, 'a call within the attempt window must not fetch again');
});

test('throws when no source is reachable and there is no cache', async () => {
  _resetCache();
  await assert.rejects(
    () => ethPriceUsd({ fetchImpl: async () => { throw new Error('down'); } }),
    /no price source reachable/
  );
});

test('ignores a non-numeric or non-positive price and moves on', async () => {
  _resetCache();
  const fetchImpl = async (url) =>
    url.includes('coinbase') ? ok({ data: { amount: 'not-a-number' } }) : ok({ ethereum: { usd: 1888 } });
  const p = await ethPriceUsd({ fetchImpl });
  assert.equal(p.usd, 1888);
  assert.equal(p.source, 'coingecko');
});
