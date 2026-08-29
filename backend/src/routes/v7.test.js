'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEther, formatEther, getAddress } = require('ethers');

// Mirrors routes/v3.test.js and routes/v6.test.js: config.js and the keystore
// module compute their file paths once, at first require, so these env vars must
// be set before requiring './v7' (which pulls in '../config' and
// '../wallets/keystore' transitively) or the chain/start route test below —
// which seeds a REAL temp-dir keystore — would touch the real on-disk keystore.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7-routes-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-v7-route-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');

const router = require('./v7');
const { _private: v7 } = require('./v7');
const { keystoreFor } = require('../wallets/keystore');
const config = require('../config');
const trade = require('../v7/trade');
const engine = require('../v7/engine');
const { provider } = require('../evm/provider');

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

// A flap curve is a FIXED launcher, not a per-token pool: the venue is
// config.flap.launcher for every token (v6 had a per-pool poolId/hook — v7 has
// neither). readCurve returns it as pool.venue.
const LAUNCHER = getAddress(config.flap.launcher);
const MAX_FRAC = config.flap.maxHeadroomFrac; // 0.8 — the big-buy graduation cap

const TOKEN = '0x1111111111111111111111111111111111111111';
const MAIN = { id: 'main', role: 'v7main', address: '0x00000000000000000000000000000000000000a1' };
const W1 = { id: 'w1', role: 'v7bundle', address: '0x00000000000000000000000000000000000000b1' };
const W2 = { id: 'w2', role: 'v7bundle', address: '0x00000000000000000000000000000000000000b2' };
const TREASURY = { id: 'tr', role: 'v7dev', address: '0x00000000000000000000000000000000000000d1' };

const FEES = { getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }) };

// A sell QUOTE that reverts. On v6/letscash this was ambiguous (the quoter taxes
// the sell simulation) and drove a getLogs honeypot scan. On v7/flap the quoter
// PRICES sells, provenance already proved a genuine state-0 clone whose sells are
// structurally guaranteed, so a revert here is a SOFT estimate + warning — never
// a block, and there is no hasRecentSell fallback to consult.
const revertingSell = () => {
  const e = new Error('execution reverted (unknown custom error)');
  e.data = '0x6190b2b0000000';
  throw e;
};

// ── _private.feasibilityOf — graduation + pricingEstimated (no sellsRevert/hasRecentSell) ──

// A run whose only feasibility-relevant field is the curve's headroomTokens (the
// graduation gate) plus the wallet count.
function runWith({ head = TOKENS(800_000), bigBuyEth = '5', wallets = 1 } = {}) {
  return {
    token: TOKEN,
    pool: {
      venue: LAUNCHER,
      state: 0,
      circulatingSupply: TOKENS(200_000),
      dexSupplyThresh: TOKENS(1_000_000),
      headroomTokens: head,
    },
    bigBuyWei: parseEther(bigBuyEth),
    targets: Array.from({ length: wallets }, (_, i) => ({ walletId: `w${i}`, address: W1.address })),
  };
}

test('a normally-quotable sell is priced with no estimate and no graduation block', async () => {
  const t = { quoteBuyOut: async () => TOKENS(400_000), quoteSellOut: async () => parseEther('4.5') };
  const feas = await v7.feasibilityOf(runWith(), { trade: t, ...FEES });
  assert.equal(feas.pricingEstimated, false);
  assert.equal(feas.positionWei, parseEther('4.5'));
  assert.equal(feas.sellError, null);
  assert.equal(feas.graduationRisk, false);
  // v7 dropped v6's honeypot machinery entirely.
  assert.equal(feas.sellsRevert, undefined);
  assert.equal(feas.sellUnverified, undefined);
});

test('a reverting sell QUOTE is a SOFT estimate (pricingEstimated), never a block — and no hasRecentSell is consulted', async () => {
  // The trade double deliberately has NO hasRecentSell: if feasibilityOf tried to
  // call it (the v6 behaviour) this would throw, proving v7 never does.
  const t = { quoteBuyOut: async () => TOKENS(400_000), quoteSellOut: revertingSell };
  const feas = await v7.feasibilityOf(runWith(), { trade: t, ...FEES });
  assert.equal(feas.pricingEstimated, true);
  assert.equal(feas.positionWei, parseEther('5'), 'position estimated as roughly the ETH put in');
  assert.equal(feas.sellError, '0x6190b2b0');
  assert.equal(feas.graduationRisk, false);
  assert.equal(feas.sellsRevert, undefined, 'a sell-quote revert is never a hard block on the flap curve');
  assert.equal(feas.feasible, true, 'a soft estimate must still be feasible');
});

test('feasibilityOf reads the selector from an ethers info.error.data shape too', async () => {
  const t = {
    quoteBuyOut: async () => TOKENS(400_000),
    quoteSellOut: async () => {
      const e = new Error('execution reverted');
      e.info = { error: { data: '0xdeadbeef11' } };
      throw e;
    },
  };
  const feas = await v7.feasibilityOf(runWith(), { trade: t, ...FEES });
  assert.equal(feas.pricingEstimated, true);
  assert.equal(feas.sellError, '0xdeadbeef');
});

test('a big buy whose tokens exceed maxHeadroomFrac*headroom sets graduationRisk true', async () => {
  const head = TOKENS(1_000_000);
  const t = { quoteBuyOut: async () => TOKENS(900_000), quoteSellOut: async () => parseEther('4') };
  const feas = await v7.feasibilityOf(runWith({ head }), { trade: t, ...FEES });
  assert.equal(feas.graduationRisk, true);
  assert.equal(feas.graduationCap, (head * BigInt(Math.round(MAX_FRAC * 100))) / 100n); // 0.8 → 800k
  assert.equal(feas.graduationCap, TOKENS(800_000));
  assert.equal(feas.tokensBought, TOKENS(900_000));
});

test('a big buy exactly AT the cap trips graduationRisk (>=)', async () => {
  const head = TOKENS(1_000_000);
  const t = { quoteBuyOut: async () => TOKENS(800_000), quoteSellOut: async () => parseEther('4') };
  const feas = await v7.feasibilityOf(runWith({ head }), { trade: t, ...FEES });
  assert.equal(feas.graduationRisk, true);
});

test('a big buy below the cap does NOT set graduationRisk', async () => {
  const head = TOKENS(1_000_000);
  const t = { quoteBuyOut: async () => TOKENS(700_000), quoteSellOut: async () => parseEther('4') };
  const feas = await v7.feasibilityOf(runWith({ head }), { trade: t, ...FEES });
  assert.equal(feas.graduationRisk, false);
});

test('a token with no headroom never trips the graduation gate', async () => {
  // headroom 0 → cap 0 → the guard short-circuits, however large the buy.
  const t = { quoteBuyOut: async () => TOKENS(5_000_000), quoteSellOut: async () => parseEther('4') };
  const feas = await v7.feasibilityOf(runWith({ head: 0n }), { trade: t, ...FEES });
  assert.equal(feas.graduationRisk, false);
  assert.equal(feas.graduationCap, 0n);
});

test('no wallets → feasible false (no-wallets), graduation is still computed', async () => {
  const head = TOKENS(1_000_000);
  const t = { quoteBuyOut: async () => TOKENS(900_000), quoteSellOut: async () => parseEther('4') };
  const feas = await v7.feasibilityOf(runWith({ head, wallets: 0 }), { trade: t, ...FEES });
  assert.equal(feas.feasible, false);
  assert.equal(feas.reason, 'no-wallets');
  assert.equal(feas.graduationRisk, true);
});

// ── _private.resolveRun — the readCurve dusting/provenance gate ──

const BODY = {
  token: TOKEN,
  bigBuyEth: '5',
  targets: [{ walletId: 'w1' }, { walletId: 'w2' }],
  intervalMs: 7000,
  jitterPct: 0,
  variancePct: 30,
  confirm: true,
};

function harness({
  wallets = [TREASURY, MAIN, W1, W2],
  readCurve,
  state = 0,
  circulatingSupply = TOKENS(200_000),
  dexSupplyThresh = TOKENS(1_000_000),
  headroomTokens,
  mainEth = parseEther('50'),
  buyOut = TOKENS(400_000),
  sellOut = parseEther('4.5'),
  sellReverts = false,
  ethUsd = 4000,
} = {}) {
  const head = headroomTokens != null ? headroomTokens : dexSupplyThresh > circulatingSupply ? dexSupplyThresh - circulatingSupply : 0n;
  return {
    keystore: {
      walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
      walletsWithRole: (r) => wallets.filter((w) => w.role === r),
      ownedAddresses: () => wallets.map((w) => w.address),
    },
    trade: {
      readCurve:
        readCurve ||
        (async () => ({
          token: getAddress(TOKEN),
          quote: 'eth',
          venue: LAUNCHER,
          state,
          circulatingSupply,
          dexSupplyThresh,
          headroomTokens: head,
        })),
      quoteBuyOut: async () => buyOut,
      quoteSellOut: sellReverts ? revertingSell : async () => sellOut,
    },
    rpc: { getBalance: async () => mainEth },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    ethPriceUsd: async () => ({ usd: ethUsd, source: 'fake', at: 0 }),
  };
}

const resolve = (h, body = BODY) => v7.resolveRun(body, h.keystore, h);

test('resolveRun resolves a good request into what the engine needs (venue, not pool/hook)', async () => {
  const h = harness();
  const out = await resolve(h);
  assert.equal(out.token, getAddress(TOKEN));
  assert.equal(out.pool.venue, LAUNCHER);
  assert.equal(out.pool.state, 0);
  assert.equal(out.bigBuyWei, parseEther('5'));
  assert.equal(out.main.id, 'main');
  assert.deepEqual(
    out.targets.map((t) => [t.walletId, t.address]),
    [
      ['w1', W1.address],
      ['w2', W2.address],
    ]
  );
  assert.ok(!('buyWei' in out.targets[0]));
  // No per-token pool identity survives — the venue is the fixed launcher.
  assert.ok(!('poolId' in out.pool));
  assert.ok(!('hook' in out.pool));
});

test('resolveRun refuses a token readCurve rejects (the dusting / provenance guard)', async () => {
  const h = harness({
    readCurve: async () => {
      throw new Error(`${getAddress(TOKEN)} is not a flap launch — code is not an EIP-1167 clone`);
    },
  });
  await assert.rejects(() => resolve(h), /not a flap launch/);
});

test('resolveRun ALLOWS buySlippageBps 0 (the flap curve permits a strictly-guaranteed buy; v6 forced > 0)', async () => {
  const h = harness();
  const out = await resolve(h, { ...BODY, buySlippageBps: 0 });
  assert.equal(out.buySlippageBps, 0);
});

test('resolveRun defaults buySlippageBps when the body omits it', async () => {
  const h = harness();
  const out = await resolve(h);
  assert.equal(out.buySlippageBps, trade.DEFAULT_BUY_SLIPPAGE_BPS);
});

test('resolveRun refuses when there is no main wallet', async () => {
  const h = harness({ wallets: [TREASURY, W1, W2] });
  await assert.rejects(() => resolve(h), /v7main/);
});

test('resolveRun refuses when there are no bundle wallets', async () => {
  const h = harness({ wallets: [TREASURY, MAIN] });
  await assert.rejects(() => resolve(h), /bundle wallet/);
});

test('resolveRun refuses a target that is not a v7 bundle wallet', async () => {
  const h = harness();
  await assert.rejects(() => resolve(h, { ...BODY, targets: [{ walletId: 'nope' }] }), /not a v7 bundle wallet/);
});

test('resolveRun refuses when the main wallet cannot cover the big buy and its gas', async () => {
  const h = harness({ mainEth: parseEther('1') });
  await assert.rejects(() => resolve(h), /has 1\.0 ETH/);
});

test('resolveRun refuses a non-positive big buy', async () => {
  const h = harness();
  await assert.rejects(() => resolve(h, { ...BODY, bigBuyEth: '0' }), /big buy/);
});

test('resolveRun defaults to every bundle wallet when targets are omitted', async () => {
  const h = harness();
  const out = await resolve(h, { ...BODY, targets: undefined });
  assert.deepEqual(
    out.targets.map((t) => t.walletId),
    ['w1', 'w2']
  );
});

// ── _private.buildPlan — venue + graduation ──

const plan = (h, body = BODY) => v7.buildPlan(body, h.keystore, h);

test('buildPlan reports the flap venue, the curve state and the graduation position', async () => {
  const h = harness();
  const p = await plan(h);
  assert.equal(p.protocol, 'v7');
  assert.equal(p.venue, LAUNCHER);
  assert.equal(p.curveState, 0);
  // The graduation block v6 never had.
  assert.equal(p.graduation.maxHeadroomFrac, MAX_FRAC);
  assert.equal(p.graduation.pctSold, 20); // 200k circulating of a 1,000k threshold
  assert.equal(p.graduation.headroomTokensRaw, TOKENS(800_000).toString());
  assert.equal(p.graduation.dexSupplyThresh, '1000000.0');
  // None of v6's pool/hook/poolTax/sellsRevert fields leak into the v7 plan.
  assert.ok(!('poolId' in p));
  assert.ok(!('hook' in p));
  assert.ok(!('poolTax' in p));
  assert.ok(!('sellsRevert' in p));
});

test('buildPlan flags graduationRisk as a HARD, blocking condition with a warning', async () => {
  const h = harness({ circulatingSupply: 0n, dexSupplyThresh: TOKENS(1_000_000), buyOut: TOKENS(900_000) });
  const p = await plan(h);
  assert.equal(p.graduationRisk, true);
  assert.match(p.warnings.join(' '), /GRADUATE OR SATURATE/i);
});

test('buildPlan makes a reverting sell quote a SOFT pricingEstimated, not a block', async () => {
  const h = harness({ sellReverts: true });
  const p = await plan(h);
  assert.equal(p.pricingEstimated, true);
  assert.equal(p.graduationRisk, false);
  assert.equal(p.position.eth, '5.0', 'the position falls back to roughly the ETH put in');
  assert.match(p.warnings.join(' '), /could not price the sell/i);
  assert.match(p.warnings.join(' '), /rough estimate/i);
});

test('buildPlan estimates the position after the round trip, not the big buy', async () => {
  const h = harness();
  const p = await plan(h);
  assert.ok(Number(p.position.eth) > 0);
  assert.ok(Number(p.position.eth) < 5, 'the round trip cannot come back whole');
  assert.ok(p.position.bleedPct > 0);
  assert.match(p.warnings.join(' '), /price impact/i);
});

test('buildPlan always states the sells have no slippage floor', async () => {
  const h = harness();
  const p = await plan(h);
  assert.match(p.warnings.join(' '), /no slippage floor/i);
});

test('buildPlan notes when buySlippageBps 0 makes the buy strictly guaranteed', async () => {
  const h = harness();
  const p = await plan(h, { ...BODY, buySlippageBps: 0 });
  assert.equal(p.buySlippageBps, 0);
  assert.match(p.warnings.join(' '), /strictly-guaranteed buy/i);
});

test('buildPlan prices everything in dollars when a rate is available', async () => {
  const h = harness();
  const p = await plan(h);
  assert.equal(p.ethUsd, 4000);
  assert.equal(p.bigBuyUsd, '20000.00');
  assert.equal(p.estimatedRunMs, 7000 * 2);
});

// ── the START route HARD-refuses a graduating big buy (no force bypass) ──
//
// The chain/start handler uses the REAL modules (it takes no injected deps), so
// these tests drive the actual handler pulled off the router's stack against a
// real temp-dir keystore, shadowing the object methods the handler looks up at
// call time: trade.readCurve/quoteBuyOut/quoteSellOut and the provider's
// getBalance/getFeeData. This exercises the flap-specific hard gate end to end.

function findRouteHandler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method.toUpperCase()} ${routePath}`);
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

// Shadow one method, returning a restore fn that unshadows cleanly whether or not
// it was an own property (provider methods live on the prototype).
function shadow(obj, key, val) {
  const hadOwn = Object.prototype.hasOwnProperty.call(obj, key);
  const orig = obj[key];
  obj[key] = val;
  return () => {
    if (hadOwn) obj[key] = orig;
    else delete obj[key];
  };
}

function seedWallets(userId) {
  const ks = keystoreFor(userId);
  ks.generate(1, { role: 'v7dev', label: 'treasury' });
  ks.generate(1, { role: 'v7main', label: 'main' });
  ks.generate(2, { role: 'v7bundle', label: 'bundle' });
  return ks;
}

const CURVE_NEAR_GRAD = async () => ({
  token: getAddress(TOKEN),
  quote: 'eth',
  venue: LAUNCHER,
  state: 0,
  circulatingSupply: TOKENS(50_000),
  dexSupplyThresh: TOKENS(1_050_000),
  headroomTokens: TOKENS(1_000_000), // cap = 800k tokens
});

const GOOD_FEES = async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });

test('POST /v7/chain/start HARD-refuses a graduating big buy — force:true does NOT bypass it', async () => {
  const userId = 'v7-start-grad';
  seedWallets(userId);

  const restores = [
    shadow(trade, 'readCurve', CURVE_NEAR_GRAD),
    shadow(trade, 'quoteBuyOut', async () => TOKENS(950_000)), // >= 800k cap
    shadow(trade, 'quoteSellOut', async () => parseEther('4')),
    shadow(provider, 'getBalance', async () => parseEther('1000')),
    shadow(provider, 'getFeeData', GOOD_FEES),
  ];
  try {
    const handler = findRouteHandler('post', '/v7/chain/start');
    const req = { user: { id: userId }, body: { token: TOKEN, bigBuyEth: '5', confirm: true, force: true } };
    const res = fakeRes();
    let caught = null;
    await handler(req, res, (err) => {
      caught = err;
    });

    assert.ok(caught, 'the start route must refuse via next(err)');
    assert.match(caught.message, /refusing to start/i);
    assert.match(caught.message, /graduate|saturate/i);
    // The refusal is BEFORE engine.start — nothing was launched, force or not.
    assert.equal(engine.isRunning(userId), false);
  } finally {
    restores.forEach((r) => r());
  }
});

test('POST /v7/chain/start clears the graduation gate for a below-cap buy and reaches engine.start', async () => {
  const userId = 'v7-start-ok';
  seedWallets(userId);

  let startedWith = null;
  const restores = [
    shadow(trade, 'readCurve', CURVE_NEAR_GRAD),
    shadow(trade, 'quoteBuyOut', async () => TOKENS(100_000)), // well below the 800k cap
    shadow(trade, 'quoteSellOut', async () => parseEther('4.5')),
    shadow(provider, 'getBalance', async () => parseEther('1000')),
    shadow(provider, 'getFeeData', GOOD_FEES),
    shadow(engine, 'start', async (uid, input) => {
      startedWith = { uid, input };
      return { id: 'job1', status: 'running', running: true, token: input.token, venue: input.pool.venue };
    }),
  ];
  try {
    const handler = findRouteHandler('post', '/v7/chain/start');
    const req = { user: { id: userId }, body: { token: TOKEN, bigBuyEth: '5', confirm: true, force: true } };
    const res = fakeRes();
    let caught = null;
    await handler(req, res, (err) => {
      caught = err;
    });

    assert.equal(caught, null, caught && caught.message);
    assert.ok(startedWith, 'engine.start must be reached once the graduation gate passes');
    assert.equal(startedWith.uid, userId);
    assert.equal(startedWith.input.pool.venue, LAUNCHER);
    assert.equal(res.body.venue, LAUNCHER);
  } finally {
    restores.forEach((r) => r());
  }
});

test('POST /v7/chain/start refuses without { confirm: true }', async () => {
  const handler = findRouteHandler('post', '/v7/chain/start');
  const req = { user: { id: 'v7-start-noconfirm' }, body: { token: TOKEN, bigBuyEth: '5' } };
  const res = fakeRes();
  let caught = null;
  await handler(req, res, (err) => {
    caught = err;
  });
  assert.ok(caught);
  assert.match(caught.message, /confirm: true/);
});

// ── the shared local helpers ──

test('jsonSafe turns every BigInt into a string, at any depth', () => {
  const out = v7.jsonSafe({ a: 1n, b: [2n, { c: 3n }], d: 'x' });
  assert.deepEqual(out, { a: '1', b: ['2', { c: '3' }], d: 'x' });
  assert.ok(JSON.stringify(out));
});

test('parseAmount refuses what is not a number', () => {
  assert.throws(() => v7.parseAmount('abc', 'buy'), /buy/);
  assert.throws(() => v7.parseAmount('', 'buy'), /buy/);
  assert.equal(v7.parseAmount('1.5', 'buy'), parseEther('1.5'));
});

// ── _private.selectBackupWallets — the OPTIONAL role / walletIds backup filter ──
// The list handed in is already gated to V7's own roles; these check that a
// filter only ever NARROWS it, and that an absent filter is a no-op (the plain
// "Download backup" must stay byte-identical).
const V7_WALLETS = [
  { id: 'a', role: 'v7dev', address: '0xdev' },
  { id: 'b', role: 'v7main', address: '0xmain' },
  { id: 'c', role: 'v7bundle', address: '0xb1' },
  { id: 'd', role: 'v7bundle', address: '0xb2' },
];

test('selectBackupWallets with no filter returns the whole list unchanged', () => {
  assert.deepEqual(v7.selectBackupWallets(V7_WALLETS, {}), V7_WALLETS);
  assert.deepEqual(v7.selectBackupWallets(V7_WALLETS, { walletIds: [] }), V7_WALLETS, 'an empty id array is not a filter');
});

test('selectBackupWallets walletIds keeps exactly the named wallets', () => {
  assert.deepEqual(
    v7.selectBackupWallets(V7_WALLETS, { walletIds: ['c', 'd'] }).map((w) => w.id),
    ['c', 'd']
  );
});

test('selectBackupWallets walletIds coerces ids to strings and ignores ids V7 does not own', () => {
  assert.deepEqual(
    v7.selectBackupWallets([{ id: '5', role: 'v7bundle' }], { walletIds: [5] }).map((w) => w.id),
    ['5'],
    'a numeric id matches its string id'
  );
  assert.deepEqual(v7.selectBackupWallets(V7_WALLETS, { walletIds: ['zzz'] }), [], 'an unknown id matches nothing');
});

test('selectBackupWallets role keeps only that V7 role', () => {
  assert.deepEqual(v7.selectBackupWallets(V7_WALLETS, { role: 'v7bundle' }).map((w) => w.id), ['c', 'd']);
  assert.deepEqual(v7.selectBackupWallets(V7_WALLETS, { role: 'v7dev' }).map((w) => w.id), ['a']);
});

test('selectBackupWallets role and walletIds combine as an intersection', () => {
  assert.deepEqual(
    v7.selectBackupWallets(V7_WALLETS, { role: 'v7bundle', walletIds: ['c'] }).map((w) => w.id),
    ['c']
  );
});

test('selectBackupWallets ignores an unknown or foreign role (never widens the set)', () => {
  assert.deepEqual(v7.selectBackupWallets(V7_WALLETS, { role: 'nope' }), V7_WALLETS, 'an unknown role is not a filter');
  assert.deepEqual(v7.selectBackupWallets(V7_WALLETS, { role: 'v6bundle' }), V7_WALLETS, "another tab's role is not V7's");
});

// Keep the linter from flagging the imported formatEther if a future edit drops
// its only use; it documents the wei→eth intent of the ETH assertions above.
void formatEther;
