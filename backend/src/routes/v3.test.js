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
    // Injected by default so no test reaches an exchange. Individual tests
    // override it to assert the priced and the unpriced paths.
    ethPriceUsd: async () => ({ usd: 4000, source: 'fake', at: 0 }),
  };
}

const BODY = {
  token: TOKEN,
  bigBuyEth: '5',
  targets: [{ walletId: 'w1' }, { walletId: 'w2' }],
  intervalMs: 7000,
  jitterPct: 0,
  variancePct: 30,
  confirm: true,
};

const resolve = (h, body = BODY) => v3.resolveRun(body, h.keystore, h);

test('it resolves a good request into what the engine needs', async () => {
  const h = harness();
  const out = await resolve(h);
  assert.equal(out.token, TOKEN);
  assert.equal(out.curve, CURVE);
  assert.equal(out.bigBuyWei, parseEther('5'));
  // Wallets and addresses only — no per-wallet amount. The run sizes each
  // cycle from what is left of the position when it gets there.
  assert.deepEqual(
    out.targets.map((t) => [t.walletId, t.address]),
    [
      ['w1', W1.address],
      ['w2', W2.address],
    ]
  );
  assert.ok(!('buyWei' in out.targets[0]));
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

test('it refuses a non-positive big buy', async () => {
  const h = harness();
  await assert.rejects(() => resolve(h, { ...BODY, bigBuyEth: '0' }), /big buy/);
});

test('it refuses a big buy that is not a number', async () => {
  const h = harness();
  await assert.rejects(() => resolve(h, { ...BODY, bigBuyEth: 'lots' }), /number of ETH/);
});

test('it defaults to every bundle wallet when targets are omitted', async () => {
  const h = harness();
  const out = await resolve(h, { ...BODY, targets: undefined });
  assert.deepEqual(
    out.targets.map((t) => t.walletId),
    ['w1', 'w2']
  );
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

test('the plan estimates the position after the round trip, not the big buy', async () => {
  // Buying 5 ETH of a curve and selling it back does not return 5 ETH: fees and
  // the operator's own price impact are both paid twice. The wallets share the
  // smaller figure, and the plan has to say so or every slice it quotes is
  // optimistic.
  const h = harness();
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.ok(Number(plan.position.eth) > 0);
  assert.ok(Number(plan.position.eth) < 5, 'the round trip cannot come back whole');
  assert.ok(plan.position.bleedPct > 0);
  assert.match(plan.warnings.join(' '), /price impact/);
});

test('the plan states an average slice and the band it varies within', async () => {
  const h = harness();
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  // Two wallets, so the mean is half the position.
  assert.ok(Math.abs(Number(plan.slice.meanEth) - Number(plan.position.eth) / 2) < 1e-9);
  assert.ok(Number(plan.slice.lowEth) < Number(plan.slice.meanEth));
  assert.ok(Number(plan.slice.highEth) > Number(plan.slice.meanEth));
  assert.equal(plan.walletCount, 2);
});

test('a variance of zero makes the band collapse onto the mean', async () => {
  const h = harness();
  const plan = await v3.buildPlan({ ...BODY, variancePct: 0 }, h.keystore, h);
  assert.equal(plan.slice.lowEth, plan.slice.meanEth);
  assert.equal(plan.slice.highEth, plan.slice.meanEth);
});

test('the plan prices everything in dollars when a rate is available', async () => {
  const h = harness();
  h.ethPriceUsd = async () => ({ usd: 4000, source: 'test', at: 0 });
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.equal(plan.ethUsd, 4000);
  assert.equal(plan.bigBuyUsd, '20000.00');
  assert.ok(Number(plan.slice.meanUsd) > 0);
});

test('a dead price feed leaves the dollar figures null rather than failing', async () => {
  // The ETH figures are the ones the curve fixes; dollars are advisory, and a
  // plan that refused to answer because an exchange was down would be worse
  // than one that answers without them.
  const h = harness();
  h.ethPriceUsd = async () => {
    throw new Error('both sources down');
  };
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.equal(plan.ethUsd, null);
  assert.equal(plan.slice.meanUsd, null);
  assert.ok(Number(plan.slice.meanEth) > 0, 'the ETH figures must still be there');
});

test('the plan estimates how long the run will take', async () => {
  const h = harness();
  const plan = await v3.buildPlan(BODY, h.keystore, h);
  assert.equal(plan.estimatedRunMs, 7000 * 2);
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
