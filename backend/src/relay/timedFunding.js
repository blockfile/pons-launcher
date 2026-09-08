'use strict';

// Server-side scheduler for v2 Relay funding.
//
// The browser should be able to close without killing the funding cadence, so
// the timer lives here, not in React. It deliberately calls the existing
// fundV2Bundle() helper with ONE target at a time: all v2-only checks, Relay
// quote validation and refreshed fee handling stay in one place.
//
// WHY THIS PATH AND NOT relay/funding.js's OWN MANY-WALLET RUN. That one quotes
// and sends every wallet inside a single HTTP request; a 23-wallet run held the
// connection for ~6 minutes and nginx cut it at its 180s proxy_read_timeout. The
// backend finished the run anyway (the dev nonce went 7 -> 29 after the 504) but
// the console lost the reply and could report neither progress nor failure. Here
// each request is short — start, stop, resume, poll — so nothing times out and
// the operator can watch a long run land wallet by wallet.
//
// A TICK MAY NOW COVER SEVERAL WALLETS, because one-per-minute meant 31 minutes
// for a 31-wallet bundle. It is still ONE fundV2Bundle() CALL PER WALLET, run
// sequentially with a gap — the batch is a loop around the existing single-target
// call, never an array handed to it, so the sentence at the top of this comment
// stays true and funding.js's own batch pacing (RELAY_QUOTE_BATCH_SIZE/_GAP_MS,
// tuned for the long-POST shape) is not involved.

const { randomUUID } = require('crypto');
const relayFunding = require('./funding');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;

// WALLETS PER TICK, AND WHY THE CEILING IS FOUR.
//
// Relay's /quote rate limit on this box is MEASURED, not guessed: about four
// quotes land per 60s window per IP, an API key does NOT lift it, and firing
// while blocked RE-ARMS the penalty — which is how a 4s-gap run ended up taking
// 43s per wallet instead of 4s. Every wallet in a tick costs exactly one quote,
// and the floor on the interval is 60s, so a tick of four is the fastest cadence
// that still averages inside the measured budget. Asking for more is refused
// with that reason rather than discovered against the live limiter.
//
// The default is ONE, so an operator who changes nothing gets exactly the
// cadence this scheduler has always had.
const DEFAULT_WALLETS_PER_TICK = 1;
const MAX_WALLETS_PER_TICK = 4;

// The pause BETWEEN wallets inside one tick — not before the first, not after
// the last. Four quotes fired back-to-back is the same burst shape that tripped
// the limiter before gaps were introduced in funding.js; spreading them keeps a
// tick under the budget with margin, and 4s is the same spacing that path
// already treats as safe between individual quotes.
const PER_TICK_GAP_MS = 4_000;

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function iso(ms) {
  return new Date(ms).toISOString();
}

function errorMessage(err) {
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

function intervalMsFrom(minutes, { minIntervalMs = MIN_INTERVAL_MS } = {}) {
  const raw = minutes === undefined || minutes === null || minutes === '' ? DEFAULT_INTERVAL_MINUTES : minutes;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('intervalMinutes must be a positive number');
  const ms = Math.round(n * 60_000);
  if (ms < minIntervalMs) throw new Error(`intervalMinutes must be at least ${minIntervalMs / 60_000}`);
  if (ms > MAX_INTERVAL_MS) throw new Error('intervalMinutes must be 1440 or less');
  return ms;
}

// How many wallets one tick may fund. Refused above the cap WITH THE REASON, so
// an operator who types 20 reads why four is the ceiling instead of meeting
// Relay's limiter mid-run and watching every remaining quote get thrown back.
function walletsPerTickFrom(value, { maxPerTick = MAX_WALLETS_PER_TICK } = {}) {
  const raw = value === undefined || value === null || value === '' ? DEFAULT_WALLETS_PER_TICK : value;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error('walletsPerTick must be a whole number of at least 1');
  if (n > maxPerTick) {
    throw new Error(
      `walletsPerTick must be ${maxPerTick} or less — Relay allows only about ${maxPerTick} quotes a minute ` +
        'from one IP, an API key does not lift it, and quoting while blocked re-arms the block'
    );
  }
  return n;
}

function publicTarget(job, target, index) {
  let state = 'pending';
  if (index < job.currentIndex) state = 'done';
  if (index === job.currentIndex && job.status === 'running') state = job.inFlight ? 'funding' : 'next';
  return { ...target, index, state };
}

function publicJob(job) {
  if (!job) {
    return {
      protocol: 'v2',
      mode: 'relay-solver-timed',
      status: 'idle',
      running: false,
      // Served even when idle: the console draws the cap and the rate it implies
      // BEFORE a job exists, and a number it invented itself would drift from
      // the one that actually refuses the request.
      walletsPerTick: DEFAULT_WALLETS_PER_TICK,
      maxWalletsPerTick: MAX_WALLETS_PER_TICK,
    };
  }
  const failed = job.results.filter((r) => r.error || r.status === 'failed').length;
  const sent = job.results.filter((r) => r.hash || r.simulated).length;
  return {
    id: job.id,
    userId: job.userId,
    protocol: 'v2',
    mode: 'relay-solver-timed',
    status: job.status,
    running: job.status === 'running',
    inFlight: job.inFlight,
    intervalMs: job.intervalMs,
    intervalMinutes: job.intervalMs / 60_000,
    walletsPerTick: job.walletsPerTick,
    maxWalletsPerTick: job.maxWalletsPerTick,
    perTickGapMs: job.perTickGapMs,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    stoppedAt: job.stoppedAt || null,
    completedAt: job.completedAt || null,
    nextRunAt: job.nextRunAt || null,
    currentIndex: job.currentIndex,
    total: job.targets.length,
    completed: job.results.length,
    remaining: Math.max(0, job.targets.length - job.currentIndex),
    sent,
    failed,
    targets: job.targets.map((target, index) => publicTarget(job, target, index)),
    results: job.results.map((r) => ({ ...r })),
  };
}

function createTimedFundingManager({
  relayFund = relayFunding.fundV2Bundle,
  keystoreForFn = keystoreFor,
  activityForFn = activityFor,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  idFn = randomUUID,
  minIntervalMs = MIN_INTERVAL_MS,
  // The wait between wallets INSIDE a tick. Separate from setTimeoutFn on
  // purpose: that one is the scheduler's clock, which tests drive by hand, while
  // this one is a real pause the batch loop awaits.
  sleepFn = sleep,
  perTickGapMs = PER_TICK_GAP_MS,
  maxPerTick = MAX_WALLETS_PER_TICK,
} = {}) {
  const jobs = new Map();

  function log(userId, summary, detail = {}) {
    activityForFn(userId).record('fund', summary, detail);
  }

  function clear(job) {
    if (job?.timer) clearTimeoutFn(job.timer);
    if (job) job.timer = null;
  }

  function schedule(job, delayMs) {
    clear(job);
    if (job.status !== 'running') return;
    job.nextRunAt = iso(nowFn() + delayMs);
    job.updatedAt = iso(nowFn());
    job.timer = setTimeoutFn(async () => {
      job.timer = null;
      try {
        await runNext(job.userId);
      } catch (err) {
        job.status = 'stopped';
        job.inFlight = false;
        job.nextRunAt = null;
        job.updatedAt = iso(nowFn());
        log(job.userId, `[v2] timed Relay funding stopped — ${errorMessage(err)}`, {
          mode: job.mode,
          jobId: job.id,
          error: errorMessage(err),
        });
      }
    }, delayMs);
    if (typeof job.timer?.unref === 'function') job.timer.unref();
  }

  function markComplete(job) {
    job.status = 'complete';
    job.completedAt = iso(nowFn());
    job.nextRunAt = null;
    job.updatedAt = job.completedAt;
    log(
      job.userId,
      `[v2] timed Relay funding complete: ${job.results.length}/${job.targets.length} wallet(s) attempted`,
      {
        mode: job.mode,
        jobId: job.id,
        sent: job.results.filter((r) => r.hash || r.simulated).length,
        failed: job.results.filter((r) => r.error || r.status === 'failed').length,
      }
    );
  }

  // ONE WALLET. The whole of the per-wallet contract lives here and nowhere
  // else: exactly one fundV2Bundle() call with exactly one target, a failure
  // RECORDED rather than thrown, and `currentIndex` advanced exactly once in a
  // `finally` — so a wallet that has been attempted can never be attempted
  // again, whatever happens around this call. currentIndex is the only thing
  // between a resumed job and a second deposit to a wallet that already got one.
  async function fundOne(job, index) {
    const userId = job.userId;
    const target = job.targets[index];
    const dueAt = job.nextRunAt || iso(nowFn());
    const startedAt = iso(nowFn());
    job.inFlight = true;
    job.updatedAt = startedAt;

    const entry = {
      index,
      dueAt,
      startedAt,
      walletId: target.walletId,
      address: target.address,
      amountEth: target.amountEth,
      status: 'funding',
    };

    try {
      const ks = keystoreForFn(userId);
      const out = await relayFund([{ walletId: target.walletId, amountEth: target.amountEth }], { keystore: ks });
      const [result] = out.results || [];
      Object.assign(entry, result || {});
      entry.status = result?.error ? 'failed' : 'sent';
      entry.finishedAt = iso(nowFn());
      log(
        userId,
        `[v2] timed Relay funded ${index + 1}/${job.targets.length}: ${target.walletId}` +
          (entry.error ? ' failed before deposit' : ''),
        {
          mode: job.mode,
          jobId: job.id,
          walletId: target.walletId,
          address: target.address,
          amountEth: target.amountEth,
          requestId: entry.requestId,
          depositAddress: entry.depositAddress,
          hash: entry.hash,
          error: entry.error,
        }
      );
    } catch (err) {
      entry.status = 'failed';
      entry.error = errorMessage(err);
      entry.finishedAt = iso(nowFn());
      log(userId, `[v2] timed Relay funding ${index + 1}/${job.targets.length} failed: ${target.walletId}`, {
        mode: job.mode,
        jobId: job.id,
        walletId: target.walletId,
        address: target.address,
        amountEth: target.amountEth,
        error: entry.error,
      });
    } finally {
      job.results.push(entry);
      job.currentIndex = index + 1;
      job.inFlight = false;
      job.updatedAt = iso(nowFn());
    }

    return entry;
  }

  // ONE TICK — up to `walletsPerTick` wallets, one fundV2Bundle() call each,
  // sequentially, with `perTickGapMs` between them.
  //
  // EVERY WAY OUT OF A PARTIAL BATCH LEAVES currentIndex ON THE FIRST
  // UNATTEMPTED WALLET. Stop pressed mid-batch (checked before each wallet and
  // again after the gap), the job running out of targets mid-batch, or an
  // unexpected throw between wallets: fundOne has already advanced past every
  // wallet it touched and past no wallet it did not, so a resume picks up
  // exactly where this left off and no wallet is funded twice.
  //
  // The next tick is scheduled ONCE, after the batch — not per wallet.
  async function runNext(userId) {
    const job = jobs.get(userId);
    if (!job || job.status !== 'running' || job.inFlight || job.ticking) return publicJob(job);

    if (job.currentIndex >= job.targets.length) {
      markComplete(job);
      return publicJob(job);
    }

    // Floored at one: a job that somehow carried a zero would fund nobody and
    // reschedule itself for ever, which reads as a hang rather than a refusal.
    const perTick = Math.max(1, Number(job.walletsPerTick) || 1);
    const gapMs = Math.max(0, Number(job.perTickGapMs) || 0);

    job.ticking = true;
    try {
      for (let n = 0; n < perTick; n += 1) {
        if (job.status !== 'running' || job.currentIndex >= job.targets.length) break;
        if (n > 0 && gapMs > 0) {
          await sleepFn(gapMs);
          // Stop can land during the gap, and a stopped job must not spend.
          if (job.status !== 'running' || job.currentIndex >= job.targets.length) break;
        }
        await fundOne(job, job.currentIndex);
      }
    } finally {
      job.ticking = false;
      job.inFlight = false;
    }

    if (job.status !== 'running') return publicJob(job);

    if (job.currentIndex >= job.targets.length) markComplete(job);
    else schedule(job, job.intervalMs);

    return publicJob(job);
  }

  function start(
    userId,
    targets,
    { intervalMinutes = DEFAULT_INTERVAL_MINUTES, walletsPerTick = DEFAULT_WALLETS_PER_TICK } = {}
  ) {
    const existing = jobs.get(userId);
    if (existing?.status === 'running') throw new Error('a v2 timed funding job is already running');
    if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');

    const ks = keystoreForFn(userId);
    const planned = relayFunding._private.planTargets(targets, ks);
    const intervalMs = intervalMsFrom(intervalMinutes, { minIntervalMs });
    const perTick = walletsPerTickFrom(walletsPerTick, { maxPerTick });
    const startedAt = iso(nowFn());
    const job = {
      id: idFn(),
      userId,
      protocol: 'v2',
      mode: 'relay-solver-timed',
      status: 'running',
      inFlight: false,
      ticking: false,
      intervalMs,
      walletsPerTick: perTick,
      maxWalletsPerTick: maxPerTick,
      perTickGapMs,
      startedAt,
      updatedAt: startedAt,
      stoppedAt: null,
      completedAt: null,
      nextRunAt: null,
      currentIndex: 0,
      targets: planned.map((p) => ({ walletId: p.walletId, address: p.address, amountEth: p.amountEth })),
      results: [],
      timer: null,
    };
    jobs.set(userId, job);
    log(
      userId,
      `[v2] timed Relay funding started for ${job.targets.length} wallet(s), ` +
        `${job.walletsPerTick} per ${job.intervalMs / 60_000} min`,
      {
        mode: job.mode,
        jobId: job.id,
        intervalMinutes: job.intervalMs / 60_000,
        walletsPerTick: job.walletsPerTick,
        targets: job.targets,
      }
    );
    schedule(job, 0);
    return publicJob(job);
  }

  function stop(userId) {
    const job = jobs.get(userId);
    if (!job) return publicJob(job);
    if (job.status !== 'running') return publicJob(job);
    clear(job);
    job.status = 'stopped';
    job.stoppedAt = iso(nowFn());
    job.updatedAt = job.stoppedAt;
    log(userId, `[v2] timed Relay funding stopped at ${job.currentIndex}/${job.targets.length}`, {
      mode: job.mode,
      jobId: job.id,
      currentIndex: job.currentIndex,
      total: job.targets.length,
    });
    return publicJob(job);
  }

  function resume(userId) {
    const job = jobs.get(userId);
    if (!job) throw new Error('no v2 timed funding job to resume');
    if (job.status === 'running') return publicJob(job);
    if (job.status === 'complete') throw new Error('v2 timed funding job is already complete');
    if (job.currentIndex >= job.targets.length) throw new Error('v2 timed funding job has no remaining wallets');

    job.status = 'running';
    job.stoppedAt = null;
    job.updatedAt = iso(nowFn());
    const oldDue = job.nextRunAt ? Date.parse(job.nextRunAt) : nowFn();
    const delayMs = Math.max(0, oldDue - nowFn());
    log(userId, `[v2] timed Relay funding resumed at ${job.currentIndex}/${job.targets.length}`, {
      mode: job.mode,
      jobId: job.id,
      currentIndex: job.currentIndex,
      total: job.targets.length,
    });
    schedule(job, delayMs);
    return publicJob(job);
  }

  function status(userId) {
    return publicJob(jobs.get(userId));
  }

  function reset() {
    for (const job of jobs.values()) clear(job);
    jobs.clear();
  }

  return { start, stop, resume, status, _runNext: runNext, _reset: reset, _jobs: jobs };
}

const singleton = createTimedFundingManager();

module.exports = singleton;
module.exports.createTimedFundingManager = createTimedFundingManager;
module.exports.DEFAULT_INTERVAL_MINUTES = DEFAULT_INTERVAL_MINUTES;
module.exports.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
module.exports.MAX_INTERVAL_MS = MAX_INTERVAL_MS;
module.exports.DEFAULT_WALLETS_PER_TICK = DEFAULT_WALLETS_PER_TICK;
module.exports.MAX_WALLETS_PER_TICK = MAX_WALLETS_PER_TICK;
module.exports.PER_TICK_GAP_MS = PER_TICK_GAP_MS;
module.exports._private = { intervalMsFrom, walletsPerTickFrom, publicJob };
