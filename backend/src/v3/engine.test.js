'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const { createEngine, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_JITTER_PCT } = require('./engine');

const USER = 'u1';
const TOKEN = '0x3333333333333333333333333333333333333333';
const CURVE = '0x2222222222222222222222222222222222222222';
const MAIN = { id: 'main', role: 'v3main', address: '0x1111111111111111111111111111111111111111' };
const W1 = { id: 'w1', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b1' };
const W2 = { id: 'w2', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b2' };
const W3 = { id: 'w3', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b3' };

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

/**
 * A clock whose timers only fire when a test says so, so cadence is asserted
 * rather than waited for. `advance()` fires the single pending timer.
 */
function fakeClock(start = 1_000_000) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    tick: (ms) => {
      now += ms;
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, at: now + ms, cancelled: false, fired: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cancelled = true;
    },
    delays: () => timers.filter((t) => !t.cancelled).map((t) => t.ms),
    pending: () => timers.filter((t) => !t.cancelled && !t.fired),
    async advance() {
      const next = timers.find((t) => !t.cancelled && !t.fired);
      if (!next) return false;
      next.fired = true;
      now = Math.max(now, next.at);
      await next.fn();
      return true;
    },
    /** Fire timers until the job stops producing them, with a runaway guard. */
    async drain(limit = 40) {
      let n = 0;
      while (await this.advance()) {
        if (++n > limit) throw new Error('drain did not converge');
      }
      return n;
    },
  };
}

function harness({
  targets = [W1, W2, W3],
  fail = null, // { step: 'sell'|'transfer'|'buy', index: 1 }
  fillAfter = 1, // polls before the ETH shows up
  fillNever = false,
  graduatedAt = null, // cycle index at which the curve reports graduated
  readyToGradAt = null, // cycle index at which the curve reports readyToGraduate
  thinCurveAt = null, // cycle index at which the curve returns a dust quote reserve
  sellRevertAt = null, // cycle index at which the sell reverts (the floor rejected the fill)
  clock = fakeClock(),
  cycleCostMs = 0, // how long each cycle's work takes on the fake clock
  readFailTimes = 0, // make the FIRST readCurve throw this many times, then succeed
  isNativeQuote = true, // false => a TOKEN-quoted (route) curve, so the engine sizes route gas
} = {}) {
  let readFails = 0;
  const calls = [];
  const logged = [];
  const balances = { [MAIN.address]: parseEther('50') };
  let polls = 0;
  // The main wallet's token position, walked down by each fake sell.
  let position = TOKENS(1_000_000);
  // What each bundle wallet's solver fill delivered, by address.
  const filled = {};

  const wallets = [MAIN, ...targets];
  const keystore = {
    walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
    walletsWithRole: (r) => wallets.filter((w) => w.role === r),
  };

  function note(step, index, extra = {}) {
    calls.push({ step, index, ...extra });
    clock.tick(cycleCostMs);
  }

  const deps = {
    keystoreForFn: () => keystore,
    activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    nowFn: clock.now,
    idFn: () => 'job-1',
    randomFn: () => 0.5, // dead centre, so jitter is 0 unless a test overrides
    sleepFn: async () => {
      polls += 1;
    },
    rpc: {
      getBalance: async (a) => {
        if (a === MAIN.address) return balances[MAIN.address];
        if (fillNever) return 0n;
        // The solver's fill: exactly what the transfer ordered, once enough
        // polls have gone by. Modelled rather than faked as a constant so the
        // buy really is sized from what arrived.
        return polls >= fillAfter ? (filled[a] ?? 0n) : 0n;
      },
    },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    // Only reached on a token-quoted (route) run, to value a pair-token slice in ETH. 1:1 here.
    swaproute: {
      quotePairToEth: async ({ amountIn }) => ({ amountOut: BigInt(amountIn), usdgFee: 3000 }),
    },
    trade: {
      readCurve: async () => {
        if (readFails < readFailTimes) {
          readFails += 1;
          throw new Error('rpc read blip');
        }
        const buysSoFar = calls.filter((c) => c.step === 'buy').length;
        const thin = thinCurveAt !== null && buysSoFar >= thinCurveAt;
        return {
        address: CURVE,
        token: TOKEN,
        isNativeQuote,
        pairToken: isNativeQuote ? null : '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
        // A dust (but non-zero) quote reserve models a momentary drain / thin read: it is a
        // VALID read, so the empty-reserve retry does not fire — the pre-sell viability check
        // must catch it and halt BEFORE selling.
        quoteReserve: thin ? parseEther('0.00000001') : parseEther('40'),
        tokenReserve: TOKENS(800_000_000),
        feeBps: 100,
        creatorTaxBps: 100,
        graduated: graduatedAt !== null && buysSoFar >= graduatedAt,
        readyToGraduate: readyToGradAt !== null && buysSoFar >= readyToGradAt,
        };
      },
      buy: async ({ wallet }) => {
        const index = wallet.id === MAIN.id ? 0 : targets.findIndex((t) => t.id === wallet.id) + 1;
        note('buy', index, { walletId: wallet.id });
        if (fail?.step === 'buy' && fail.index === index) throw new Error('buy reverted');
        return { hash: `0xbuy${index}`, status: 'confirmed', blockNumber: 1, tokensOut: TOKENS(100) };
      },
      sell: async ({ tokensIn }) => {
        const index = calls.filter((c) => c.step === 'sell').length + 1;
        note('sell', index, { tokensIn });
        if (fail?.step === 'sell' && fail.index === index) throw new Error('sell reverted');
        // The floor rejected the fill: the curve reverts and NOTHING is sold (the position is
        // not decremented), the exact resume-safe property the floor exists for.
        if (sellRevertAt !== null && index >= sellRevertAt) {
          return { approveHash: `0xap${index}`, sellHash: `0xse${index}`, status: 'reverted', blockNumber: 1, ethReceived: 0n, tokensIn };
        }
        // The position shrinks by what was sold, so the next cycle's slice is
        // drawn against a genuinely smaller balance.
        position -= tokensIn;
        return {
          approveHash: `0xap${index}`,
          sellHash: `0xse${index}`,
          status: 'confirmed',
          blockNumber: 1,
          ethReceived: parseEther('1'),
          tokensIn,
        };
      },
      tokenBalance: async () => position,
    },
    relay: {
      transfer: async ({ toAddress, amountWei }) => {
        const index = targets.findIndex((t) => t.address === toAddress) + 1;
        note('transfer', index, { amountWei });
        if (fail?.step === 'transfer' && fail.index === index) throw new Error('relay refused');
        balances[MAIN.address] -= amountWei;
        filled[toAddress] = amountWei;
        return { hash: `0xrl${index}`, requestId: `0xreq${index}`, depositAddress: '0xdep', amountWei };
      },
    },
    // The real sizing module, not a fake: it is pure arithmetic with its own
    // tests, and faking it here would hide whether the engine divides the
    // position correctly — which is the behaviour these tests are about.
    fillPollMs: 1,
    fillTimeoutMs: 20,
  };

  const engine = createEngine(deps);
  const input = {
    token: TOKEN,
    curve: CURVE,
    symbol: 'TEST',
    bigBuyWei: parseEther('5'),
    targets: targets.map((t) => ({ walletId: t.id, address: t.address })),
  };

  return {
    engine,
    clock,
    calls,
    logged,
    input,
    deps,
    balances,
    polls: () => polls,
    position: () => position,
  };
}

const steps = (calls) => calls.map((c) => `${c.step}${c.index}`);

test('cycle 0 is the big buy, and it happens before any transfer', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.advance(); // the first tick
  assert.deepEqual(steps(h.calls), ['buy0']);
});

test('one cycle per target, in the order given, each sell then transfer then buy', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  assert.deepEqual(steps(h.calls), [
    'buy0',
    'sell1', 'transfer1', 'buy1',
    'sell2', 'transfer2', 'buy2',
    'sell3', 'transfer3', 'buy3',
  ]);
  assert.equal(h.engine.status(USER).status, 'complete');
});

test('a transient read blip is retried in place, and the run continues', async () => {
  // readCurve throws twice, then succeeds — inside READ_RETRIES (3), so the cycle
  // recovers without halting.
  const h = harness({ readFailTimes: 2 });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  assert.equal(h.engine.status(USER).status, 'complete', 'the run finished despite the read blips');
  assert.deepEqual(steps(h.calls), [
    'buy0',
    'sell1', 'transfer1', 'buy1',
    'sell2', 'transfer2', 'buy2',
    'sell3', 'transfer3', 'buy3',
  ]);
});

test('a read that keeps failing past the retry budget still halts the run', async () => {
  const h = harness({ readFailTimes: 99 }); // never recovers
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const st = h.engine.status(USER);
  assert.equal(st.status, 'failed', 'a persistent read failure halts rather than spinning forever');
});

test('the run completes with every wallet marked done', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const job = h.engine.status(USER);
  assert.equal(job.completed, 3);
  assert.equal(job.failed, 0);
  assert.ok(job.cycles.filter((c) => c.kind === 'cycle').every((c) => c.state === 'done'));
});

test('the default interval is seven seconds', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  assert.equal(DEFAULT_INTERVAL_MS, 7000);
  // The first tick is immediate; every later one waits the interval.
  assert.deepEqual(h.clock.delays(), [0, 7000, 7000, 7000]);
});

test('the interval is a floor: a slow cycle does not bunch the next one', async () => {
  // Each cycle's work burns 9s of clock, which is longer than the interval.
  // The next cycle must start immediately rather than being scheduled into the
  // past and then racing to catch up.
  const clock = fakeClock();
  const h = harness({ clock, cycleCostMs: 8000, targets: [W1, W2] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const waits = h.clock.delays().slice(1);
  assert.ok(
    waits.every((d) => d === 0),
    `a cycle costing more than the interval must schedule the next at 0, got ${waits}`
  );
});

test('jitter defaults to off, so cycles are exactly intervalMs apart', async () => {
  const h = harness({ targets: [W1, W2] });
  await h.engine.start(USER, { ...h.input, intervalMs: 5000 });
  await h.clock.drain();
  assert.deepEqual(h.clock.delays(), [0, 5000, 5000]);
});

test('jitter stays within plus or minus jitterPct of the interval', async () => {
  for (const [roll, expected] of [[0, 8000 - 800], [1, 8000 + 800], [0.5, 8000]]) {
    const clock = fakeClock();
    const h = harness({ clock, targets: [W1, W2] });
    h.deps.randomFn = () => roll;
    const engine = createEngine(h.deps);
    await engine.start(USER, { ...h.input, intervalMs: 8000, jitterPct: 10 });
    await clock.drain();
    for (const d of clock.delays().slice(1)) {
      assert.ok(d >= 7200 && d <= 8800, `${d} outside +/-10% of 8000`);
    }
    assert.equal(clock.delays()[1], expected);
  }
});

test('a failed sell halts the run and keeps state', async () => {
  const h = harness({ fail: { step: 'sell', index: 2 } });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.equal(job.failure.step, 'selling');
  assert.equal(job.failure.walletId, 'w2');
  assert.match(job.failure.error, /sell reverted/);
  // Wallet 1 finished; wallet 3 was never touched.
  assert.deepEqual(steps(h.calls), ['buy0', 'sell1', 'transfer1', 'buy1', 'sell2']);
  assert.equal(h.clock.pending().length, 0, 'a halted run schedules nothing');
});

test('a failed transfer halts the run and keeps state', async () => {
  const h = harness({ fail: { step: 'transfer', index: 1 } });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.equal(job.failure.step, 'transferring');
  assert.match(job.failure.error, /relay refused/);
});

test('a failed buy halts the run and keeps state', async () => {
  const h = harness({ fail: { step: 'buy', index: 2 } });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.equal(job.failure.step, 'buying');
  assert.equal(job.failure.walletId, 'w2');
});

test('a big buy that reverts stops the run before any wallet is funded', async () => {
  const h = harness({ fail: { step: 'buy', index: 0 } });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  assert.equal(h.engine.status(USER).status, 'failed');
  assert.deepEqual(steps(h.calls), ['buy0']);
});

test('a fill that never arrives halts the run, naming the wallet and the request', async () => {
  const h = harness({ fillNever: true });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.equal(job.failure.step, 'waiting-fill');
  assert.match(job.failure.error, /0xreq1/, 'the requestId is how a stall is looked up on Relay');
  assert.match(job.failure.error, new RegExp(W1.address, 'i'));
});

test('a curve that graduates mid-run halts it', async () => {
  const h = harness({ graduatedAt: 2 });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.match(job.failure.error, /graduated/);
});

test('resume continues at the wallet that failed, not the next one', async () => {
  const h = harness({ fail: { step: 'buy', index: 2 } });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  assert.equal(h.engine.status(USER).failure.walletId, 'w2');

  // Clear the fault and resume.
  h.deps.trade.buy = async ({ wallet }) => {
    const index = targetIndex(h, wallet);
    h.calls.push({ step: 'buy', index, walletId: wallet.id });
    return { hash: '0xok', status: 'confirmed', blockNumber: 1, tokensOut: TOKENS(1) };
  };
  h.engine.resume(USER);
  await h.clock.drain();

  const job = h.engine.status(USER);
  assert.equal(job.status, 'complete');
  const buys = h.calls.filter((c) => c.step === 'buy').map((c) => c.walletId);
  assert.deepEqual(buys, ['main', 'w1', 'w2', 'w2', 'w3'], 'w2 is retried, w1 is not repeated');
});

function targetIndex(h, wallet) {
  return wallet.id === MAIN.id ? 0 : Number(wallet.id.slice(1));
}

test('resume refuses a job that is already complete', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  assert.throws(() => h.engine.resume(USER), /complete/);
});

test('resume refuses when there is no job', () => {
  const h = harness();
  assert.throws(() => h.engine.resume('nobody'), /no v3/);
});

test('stop halts the run and status stays readable', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.advance(); // big buy
  h.engine.stop(USER);
  await h.clock.drain();
  const job = h.engine.status(USER);
  assert.equal(job.status, 'stopped');
  assert.deepEqual(steps(h.calls), ['buy0'], 'nothing runs after a stop');
  assert.equal(h.clock.pending().length, 0);
});

test('a stopped run resumes where it left off', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.advance();
  h.engine.stop(USER);
  h.engine.resume(USER);
  await h.clock.drain();
  assert.equal(h.engine.status(USER).status, 'complete');
  assert.deepEqual(steps(h.calls), [
    'buy0', 'sell1', 'transfer1', 'buy1', 'sell2', 'transfer2', 'buy2', 'sell3', 'transfer3', 'buy3',
  ]);
});

test('a second start while running is refused', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await assert.rejects(() => h.engine.start(USER, h.input), /already running/);
});

test('two users run independently', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await assert.doesNotReject(() => h.engine.start('u2', h.input));
});

test('the transfer carries what the sell raised, less gas and a relay allowance', async () => {
  const h = harness({ targets: [W1] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const transfer = h.calls.find((c) => c.step === 'transfer');
  // The fake sell raises exactly 1 ETH. The transfer must be less than that —
  // the main wallet keeps its own next round of gas and the Relay fee back —
  // but not by much.
  assert.ok(transfer.amountWei < parseEther('1'), 'gas and the relay fee must be held back');
  assert.ok(transfer.amountWei > parseEther('0.9'), `held back too much: ${transfer.amountWei}`);
});

test('the buy spends everything that arrived, less gas', async () => {
  const h = harness({ targets: [W1] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const cycle = h.engine.status(USER).cycles.find((c) => c.kind === 'cycle');
  // Whatever the transfer delivered, minus gas — never a preset figure.
  assert.ok(Number(cycle.buyEth) < Number(cycle.transferredEth), 'gas must be left behind');
  assert.ok(
    Number(cycle.buyEth) > Number(cycle.transferredEth) * 0.99,
    `bought with ${cycle.buyEth} of the ${cycle.transferredEth} that arrived — too much held back`
  );
});

// THE DIVISION. Three wallets, one position: each cycle draws its slice from
// what is actually left, and the last one clears the rest.
test('the position is divided across the wallets and lands on zero', async () => {
  const h = harness({ targets: [W1, W2, W3] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  assert.equal(h.engine.status(USER).status, 'complete');
  assert.equal(h.position(), 0n, 'the last wallet must clear the position exactly');
});

test('the last cycle is flagged as the one taking the remainder', async () => {
  const h = harness({ targets: [W1, W2, W3] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const cycles = h.engine.status(USER).cycles.filter((c) => c.kind === 'cycle');
  assert.deepEqual(
    cycles.map((c) => c.finalSlice),
    [false, false, true]
  );
});

test('the final cycle keeps back only deposit gas, funding the last wallet more', async () => {
  // Every cycle raises the same 1 ETH in this harness, so the ONLY thing that changes the transfer
  // is how much gas the main keeps back: a full next-sell for the middle cycles, just THIS
  // transfer's deposit for the final one (there is no next sell). Over-reserving on the last,
  // thinnest slice is what left a route run's final wallet unable to cover its own buy gas.
  const h = harness({ targets: [W1, W2, W3] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const transfers = h.calls.filter((c) => c.step === 'transfer').map((c) => c.amountWei);
  assert.equal(transfers.length, 3);
  assert.ok(transfers[2] > transfers[0], 'the final wallet is funded more — no phantom next-sell reserve');
  assert.ok(transfers[2] > transfers[1]);
});

test('a token-quoted (route) run reserves route gas and a spike margin, and still completes', async () => {
  // End-to-end on a route curve: the engine sizes 4-leg sell / 3-leg buy gas and adds the
  // gas-spike margin, so each bundle wallet is funded with headroom above its buy gas. With the
  // harness's healthy 1-ETH-per-cycle sells the whole run still completes.
  const routed = harness({ isNativeQuote: false, targets: [W1, W2, W3] });
  const native = harness({ targets: [W1, W2, W3] });
  await routed.engine.start(USER, routed.input);
  await routed.clock.drain();
  await native.engine.start(USER, native.input);
  await native.clock.drain();

  assert.equal(routed.engine.status(USER).status, 'complete', 'the route run completes');
  const rBuys = routed.calls.filter((c) => c.step === 'buy' && c.index > 0);
  assert.equal(rBuys.length, 3, 'every bundle wallet bought');

  // A route wallet is funded with LESS than a native wallet from the same 1-ETH sell: more is held
  // back for the extra sell/buy legs plus the spike margin. That headroom is the whole point.
  const rT = routed.calls.filter((c) => c.step === 'transfer').map((c) => c.amountWei);
  const nT = native.calls.filter((c) => c.step === 'transfer').map((c) => c.amountWei);
  assert.ok(rT[0] < nT[0], 'a route cycle keeps back more (route gas + spike margin) than a native one');
});

test('every cycle sells a positive slice, none is starved', async () => {
  const h = harness({ targets: [W1, W2, W3] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  for (const s of h.calls.filter((c) => c.step === 'sell')) {
    assert.ok(s.tokensIn > 0n, 'a cycle that sells nothing leaves a hole in the tape');
  }
});

test('variance makes consecutive slices differ', async () => {
  // Rolls alternate between the ends of the band, so two adjacent cycles must
  // not sell the same amount.
  const clock = fakeClock();
  const h = harness({ clock, targets: [W1, W2, W3] });
  let n = 0;
  h.deps.randomFn = () => (n++ % 2 === 0 ? 0.05 : 0.95);
  const engine = createEngine(h.deps);
  await engine.start(USER, { ...h.input, variancePct: 40 });
  await clock.drain();
  const sells = h.calls.filter((c) => c.step === 'sell');
  assert.notEqual(sells[0].tokensIn, sells[1].tokensIn, 'identical slices are a machine signature');
});

test('a position that is already gone halts the run rather than selling nothing', async () => {
  const h = harness({ targets: [W1, W2] });
  h.deps.trade.tokenBalance = async () => 0n;
  const engine = createEngine(h.deps);
  await engine.start(USER, h.input);
  await h.clock.drain();
  const job = engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.match(job.failure.error, /nothing left to distribute/);
});

test('a thin curve quote halts the cycle BEFORE selling — no dust sell, no wedge', async () => {
  // Cycle 1 is healthy; at cycle 2 the curve returns a dust (valid, non-zero) quote reserve,
  // so a slice would raise almost nothing. The fix must catch this on the EXPECTED raise and
  // halt before the sell — otherwise a dust sell is recorded done and Resume re-hits it
  // forever, and re-selling would sell the position twice.
  const h = harness({ targets: [W1, W2, W3], thinCurveAt: 2 });
  await h.engine.start(USER, h.input);
  await h.clock.drain();

  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed', 'the thin cycle halts the run');
  assert.match(job.failure.error, /too thin|NOTHING WAS SOLD/i);

  // Cycle 1 sold once; cycle 2 must NOT have reached the sell at all.
  assert.deepEqual(
    steps(h.calls),
    ['buy0', 'sell1', 'transfer1', 'buy1'],
    'the run stops at cycle 2 BEFORE its sell — sell2 never happens'
  );
  const sells = h.calls.filter((c) => c.step === 'sell');
  assert.equal(sells.length, 1, 'exactly one sell happened — the position was not sold a second time');
  assert.equal(job.failure.step, 'selling', 'it halted in the sell step, before broadcasting');
});

test('a curve that becomes readyToGraduate mid-run halts before another sell', async () => {
  // The start route refuses readyToGraduate; the engine must re-check it every cycle too, or
  // a run whose own buys push the curve to the graduation line keeps selling into it.
  const h = harness({ targets: [W1, W2, W3], readyToGradAt: 2 });
  await h.engine.start(USER, h.input);
  await h.clock.drain();

  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.match(job.failure.error, /ready to graduate/i);
  assert.deepEqual(
    steps(h.calls),
    ['buy0', 'sell1', 'transfer1', 'buy1'],
    'it halts at cycle 2 before selling into a graduating curve'
  );
});

test('a cycle sell rejected by the floor halts resume-safe — nothing sold, no double sell', async () => {
  // At cycle 2 the sell reverts (the curve would have filled below the minQuoteOut floor). The
  // engine must halt with the position INTACT (the reverted sell decremented nothing) and
  // sellDone false, so Resume re-sizes and sells exactly once when the price is stable.
  const h = harness({ targets: [W1, W2, W3], sellRevertAt: 2 });
  await h.engine.start(USER, h.input);
  const posBefore = h.position();
  await h.clock.drain();

  const job = h.engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.match(job.failure.error, /reverted/i);
  assert.equal(job.failure.step, 'selling', 'it halts in the sell step');
  // cycle 1 sold and moved on; cycle 2's sell was attempted, reverted, and stopped the run.
  assert.deepEqual(steps(h.calls), ['buy0', 'sell1', 'transfer1', 'buy1', 'sell2']);
  // Cycle 1 reduced the position once; cycle 2's revert reduced it by nothing.
  const sells = h.calls.filter((c) => c.step === 'sell');
  assert.equal(sells.length, 2, 'sell2 was attempted');
  assert.equal(h.position(), posBefore - sells[0].tokensIn, 'only cycle 1 sold — the reverted cycle 2 sold nothing');
});

test('a graduated curve that also reports empty reserves still gives the graduated message', async () => {
  // The empty-reserve reject must not shadow the graduated halt: a graduated curve that
  // zeroes its reserves should still tell the operator to run the exit, not "empty reserves".
  const h = harness({ targets: [W1, W2] });
  const good = h.deps.trade.readCurve;
  h.deps.trade.readCurve = async (...args) => ({
    ...(await good(...args)),
    graduated: true,
    quoteReserve: 0n,
    tokenReserve: 0n,
  });
  const engine = createEngine(h.deps);
  await engine.start(USER, h.input);
  await h.clock.drain();
  const job = engine.status(USER);
  assert.equal(job.status, 'failed');
  assert.match(job.failure.error, /graduated/i, 'graduated message wins over empty-reserve');
});

test('an empty-reserve read is retried in place, not sold against', async () => {
  // A zero-reserve read is a transient RPC glitch, not a real state: it must be retried
  // (within the read-retry budget) rather than trusted and sold against as a dust position.
  const h = harness({ targets: [W1, W2] });
  let firstReadDone = false;
  const good = h.deps.trade.readCurve;
  h.deps.trade.readCurve = async (...args) => {
    const c = await good(...args);
    // Make only the very first read of cycle 1 come back with empty reserves.
    if (!firstReadDone) {
      firstReadDone = true;
      return { ...c, quoteReserve: 0n, tokenReserve: 0n };
    }
    return c;
  };
  const engine = createEngine(h.deps);
  await engine.start(USER, h.input);
  await h.clock.drain();
  assert.equal(engine.status(USER).status, 'complete', 'the empty read was retried and the run finished');
});

test('start refuses an interval below the floor', async () => {
  const h = harness();
  await assert.rejects(() => h.engine.start(USER, { ...h.input, intervalMs: MIN_INTERVAL_MS - 1 }), /interval/);
});

test('start refuses jitter above the cap', async () => {
  const h = harness();
  await assert.rejects(
    () => h.engine.start(USER, { ...h.input, jitterPct: MAX_JITTER_PCT + 1 }),
    /jitter/
  );
});

test('start refuses no targets', async () => {
  const h = harness();
  await assert.rejects(() => h.engine.start(USER, { ...h.input, targets: [] }), /wallet/);
});

test('start refuses a target with no address', async () => {
  const h = harness();
  await assert.rejects(
    () => h.engine.start(USER, { ...h.input, targets: [{ walletId: 'w1' }] }),
    /address/
  );
});

test('start refuses the same wallet twice', async () => {
  const h = harness();
  const twice = [
    { walletId: 'w1', address: W1.address },
    { walletId: 'w1', address: W1.address },
  ];
  await assert.rejects(() => h.engine.start(USER, { ...h.input, targets: twice }), /twice/);
});

test('start refuses a variance above the cap', async () => {
  const h = harness();
  await assert.rejects(() => h.engine.start(USER, { ...h.input, variancePct: 91 }), /variance/);
});

test('start refuses a non-positive big buy', async () => {
  const h = harness();
  await assert.rejects(() => h.engine.start(USER, { ...h.input, bigBuyWei: 0n }), /big buy/);
});

test('every step is written to the activity log as it happens', async () => {
  const h = harness({ targets: [W1] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const summaries = h.logged.map((l) => l.summary).join('\n');
  assert.match(summaries, /started/);
  assert.match(summaries, /big buy/);
  assert.match(summaries, /sold/);
  assert.match(summaries, /transferred/i);
  assert.match(summaries, /bought/);
  assert.match(summaries, /complete/);
  assert.ok(h.logged.every((l) => l.kind === 'v3'), 'every entry is tagged v3');
});

test('status of an unknown user is an idle shape, not a throw', () => {
  const h = harness();
  const job = h.engine.status('nobody');
  assert.equal(job.status, 'idle');
  assert.equal(job.running, false);
});

test('the public job never contains a BigInt', async () => {
  const h = harness();
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const seen = JSON.stringify(h.engine.status(USER)); // throws on a BigInt
  assert.ok(seen.length > 0);
});
