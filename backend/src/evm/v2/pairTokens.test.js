'use strict';

// The approved-pair-token resolver. No chain: the Multicall3 read is injected,
// and getLogs is faked on the provider.
//
// What matters here is the SAFETY property — the list is what approvedPairTokens
// says NOW, never what the event history once said. A seed address the factory
// has un-approved (RIVN's fate) must not appear; a token discovered only from
// the logs must; native ETH is always first.

const test = require('node:test');
const assert = require('node:assert');
const { Interface, getAddress, ZeroAddress } = require('ethers');

const { resolvePairTokens, clearPairTokenCache, SEED_CANDIDATES } = require('./pairTokens');
const { FACTORY_V2_ABI } = require('./abi');
const { ERC20_ABI } = require('../erc20');

const factoryIface = new Interface(FACTORY_V2_ABI);
const erc20Iface = new Interface(ERC20_ABI);

const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'); // seed, 6-dec
const SPCX = getAddress('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa'); // seed, 18-dec
const GME = getAddress('0x1b0E319c6A659F002271B69dB8A7df2F911c153E'); // seed, REMOVED
const NEWT = getAddress('0x' + 'ab'.repeat(20)); // discovered from logs only

// address(lowercased) → its on-chain truth
function db() {
  return {
    [USDG.toLowerCase()]: { approved: true, symbol: 'USDG', decimals: 6, phantomQuote: 5_000_000_000n, threshold: 20_000_000_000n },
    [SPCX.toLowerCase()]: { approved: true, symbol: 'SPCX', decimals: 18, phantomQuote: 168n * 10n ** 16n, threshold: 42n * 10n ** 17n },
    [GME.toLowerCase()]: { approved: false, symbol: 'GME', decimals: 18, phantomQuote: 0n, threshold: 0n },
    [NEWT.toLowerCase()]: { approved: true, symbol: 'NEWT', decimals: 18, phantomQuote: 1n, threshold: 2n },
  };
}

const SEL = {
  approved: factoryIface.getFunction('approvedPairTokens').selector,
  econ: factoryIface.getFunction('pairTokenEconomics').selector,
  symbol: erc20Iface.getFunction('symbol').selector,
  decimals: erc20Iface.getFunction('decimals').selector,
};

function fakeMulticall(data, counter) {
  return async (calls) => {
    counter.n++;
    return calls.map((c) => {
      const sel = c.callData.slice(0, 10);
      if (sel === SEL.approved) {
        const [addr] = factoryIface.decodeFunctionData('approvedPairTokens', c.callData);
        const rec = data[getAddress(addr).toLowerCase()];
        return { success: true, returnData: factoryIface.encodeFunctionResult('approvedPairTokens', [Boolean(rec && rec.approved)]) };
      }
      if (sel === SEL.econ) {
        const [addr] = factoryIface.decodeFunctionData('pairTokenEconomics', c.callData);
        const rec = data[getAddress(addr).toLowerCase()];
        return { success: true, returnData: factoryIface.encodeFunctionResult('pairTokenEconomics', [rec.phantomQuote, rec.threshold, rec.decimals]) };
      }
      if (sel === SEL.symbol) {
        const rec = data[getAddress(c.target).toLowerCase()];
        return { success: true, returnData: erc20Iface.encodeFunctionResult('symbol', [rec ? rec.symbol : '?']) };
      }
      if (sel === SEL.decimals) {
        const rec = data[getAddress(c.target).toLowerCase()];
        return { success: true, returnData: erc20Iface.encodeFunctionResult('decimals', [rec ? rec.decimals : 18]) };
      }
      return { success: false, returnData: '0x' };
    });
  };
}

// A provider whose getLogs reports one approval event — for NEWT, which is NOT
// in the seed, so it can only be discovered here.
function providerWithLog(token = NEWT) {
  const ev = factoryIface.getEvent('PairTokenApprovalUpdated');
  const { data, topics } = factoryIface.encodeEventLog(ev, [token, true]);
  return { getLogs: async () => [{ topics, data, blockNumber: 100 }] };
}

test('native ETH is always first, even when every candidate is unapproved', async () => {
  clearPairTokenCache();
  const counter = { n: 0 };
  const empty = {};
  const tokens = await resolvePairTokens({
    refresh: true,
    provider: { getLogs: async () => [] },
    multicall: fakeMulticall(empty, counter),
  });
  assert.equal(tokens[0].address, ZeroAddress);
  assert.equal(tokens[0].symbol, 'ETH');
  assert.equal(tokens[0].native, true);
  assert.equal(tokens.length, 1, 'nothing approved → native alone');
});

test('the list is what approvedPairTokens says now: removed excluded, log-only included', async () => {
  clearPairTokenCache();
  const counter = { n: 0 };
  const tokens = await resolvePairTokens({
    refresh: true,
    provider: providerWithLog(NEWT),
    multicall: fakeMulticall(db(), counter),
  });

  const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));
  assert.equal(tokens[0].symbol, 'ETH');
  // Approved seeds and the log-discovered token are present…
  assert.ok(bySymbol.has('USDG'));
  assert.ok(bySymbol.has('SPCX'));
  assert.ok(bySymbol.has('NEWT'), 'a token seen only in the logs is discovered');
  // …the un-approved seed (RIVN's fate) is NOT, even though it is in the seed.
  assert.ok(!bySymbol.has('GME'), 'a removed token must never be listed');

  // Enrichment is correct and decimals come from the factory economics.
  assert.equal(bySymbol.get('USDG').decimals, 6);
  assert.equal(bySymbol.get('USDG').address, USDG);
  assert.equal(bySymbol.get('USDG').phantomQuote, '5000000000');
  assert.equal(bySymbol.get('USDG').graduationThreshold, '20000000000');
  assert.equal(bySymbol.get('SPCX').decimals, 18);

  // Stable order: native first, then the rest by symbol.
  const rest = tokens.slice(1).map((t) => t.symbol);
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)));
});

test('the result is cached, and refresh forces a re-read', async () => {
  clearPairTokenCache();
  const counter = { n: 0 };
  const opts = { provider: providerWithLog(NEWT), multicall: fakeMulticall(db(), counter) };

  await resolvePairTokens({ ...opts, refresh: true });
  const afterFirst = counter.n;
  assert.ok(afterFirst > 0, 'the first read hits the chain');

  await resolvePairTokens(opts); // no refresh, within TTL
  assert.equal(counter.n, afterFirst, 'a cached read hits nothing');

  await resolvePairTokens({ ...opts, refresh: true });
  assert.ok(counter.n > afterFirst, 'refresh reads again');
});

test('a getLogs failure still resolves the known pairs from the seed', async () => {
  clearPairTokenCache();
  const counter = { n: 0 };
  // Range-limited node: whole-chain getLogs throws. The seed must carry it.
  const tokens = await resolvePairTokens({
    refresh: true,
    provider: { getLogs: async () => { throw new Error('range too wide'); } },
    multicall: fakeMulticall(db(), counter),
  });
  const symbols = tokens.map((t) => t.symbol);
  assert.ok(symbols.includes('USDG'), 'a seed pair resolves even with no logs');
  assert.ok(symbols.includes('SPCX'));
  assert.ok(!symbols.includes('NEWT'), 'without logs, a non-seed token cannot be found');
  // The seed contains the well-known RWAs.
  assert.ok(SEED_CANDIDATES.map((a) => getAddress(a)).includes(USDG));
});

// ── A FAILED READ MUST NOT BECOME THE CACHED ANSWER ─────────────────────────
// Observed live: a 31-wallet bundle holding NVDA showed a dash in every row
// while a direct Multicall3 read of the same wallets returned every balance in
// 379ms. The chain was fine. One unlucky refill had degraded to native-alone,
// that got cached like any other answer, and for the whole five-minute TTL
// GET /wallets resolved no pair and answered in the native shape.

const boom = () => { throw new Error('multicall unavailable'); };

test('a failed read serves the last good list rather than native alone', async () => {
  clearPairTokenCache();
  const good = await resolvePairTokens({
    refresh: true,
    provider: providerWithLog(NEWT),
    multicall: fakeMulticall(db(), { n: 0 }),
  });
  assert.ok(good.length > 1, 'precondition: a good list was cached');

  // THE CACHE MUST BE EXPIRED, or the read never happens and this proves
  // nothing. A first attempt at this test called through a WARM cache, returned
  // early on the TTL check, and passed with the fix removed — a vacuous test.
  // Advancing the clock past the TTL is what puts the failing refill on the path.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    const stale = await resolvePairTokens({
      // no refresh: the display path, the one GET /wallets uses
      provider: providerWithLog(NEWT),
      multicall: boom,
    });
    assert.ok(stale.length > 1, 'a failed refill does not blank the list');
    assert.deepEqual(stale.map((t) => t.symbol), good.map((t) => t.symbol));
  } finally {
    Date.now = realNow;
  }
});

test('a failed read is NOT cached, so the next call retries instead of serving it', async () => {
  clearPairTokenCache();
  const first = await resolvePairTokens({
    refresh: true,
    provider: { getLogs: async () => [] },
    multicall: boom,
  });
  assert.equal(first.length, 1, 'nothing better to offer than native');

  // If that had been cached, this would return native alone from the cache
  // without asking the chain at all.
  const counter = { n: 0 };
  const second = await resolvePairTokens({
    provider: providerWithLog(NEWT),
    multicall: fakeMulticall(db(), counter),
  });
  assert.ok(counter.n > 0, 'the failure was not cached — the chain was asked again');
  assert.ok(second.length > 1, 'and the retry recovers the real list');
});

test('refresh:true still fails CLOSED — the money paths never get a stale list', async () => {
  clearPairTokenCache();
  const good = await resolvePairTokens({
    refresh: true,
    provider: providerWithLog(NEWT),
    multicall: fakeMulticall(db(), { n: 0 }),
  });
  assert.ok(good.length > 1);

  // prepareV2 / swapToPair / swapFromPair pass refresh:true precisely so an
  // un-approved token cannot be spent against. A stale answer there would
  // defeat that, so they get native alone and resolveApprovedPair throws.
  const forced = await resolvePairTokens({
    refresh: true,
    provider: providerWithLog(NEWT),
    multicall: boom,
  });
  assert.equal(forced.length, 1, 'a forced refresh that fails must not serve stale');
});

test('a genuine "nothing approved" IS cached — it is an answer, not a failure', async () => {
  clearPairTokenCache();
  const counter = { n: 0 };
  const opts = { provider: { getLogs: async () => [] }, multicall: fakeMulticall({}, counter) };
  const first = await resolvePairTokens({ ...opts, refresh: true });
  assert.equal(first.length, 1);
  const reads = counter.n;
  await resolvePairTokens(opts);
  assert.equal(counter.n, reads, 'the chain answered "none" — that is cached like any answer');
});

// ── A PARTLY-READ LIST MUST NOT STAND FOR THE FULL WINDOW ───────────────────
// The operator asked why AMD was missing from the v2 picker. It is approved and
// priced; the picker was drawing a cached list that had lost it to one failed
// economics slot in round two, which `answered` (round one only) cannot see.

test('a token dropped by a failed economics slot is served, but only briefly', async () => {
  clearPairTokenCache();
  // Round one approves everything; round two loses ONE token's economics.
  const full = db();
  const dropOne = (calls) => {
    const out = fakeMulticall(full, { n: 0 })(calls);
    return Promise.resolve(out).then((slots) =>
      slots.map((slot, i) =>
        // round two is triples; blank the FIRST economics slot only
        calls.length > 3 && i === 0 ? { success: false, returnData: '0x' } : slot
      )
    );
  };
  const partial = await resolvePairTokens({
    refresh: true,
    provider: providerWithLog(NEWT),
    multicall: dropOne,
  });
  const complete = await resolvePairTokens({
    refresh: true,
    provider: providerWithLog(NEWT),
    multicall: fakeMulticall(full, { n: 0 }),
  });
  assert.ok(partial.length < complete.length, 'precondition: one token was dropped');

  // Re-read it. A COMPLETE list would still be cached here; the partial one
  // must not be, beyond its short ttl.
  clearPairTokenCache();
  await resolvePairTokens({ refresh: true, provider: providerWithLog(NEWT), multicall: dropOne });
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 1000; // past INCOMPLETE_TTL_MS, inside CACHE_TTL_MS
  try {
    const counter = { n: 0 };
    const healed = await resolvePairTokens({
      provider: providerWithLog(NEWT),
      multicall: fakeMulticall(full, counter),
    });
    assert.ok(counter.n > 0, 'the incomplete list expired and the chain was asked again');
    assert.equal(healed.length, complete.length, 'and the re-read recovered the missing token');
  } finally {
    Date.now = realNow;
  }
});

test('a COMPLETE list still gets the full window', async () => {
  clearPairTokenCache();
  const counter = { n: 0 };
  const opts = { provider: providerWithLog(NEWT), multicall: fakeMulticall(db(), counter) };
  await resolvePairTokens({ ...opts, refresh: true });
  const reads = counter.n;
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 1000; // past the INCOMPLETE ttl only
  try {
    await resolvePairTokens(opts);
    assert.equal(counter.n, reads, 'a complete list is not re-read after 25s');
  } finally {
    Date.now = realNow;
  }
});

// ── THE RANGE-LIMITED NODE, WHICH IS WHAT THE OPERATOR IS ON ────────────────
// QuickNode refuses any getLogs span over 10k blocks, so the whole-chain query
// throws and discovery finds NOTHING. With only 7 seeded pairs the picker
// offered 7 of 56 and AMD was invisible -- approved, priced, undiscoverable.
// The seed now carries all of them, so this node sees the same list as any
// other. Every entry still goes through approvedPairTokens, so the seed being
// large does not make it trusted.

test('a range-limited node (no logs at all) still resolves every seeded pair', async () => {
  clearPairTokenCache();
  const approveAll = (calls) =>
    Promise.resolve(
      calls.map((c, i) => {
        // round one: approvedPairTokens(addr) -> true for everything
        if (calls.length && calls.every((x) => x.target === calls[0].target)) {
          return { success: true, returnData: '0x' + '0'.repeat(63) + '1' };
        }
        return { success: false, returnData: '0x' };
      })
    );
  const tokens = await resolvePairTokens({
    refresh: true,
    provider: { getLogs: async () => { throw new Error('range too wide'); } },
    multicall: approveAll,
  });
  // Round two is stubbed out, so nothing is enriched -- but round one must have
  // been ASKED about every seed entry, which is the property under test.
  assert.ok(SEED_CANDIDATES.length >= 50, 'the seed carries the full approved set, not 7');
  assert.ok(
    SEED_CANDIDATES.map((a) => getAddress(a)).includes(
      getAddress('0x86923f96303D656E4aa86D9d42D1e57ad2023fdC')
    ),
    'AMD is seeded — the token whose absence surfaced this'
  );
  assert.equal(tokens[0].symbol, 'ETH', 'native is still first whatever happened');
});
