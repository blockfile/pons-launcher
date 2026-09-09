'use strict';

// THE PACING THE CONSOLE PRICES A PRESS WITH, tested at the route it arrives on.
//
// The untimed v2 Relay funding run quotes EVERY wallet before it sends ANY
// deposit, so its request stays open for roughly (wallets ÷ batchSize) × gapMs.
// Thirty wallets at a 15s gap is 450s against nginx's 180s proxy_read_timeout:
// the operator gets 504 Gateway Time-out over a run that is still going, twice
// over, and a half-finished funding run cannot be safely re-pressed.
//
// The console warns about that BEFORE the press — but only if it knows the two
// numbers, and neither was reachable from the browser. They ride on this GET
// because it is the one funding endpoint the console already polls. What is
// asserted here is that they ride on it AT ALL and that they are read from
// config rather than typed in: a stale figure here is worse than no figure,
// because the warning built on it would be a confident lie.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same reason as routes/wallets.test.js: config.js and the keystore compute
// their paths once at first require, so these must be set before './wallets'.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallets-quotepacing-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-quote-pacing-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');

const router = require('./wallets');
const config = require('../config');

function handlerFor(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  assert.ok(layer, `no ${method.toUpperCase()} ${routePath} route`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getTimedFund(userId = 'default') {
  const res = { code: 200, body: undefined };
  res.status = (c) => ((res.code = c), res);
  res.json = (b) => ((res.body = b), res);
  handlerFor('get', '/v2/relay/timed-fund')({ user: { id: userId }, query: {} }, res, (err) => {
    throw err;
  });
  return res.body;
}

test('the timed-fund read carries the untimed run’s pacing', () => {
  const out = getTimedFund();
  assert.ok(out.quotePacing, 'without this the console has no limit to draw and the trap stays armed');
  assert.equal(out.quotePacing.batchSize, config.relayQuoteBatchSize);
  assert.equal(out.quotePacing.gapMs, config.relayQuoteGapMs);
  assert.equal(out.quotePacing.gatewayTimeoutMs, config.gatewayTimeoutMs);
});

test('the timed job it was already serving is untouched', () => {
  const out = getTimedFund();
  // The whole point of adding to this response rather than making a new
  // endpoint: the console reads one thing, and the thing it already read must
  // arrive exactly as it did.
  assert.equal(out.status, 'idle');
  assert.equal(out.mode, 'relay-solver-timed');
  assert.equal(out.maxWalletsPerTick, 4);
  assert.equal(out.walletsPerTick, 1);
});

test('reading it twice changes nothing — it is a read, not a knob', () => {
  assert.deepEqual(getTimedFund(), getTimedFund());
});

test('the gateway timeout defaults to the proxy_read_timeout deploy/ ships', () => {
  // 180s in deploy/nginx.conf and deploy/nginx-rhbond.conf. If that directive
  // moves, GATEWAY_TIMEOUT_MS moves with it — a console warning about a wall
  // that is no longer there is as useless as no warning at all.
  assert.equal(config.gatewayTimeoutMs, 180000);
});
