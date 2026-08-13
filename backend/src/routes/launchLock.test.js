'use strict';

// The per-account launch lock: a second launch while one is in flight must be
// refused, not raced. Two overlapping launches would sign two transactions
// against the same dev-wallet nonce and can strand the losing one's buys.

const test = require('node:test');
const assert = require('node:assert');
const { withLaunchLock } = require('./launch');

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

test('a second launch for the same account while one is in flight is refused', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = withLaunchLock(async () => {
    await gate; // hold the lock open
  });

  const req = { user: { id: 'alice' } };
  const r1 = res();
  const first = slow(req, r1, () => {});
  // Second call arrives while the first still holds the lock.
  const r2 = res();
  await withLaunchLock(async () => {
    throw new Error('handler should not run for the blocked request');
  })(req, r2, () => {});

  assert.equal(r2.statusCode, 409);
  assert.match(r2.body.error, /already in progress/);

  release();
  await first;
});

test('a different account is not blocked', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const req = { user: { id: 'alice' } };
  const first = withLaunchLock(async () => {
    await gate;
  })(req, res(), () => {});

  let bobRan = false;
  await withLaunchLock(async () => {
    bobRan = true;
  })({ user: { id: 'bob' } }, res(), () => {});
  assert.equal(bobRan, true, 'bob must not be blocked by alice');

  release();
  await first;
});

test('the lock is released after the launch finishes (even on error)', async () => {
  const req = { user: { id: 'carol' } };
  await withLaunchLock(async () => {
    throw new Error('boom');
  })(req, res(), () => {}).catch(() => {});

  // A subsequent launch for the same account must now be allowed through.
  let ran = false;
  await withLaunchLock(async () => {
    ran = true;
  })(req, res(), () => {});
  assert.equal(ran, true, 'the lock must release even when the handler throws');
});
