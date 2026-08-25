'use strict';

// The v5 bundle fan-out ROUTE guards — the surface the fund-safety review flagged
// as untested: the SIGNED-raw strip (the one irreversible leak here), the
// {confirm:true} gate on the money path, the lock composition with the launch on
// the shared launcher wallet, and the token PIN to the operator's own launches.

const test = require('node:test');
const assert = require('node:assert');

const v5 = require('./v5');
const { withBundleLock, withLaunchLock, bundling, pendingLaunches, publicBundlePlan, assertOwnLaunchedToken } = v5;

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

// ── publicBundlePlan strips every signed raw ──────────────────────────────────
test('publicBundlePlan strips the signed raw from every transfer', () => {
  const plan = {
    protocol: 'v5',
    kind: 'bundle',
    token: '0xToKeN',
    symbol: 'CAT',
    transfers: [
      { walletId: 'b1', to: '0xA', amount: '250', raw: '0xSIGNED_SECRET_1' },
      { walletId: 'b2', to: '0xB', amount: '250', raw: '0xSIGNED_SECRET_2' },
    ],
  };
  const pub = publicBundlePlan(plan);
  const serialized = JSON.stringify(pub);
  assert.equal(serialized.includes('SIGNED_SECRET'), false, 'no signed raw may reach the client');
  for (const t of pub.transfers) assert.equal(t.raw, undefined, 'every transfer raw is stripped');
  // the safe fields survive
  assert.equal(pub.transfers[0].amount, '250');
  assert.equal(pub.transfers[0].walletId, 'b1');
});

// ── withBundleLock composes with itself and the launch guards ─────────────────
test('a second concurrent bundle for the same account is refused', async () => {
  bundling.clear();
  pendingLaunches.clear();
  let release;
  const gate = new Promise((r) => (release = r));
  const req = { user: { id: 'alice' } };
  const first = withBundleLock(async () => {
    await gate;
  })(req, res(), () => {});

  const r2 = res();
  await withBundleLock(async () => {
    throw new Error('the blocked bundle must not run');
  })(req, r2, () => {});
  assert.equal(r2.statusCode, 409);
  assert.match(r2.body.error, /already in progress/);

  release();
  await first;
});

test('a bundle is refused while a launch is parked-unconfirmed on the same wallet', async () => {
  bundling.clear();
  pendingLaunches.clear();
  pendingLaunches.set('bob', { hash: '0xdead' }); // a launch left unresolved

  const r = res();
  let ran = false;
  await withBundleLock(async () => {
    ran = true;
  })({ user: { id: 'bob' } }, r, () => {});
  assert.equal(ran, false, 'the launcher is not settled — no fan-out');
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /launch is in progress or unresolved/);
  pendingLaunches.clear();
});

test('a launch is refused while a bundle is in progress on the same wallet', async () => {
  bundling.clear();
  pendingLaunches.clear();
  bundling.add('carol'); // a bundle mid-flight

  const r = res();
  let ran = false;
  await withLaunchLock(async () => {
    ran = true;
  })({ user: { id: 'carol' } }, r, () => {});
  assert.equal(ran, false, 'a launch must not sign against a wallet a bundle is spending');
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /bundle fan-out is in progress/);
  bundling.clear();
});

// ── assertOwnLaunchedToken pins the token to the operator's own launches ──────
// A throwaway activity store keyed off the real one would touch disk; instead we
// exercise the pure guard against a user with no v5 activity (nothing launched),
// which must refuse any token, and the explicit override, which must allow it.
test('the token pin refuses a token this account never launched', () => {
  // A user id that has no v5 activity records → no launched tokens → refuse.
  assert.throws(
    () => assertOwnLaunchedToken('nobody-has-launched-here', '0xArbitraryToken', false),
    /not among this account's launched/
  );
});

test('the token pin honours the explicit allowUnlistedToken escape hatch', () => {
  assert.doesNotThrow(() => assertOwnLaunchedToken('nobody-has-launched-here', '0xArbitraryToken', true));
});
