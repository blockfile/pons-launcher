'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther, parseUnits } = require('ethers');

const funding = require('./funding');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const WALLETS = [
  { id: 'dev', role: 'dev', address: '0x1111111111111111111111111111111111111111' },
  { id: 'b1', role: 'bundle', address: '0x2222222222222222222222222222222222222222' },
  { id: 'b2', role: 'bundle', address: '0x3333333333333333333333333333333333333333' },
];

function harness({ eth = {}, pair = {}, readThrows = false } = {}) {
  const nativeReads = [];
  const batchCalls = [];
  const deps = {
    keystore: { list: () => WALLETS },
    provider: {
      getBalance: async (a) => {
        nativeReads.push(a);
        return eth[a] ?? 0n;
      },
    },
    readTokenBalances: async (token, owners) => {
      batchCalls.push({ token, owners });
      if (readThrows) throw new Error('multicall down');
      return owners.map((o) => (o in pair ? pair[o] : null));
    },
  };
  return { deps, nativeReads, batchCalls };
}

// ── the native path is untouched ─────────────────────────────────────────────

test('with no pair, the listing is exactly the shape and the reads it has always been', async () => {
  const { deps, nativeReads, batchCalls } = harness({
    eth: { [WALLETS[0].address]: parseEther('1.5') },
  });
  const out = await funding.balances(deps);

  assert.equal(out.length, 3);
  assert.deepEqual(Object.keys(out[0]).sort(), ['address', 'balanceEth', 'balanceWei', 'id', 'role']);
  assert.equal(out[0].balanceEth, '1.5');
  assert.equal(out[1].balanceEth, '0.0');
  // One native read per wallet, and NOT ONE token read.
  assert.equal(nativeReads.length, 3);
  assert.equal(batchCalls.length, 0, 'a native launch must make no extra chain read for a pair column');
});

test('a pair that could not be resolved degrades to the native shape rather than failing', async () => {
  // The route hands `pair: null` down whenever the token is native, unparseable,
  // un-approved, or the factory could not be read.
  const { deps, batchCalls } = harness();
  const out = await funding.balances({ ...deps, pair: null });
  assert.equal(batchCalls.length, 0);
  assert.ok(out.every((w) => w.pairBalance === undefined && w.pairToken === undefined));
});

// ── the pair column ──────────────────────────────────────────────────────────

test('a pair is read ONCE for every wallet, not once per wallet', async () => {
  const { deps, nativeReads, batchCalls } = harness({
    pair: {
      [WALLETS[1].address]: parseUnits('12.5', 18),
      [WALLETS[2].address]: 0n,
      [WALLETS[0].address]: parseUnits('3', 18),
    },
  });
  const out = await funding.balances({
    ...deps,
    pair: { address: NVDA, symbol: 'NVDA', decimals: 18 },
  });

  assert.equal(nativeReads.length, 3, 'the native reads are unchanged in number');
  assert.equal(batchCalls.length, 1, '31 sequential balanceOf calls is what the batch exists to avoid');
  assert.deepEqual(batchCalls[0].owners, WALLETS.map((w) => w.address));

  assert.equal(out[1].pairBalance, '12.5');
  assert.equal(out[1].pairSymbol, 'NVDA');
  assert.equal(out[1].pairDecimals, 18);
  assert.equal(out[1].pairToken, NVDA);
  assert.equal(out[2].pairBalance, '0.0');
  // The dev wallet gets one too — a paired launch denominates the DEV buy in the
  // pair token as well, so its holding is as much a fact as a bundle wallet's.
  assert.equal(out[0].pairBalance, '3.0');
});

test('the pair amount is formatted at the FACTORY decimals it was resolved with', async () => {
  // USDG is 6dp. Formatting a 6dp balance as 18dp would be off by a factor of
  // a trillion, and the Buy column it is compared against is parsed at 6.
  const { deps } = harness({ pair: { [WALLETS[1].address]: 12_500_000n } });
  const out = await funding.balances({
    ...deps,
    pair: { address: NVDA, symbol: 'USDG', decimals: 6 },
  });
  assert.equal(out[1].pairBalance, '12.5');
  assert.equal(out[1].pairBalanceWei, '12500000');
});

test('a slot that could not be read is NULL, never 0', async () => {
  // An unread balance and an empty wallet are different facts, and a table that
  // rendered the first as "0" would tell an operator a funded wallet is empty.
  const { deps } = harness({ pair: { [WALLETS[1].address]: parseUnits('1', 18) } });
  const out = await funding.balances({
    ...deps,
    pair: { address: NVDA, symbol: 'NVDA', decimals: 18 },
  });
  assert.equal(out[1].pairBalance, '1.0');
  assert.equal(out[0].pairBalance, null);
  assert.equal(out[0].pairBalanceWei, null);
  assert.equal(out[2].pairBalance, null);
});

test('an empty keystore never reaches the token read at all', async () => {
  const { deps, batchCalls } = harness();
  deps.keystore = { list: () => [] };
  const out = await funding.balances({ ...deps, pair: { address: NVDA, symbol: 'NVDA', decimals: 18 } });
  assert.deepEqual(out, []);
  assert.equal(batchCalls.length, 0);
});
