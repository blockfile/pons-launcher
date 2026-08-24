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
