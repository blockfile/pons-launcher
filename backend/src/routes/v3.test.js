'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const { _private: v3 } = require('./v3');

const TOKEN = '0x3333333333333333333333333333333333333333';
const CURVE = '0x2222222222222222222222222222222222222222';
const MAIN = { id: 'main', role: 'v3main', address: '0x1111111111111111111111111111111111111111' };
const W1 = { id: 'w1', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b1' };
const W2 = { id: 'w2', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b2' };
const TREASURY = { id: 'tr', role: 'v3dev', address: '0x00000000000000000000000000000000000000d1' };
const STRANGER = '0x00000000000000000000000000000000000000ff';

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

function harness({
  wallets = [TREASURY, MAIN, W1, W2],
  exists = true,
  deployer = TREASURY.address,
  graduated = false,
  readyToGraduate = false,
  mainEth = parseEther('50'),
  snipeBps = 0,
} = {}) {
  return {
    keystore: {
      walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
      walletsWithRole: (r) => wallets.filter((w) => w.role === r),
      ownedAddresses: () => wallets.map((w) => w.address),
    },
    describeToken: async () => (exists ? { token: TOKEN, protocol: 'v2', exists: true, curve: CURVE, deployer } : { token: TOKEN, protocol: 'v2', exists: false }),
    trade: {
      readCurve: async () => ({
        address: CURVE,
        token: TOKEN,
        isNativeQuote: true,
        quoteReserve: parseEther('40'),
        tokenReserve: TOKENS(800_000_000),
        feeBps: 100,
        creatorTaxBps: 100,
        graduated,
        readyToGraduate,
      }),
      snipeTax: async () => ({ bps: snipeBps, windowSeconds: 600 }),
      tokenBalance: async () => TOKENS(1000),
    },
    rpc: { getBalance: async () => mainEth },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
  };
}

const BODY = {
  token: TOKEN,
  bigBuyEth: '5',
  targets: [
    { walletId: 'w1', buyEth: '0.1' },
    { walletId: 'w2', buyEth: '0.2' },
  ],
  intervalMs: 7000,
  jitterPct: 0,
  confirm: true,
};

const resolve = (h, body = BODY) => v3.resolveRun(body, h.keystore, h);

test('it resolves a good request into what the engine needs', async () => {
  const h = harness();
  const out = await resolve(h);
  assert.equal(out.token, TOKEN);
  assert.equal(out.curve, CURVE);
  assert.equal(out.bigBuyWei, parseEther('5'));
  assert.deepEqual(
    out.targets.map((t) => [t.walletId, t.buyWei]),
    [
      ['w1', parseEther('0.1')],
      ['w2', parseEther('0.2')],
    ]
  );
});

test('it refuses a token the v2 factory has never heard of', async () => {
  const h = harness({ exists: false });
  await assert.rejects(() => resolve(h), /not a pons v2 launch/);
});

test('it refuses a token a wallet of ours did not launch', async () => {
  // The dusting attack: preparing to sell means approving, and an approval to a
  // hostile ERC-20 is the whole of it.
  const h = harness({ deployer: STRANGER });
  await assert.rejects(() => resolve(h), /not launched by a wallet/);
});

test('it accepts a token launched by any wallet this account holds', async () => {
  // A v1 or v2 dev wallet is still ours — V3 distributes tokens launched on the
  // other tabs, which is the entire point of it not being a launcher.
  const h = harness({ deployer: W2.address });
  await assert.doesNotReject(() => resolve(h));
});

test('it refuses a graduated curve', async () => {
  const h = harness({ graduated: true });
  await assert.rejects(() => resolve(h), /graduated/);
});

test('it refuses a curve that is ready to graduate', async () => {
  // Starting a run that graduates halfway leaves the rest of the position in a
  // pool this code cannot sell.
  const h = harness({ readyToGraduate: true });
  await assert.rejects(() => resolve(h), /ready to graduate/);
});

test('it refuses when there is no main wallet', async () => {
  const h = harness({ wallets: [TREASURY, W1] });
  await assert.rejects(() => resolve(h), /v3main/);
});

test('it refuses when there are no bundle wallets', async () => {
  const h = harness({ wallets: [TREASURY, MAIN] });
  await assert.rejects(() => resolve(h), /bundle wallet/);
});

test('it refuses a target that is not a v3 bundle wallet', async () => {
  const h = harness();
  const body = { ...BODY, targets: [{ walletId: 'nope', buyEth: '0.1' }] };
  await assert.rejects(() => resolve(h, body), /not a v3 bundle wallet/);
});

test('it refuses when the main wallet cannot cover the big buy and its gas', async () => {
  const h = harness({ mainEth: parseEther('1') });
  await assert.rejects(() => resolve(h), /has 1\.0 ETH/);
});

test('it refuses a target with no positive buy amount', async () => {
  const h = harness();
  const body = { ...BODY, targets: [{ walletId: 'w1', buyEth: '0' }] };
  await assert.rejects(() => resolve(h, body), /positive/);
});

test('it refuses a non-positive big buy', async () => {
  const h = harness();
  await assert.rejects(() => resolve(h, { ...BODY, bigBuyEth: '0' }), /big buy/);
});

test('it defaults to every bundle wallet when targets are omitted', async () => {
  const h = harness();
  const out = await resolve(h, { ...BODY, targets: undefined, defaultBuyEth: '0.05' });
  assert.deepEqual(out.targets.map((t) => t.walletId), ['w1', 'w2']);
  assert.ok(out.targets.every((t) => t.buyWei === parseEther('0.05')));
});

test('the plan states the snipe tax each wallet would pay and when it closes', async () => {
  // V3 buys after the launch, so its wallets are not on the exemption list. If
  // the opening window is open, every buy pays this.
  const h = harness({ snipeBps: 500 });
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.equal(plan.snipeTax.bps, 500);
  assert.equal(plan.snipeTax.windowSeconds, 600);
  assert.match(plan.warnings.join(' '), /snipe tax/i);
});

test('the plan is silent about the snipe tax once the window has closed', async () => {
  const h = harness({ snipeBps: 0 });
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.ok(!plan.warnings.join(' ').match(/snipe tax/i));
});

test('the plan says what cycle one would sell, without selling it', async () => {
  const h = harness();
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.ok(BigInt(plan.firstCycle.tokensRaw) > 0n);
  assert.equal(plan.firstCycle.walletId, 'w1');
  assert.equal(plan.totalBuyEth, '0.3');
});

test('the plan always states that there is no slippage floor', async () => {
  const h = harness();
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.match(plan.warnings.join(' '), /no slippage floor/i);
});

test('jsonSafe turns every BigInt into a string, at any depth', () => {
  const out = v3.jsonSafe({ a: 1n, b: [2n, { c: 3n }], d: 'x' });
  assert.deepEqual(out, { a: '1', b: ['2', { c: '3' }], d: 'x' });
  assert.ok(JSON.stringify(out));
});

test('parseAmount refuses what is not a number', () => {
  assert.throws(() => v3.parseAmount('abc', 'buy'), /buy/);
  assert.throws(() => v3.parseAmount('', 'buy'), /buy/);
  assert.equal(v3.parseAmount('1.5', 'buy'), parseEther('1.5'));
});
