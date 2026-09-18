'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Interface, Wallet } = require('ethers');

const {
  LIMITS,
  clientIp,
  tokenBuckets,
  rateLimit,
  broadcastCost,
  txSelector,
  createStreamSlots,
  streamSlots,
} = require('./limits');
const { TpError } = require('./errors');
const C = require('./constants');

function clock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test('defaults: 120 reads/min, 600 sell tx/min, 300 approval tx/min, 5 streams', () => {
  if (!process.env.TP_READS_PER_MIN) assert.equal(LIMITS.readsPerMin, 120);
  if (!process.env.TP_BROADCAST_TX_PER_MIN) assert.equal(LIMITS.broadcastTxPerMin, 600);
  if (!process.env.TP_APPROVE_TX_PER_MIN) assert.equal(LIMITS.approveTxPerMin, 300);
  if (!process.env.TP_STREAMS_PER_IP) assert.equal(LIMITS.streamsPerIp, 5);
});

test('a bucket allows a burst of max, then refills one token per window/max', () => {
  const now = clock();
  const b = tokenBuckets({ windowMs: 60_000, max: 3, now });
  assert.deepEqual(b.take('a'), { ok: true, remaining: 2 });
  assert.deepEqual(b.take('a'), { ok: true, remaining: 1 });
  assert.deepEqual(b.take('a'), { ok: true, remaining: 0 });
  assert.deepEqual(b.take('a'), { ok: false, retryAfterMs: 20_000 });
  now.advance(19_999);
  assert.deepEqual(b.take('a'), { ok: false, retryAfterMs: 1 });
  now.advance(1);
  assert.equal(b.take('a').ok, true);
  assert.equal(b.take('a').ok, false);
});

test('buckets are per key', () => {
  const b = tokenBuckets({ windowMs: 60_000, max: 1, now: clock() });
  assert.equal(b.take('1.1.1.1').ok, true);
  assert.equal(b.take('1.1.1.1').ok, false);
  assert.equal(b.take('2.2.2.2').ok, true);
});

test('a cost spends several tokens at once, and is clamped to the capacity', () => {
  const now = clock();
  const b = tokenBuckets({ windowMs: 60_000, max: 300, now });
  assert.equal(b.take('ip', 100).ok, true);
  assert.equal(b.take('ip', 200).ok, true);
  assert.equal(b.take('ip', 1).ok, false);
  now.advance(60_000); // a full window refills the whole bucket
  assert.equal(b.take('ip', 5000).ok, true, 'a cost above max is charged as max');
  assert.equal(b.take('ip', 1).ok, false);
});

test('a bucket never holds more than max, however long it idles', () => {
  const now = clock();
  const b = tokenBuckets({ windowMs: 60_000, max: 2, now });
  b.take('k');
  now.advance(10 * 60_000);
  assert.equal(b.take('k').ok, true);
  assert.equal(b.take('k').ok, true);
  assert.equal(b.take('k').ok, false);
});

test('idle keys are pruned once maxKeys is exceeded', () => {
  const now = clock();
  const b = tokenBuckets({ windowMs: 1000, max: 1, now, maxKeys: 10 });
  for (let i = 0; i < 10; i++) b.take(`ip${i}`);
  now.advance(1000); // every bucket is full again
  b.take('fresh');
  assert.equal(b.size(), 1);
});

test('the bucket rejects a nonsense configuration', () => {
  assert.throws(() => tokenBuckets({ windowMs: 0, max: 1 }), /positive/);
  assert.throws(() => tokenBuckets({ windowMs: 1000, max: 0 }), /positive/);
});

test('peek answers exactly like take, without spending anything', () => {
  const b = tokenBuckets({ windowMs: 60_000, max: 2, now: clock() });
  assert.deepEqual(b.peek('k', 2), { ok: true, remaining: 0 });
  assert.equal(b.size(), 0, 'a peek leaves no trace');
  assert.deepEqual(b.take('k', 2), { ok: true, remaining: 0 });
  assert.deepEqual(b.peek('k'), { ok: false, retryAfterMs: 30_000 });
  assert.deepEqual(b.take('k'), { ok: false, retryAfterMs: 30_000 });
});

function fakeRes() {
  return {
    headers: {},
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
  };
}

function run(mw, req) {
  const res = fakeRes();
  let passed = null;
  mw(req, res, (err) => {
    passed = err || 'next';
  });
  return { res, passed };
}

test('rateLimit middleware: next() while allowed, then a 429 TpError with Retry-After', () => {
  const now = clock();
  const mw = rateLimit({ windowMs: 60_000, max: 2, now });
  const req = { socket: { remoteAddress: '203.0.113.7' }, headers: {} };
  assert.equal(run(mw, req).passed, 'next');
  assert.equal(run(mw, req).passed, 'next');
  const { res, passed } = run(mw, req);
  assert.ok(passed instanceof TpError);
  assert.equal(passed.code, 'rate_limited');
  assert.equal(passed.status, 429);
  assert.equal(res.headers['retry-after'], '30');
});

test('rateLimit charges cost(req) — a broadcast pays per transaction', () => {
  const mw = rateLimit({
    windowMs: 60_000,
    max: 300,
    now: clock(),
    cost: (req) => req.body.txs.length,
  });
  const req = (n) => ({ socket: { remoteAddress: '203.0.113.8' }, headers: {}, body: { txs: new Array(n).fill('0x') } });
  assert.equal(run(mw, req(100)).passed, 'next');
  assert.equal(run(mw, req(100)).passed, 'next');
  assert.equal(run(mw, req(100)).passed, 'next');
  assert.ok(run(mw, req(1)).passed instanceof TpError);
});

test('named buckets: approvals never spend the sell budget', () => {
  const mw = rateLimit({ windowMs: 60_000, max: { send: 600, approve: 300 }, now: clock(), cost: (req) => req.cost });
  const req = (cost) => ({ socket: { remoteAddress: '203.0.113.20' }, headers: {}, cost });
  // arming 100 wallets on a graduated token (200 approvals) + 100 pair-token approvals
  for (let i = 0; i < 3; i++) assert.equal(run(mw, req({ approve: 100 })).passed, 'next', `arm batch ${i + 1}`);
  const armRefused = run(mw, req({ approve: 1 }));
  assert.ok(armRefused.passed instanceof TpError);
  assert.equal(armRefused.passed.code, 'rate_limited');
  assert.equal(armRefused.res.headers['retry-after'], '1');
  // … and the same visitor still has the WHOLE sell budget: six 100-wallet clicks
  for (let i = 0; i < 6; i++) assert.equal(run(mw, req({ send: 100 })).passed, 'next', `sell click ${i + 1}`);
  assert.ok(run(mw, req({ send: 1 })).passed instanceof TpError);
});

test('named buckets: a request is charged all-or-nothing', () => {
  const mw = rateLimit({ windowMs: 60_000, max: { send: 10, approve: 2 }, now: clock(), cost: (req) => req.cost });
  const req = (cost) => ({ socket: { remoteAddress: '203.0.113.21' }, headers: {}, cost });
  assert.equal(run(mw, req({ approve: 2 })).passed, 'next');
  // the approve bucket is empty: a mixed request is refused whole, its sells NOT charged
  assert.ok(run(mw, req({ send: 5, approve: 1 })).passed instanceof TpError);
  assert.equal(run(mw, req({ send: 10 })).passed, 'next', 'the refused request spent nothing');
  assert.ok(run(mw, req({ send: 1 })).passed instanceof TpError);
});

test('named buckets: a request that charges nothing costs one token of the first bucket', () => {
  const mw = rateLimit({ windowMs: 60_000, max: { send: 1, approve: 5 }, now: clock(), cost: () => ({ send: 0 }) });
  const req = { socket: { remoteAddress: '203.0.113.22' }, headers: {} };
  assert.equal(run(mw, req).passed, 'next');
  assert.ok(run(mw, req).passed instanceof TpError);
});

test('rateLimit refuses a nonsense max', () => {
  assert.throws(() => rateLimit({ windowMs: 1000, max: {} }), /max must be/);
  assert.throws(() => rateLimit({ windowMs: 1000 }), /max must be/);
  assert.throws(() => rateLimit({ windowMs: 1000, max: { send: 0 } }), /positive/);
});

// Signed offline with a throwaway key: nothing here touches a chain.
function signed(to, data) {
  return Wallet.createRandom().signTransaction({
    type: 2,
    chainId: 4663,
    nonce: 0,
    to,
    data,
    value: 0n,
    gasLimit: 200_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 0n,
  });
}

test('broadcastCost: ERC-20 and Permit2 approvals go to their own bucket, everything else to send', async () => {
  const token = `0x${'11'.repeat(20)}`;
  const curve = `0x${'22'.repeat(20)}`;
  const approve = await signed(token, new Interface(C.ABI.ERC20).encodeFunctionData('approve', [C.PERMIT2, 2n ** 256n - 1n]));
  const permit2 = await signed(
    C.PERMIT2,
    new Interface(C.ABI.PERMIT2).encodeFunctionData('approve', [token, C.UNIVERSAL_ROUTER, 2n ** 160n - 1n, 2n ** 48n - 1n])
  );
  const sell = await signed(curve, new Interface(C.ABI.CURVE).encodeFunctionData('sell', [10n ** 18n, 1n, `0x${'33'.repeat(20)}`]));

  // a legacy (type 0) approval: the dApp never signs one, so it is not classified
  const legacy = await Wallet.createRandom().signTransaction({
    type: 0,
    chainId: 4663,
    nonce: 0,
    to: token,
    data: new Interface(C.ABI.ERC20).encodeFunctionData('approve', [C.PERMIT2, 1n]),
    gasLimit: 100_000n,
    gasPrice: 1n,
  });

  assert.equal(txSelector(approve), '0x095ea7b3');
  assert.equal(txSelector(permit2), '0x87517c45');
  assert.equal(txSelector(sell), '0xd04c6983');
  assert.equal(txSelector(legacy), null);

  const body = (txs) => ({ body: { token, txs } });
  assert.deepEqual(broadcastCost(body([approve, permit2, sell])), { send: 1, approve: 2 });
  assert.deepEqual(broadcastCost(body(new Array(100).fill(approve))), { send: 0, approve: 100 });
  assert.deepEqual(broadcastCost(body(new Array(100).fill(sell))), { send: 100, approve: 0 });
  // not a transaction, not a string, a truncated approval, a legacy approval: the sell
  // bucket, never "approve" — a malformed raw cannot pass itself off as an approval
  assert.deepEqual(broadcastCost(body(['0x00', 42, null, approve.slice(0, 40), legacy])), { send: 5, approve: 0 });
  // no list at all: one sell-bucket token (the validator answers bad_request)
  assert.deepEqual(broadcastCost(body([])), { send: 1 });
  assert.deepEqual(broadcastCost({}), { send: 1 });
  assert.deepEqual(broadcastCost({ body: { txs: 'nope' } }), { send: 1 });
  // more than one request may carry is charged by count and never parsed (validator: too_many)
  assert.deepEqual(broadcastCost(body(new Array(101).fill(approve))), { send: 101 });
});

test('clientIp trusts X-Real-IP only from a loopback peer (our nginx)', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '198.51.100.4' } }), '198.51.100.4');
  assert.equal(clientIp({ socket: { remoteAddress: '::1' }, headers: { 'x-real-ip': ' 198.51.100.5 ' } }), '198.51.100.5');
  assert.equal(
    clientIp({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-real-ip': '198.51.100.6' } }),
    '198.51.100.6'
  );
  // a direct (non-loopback) client cannot pick its own bucket
  assert.equal(clientIp({ socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-real-ip': '1.2.3.4' } }), '203.0.113.9');
  // loopback with no header (local dev, the fork run) is the peer itself
  assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), '127.0.0.1');
});

test('stream slots: 5 per IP, released one at a time', () => {
  const slots = createStreamSlots({ perIp: 5 });
  for (let i = 0; i < 5; i++) assert.equal(slots.acquire('ip'), true);
  assert.equal(slots.acquire('ip'), false);
  assert.equal(slots.acquire('other'), true);
  slots.release('ip');
  assert.equal(slots.count('ip'), 4);
  assert.equal(slots.acquire('ip'), true);
  for (let i = 0; i < 10; i++) slots.release('ip'); // over-release never goes negative
  assert.equal(slots.count('ip'), 0);
  assert.equal(typeof streamSlots.acquire, 'function');
  assert.equal(typeof streamSlots.release, 'function');
});
