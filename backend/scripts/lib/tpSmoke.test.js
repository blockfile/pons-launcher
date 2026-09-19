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
  assert.equal(isUpstreamHiccup(forkCallError('historical state 0xabc is not available')), true);
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
