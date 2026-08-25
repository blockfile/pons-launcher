'use strict';

// launchedTokenQuote / launchedTokenHook derive the sell's quote + pool hook from
// the account's own launch activity, so a USDG-launched token sells into its
// (USDG,token) pool without the console having to know its quote. Seeds a real
// per-user activity log for a unique test user and cleans it up.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const v5 = require('./v5');
const { launchedTokenQuote, launchedTokenHook, assertOwnLaunchedToken, resolveSellPool } = v5;
const { activityFor } = require('../store/activity');
const config = require('../config');

const USER = 'v5quotetest-' + process.pid;
const TOKEN = '0x4f0d7ea112547af5dad59959d98b6a8ee3355bcc';
const USDG = config.letscash.usdg;
const HOOK = '0xEfe669814e5Eec33406Bd50ffa8331618D076aEc';

test.after(() => {
  try {
    fs.unlinkSync(activityFor(USER)._path());
  } catch {
    /* nothing written */
  }
});

test('launchedTokenQuote maps a USDG-quoted launch record to "usdg"', () => {
  const log = activityFor(USER);
  log.record('v5', 'launched USDGCAT', { token: TOKEN, hook: HOOK, quote: USDG });
  assert.equal(launchedTokenQuote(USER, TOKEN), 'usdg');
  assert.equal(launchedTokenHook(USER, TOKEN).toLowerCase(), HOOK.toLowerCase());
});

test('launchedTokenQuote maps a native (0x0) launch record to "eth"', () => {
  const ethToken = '0x00000000000000000000000000000000000000cc';
  activityFor(USER).record('v5', 'launched ETHCAT', {
    token: ethToken,
    hook: HOOK,
    quote: '0x0000000000000000000000000000000000000000',
  });
  assert.equal(launchedTokenQuote(USER, ethToken), 'eth');
});

test('launchedTokenQuote returns null for a token this account never launched', () => {
  assert.equal(launchedTokenQuote(USER, '0x00000000000000000000000000000000000000ff'), null);
});

test('resolveSellPool uses the RECORD hook+quote and rejects a mismatching client hook', () => {
  // Listed token: the receipt hook/quote win.
  const r = resolveSellPool(USER, { token: TOKEN });
  assert.equal(r.hook.toLowerCase(), HOOK.toLowerCase());
  assert.equal(r.quote, 'usdg');
  // A matching client hook is fine.
  assert.doesNotThrow(() => resolveSellPool(USER, { token: TOKEN, hook: HOOK }));
  // A DIFFERENT client hook is refused — it cannot override the authoritative pool.
  assert.throws(
    () => resolveSellPool(USER, { token: TOKEN, hook: '0x1111111111111111111111111111111111111111' }),
    /does not match this token's launch record/
  );
});

test('resolveSellPool requires an explicit quote for an unlisted token given a hook', () => {
  const unlisted = '0x00000000000000000000000000000000000000ff';
  assert.throws(
    () => resolveSellPool(USER, { token: unlisted, hook: HOOK }),
    /pass an explicit quote/
  );
  // With both, it passes them through.
  const r = resolveSellPool(USER, { token: unlisted, hook: HOOK, quote: 'usdg' });
  assert.equal(r.quote, 'usdg');
  assert.equal(r.hook, HOOK);
});

test('assertOwnLaunchedToken ACCEPTS a token this account actually launched', () => {
  // The bug this guards: the token pin read e.detail.token (undefined) instead of
  // e.token, so it refused EVERY launched token — breaking bundle + sell from the
  // console. This must not throw for USER's own launched TOKEN.
  assert.doesNotThrow(() => assertOwnLaunchedToken(USER, TOKEN, false));
  assert.throws(
    () => assertOwnLaunchedToken(USER, '0x00000000000000000000000000000000000000ff', false),
    /not among this account/
  );
});
