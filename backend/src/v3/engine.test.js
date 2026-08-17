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
  clock = fakeClock(),
  cycleCostMs = 0, // how long each cycle's work takes on the fake clock
} = {}) {
  const calls = [];
  const logged = [];
  const balances = { [MAIN.address]: parseEther('50') };
  let polls = 0;

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
        return polls >= fillAfter ? parseEther('1') : 0n;
      },
    },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    trade: {
      readCurve: async () => ({
        address: CURVE,
        token: TOKEN,
        isNativeQuote: true,
        quoteReserve: parseEther('40'),
        tokenReserve: TOKENS(800_000_000),
        feeBps: 100,
        creatorTaxBps: 100,
        graduated: graduatedAt !== null && calls.filter((c) => c.step === 'buy').length >= graduatedAt,
        readyToGraduate: false,
      }),
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
        return {
          approveHash: `0xap${index}`,
          sellHash: `0xse${index}`,
          status: 'confirmed',
          blockNumber: 1,
          ethReceived: parseEther('1'),
          tokensIn,
        };
      },
      tokenBalance: async () => TOKENS(1_000_000),
    },
    relay: {
      transfer: async ({ toAddress, amountWei }) => {
        const index = targets.findIndex((t) => t.address === toAddress) + 1;
        note('transfer', index, { amountWei });
        if (fail?.step === 'transfer' && fail.index === index) throw new Error('relay refused');
        balances[MAIN.address] -= amountWei;
        return { hash: `0xrl${index}`, requestId: `0xreq${index}`, depositAddress: '0xdep', amountWei };
      },
    },
    sizing: {
      tokensToRaise: () => TOKENS(5000),
    },
    fillPollMs: 1,
    fillTimeoutMs: 20,
  };

  const engine = createEngine(deps);
  const input = {
    token: TOKEN,
    curve: CURVE,
    symbol: 'TEST',
    bigBuyWei: parseEther('5'),
    targets: targets.map((t) => ({ walletId: t.id, address: t.address, buyWei: parseEther('0.1') })),
  };

  return { engine, clock, calls, logged, input, deps, balances, polls: () => polls };
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

test('the transfer carries the buy amount plus a gas reserve, not the bare buy', async () => {
  const h = harness({ targets: [W1] });
  await h.engine.start(USER, h.input);
  await h.clock.drain();
  const transfer = h.calls.find((c) => c.step === 'transfer');
  assert.ok(
    transfer.amountWei > parseEther('0.1'),
    'a wallet funded with exactly its buy cannot pay the gas to make it'
  );
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

test('start refuses a target with no buy amount', async () => {
  const h = harness();
  const targets = [{ walletId: 'w1', address: W1.address, buyWei: 0n }];
  await assert.rejects(() => h.engine.start(USER, { ...h.input, targets }), /positive/);
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
