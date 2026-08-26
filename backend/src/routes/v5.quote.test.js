'use strict';

// launchedTokenQuote / launchedTokenHook derive the sell's quote + pool hook from
// the account's own launch activity, so a USDG-launched token sells into its
// (USDG,token) pool without the console having to know its quote. Seeds a real
// per-user activity log for a unique test user and cleans it up.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const v5 = require('./v5');
const { launchedTokenQuote, launchedTokenHook, assertOwnLaunchedToken, resolveSellPool, safeBundleBuyBody, launchesFromActivity } = v5;
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
  // Real launch records carry a launchHash (launchActivityDetail sets it) — it is
  // the positive marker assertOwnLaunchedToken keys off, so seed it like production.
  log.record('v5', 'launched USDGCAT', { token: TOKEN, hook: HOOK, quote: USDG, launchHash: '0xaaa1' });
  assert.equal(launchedTokenQuote(USER, TOKEN), 'usdg');
  assert.equal(launchedTokenHook(USER, TOKEN).toLowerCase(), HOOK.toLowerCase());
});

test('launchedTokenQuote maps a native (0x0) launch record to "eth"', () => {
  const ethToken = '0x00000000000000000000000000000000000000cc';
  activityFor(USER).record('v5', 'launched ETHCAT', {
    token: ethToken,
    hook: HOOK,
    quote: '0x0000000000000000000000000000000000000000',
    launchHash: '0xaaa2',
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

test('launchesFromActivity recovers launch records (newest-first, distinct token, hook/quote intact)', () => {
  // A page refresh loses the in-memory lastLaunch; this is how the Sell step gets
  // the token + recorded hook back so it never treats an own launch as unlisted.
  const entries = [
    // newest first (list() unshifts), two records for the SAME token — newest wins
    { at: '2026-08-26T10:00:00.000Z', kind: 'v5', launchHash: '0xh2', token: '0xAAA', symbol: 'CATB', hook: '0xHOOK2', quote: '0x0', status: 'confirmed' },
    { at: '2026-08-25T10:00:00.000Z', kind: 'v5', launchHash: '0xh1', token: '0xAAA', symbol: 'CATA', hook: '0xHOOK1', quote: '0x0', status: 'confirmed' },
    { at: '2026-08-24T10:00:00.000Z', kind: 'v5', launchHash: '0xh0', token: '0xBBB', symbol: 'DOG', hook: '0xHOOKB', quote: USDG, status: 'confirmed' },
    // non-launch rows (no launchHash) and a pending/no-token launch are skipped
    { at: '2026-08-26T11:00:00.000Z', kind: 'sell', token: '0xCCC', symbol: 'X' },
    { at: '2026-08-26T09:00:00.000Z', kind: 'v5', launchHash: '0xh9', token: null, status: 'pending' },
  ];
  const out = launchesFromActivity(entries);
  assert.equal(out.length, 2, 'two distinct launched tokens');
  assert.equal(out[0].token, '0xAAA');
  assert.equal(out[0].symbol, 'CATB'); // newest record for 0xAAA wins
  assert.equal(out[0].hook, '0xHOOK2');
  assert.equal(out[0].hookResolved, true);
  assert.equal(out[1].token, '0xBBB');
  assert.equal(out[1].quote, USDG);
  // The sell row and the token-less pending launch are not in the list.
  assert.equal(out.some((l) => l.token === '0xCCC'), false);
});

test('safeBundleBuyBody strips a client-injected poolKey/poolId/hook/quote', () => {
  // The standalone /v5/bundle-buy route must never let a client reach prepareBundleBuys'
  // trust-the-key fast path — an injected poolKey/poolId would bypass the decoy-pool
  // guard and drain the wallets' ETH into a rigged pool. The route pins hook/quote
  // itself, so those go too. Everything legitimate (token, buys, slippage…) survives.
  const cleaned = safeBundleBuyBody({
    token: TOKEN,
    buys: [{ walletId: 'b1', amountEth: '0.1' }],
    slippageBps: 300,
    confirm: true,
    poolKey: { currency0: '0x0', currency1: TOKEN, fee: 0, tickSpacing: 60, hooks: '0xbad' },
    poolId: '0xdeadbeef',
    hook: '0xbad',
    quote: 'usdg',
  });
  assert.deepEqual(cleaned, { token: TOKEN, buys: [{ walletId: 'b1', amountEth: '0.1' }], slippageBps: 300, confirm: true });
  assert.equal(cleaned.poolKey, undefined);
  assert.equal(cleaned.poolId, undefined);
  assert.equal(cleaned.hook, undefined);
  assert.equal(cleaned.quote, undefined);
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

test('assertOwnLaunchedToken IGNORES a token that only appears in a non-launch record', () => {
  // Hardening: the "launched" set is built ONLY from launch records (launchHash),
  // not from every entry that carries an e.token. A launcher/withdraw of an
  // ARBITRARY ERC-20 records that token — but it was never launched here, so it must
  // NOT pass the anti-dusting gate (it would otherwise become a fan-out target).
  const dust = '0x00000000000000000000000000000000deadbeef';
  activityFor(USER).record('v5', '[v5] withdrew 1 SOMETOKEN from launcher', {
    kind: 'launcher-withdraw',
    asset: 'SOMETOKEN',
    token: dust,
    to: '0x0000000000000000000000000000000000001234',
    amount: '1',
    hash: '0xdeadbeef',
    status: 'confirmed',
  });
  assert.throws(() => assertOwnLaunchedToken(USER, dust, false), /not among this account/);
  // The escape hatch still lets the operator force it if they know it is theirs.
  assert.doesNotThrow(() => assertOwnLaunchedToken(USER, dust, true));
});
