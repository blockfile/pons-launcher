'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const exit = require('./exit');

const USER = 'u1';
const TOKEN = '0x3333333333333333333333333333333333333333';
const CURVE = '0x2222222222222222222222222222222222222222';
const MAIN = { id: 'main', role: 'v3main', address: '0x1111111111111111111111111111111111111111' };
const W1 = { id: 'w1', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b1' };
const W2 = { id: 'w2', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b2' };
const OTHER = { id: 'v2b', role: 'v2bundle', address: '0x00000000000000000000000000000000000000c1' };

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

function harness({
  holdings = { [MAIN.address]: TOKENS(400), [W1.address]: TOKENS(100), [W2.address]: TOKENS(50) },
  eth = { [MAIN.address]: parseEther('1'), [W1.address]: parseEther('1'), [W2.address]: parseEther('1') },
  graduated = false,
  revertFor = [],
} = {}) {
  const sold = [];
  const logged = [];
  const wallets = [MAIN, W1, W2, OTHER];

  const deps = {
    keystoreForFn: () => ({
      walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
      walletsWithRole: (r) => wallets.filter((w) => w.role === r),
    }),
    activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
    rpc: { getBalance: async (a) => eth[a] ?? 0n },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    trade: {
      readCurve: async () => ({
        address: CURVE,
        token: TOKEN,
        quoteReserve: parseEther('40'),
        tokenReserve: TOKENS(800_000_000),
        feeBps: 100,
        creatorTaxBps: 100,
        graduated,
        readyToGraduate: false,
      }),
      tokenBalance: async (_t, owner) => holdings[owner] ?? 0n,
      sell: async ({ wallet, tokensIn }) => {
        sold.push({ walletId: wallet.id, tokensIn });
        if (revertFor.includes(wallet.id)) {
          return { status: 'reverted', approveHash: '0xa', sellHash: '0xs', ethReceived: 0n, tokensIn };
        }
        return {
          status: 'confirmed',
          approveHash: `0xa${wallet.id}`,
          sellHash: `0xs${wallet.id}`,
          blockNumber: 1,
          ethReceived: parseEther('0.5'),
          tokensIn,
        };
      },
    },
  };

  return { deps, sold, logged };
}

test('the exit includes v3main as well as the bundle wallets', async () => {
  const h = harness();
  const out = await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.deepEqual(
    h.sold.map((s) => s.walletId).sort(),
    ['main', 'w1', 'w2'],
    'main finishes a run still holding whatever it did not sell'
  );
  assert.equal(out.totals.sold, 3);
});

test('it never touches another launchers wallets', async () => {
  const h = harness();
  await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.ok(!h.sold.some((s) => s.walletId === 'v2b'));
});

test('it sells each wallets whole balance', async () => {
  const h = harness();
  await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  const byId = Object.fromEntries(h.sold.map((s) => [s.walletId, s.tokensIn]));
  assert.equal(byId.main, TOKENS(400));
  assert.equal(byId.w1, TOKENS(100));
  assert.equal(byId.w2, TOKENS(50));
});

test('it skips a wallet holding none, and says so', async () => {
  const h = harness({ holdings: { [MAIN.address]: TOKENS(400), [W1.address]: 0n, [W2.address]: TOKENS(50) } });
  const out = await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.ok(!h.sold.some((s) => s.walletId === 'w1'));
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /holds none/);
});

test('it skips a wallet too short of gas, and says which', async () => {
  // Signing an approval a wallet cannot pay for is worse than skipping it: the
  // sell queued behind it at n+1 is then stuck for good.
  const h = harness({ eth: { [MAIN.address]: parseEther('1'), [W1.address]: 1n, [W2.address]: parseEther('1') } });
  const out = await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.ok(!h.sold.some((s) => s.walletId === 'w1'));
  assert.match(out.skipped[0].reason, /gas/);
});

test('one wallets revert does not stop the others', async () => {
  const h = harness({ revertFor: ['w1'] });
  const out = await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.equal(h.sold.length, 3, 'every wallet is still attempted');
  assert.equal(out.totals.failed, 1);
  assert.equal(out.totals.sold, 2);
});

test('it refuses without confirm', async () => {
  const h = harness();
  await assert.rejects(() => exit.run(USER, { token: TOKEN, curve: CURVE }, h.deps), /confirm/);
  assert.equal(h.sold.length, 0);
});

test('it refuses a graduated curve', async () => {
  const h = harness({ graduated: true });
  await assert.rejects(
    () => exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps),
    /graduated/
  );
  assert.equal(h.sold.length, 0);
});

test('it refuses when nothing holds any', async () => {
  const h = harness({ holdings: {} });
  await assert.rejects(
    () => exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps),
    /nothing to sell/
  );
});

test('totals count sold, failed and eth received', async () => {
  const h = harness();
  const out = await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.equal(out.totals.wallets, 3);
  assert.equal(out.totals.sold, 3);
  assert.equal(out.totals.failed, 0);
  assert.equal(out.totals.ethReceived, '1.5');
});

test('preview says what each wallet holds without selling anything', async () => {
  const h = harness();
  const out = await exit.preview(USER, { token: TOKEN, curve: CURVE }, h.deps);
  assert.equal(h.sold.length, 0);
  assert.equal(out.wallets.length, 3);
  assert.equal(out.totalTokens, '550.0');
  assert.ok(out.wallets.some((w) => w.role === 'v3main'));
});

test('the run is written to the activity log', async () => {
  const h = harness();
  await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.equal(h.logged.length, 1);
  assert.equal(h.logged[0].kind, 'v3');
  assert.match(h.logged[0].summary, /sold/);
});

test('no field of the result is a BigInt', async () => {
  const h = harness();
  const out = await exit.run(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.ok(JSON.stringify(out).length > 0);
});
