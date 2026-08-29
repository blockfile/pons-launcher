'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEther } = require('ethers');

// Mirrors routes/wallets.test.js and routes/v4.test.js: config.js and the
// store/keystore modules compute their file paths once, at first require, so
// these env vars must be set before requiring './v3' (which pulls in
// '../config', '../wallets/keystore' and '../v4/store' transitively) or the
// claim-seasoned route tests below would touch the real on-disk keystore.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-routes-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-v3-route-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');

const router = require('./v3');
const { _private: v3 } = require('./v3');
const { keystoreFor } = require('../wallets/keystore');
const { storeFor } = require('../v4/store');
const engine = require('../v3/engine');

// The claim-seasoned tests below are unit tests over the route module's own
// handler, not an HTTP harness — the repo has no supertest dependency. The
// handler is pulled directly off the mounted router's own stack and called
// with fake req/res objects, against a real (temp-dir) keystore and campaign
// store — seasoned.available()/claim() read both for real, not through
// doubles.

function findRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(`no route ${method.toUpperCase()} ${routePath}`);
  // requireApiKey sits ahead of the handler in the route's own middleware
  // stack; the handler itself is always last.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// Seeds a v4seed wallet funded well past the seasoning gate, via a real
// campaign in the v4 seasoning store. Mirrors seedAgedWallet in
// routes/wallets.test.js.
function seedAgedWallet(ks, store, { userTag, campaignId }) {
  const [seed] = ks.generate(1, { role: 'v4seed', label: `seed-${userTag}` });
  const sentAt = new Date(Date.now() - 3 * 24 * 3600_000).toISOString(); // 3 days ago
  store.create({
    id: campaignId,
    name: `season ${userTag}`,
    status: 'complete',
    kind: 'season',
    masterWalletId: 'm1',
    seed: 'x',
    params: {},
    transfers: [
      {
        id: `t-${campaignId}`,
        walletId: seed.id,
        address: seed.address,
        amountEth: '0.004',
        status: 'sent',
        sentAt,
        attempts: [],
      },
    ],
    createdAt: sentAt,
  });
  return seed;
}

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
  isNativeQuote = true,
  pairToken = null,
  routeImpactBps = 100, // the price impact the token-quote preflight sees (well under the cap)
  routeError = null, // if set, the route lookup throws it — "no funded swap pool"
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
        isNativeQuote,
        pairToken,
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
    // The ETH<->pairToken route preflight for a token-quoted curve. Default: a funded, low-impact
    // route. Tests flip routeError (no pool) or routeImpactBps (thin pool) to exercise the refusals.
    swaproute: {
      assessBuyImpact: async () => {
        if (routeError) throw new Error(routeError);
        return { impactBps: routeImpactBps, fullOut: TOKENS(1), usdgFee: 3000 };
      },
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

const AMZN = '0x000000000000000000000000000000000000a123';

test('it refuses a token-quoted curve that exposes no pairToken to route through', async () => {
  const h = harness({ isNativeQuote: false, pairToken: null });
  await assert.rejects(() => resolve(h), /exposes no pairToken/);
});

test('it accepts a token-quoted curve when a funded, low-impact swap route exists', async () => {
  // The AMZN case: the curve trades against a pair token, but V3 routes ETH<->pairToken around it.
  const h = harness({ isNativeQuote: false, pairToken: AMZN, routeImpactBps: 100 });
  const out = await assert.doesNotReject(() => resolve(h));
  return out;
});

test('it refuses a token-quoted curve when no funded swap pool exists', async () => {
  const h = harness({ isNativeQuote: false, pairToken: AMZN, routeError: 'no USDG<->pool with liquidity' });
  await assert.rejects(() => resolve(h), /cannot route ETH to it/);
});

test('it refuses a token-quoted big buy that would over-impact the thin pool', async () => {
  // The quoter saturates instead of reverting, so a slippage floor cannot see this — the impact
  // preflight (25% here, over the 10% cap) is the only thing that catches it.
  const h = harness({ isNativeQuote: false, pairToken: AMZN, routeImpactBps: 2500 });
  await assert.rejects(() => resolve(h), /would move the .* pool|too thin/);
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

// ── POST /v3/wallets/claim-seasoned ────────────────────────────────────────

test('POST /v3/wallets/claim-seasoned claims the aged seeds into v3bundle and reports the shortfall', async () => {
  const userId = 'v3-claim-seasoned-1';
  const ks = keystoreFor(userId);
  const store = storeFor(userId);

  const seed1 = seedAgedWallet(ks, store, { userTag: 'a', campaignId: 'v3c1' });
  const seed2 = seedAgedWallet(ks, store, { userTag: 'b', campaignId: 'v3c2' });

  const handler = findRouteHandler('post', '/v3/wallets/claim-seasoned');
  const req = { user: { id: userId }, body: { count: 2 } };
  const res = fakeRes();
  await handler(req, res, (err) => {
    if (err) throw err;
  });

  assert.equal(res.body.claimed.length, 2);
  assert.equal(res.body.available, 2);
  assert.equal(res.body.shortfall, 0);

  const claimedAddresses = res.body.claimed.map((w) => w.address).sort();
  assert.deepEqual(claimedAddresses, [seed1.address, seed2.address].sort());

  const bundleWallets = keystoreFor(userId).walletsWithRole('v3bundle');
  const bundleAddresses = bundleWallets.map((w) => w.address).sort();
  assert.deepEqual(bundleAddresses, [seed1.address, seed2.address].sort());
});

test('POST /v3/wallets/claim-seasoned is refused mid-run and re-roles nothing', async () => {
  const userId = 'v3-claim-seasoned-2';
  const ks = keystoreFor(userId);
  const store = storeFor(userId);

  seedAgedWallet(ks, store, { userTag: 'mid-run', campaignId: 'v3c3' });

  // Same seam the engine itself exposes for tests: a job map keyed by userId,
  // read by isRunning(). No real run needs to be started to exercise the guard.
  engine._jobs.set(userId, { status: 'running' });
  try {
    const handler = findRouteHandler('post', '/v3/wallets/claim-seasoned');
    const req = { user: { id: userId }, body: { count: 1 } };
    const res = fakeRes();
    let caught = null;
    await handler(req, res, (err) => {
      caught = err;
    });

    assert.ok(caught, 'expected the route to pass an error to next()');
    assert.match(caught.message, /a v3 run is in progress/);

    // Refused before any re-role: the seed wallet must still be a v4seed.
    assert.equal(ks.walletsWithRole('v3bundle').length, 0);
    assert.equal(ks.walletsWithRole('v4seed').length, 1);
  } finally {
    engine._jobs.delete(userId);
  }
});

test('POST /v3/wallets/claim-seasoned answers cleanly when nothing is available to claim', async () => {
  const userId = 'v3-claim-seasoned-3';

  const handler = findRouteHandler('post', '/v3/wallets/claim-seasoned');
  const req = { user: { id: userId }, body: { count: 3 } };
  const res = fakeRes();
  await handler(req, res, (err) => {
    if (err) throw err;
  });

  assert.deepEqual(res.body.claimed, []);
  assert.equal(res.body.available, 0);
  assert.equal(res.body.shortfall, 3);

  assert.equal(keystoreFor(userId).walletsWithRole('v3bundle').length, 0);
});

// ── POST /v3/wallets/backup (walletIds / role filter) ──────────────────────
// Same harness as the claim-seasoned tests: the handler is pulled off the
// router and called with a fake req/res against a real temp-dir keystore.
// exportAll()/decrypt() run for real, so these exercise the whole path.

function seedV3Wallets(userId) {
  const ks = keystoreFor(userId);
  const [treasury] = ks.generate(1, { role: 'v3dev', label: 'v3 treasury' });
  const [main] = ks.generate(1, { role: 'v3main', label: 'v3 main' });
  const bundle = ks.generate(3, { role: 'v3bundle', label: 'v3 bundle' });
  return { ks, treasury, main, bundle };
}

async function callBackup(userId, body) {
  const handler = findRouteHandler('post', '/v3/wallets/backup');
  const req = { user: { id: userId }, body };
  const res = fakeRes();
  let caught = null;
  await handler(req, res, (err) => {
    caught = err;
  });
  return { res, caught };
}

test('POST /v3/wallets/backup with no filter exports every v3 wallet, unchanged', async () => {
  const userId = 'v3-backup-all';
  seedV3Wallets(userId);
  const { res, caught } = await callBackup(userId, { confirm: true });
  assert.equal(caught, null);
  assert.equal(res.body.count, 5);
  assert.equal(res.body.wallets.length, 5);
  assert.ok(res.body.wallets.every((w) => ['v3dev', 'v3main', 'v3bundle'].includes(w.role)));
  // Real keys came out — this is the export that hands them over.
  assert.ok(res.body.wallets.every((w) => typeof w.privateKey === 'string' && w.privateKey.startsWith('0x')));
  // The full-backup response shape is byte-for-byte what it was: no note field.
  assert.ok(!('note' in res.body));
});

test('POST /v3/wallets/backup with a role exports only that panel\'s wallets', async () => {
  const userId = 'v3-backup-role';
  seedV3Wallets(userId);
  const { res, caught } = await callBackup(userId, { confirm: true, role: 'v3bundle' });
  assert.equal(caught, null);
  assert.equal(res.body.count, 3);
  assert.ok(res.body.wallets.every((w) => w.role === 'v3bundle'));
  assert.match(res.body.note, /per-panel/i);
});

test('POST /v3/wallets/backup with walletIds exports only those wallets', async () => {
  const userId = 'v3-backup-ids';
  const { bundle } = seedV3Wallets(userId);
  const ids = [bundle[0].id, bundle[2].id];
  const { res, caught } = await callBackup(userId, { confirm: true, walletIds: ids });
  assert.equal(caught, null);
  assert.equal(res.body.count, 2);
  assert.deepEqual(
    res.body.wallets.map((w) => w.id).sort(),
    ids.slice().sort()
  );
  assert.match(res.body.note, /selected/i);
});

test('POST /v3/wallets/backup never exports a non-v3 wallet, even when its id is named', async () => {
  // The one guard that matters: walletIds can only ever NARROW the v3-only floor,
  // so naming a v1 wallet's id gets it dropped rather than exported.
  const userId = 'v3-backup-guard';
  const { bundle } = seedV3Wallets(userId);
  const [v1] = keystoreFor(userId).generate(1, { role: 'dev', label: 'v1 dev' });
  const { res, caught } = await callBackup(userId, { confirm: true, walletIds: [bundle[0].id, v1.id] });
  assert.equal(caught, null);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.wallets[0].id, bundle[0].id);
  assert.ok(res.body.wallets.every((w) => w.role !== 'dev'));
});

test('POST /v3/wallets/backup refuses a role that is not one of v3\'s', async () => {
  const userId = 'v3-backup-badrole';
  seedV3Wallets(userId);
  const { caught } = await callBackup(userId, { confirm: true, role: 'dev' });
  assert.ok(caught, 'expected the route to reject a non-v3 role');
  assert.match(caught.message, /role must be one of/);
});

test('POST /v3/wallets/backup still requires confirm:true with a filter present', async () => {
  const userId = 'v3-backup-noconfirm';
  seedV3Wallets(userId);
  const { caught } = await callBackup(userId, { role: 'v3bundle' });
  assert.ok(caught);
  assert.match(caught.message, /confirm: true/);
});
