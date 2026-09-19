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
