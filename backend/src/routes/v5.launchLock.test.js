'use strict';

// The v5 (letscash) launch guards — the fund-safety pair the review demanded:
//
//  1. the in-FLIGHT guard. When a launch is broadcast but its receipt never
//     arrives (status 'pending'), the wallet is PARKED: a second launch would
//     sign at the next nonce and spend a second fee + first buy alongside the one
//     still in the mempool. So a parked wallet is refused until it is resolved.
//  2. launchActivityDetail HONESTY. token/poolId are persisted as real ONLY when
//     the launch confirmed; a reverted/pending launch persists null, and a null
//     hook on a confirmed record announces itself via hookResolved:false.

const test = require('node:test');
const assert = require('node:assert');

const v5 = require('./v5');
const { withLaunchLock, pendingLaunches, launchActivityDetail } = v5;

function res() {
  return {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

test('the concurrent-handler guard refuses an overlapping launch (same account)', async () => {
  pendingLaunches.clear();
  let release;
  const gate = new Promise((r) => (release = r));
  const req = { user: { id: 'alice' } };
  const first = withLaunchLock(async () => {
    await gate;
  })(req, res(), () => {});

  const r2 = res();
  await withLaunchLock(async () => {
    throw new Error('the blocked request must not run');
  })(req, r2, () => {});
  assert.equal(r2.statusCode, 409);
  assert.match(r2.body.error, /already in progress/);

  release();
  await first;
});

test('a PARKED (in-flight, unconfirmed) wallet refuses a fresh launch until resolved', async () => {
  pendingLaunches.clear();
  const req = { user: { id: 'bob' } };
  // Simulate the state fireLaunch's 'pending' outcome leaves behind.
  pendingLaunches.set('bob', { hash: '0xdead', nonce: 4, address: '0xB0B', symbol: 'CAT' });

  const r = res();
  let ran = false;
  await withLaunchLock(async () => {
    ran = true;
  })(req, r, () => {});

  assert.equal(ran, false, 'a fresh launch must NOT run while a prior one is unconfirmed');
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /never confirmed/);
  assert.equal(r.body.pending.hash, '0xdead', 'the refusal surfaces the in-flight hash to resolve');
  assert.match(r.body.resolve, /resolve/);

  pendingLaunches.clear();
});

test('a parked wallet does not block a DIFFERENT account', async () => {
  pendingLaunches.clear();
  pendingLaunches.set('bob', { hash: '0xdead' });
  let carolRan = false;
  await withLaunchLock(async () => {
    carolRan = true;
  })({ user: { id: 'carol' } }, res(), () => {});
  assert.equal(carolRan, true, 'carol has no in-flight launch, so she is not parked');
  pendingLaunches.clear();
});

// ── launchActivityDetail honesty ──────────────────────────────────────────────
const plan = {
  quote: '0x0000000000000000000000000000000000000000',
  configId: 1000,
  launch: { firstBuyEth: '0.1' },
};

test('a CONFIRMED launch persists the real token/poolId/hook', () => {
  const detail = launchActivityDetail(
    {
      token: '0xToKeN',
      poolId: '0xP00L',
      hook: '0xH00K',
      firstBuyOut: '123',
      launch: { status: 'confirmed', hash: '0xH', blockNumber: 9 },
    },
    plan
  );
  assert.equal(detail.token, '0xToKeN');
  assert.equal(detail.poolId, '0xP00L');
  assert.equal(detail.hook, '0xH00K');
  assert.equal(detail.hookResolved, true);
  assert.equal(detail.status, 'confirmed');
});

test('a REVERTED launch persists null token/poolId — never a phantom pool', () => {
  const detail = launchActivityDetail(
    {
      token: '0xPREDICTED', // the breadcrumb fireLaunch carries — must NOT be persisted as real
      poolId: '0xPREDICTED_POOL',
      hook: null,
      launch: { status: 'reverted', hash: '0xH', blockNumber: 9 },
    },
    plan
  );
  assert.equal(detail.token, null, 'a reverted launch created no token');
  assert.equal(detail.poolId, null, 'a reverted launch has no pool');
  assert.equal(detail.hook, null);
  assert.equal(detail.hookResolved, false);
  assert.equal(detail.status, 'reverted');
});

test('a PENDING launch persists null token/poolId (it may never mine)', () => {
  const detail = launchActivityDetail(
    { token: '0xPREDICTED', poolId: '0xPREDICTED_POOL', hook: null, launch: { status: 'pending', hash: '0xH', blockNumber: null } },
    plan
  );
  assert.equal(detail.token, null);
  assert.equal(detail.poolId, null);
  assert.equal(detail.status, 'pending');
});

test('a confirmed launch with an unresolved hook flags hookResolved:false and carries the warning', () => {
  const detail = launchActivityDetail(
    {
      token: '0xToKeN',
      poolId: '0xP00L',
      hook: null,
      hookResolved: false,
      warning: 'the launch confirmed but no TokenLaunched event was decoded',
      launch: { status: 'confirmed', hash: '0xH', blockNumber: 9 },
    },
    plan
  );
  assert.equal(detail.token, '0xToKeN', 'the token was cross-checked before signing — it is real');
  assert.equal(detail.hook, null);
  assert.equal(detail.hookResolved, false, 'so a reader never mistakes null for "ETH pool / config default"');
  assert.match(detail.warning, /no TokenLaunched/);
});

test('a mismatch/poolId-suspect launch carries the warning into the record', () => {
  const detail = launchActivityDetail(
    {
      token: '0xToKeN',
      poolId: '0xP00L',
      hook: '0xH00K',
      mismatch: 'launch created token X, but preflight predicted Y',
      launch: { status: 'confirmed', hash: '0xH', blockNumber: 9 },
    },
    plan
  );
  assert.match(detail.mismatch, /preflight predicted/, 'the suspicion travels with the pool identity');
});
