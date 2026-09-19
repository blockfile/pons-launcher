'use strict';

// Offline tests for the pure helpers of scripts/tp-fork-smoke.js. No network, no
// chain, no keys. No escape sequences (memory: write-tool-escapes): line breaks
// are built with String.fromCharCode.
//
// Not in `npm test`'s glob (src/** only): run it by path,
//   cd backend && node --test scripts/lib/tpSmoke.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pctAmount,
  clickAmounts,
  receivedWei,
  withinPpm,
  newestFirstWindows,
  landedInOrder,
  soldPerTx,
  createSseParser,
  cspProblems,
  firstLoadFiles,
  isUpstreamHiccup,
  withRetry,
  pollReceipt,
  createCookieJar,
  countHexIn,
  imageKind,
  logoProblems,
  tokenInfoProblems,
  figuresProblems,
  statsProblems,
  NonceFloor,
} = require('./tpSmoke');

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

test('pctAmount is floor(balance x pct / 100), and exactly the balance at 100', () => {
  assert.equal(pctAmount(1000n, 25), 250n);
  assert.equal(pctAmount('1000', 33), 330n);
  assert.equal(pctAmount(7n, 50), 3n);
  assert.equal(pctAmount(7n, 100), 7n);
  assert.equal(pctAmount(99n, 1), 0n);
  assert.equal(pctAmount(10n ** 24n + 1n, 100), 10n ** 24n + 1n);
  assert.throws(() => pctAmount(1000n, 0), (err) => err.message.includes('1..100'));
  assert.throws(() => pctAmount(1000n, 101), (err) => err.message.includes('1..100'));
  assert.throws(() => pctAmount(1000n, 12.5), (err) => err.message.includes('1..100'));
  assert.throws(() => pctAmount(-1n, 50), (err) => err.message.includes('negative'));
});

test('clickAmounts takes each click from what the clicks before it left', () => {
  assert.deepEqual(clickAmounts(1000n, [25, 50, 100]), [250n, 375n, 375n]);
  assert.deepEqual(clickAmounts(7n, [25, 50, 100]), [1n, 3n, 3n]);
  assert.deepEqual(clickAmounts('999', [30]), [299n]);
  assert.deepEqual(clickAmounts(0n, [25, 100]), [0n, 0n]);
  assert.throws(() => clickAmounts(1000n, [25, 0]), (err) => err.message.includes('1..100'));
});

test('receivedWei adds back the gas the wallet paid in the same span', () => {
  assert.equal(receivedWei({ ethBefore: 10n, ethAfter: 7n, gasCosts: [5n] }), 2n);
  assert.equal(receivedWei({ ethBefore: '100', ethAfter: '160', gasCosts: ['3', 2n] }), 65n);
  assert.equal(receivedWei({ ethBefore: 100n, ethAfter: 90n }), -10n);
});

test('withinPpm allows expected x ppm / 1e6, or the wei floor when that is larger', () => {
  assert.equal(withinPpm(1_001_000n, 1_000_000n, 1000), true);
  assert.equal(withinPpm(1_001_001n, 1_000_000n, 1000), false);
  assert.equal(withinPpm(999_000n, 1_000_000n, 1000), true);
  assert.equal(withinPpm(998_999n, 1_000_000n, 1000), false);
  assert.equal(withinPpm(15n, 10n, 0, 5n), true);
  assert.equal(withinPpm(16n, 10n, 0, 5n), false);
});

test('newestFirstWindows walks back in fixed windows and stops at block 0', () => {
  assert.deepEqual(newestFirstWindows(25_000, 10_000, 5), [
    { from: 15_001, to: 25_000 },
    { from: 5_001, to: 15_000 },
    { from: 0, to: 5_000 },
  ]);
  assert.deepEqual(newestFirstWindows(100, 10_000, 3), [{ from: 0, to: 100 }]);
  assert.deepEqual(newestFirstWindows(50_000, 10_000, 2), [
    { from: 40_001, to: 50_000 },
    { from: 30_001, to: 40_000 },
  ]);
});

test('landedInOrder compares block, then index, against the planned order', () => {
  const r = (hash, blockNumber, index) => ({ hash, blockNumber, index });
  assert.equal(landedInOrder(['0xA', '0xb', '0xc'], [r('0xa', 5, 0), r('0xb', 6, 0), r('0xc', 7, 0)]), true);
  assert.equal(landedInOrder(['0xa', '0xb'], [r('0xa', 5, 1), r('0xb', 5, 2)]), true);
  assert.equal(landedInOrder(['0xa', '0xb'], [r('0xa', 6, 0), r('0xb', 5, 0)]), false);
  assert.equal(landedInOrder(['0xa', '0xb'], [r('0xa', 5, 2), r('0xb', 5, 1)]), false);
  assert.equal(landedInOrder(['0xa', '0xb'], [r('0xa', 5, 0)]), false);
});

test('soldPerTx sums the Transfer logs of one transaction and orders by block, then index', () => {
  const t = (hash, blockNumber, txIndex, amount) => ({ hash, blockNumber, txIndex, amount });
  assert.deepEqual(
    soldPerTx([t('0xB', 7, 0, 5n), t('0xa', 5, 1, '3'), t('0xA', 5, 1, 4n), t('0xc', 5, 0, 1n)]),
    [
      { hash: '0xc', blockNumber: 5, txIndex: 0, amount: 1n },
      { hash: '0xa', blockNumber: 5, txIndex: 1, amount: 7n },
      { hash: '0xb', blockNumber: 7, txIndex: 0, amount: 5n },
    ]
  );
  assert.deepEqual(soldPerTx([]), []);
});

test('the SSE parser survives chunk splits, CRLF, comments and multi-line data', () => {
  const p = createSseParser();
  const frame1 = ['event: snapshot', 'data: {"bars":[],"trades":[]}', '', ''].join(LF);
  assert.deepEqual(p.push(frame1.slice(0, 20)), []);
  assert.deepEqual(p.push(frame1.slice(20)), [{ event: 'snapshot', data: { bars: [], trades: [] } }]);

  const frame2 = ['event: receipt', 'data: {"hash":"0xab","status":"landed"}', '', ''].join(CR + LF);
  const cut = frame2.indexOf(LF);
  assert.deepEqual(p.push(frame2.slice(0, cut)), []);
  assert.deepEqual(p.push(frame2.slice(cut)), [{ event: 'receipt', data: { hash: '0xab', status: 'landed' } }]);

  const frame3 = [': keep-alive', 'data: first', 'data: second', '', 'event: ping', 'data: {}', '', ''].join(LF);
  assert.deepEqual(p.push(frame3), [
    { event: 'message', data: ['first', 'second'].join(LF) },
    { event: 'ping', data: {} },
  ]);
});

test('cspProblems passes a Vite page and flags what script-src/style-src self would block', () => {
  const vite = [
    '<!doctype html><html><head>',
    '<script type="module" crossorigin src="/assets/dapp-abc123.js"></script>',
    '<link rel="stylesheet" crossorigin href="/assets/dapp-def456.css">',
    '</head><body><div id="root"></div></body></html>',
  ].join(LF);
  assert.deepEqual(cspProblems(vite), []);
  assert.deepEqual(cspProblems('<script>window.x = 1</script>'), ['inline <script>']);
  assert.deepEqual(cspProblems('<body onload="go()"></body>'), ['inline handler onload=']);
  assert.deepEqual(cspProblems('<link rel="stylesheet" href="https://fonts.example/x.css">'), [
    'off-origin URL (href="http)',
  ]);
});

test('firstLoadFiles follows static imports and preloads, keeps CSS apart and leaves dynamic imports lazy', () => {
  const html = [
    '<script type="module" crossorigin src="/dapp/assets/dapp-a1.js"></script>',
    '<link rel="modulepreload" crossorigin href="/dapp/assets/shared-b2.js">',
    '<link rel="stylesheet" crossorigin href="/dapp/assets/dapp-c3.css">',
  ].join(LF);
  const code = {
    '/dapp/assets/dapp-a1.js': 'import{t as e}from"./shared-b2.js";import"./side-d4.js";const s=()=>import(`./EmptyScene-e5.js`);',
    '/dapp/assets/shared-b2.js': 'export const t=1;',
    '/dapp/assets/side-d4.js': 'export{t}from"./shared-b2.js";',
    '/dapp/assets/EmptyScene-e5.js': 'import{t}from"./three-f6.js";',
  };
  const read = (p) => {
    if (!(p in code)) throw new Error(`read an unexpected file ${p}`);
    return code[p];
  };
  assert.deepEqual(firstLoadFiles(html, read), {
    js: ['/dapp/assets/dapp-a1.js', '/dapp/assets/shared-b2.js', '/dapp/assets/side-d4.js'],
    css: ['/dapp/assets/dapp-c3.css'],
    lazy: ['/dapp/assets/EmptyScene-e5.js'],
  });
});

// What ethers v6 throws for an eth_call anvil could not serve because its fork
// upstream answered 429 (measured on a fork of 4663): a CALL_EXCEPTION whose own
// message is the generic "missing revert data", with anvil's words in info.error.
function forkCallError(anvilMessage) {
  const err = new Error('missing revert data (action="call", data=null, reason=null, code=CALL_EXCEPTION, version=6.17.0)');
  err.code = 'CALL_EXCEPTION';
  err.shortMessage = 'missing revert data';
  err.info = { error: { code: -32603, message: anvilMessage }, payload: { method: 'eth_call' } };
  return err;
}

test('isUpstreamHiccup: a fork read the upstream throttled or pruned, not a real revert', () => {
  const throttled = forkCallError(
    'Internal error: failed to get storage for 0x7eD5 at 5521: Max retries exceeded HTTP error 429 with body: {"code":429,"message":"Too Many Requests"}'
  );
  assert.equal(isUpstreamHiccup(throttled), true);
  assert.equal(isUpstreamHiccup(forkCallError('Internal error: failed to get account for 0x64F8: Max retries exceeded')), true);
  // Pruned history is NOT a hiccup: once the public RPC stops serving the fork
  // block's state it never serves it again, so a retry only burns the backoff
  // (measured: a --pair setup stalled ~10 min retrying it). It fails at once.
  assert.equal(
    isUpstreamHiccup(
      forkCallError('Internal error: failed to get storage for 0x7868 at 2296: server returned an error response: error code -32000: historical state adf836 is not available')
    ),
    false
  );
  assert.equal(isUpstreamHiccup(new Error('server response 429 Too Many Requests')), true);
  assert.equal(isUpstreamHiccup(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
  // A contract that really reverted is not retried: the same generic message, no upstream words.
  const reverted = forkCallError('execution reverted');
  assert.equal(isUpstreamHiccup(reverted), false);
  assert.equal(isUpstreamHiccup(forkCallError('Execution error: execution reverted: SPL')), false);
  assert.equal(isUpstreamHiccup(new Error('missing revert data')), false);
  assert.equal(isUpstreamHiccup(null), false);
});

test('withRetry retries only what `retryable` accepts, backing off 1x, 2x, 4x the base', async () => {
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new Error('429');
    return 'value';
  };
  assert.equal(await withRetry(flaky, { attempts: 5, baseMs: 100, sleep, retryable: () => true }), 'value');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);

  // Out of attempts: the LAST error surfaces, after attempts - 1 waits.
  waits.length = 0;
  let n = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n++;
        throw new Error(`429 #${n}`);
      },
      { attempts: 3, baseMs: 10, sleep, retryable: () => true }
    ),
    (err) => err.message === '429 #3'
  );
  assert.deepEqual(waits, [10, 20]);

  // Not retryable: thrown at once, no wait.
  waits.length = 0;
  let m = 0;
  await assert.rejects(
    withRetry(
      async () => {
        m++;
        throw new Error('execution reverted');
      },
      { attempts: 5, baseMs: 10, sleep, retryable: (err) => err.message.includes('429') }
    ),
    (err) => err.message === 'execution reverted'
  );
  assert.equal(m, 1);
  assert.deepEqual(waits, []);

  // The default classifier is isUpstreamHiccup.
  let k = 0;
  const value = await withRetry(
    async () => {
      k++;
      if (k === 1) throw forkCallError('Internal error: failed to get storage: HTTP error 429');
      return k;
    },
    { attempts: 2, baseMs: 1, sleep }
  );
  assert.equal(value, 2);
});

// ethers v6 waitForTransaction reads the head (N), then the receipt; a tx mined in
// N+1 between the two has "0 confirmations" and the wait sleeps until a NEXT block.
// An automining fork that goes idle after the last tx never mines one (measured: a
// pair leg's 6 txs all mined within 1 s, the wait timed out after 60 s). The smoke
// run polls the receipt itself.
test('pollReceipt returns the receipt as soon as the node has one, with no block event needed', async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  let calls = 0;
  const getReceipt = async (hash) => {
    calls++;
    return calls >= 3 ? { hash, status: 1, blockNumber: 7 } : null;
  };
  const r = await pollReceipt(getReceipt, '0xab', { timeoutMs: 5_000, pollMs: 100, ...clock });
  assert.deepEqual(r, { hash: '0xab', status: 1, blockNumber: 7 });
  assert.equal(calls, 3);
  assert.equal(t, 200, 'two waits of pollMs between three reads');

  // A read that throws is retried like a missing receipt (the fork answers late).
  t = 0;
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) throw new Error('socket hang up');
    return { status: 0 };
  };
  assert.deepEqual(await pollReceipt(flaky, '0xcd', { timeoutMs: 5_000, pollMs: 50, ...clock }), { status: 0 }, 'a reverted receipt is returned too');

  // Never mined: a timeout error naming the hash, after timeoutMs.
  t = 0;
  await assert.rejects(
    pollReceipt(async () => null, '0xef', { timeoutMs: 1_000, pollMs: 250, ...clock }),
    (err) => err.message.includes('0xef') && err.message.includes('1 s')
  );
  assert.ok(t >= 1_000 && t < 1_300);
});

// ── v2 (Addendum A, C, D): the account's cookie, the logo route, the header's facts ──

test('createCookieJar keeps what Set-Cookie sets and drops what it clears', () => {
  const jar = createCookieJar();
  assert.equal(jar.header(), '');
  jar.take('__Host-tp_session=v1.abc.1.2.mac; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Strict');
  jar.take(['other=1; Path=/', 'junk', '=novalue']);
  assert.equal(jar.header(), '__Host-tp_session=v1.abc.1.2.mac; other=1');
  jar.take('__Host-tp_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict');
  assert.equal(jar.has('__Host-tp_session'), false, "express's clearCookie form");
  jar.take('other=2; Max-Age=0');
  assert.equal(jar.header(), '');
  jar.take(undefined);
  assert.deepEqual(jar.names(), []);
});

test('countHexIn finds hex needles with or without 0x, in any case', () => {
  const key = '0x' + 'ab'.repeat(32);
  const addr = '0x' + 'CD'.repeat(20);
  assert.equal(countHexIn(`{"ct":"xyz","k":"${key.slice(2).toUpperCase()}"}`, [key, addr]), 1);
  assert.equal(countHexIn(`addr ${addr.toLowerCase()} and ${key}`, [key, addr]), 2);
  assert.equal(countHexIn('nothing here', [key, addr]), 0);
});

test('imageKind reads PNG, JPEG, GIF and WebP by their magic bytes, and nothing else', () => {
  const pad = (head) => Uint8Array.from([...head, ...new Array(16).fill(0)]);
  assert.equal(imageKind(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(imageKind(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(imageKind(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'gif');
  assert.equal(imageKind(pad([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), 'webp');
  assert.equal(imageKind(pad([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20])), null, 'a RIFF that is not WebP');
  assert.equal(imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(imageKind(new Uint8Array(3)), null);
});

test("logoProblems holds the logo route to its contract: nosniff, CSP default-src 'none', CORP, a sniffed image type", () => {
  const safe = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin' };
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
  const immutable = 'public, max-age=31536000, immutable';
  assert.deepEqual(logoProblems({ status: 404, headers: { ...safe, 'cache-control': 'no-store' }, bytes: Buffer.from('{}') }), []);
  assert.deepEqual(logoProblems({ status: 200, headers: { ...safe, 'content-type': 'image/png', 'cache-control': immutable }, bytes: png }), []);
  assert.deepEqual(logoProblems({ status: 200, headers: { ...safe, 'content-type': 'image/jpeg', 'cache-control': immutable }, bytes: png }), [
    'content-type image/jpeg for a png',
  ]);
  assert.deepEqual(logoProblems({ status: 200, headers: { ...safe, 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }, bytes: Buffer.from('<svg/>') }), [
    'the body is not a PNG, JPEG, GIF or WebP',
    'a logo is cached neither immutable nor for a day',
  ]);
  // The caching a served logo must carry follows what the token's info says the logo is.
  const day = 'public, max-age=86400';
  const ok = (cc) => ({ status: 200, headers: { ...safe, 'content-type': 'image/png', 'cache-control': cc }, bytes: png });
  const rawCid = { logo: { cid: 'bafkreif2nctwv7yv2iuqzw3jfrpe6iq6ko4vqxe7valfgejqtaox26pms4', path: '/api/tp/logo/0x1' } };
  const dagPb = { logo: { cid: 'QmPmVbpMQzDW5kA84Q3N7hRyuz43xTf329DGNP8W1xULGQ', path: '/api/tp/logo/0x1' } };
  const httpsHost = { logo: { path: '/api/tp/logo/0x1' } }; // the URL is never in the JSON
  assert.deepEqual(logoProblems(ok(immutable), rawCid), []);
  assert.deepEqual(logoProblems(ok(day), rawCid), ['a raw-CID logo is not cached immutable']);
  assert.deepEqual(logoProblems(ok(day), dagPb), []);
  assert.deepEqual(logoProblems(ok(immutable), dagPb), ['an unverified logo is not cached for exactly a day']);
  assert.deepEqual(logoProblems(ok(day), httpsHost), []);
  assert.deepEqual(logoProblems(ok(immutable), httpsHost), ['an unverified logo is not cached for exactly a day']);
  assert.deepEqual(logoProblems(ok(day)), [], 'no info: a day is accepted');
  assert.deepEqual(logoProblems({ status: 500, headers: {}, bytes: null }), [
    'status 500',
    'no X-Content-Type-Options: nosniff',
    "CSP is not default-src 'none'",
    'CORP is not same-origin',
  ]);
});

const T = '0x' + '7'.repeat(40);
const INFO = {
  token: T,
  version: 'v2',
  name: 'Token',
  symbol: 'TKN',
  description: 'a line',
  socials: { x: 'https://x.com/tkn', telegram: null, discord: null, website: 'https://tkn.example', farcaster: null },
  logo: { cid: 'bafkreibm2hpxyz', path: `/api/tp/logo/${T}` },
  creator: '0x' + 'aB'.repeat(20),
  creatorFeeRecipient: null,
  launchedAt: 1789821655,
  launchedBefore: null,
  graduationThreshold: '4200000000000000000',
  phantomQuote: '1680000000000000000',
  launchSupply: '1000000000000000000000000000',
};

test("tokenInfoProblems holds GET /token's info to Part 02's shape", () => {
  assert.deepEqual(tokenInfoProblems(INFO, T.toUpperCase().replace('0X', '0x')), []);
  assert.deepEqual(tokenInfoProblems({ ...INFO, logo: null, creator: null }, T), []);
  assert.deepEqual(tokenInfoProblems({ ...INFO, logo: { path: `/api/tp/logo/${T}` } }, T), [], 'a logo on an https host: {path} alone');
  assert.deepEqual(tokenInfoProblems({ ...INFO, logo: { path: `/api/tp/logo/${T}`, url: 'https://x.example/a.png' } }, T), [
    'info.logo is not {cid?, path: /api/tp/logo/<ca>} or null',
  ]);
  assert.deepEqual(tokenInfoProblems(null, T), ['info is missing']);
  const bad = {
    ...INFO,
    socials: { ...INFO.socials, x: 'http://x.com/tkn', telegram: 'javascript:alert(1)' },
    logo: { cid: 'x', path: 'https://evil.example/x.png' },
    launchedAt: null,
  };
  delete bad.launchSupply;
  assert.deepEqual(tokenInfoProblems(bad, T), [
    'info.launchSupply is missing',
    'info.socials.x is not an https URL or null',
    'info.socials.telegram is not an https URL or null',
    'info.logo is not {cid?, path: /api/tp/logo/<ca>} or null',
    'info.launchedAt is not a unix time (v2)',
    'info.launchSupply is not a decimal string (v2)',
  ]);
});

test('figuresProblems: a curve has progress 0..1 and a raised amount; a pool has progress 1 and quote liquidity', () => {
  assert.deepEqual(figuresProblems({ progress: 0.27, raised: '11640000000000000', liquidity: null }, 'curve'), []);
  assert.deepEqual(figuresProblems({ progress: 1, raised: null, liquidity: { quote: '3230600000000000000', token: '1' } }, 'graduated'), []);
  assert.deepEqual(figuresProblems({ progress: 1.2, raised: 'x', liquidity: null }, 'curve'), ['curve progress is not 0..1', 'curve raised is not a decimal string']);
  assert.deepEqual(figuresProblems({ progress: null, raised: null, liquidity: { quote: '0', token: '0' } }, 'graduated'), [
    'a graduated token is not at progress 1',
    'pool liquidity (quote side) is not above 0',
  ]);
  assert.deepEqual(figuresProblems(undefined, 'curve'), ['figures are missing']);
});

test("statsProblems holds the stream's stats to Part 02's shape", () => {
  const ok = {
    at: 1789821700,
    since: 1789821000,
    price: 0.0000012,
    change: { m5: 0.12, h1: null, h24: -0.5 },
    volume: { m5: 0.3, h1: 0.3, h24: 0.3 },
    complete: { m5: true, h1: false, h24: false },
    figures: { progress: 0.3, raised: '1', liquidity: null },
  };
  assert.deepEqual(statsProblems(ok), []);
  assert.deepEqual(statsProblems({ ...ok, at: 'now', change: { m5: 'x', h1: 0 }, figures: null }), [
    'stats.at is not a unix time',
    'stats.change.h24 is missing',
    'stats.change.m5 is not a number or null',
    'stats.figures is missing',
  ]);
  assert.deepEqual(statsProblems(null), ['stats are missing']);
});

// ── the nonce floor: a /wallets read must show what this run already landed ──

test('an empty floor refuses a read rather than trusting it', async () => {
  const floor = new NonceFloor();
  const states = [{ address: '0xAa', nonce: 7 }];
  assert.deepEqual(floor.measure(states), { unknown: 1, behind: 0, total: 1 });
  await assert.rejects(
    () => floor.waitFor(async () => states, { timeoutMs: 0 }),
    /no landing recorded for 1 of 1 wallet/
  );
});

test('record keeps the highest nonce per wallet, whatever the address case', () => {
  const floor = new NonceFloor();
  floor.record('0xAaBb', 4);
  floor.record('0xaabb', 2);
  assert.equal(floor.get('0xAABB'), 4);
  floor.record('0xAABB', 9);
  assert.equal(floor.get('0xaabb'), 9);
});

test('a floor raised by a landing refuses states from before it', () => {
  const floor = new NonceFloor();
  floor.record('0xa1', 5);
  floor.record('0xa2', 5);
  assert.deepEqual(
    floor.measure([
      { address: '0xA1', nonce: 4 },
      { address: '0xA2', nonce: 5 },
    ]),
    { unknown: 0, behind: 1, total: 2 }
  );
});

test('waitFor reads again until every wallet has caught up, then returns that read', async () => {
  const floor = new NonceFloor();
  floor.record('0xa1', 5);
  const reads = [
    [{ address: '0xa1', nonce: 4 }],
    [{ address: '0xa1', nonce: 4 }],
    [{ address: '0xa1', nonce: 6 }],
  ];
  let n = 0;
  const got = await floor.waitFor(async () => reads[n++], { timeoutMs: 5_000, pauseMs: 0 });
  assert.equal(n, 3);
  assert.deepEqual(got, [{ address: '0xa1', nonce: 6 }]);
});

test('waitFor gives up with the count still behind, never an address', async () => {
  const floor = new NonceFloor();
  floor.record('0xa1', 5);
  floor.record('0xa2', 5);
  const stale = [
    { address: '0xa1', nonce: 4 },
    { address: '0xa2', nonce: 4 },
  ];
  await assert.rejects(
    () => floor.waitFor(async () => stale, { timeoutMs: 20, pauseMs: 1 }),
    (err) => {
      assert.match(err.message, /2 of 2 wallets/);
      assert.equal(/0xa1/.test(err.message), false, 'the message names no wallet address');
      return true;
    }
  );
});
