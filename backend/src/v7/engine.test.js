'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseEther } = require('ethers');
const { createEngine } = require('./engine');
const realSizing = require('./sizing');

// V7 trades a flap BONDING CURVE, not a V4 pool: the resolved venue is a { venue, state,
// circulatingSupply, dexSupplyThresh, headroomTokens } snapshot (no poolKey/poolId/hook).
// Only `venue` is load-bearing to the engine (start() requires it); the rest is carried
// onto the job for its status snapshot.
const POOL = {
  venue: '0xlauncher',
  state: 0,
  circulatingSupply: 1_000n,
  dexSupplyThresh: 10_000n,
  headroomTokens: 9_000n,
};

// A fake keystore exposing exactly what v7/roles reads.
function fakeKs(main, bundle) {
  return {
    walletWithRole: (r) => (r === 'v7main' ? main : r === 'v7dev' ? { id: 'dev', address: '0xdev' } : null),
    walletsWithRole: (r) => (r === 'v7bundle' ? bundle : []),
    signer: () => ({}),
  };
}

// Build an engine wired to controllable fakes. `overrides` can replace trade fns.
function harness(overrides = {}) {
  const main = { id: 'main', address: '0xmain', role: 'v7main' };
  const bundle = [
    { id: 'b1', address: '0xb1', role: 'v7bundle' },
    { id: 'b2', address: '0xb2', role: 'v7bundle' },
  ];
  const seq = [];
  const transfers = [];
  let mainBalance = 10_000n;
  // assertTradable is called before the big buy, at the top of every cycle, and again
  // before each bundle buy. Count the calls so a test can graduate the token on a chosen
  // call (assertThrowsFrom) — the mid-run halt-and-keep-state case v6 never had.
  let assertCalls = 0;
  // Per-address ETH, so a Relay fill is modelled as the recipient's balance RISING —
  // the delta waitForFill now measures. Seed with overrides.eth; dropFill simulates a
  // deposit that is SENT but never fills (the transfer credits nothing).
  const ethBalances = new Map(Object.entries(overrides.eth || {}).map(([a, v]) => [a, BigInt(v)]));
  const ethOf = (a) => ethBalances.get(a) ?? 0n;

  const trade = {
    DEFAULT_BUY_SLIPPAGE_BPS: 1500,
    // gasFigures reads the REAL v7/trade.js constants (no Permit2 leg), not these — the
    // injected trade only supplies the four functions the engine calls plus the slippage
    // default start() reads.
    assertTradable: async () => {
      assertCalls += 1;
      if (overrides.assertThrows && assertCalls >= (overrides.assertThrowsFrom ?? 1)) {
        throw new Error(overrides.assertThrows);
      }
    },
    tokenBalance: async () => mainBalance,
    buy: async ({ wallet, amountWei }) => {
      seq.push(`buy:${wallet.id}`);
      if (overrides.buyThrows) throw new Error(overrides.buyThrows);
      return { hash: '0xbuy', status: overrides.buyStatus || 'confirmed', blockNumber: 1, tokensOut: 500n, expectedOut: 500n, minOut: 1n };
    },
    // The flap sell is TWO txs (approve + swapExactInput): approveHashes:[oneHash], sellHash.
    sell: async ({ wallet, tokensIn }) => {
      seq.push(`sell:${wallet.id}`);
      if (overrides.sellThrows) throw new Error(overrides.sellThrows);
      // Any non-confirmed status (reverted OR a timed-out 'pending') raised nothing.
      if (overrides.sellStatus && overrides.sellStatus !== 'confirmed')
        return { approveHashes: ['0xapprove'], sellHash: '0xsell', status: overrides.sellStatus, blockNumber: null, ethReceived: 0n, tokensIn };
      mainBalance -= BigInt(tokensIn);
      return { approveHashes: ['0xapprove'], sellHash: '0xsell', status: 'confirmed', blockNumber: 2, ethReceived: parseEther('0.1'), tokensIn };
    },
  };
  const relay = {
    transfer: async ({ fromWallet, toAddress, amountWei }) => {
      transfers.push({ from: fromWallet.id, to: toAddress, amountWei });
      // The fill credits the recipient — unless we are simulating a deposit that never
      // arrives, which is what lets the delta check prove itself against a pre-funded wallet.
      if (!overrides.dropFill) ethBalances.set(toAddress, ethOf(toAddress) + BigInt(amountWei));
      return { requestId: '0x' + 'aa'.repeat(32), depositAddress: '0xdep', hash: '0xrelay' };
    },
  };

  const engine = createEngine({
    setTimeoutFn: () => ({ unref() {} }), // never auto-fires; we drive via _runNext
    clearTimeoutFn: () => {},
    nowFn: () => 1000,
    idFn: () => 'job1',
    randomFn: () => 0.5,
    sleepFn: async () => {},
    keystoreForFn: () => fakeKs(main, bundle),
    activityForFn: () => ({ record() {} }),
    rpc: { getBalance: async (a) => ethOf(a) },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    trade,
    relay,
    sizing: realSizing,
  });

  return { engine, main, bundle, seq, transfers, getAssertCalls: () => assertCalls };
}

const START = { token: '0xtok', pool: POOL, symbol: 'CAT', bigBuyWei: parseEther('0.5'), targets: [{ walletId: 'b1', address: '0xb1' }, { walletId: 'b2', address: '0xb2' }] };

async function drive(engine) {
  for (let i = 0; i < 10; i++) {
    const s = await engine._runNext('u');
    if (s.status === 'complete' || s.status === 'failed') return s;
  }
  throw new Error('drive did not terminate');
}

test('a full run: big buy, then sell→transfer→fill→buy per wallet, to completion', async () => {
  const { engine, seq, transfers } = harness();
  await engine.start('u', START);
  const final = await drive(engine);

  assert.equal(final.status, 'complete');
  assert.equal(final.completed, 2, 'both cycles done');
  // The big buy is the main wallet; each bundle wallet buys once; main sells each cycle.
  assert.deepEqual(seq, ['buy:main', 'sell:main', 'buy:b1', 'sell:main', 'buy:b2']);
  // One Relay transfer per cycle, main → each bundle wallet (the "chaining").
  assert.equal(transfers.length, 2);
  assert.deepEqual(transfers.map((t) => t.to), ['0xb1', '0xb2']);
  assert.ok(transfers.every((t) => t.from === 'main'));
});

test('the run reports the flap curve venue, not a pool/hook', async () => {
  // v7's status snapshot carries the resolved curve venue and its state-0 curve numbers —
  // there is no poolId/hook to report.
  const { engine } = harness();
  const started = await engine.start('u', START);
  assert.equal(started.venue, '0xlauncher');
  assert.equal(started.curveState, 0);
  assert.equal(started.dexSupplyThresh, '10000');
  assert.equal(started.circulatingSupplyAtStart, '1000');
});

test('a buy slippage floor of 0 is allowed on the predictable flap curve', async () => {
  // v6 forced buySlippageBps > 0; v7 permits a strictly-guaranteed 0 on the predictable
  // constant-product curve. start() must accept it rather than throw or coerce to a default.
  const { engine } = harness();
  const started = await engine.start('u', { ...START, buySlippageBps: 0 });
  assert.equal(started.buySlippageBps, 0);
  const final = await drive(engine);
  assert.equal(final.status, 'complete');
});

test('a reverted sell HALTS the run and keeps state (no retry, no skip)', async () => {
  const { engine, seq } = harness({ sellStatus: 'reverted' });
  await engine.start('u', START);
  const final = await drive(engine);

  assert.equal(final.status, 'failed');
  assert.equal(final.failure.step, 'selling');
  assert.equal(final.failure.index, 1, 'halted on cycle 1');
  // Big buy happened, cycle 1's sell was attempted; nothing past it ran.
  assert.deepEqual(seq, ['buy:main', 'sell:main']);
});

test('RESUME picks up at the failed step — a done sell+transfer is not re-run', async () => {
  // Fail the BUY of cycle 1 (sell + transfer + fill already succeeded), then resume
  // with a working buy and assert the sell/transfer did NOT run a second time.
  const main = { id: 'main', address: '0xmain', role: 'v7main' };
  const bundle = [{ id: 'b1', address: '0xb1', role: 'v7bundle' }];
  const seq = [];
  let mainBalance = 10_000n;
  let failBuy = true;
  const ethBalances = new Map();
  const ethOf = (a) => ethBalances.get(a) ?? 0n;
  const trade = {
    DEFAULT_BUY_SLIPPAGE_BPS: 1500,
    assertTradable: async () => {},
    tokenBalance: async () => mainBalance,
    buy: async ({ wallet }) => {
      seq.push(`buy:${wallet.id}`);
      if (wallet.id === 'b1' && failBuy) throw new Error('buy blip');
      return { hash: '0xbuy', status: 'confirmed', blockNumber: 1, tokensOut: 500n };
    },
    sell: async ({ tokensIn }) => { seq.push('sell'); mainBalance -= BigInt(tokensIn); return { approveHashes: ['0xa'], sellHash: '0xs', status: 'confirmed', blockNumber: 2, ethReceived: parseEther('0.1'), tokensIn }; },
  };
  const relay = { transfer: async ({ toAddress, amountWei }) => { seq.push('transfer'); ethBalances.set(toAddress, ethOf(toAddress) + BigInt(amountWei)); return { requestId: '0x' + 'bb'.repeat(32), depositAddress: '0xd', hash: '0xr' }; } };
  const engine = createEngine({
    setTimeoutFn: () => ({ unref() {} }), clearTimeoutFn: () => {}, nowFn: () => 1000, idFn: () => 'j', randomFn: () => 0.5, sleepFn: async () => {},
    keystoreForFn: () => fakeKs(main, bundle), activityForFn: () => ({ record() {} }),
    rpc: { getBalance: async (a) => ethOf(a) },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    trade, relay, sizing: realSizing,
  });

  await engine.start('u', { ...START, targets: [{ walletId: 'b1', address: '0xb1' }] });
  const failed = await drive(engine);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.step, 'buying');
  assert.deepEqual(seq, ['buy:main', 'sell', 'transfer', 'buy:b1'], 'sell + transfer ran once, buy failed');

  // Fix the buy and resume — the sell and transfer must NOT run again.
  failBuy = false;
  engine.resume('u');
  const done = await drive(engine);
  assert.equal(done.status, 'complete');
  assert.deepEqual(seq, ['buy:main', 'sell', 'transfer', 'buy:b1', 'buy:b1'],
    'only the buy re-ran; the completed sell + transfer were skipped (done-flags)');
});

test('a PRE-FUNDED bundle wallet still completes — the fill is detected as a delta, not an absolute balance', async () => {
  // Both bundle wallets already hold ETH (the usual case: claimed from the seasoning
  // pool). The fill credits transferWei ON TOP of that, so the delta clears and the run
  // completes — the delta check must not reject a legitimately pre-funded wallet.
  const { engine } = harness({ eth: { '0xb1': parseEther('0.05'), '0xb2': parseEther('0.05') } });
  await engine.start('u', START);
  const final = await drive(engine);
  assert.equal(final.status, 'complete');
  assert.equal(final.completed, 2);
});

test('a pre-funded wallet does NOT mask an unfilled Relay deposit — the run halts at waiting-fill', async () => {
  // The wallet holds 1 ETH already and the deposit never fills. The OLD absolute check
  // (balance >= needWei) returned instantly and let the buy spend the wallet's own
  // seasoning ETH while the sold proceeds sat stranded at the deposit address. The delta
  // check sees no RISE and halts — no buy fires against the pre-funded balance.
  const { engine, seq } = harness({ eth: { '0xb1': parseEther('1'), '0xb2': parseEther('1') }, dropFill: true });
  await engine.start('u', START);
  const final = await drive(engine);
  assert.equal(final.status, 'failed');
  assert.equal(final.failure.step, 'waiting-fill');
  assert.equal(final.failure.index, 1, 'halted on cycle 1');
  assert.deepEqual(seq, ['buy:main', 'sell:main'], 'no buy fired against the pre-funded ETH');
});

test('a sell whose receipt times out (pending) HALTS at selling — it does not wedge at raised-0', async () => {
  // A 'pending' sell (receipt did not arrive) raised nothing measurable. The OLD code
  // recorded it done with ethRaised 0, and every resume then threw "raised 0 ETH" at the
  // TRANSFER forever — a dead run. Now it halts at the SELL with sellDone still false, so
  // a resume re-reads the balance and re-slices.
  const { engine, seq } = harness({ sellStatus: 'pending' });
  await engine.start('u', START);
  const final = await drive(engine);
  assert.equal(final.status, 'failed');
  assert.equal(final.failure.step, 'selling', 'halts at the sell, NOT at the transfer against a phantom 0 balance');
  assert.deepEqual(seq, ['buy:main', 'sell:main'], 'nothing past the sell ran');
});

// ── GRADUATION: the one concern v6 never had ────────────────────────────────────
// A flap token graduates off the curve once tokens-sold crosses a threshold. The engine
// re-checks trade.assertTradable before the big buy, at the top of every cycle, and again
// before each bundle buy, so a token that graduates HALTS-AND-KEEPS-STATE (nothing signed
// on the wrong venue) rather than trade the V2 pair v7 does not understand.

test('a token already graduated at the big buy is refused before anything is signed', async () => {
  // assertTradable throws on its very first call (before the big buy). No buy, no sell.
  const { engine, seq, transfers } = harness({ assertThrows: 'it graduated to the V2 pair', assertThrowsFrom: 1 });
  await engine.start('u', START);
  const final = await drive(engine);

  assert.equal(final.status, 'failed');
  assert.equal(final.failure.index, 0);
  assert.equal(final.failure.step, 'big-buy');
  assert.match(final.failure.error, /graduated/);
  assert.deepEqual(seq, [], 'nothing signed — the big buy never fired');
  assert.equal(transfers.length, 0);
});

test('a token that GRADUATES mid-run halts and keeps state — nothing further is signed', async () => {
  // Let the big buy (assert call 1) and all of cycle 1 (calls 2 top-of-cycle, 3 pre-buy)
  // complete, then graduate on cycle 2's top-of-cycle guard (call 4): cycle 2 signs
  // nothing — no sell, no transfer, no buy — and the failed state is kept for a checked
  // resume/exit.
  const { engine, seq, transfers } = harness({ assertThrows: 'it graduated to the V2 pair mid-run', assertThrowsFrom: 4 });
  await engine.start('u', START);
  const final = await drive(engine);

  assert.equal(final.status, 'failed');
  assert.equal(final.failure.index, 2, 'halted entering cycle 2');
  assert.equal(final.failure.step, 'cycle', 'stopped at the top-of-cycle guard, before the sell step was entered');
  assert.match(final.failure.error, /graduated/);
  // Cycle 1 ran fully; cycle 2 signed nothing.
  assert.deepEqual(seq, ['buy:main', 'sell:main', 'buy:b1']);
  assert.equal(transfers.length, 1, 'only cycle 1 transferred; graduation stopped cycle 2 before its sell');
  assert.equal(final.completed, 1, 'cycle 1 stays done — state is kept');
});

test('a token that graduates during the fill wait halts at the bundle buy — the fill ETH is not spent', async () => {
  // Cycle 1's sell + transfer + fill all succeed (calls 1 big-buy, 2 top-of-cycle), then
  // the token graduates before the bundle buy fires (call 3, the pre-buy guard). The buy
  // never signs, so the filled ETH stays in the bundle wallet (recoverable by the sweep).
  const { engine, seq, transfers } = harness({ assertThrows: 'it graduated during the fill wait', assertThrowsFrom: 3 });
  await engine.start('u', START);
  const final = await drive(engine);

  assert.equal(final.status, 'failed');
  assert.equal(final.failure.index, 1, 'halted on cycle 1');
  assert.equal(final.failure.step, 'buying', 'stopped at the pre-buy graduation guard');
  assert.match(final.failure.error, /graduated/);
  assert.deepEqual(seq, ['buy:main', 'sell:main'], 'the bundle buy never fired');
  assert.equal(transfers.length, 1, 'the sell + transfer of cycle 1 completed before graduation');
});
