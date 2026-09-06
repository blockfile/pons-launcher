'use strict';

/**
 * The server-held, paced version of V8's fan-out: one Relay transfer per interval, over
 * the same sender and the same money path.
 *
 * WHY THE TIMER LIVES HERE AND NOT IN REACT. A fan-out across many wallets at a
 * human-looking cadence takes hours; the browser must be able to close, sleep or crash
 * without stopping it. So the job is held on the server, keyed by user, and the console
 * just polls GET /api/v8/transfer/timed to draw it. Stopping and resuming are explicit
 * operator actions, not a side effect of a tab closing.
 *
 * MODELLED ON relay/timedFunding.js, and V8-owned per the tab-isolation rule. It calls
 * v8/relayTransfer.transfer() with exactly ONE target at a time, so every v8-only check
 * (is this really a v8bundle wallet), the Relay quote validation, the drain guard, the
 * fee refresh and the balance check stay in one place and cannot drift between the
 * one-shot and the timed path.
 *
 * ONE JOB PER ACCOUNT. Starting a second while one is running — or while one is still
 * draining an in-flight deposit — is refused: two schedulers signing the same main wallet
 * would collide on a nonce.
 */

const { randomUUID } = require('crypto');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const relayTransfer = require('./relayTransfer');

const DEFAULT_INTERVAL_MINUTES = 30;

// A floor, not a preference. Relay rate-limits /quote per IP at roughly five per window
// and each 429 re-arms the block, so a sub-minute cadence across many wallets would spend
// the run fighting the limiter. An operator who wants a faster fan-out uses the one-shot
// POST /api/v8/transfer, which paces itself in seconds inside a single request.
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;

const iso = (ms) => new Date(ms).toISOString();
const errorMessage = (err) => err?.shortMessage || err?.reason || err?.message || String(err);

function intervalMsFrom(minutes, { minIntervalMs = MIN_INTERVAL_MS } = {}) {
  const raw = minutes === undefined || minutes === null || minutes === '' ? DEFAULT_INTERVAL_MINUTES : minutes;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('intervalMinutes must be a positive number');
  const ms = Math.round(n * 60_000);
  if (ms < minIntervalMs) throw new Error(`intervalMinutes must be at least ${minIntervalMs / 60_000}`);
  if (ms > MAX_INTERVAL_MS) throw new Error('intervalMinutes must be 1440 or less');
  return ms;
}

function publicTarget(job, target, index) {
  let state = 'pending';
  if (index < job.currentIndex) state = 'done';
  if (index === job.currentIndex && job.status === 'running') state = job.inFlight ? 'sending' : 'next';
  return { walletId: target.walletId, address: target.address, amountEth: target.amountEth, index, state };
}

function publicJob(job) {
  if (!job) return { protocol: 'v8', mode: 'relay-transfer-timed', status: 'idle', running: false };
  const sent = job.results.filter((r) => r.hash || r.simulated).length;
  const failed = job.results.filter((r) => r.error || r.status === 'failed').length;
  return {
    id: job.id,
    userId: job.userId,
    protocol: 'v8',
    mode: 'relay-transfer-timed',
    status: job.status,
    running: job.status === 'running',
    inFlight: job.inFlight,
    intervalMs: job.intervalMs,
    intervalMinutes: job.intervalMs / 60_000,
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
    targets: job.targets.map((t, i) => publicTarget(job, t, i)),
    results: job.results.map((r) => ({ ...r })),
  };
}

function createTimedTransferManager({
  transferFn = relayTransfer.transfer,
  planTargetsFn = relayTransfer.planTargets,
  keystoreForFn = keystoreFor,
  activityForFn = activityFor,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  idFn = randomUUID,
  minIntervalMs = MIN_INTERVAL_MS,
} = {}) {
  const jobs = new Map();

  const log = (userId, summary, detail = {}) => activityForFn(userId).record('v8', summary, detail);

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
        // runNext already isolates a per-wallet failure; reaching here means the machinery
        // itself broke (a keystore that will not open, say). Stop rather than spin, and
        // say so in the log — the job can be resumed once the cause is fixed.
        job.status = 'stopped';
        job.inFlight = false;
        job.nextRunAt = null;
        job.updatedAt = iso(nowFn());
        log(job.userId, `[v8] timed Relay transfer stopped — ${errorMessage(err)}`, {
          jobId: job.id,
          error: errorMessage(err),
        });
      }
    }, delayMs);
    if (typeof job.timer?.unref === 'function') job.timer.unref();
  }

  function finish(job) {
    job.status = 'complete';
    job.completedAt = iso(nowFn());
    job.nextRunAt = null;
    job.updatedAt = job.completedAt;
    log(job.userId, `[v8] timed Relay transfer complete: ${job.results.length}/${job.targets.length} wallet(s) attempted`, {
      jobId: job.id,
      sent: job.results.filter((r) => r.hash || r.simulated).length,
      failed: job.results.filter((r) => r.error || r.status === 'failed').length,
    });
  }

  async function runNext(userId) {
    const job = jobs.get(userId);
    if (!job || job.status !== 'running' || job.inFlight) return publicJob(job);
    if (job.currentIndex >= job.targets.length) {
      finish(job);
      return publicJob(job);
    }

    const index = job.currentIndex;
    const target = job.targets[index];
    const dueAt = job.nextRunAt || iso(nowFn());
    job.inFlight = true;
    job.updatedAt = iso(nowFn());

    const entry = {
      index,
      dueAt,
      startedAt: iso(nowFn()),
      walletId: target.walletId,
      address: target.address,
      amountEth: target.amountEth,
      status: 'sending',
    };

    try {
      const ks = keystoreForFn(userId);
      const out = await transferFn([{ walletId: target.walletId, amountEth: target.amountEth }], { keystore: ks });
      const [result] = out.results || [];
      Object.assign(entry, result || {});
      entry.status = result?.error ? 'failed' : 'sent';
      entry.finishedAt = iso(nowFn());
      log(
        userId,
        `[v8] timed Relay transfer ${index + 1}/${job.targets.length}: ${target.walletId}` +
          (entry.error ? ' failed before the deposit' : ` — ${target.amountEth} ETH`),
        {
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
      // One wallet failing is recorded against that wallet; the cadence carries on.
      entry.status = 'failed';
      entry.error = errorMessage(err);
      entry.finishedAt = iso(nowFn());
      log(userId, `[v8] timed Relay transfer ${index + 1}/${job.targets.length} failed: ${target.walletId}`, {
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
      // A stop() that landed while this wallet was in flight is honoured here: the result
      // is still recorded, and nothing further is scheduled.
      if (job.status === 'running') {
        if (job.currentIndex >= job.targets.length) finish(job);
        else schedule(job, job.intervalMs);
      }
    }

    return publicJob(job);
  }

  function start(userId, targets, { intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}) {
    const existing = jobs.get(userId);
    // Refused while one is running OR still draining an in-flight deposit (stop/complete
    // flips status before the last transfer resolves) — a second scheduler on the same
    // main wallet would sign at a nonce the in-flight deposit still holds.
    if (existing?.status === 'running' || existing?.inFlight) {
      throw new Error('a v8 timed transfer job is already running for this account');
    }

    const ks = keystoreForFn(userId);
    const planned = planTargetsFn(targets, ks); // every target validated before the first tick
    const intervalMs = intervalMsFrom(intervalMinutes, { minIntervalMs });

    const startedAt = iso(nowFn());
    const job = {
      id: idFn(),
      userId,
      status: 'running',
      inFlight: false,
      intervalMs,
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
    log(userId, `[v8] timed Relay transfer started for ${job.targets.length} wallet(s)`, {
      jobId: job.id,
      intervalMinutes: job.intervalMs / 60_000,
      targets: job.targets,
    });
    schedule(job, 0); // the first wallet goes immediately; the rest are intervalMs apart
    return publicJob(job);
  }

  function stop(userId) {
    const job = jobs.get(userId);
    if (!job || job.status !== 'running') return publicJob(job);
    clear(job);
    job.status = 'stopped';
    job.stoppedAt = iso(nowFn());
    job.updatedAt = job.stoppedAt;
    log(userId, `[v8] timed Relay transfer stopped at ${job.currentIndex}/${job.targets.length}`, {
      jobId: job.id,
      currentIndex: job.currentIndex,
      total: job.targets.length,
    });
    return publicJob(job);
  }

  /**
   * Pick a stopped job back up where it left off. The remaining wallets keep their planned
   * amounts, and the wallets already done are not re-sent — currentIndex is the record of
   * what has been paid, so resuming can never pay a wallet twice.
   */
  function resume(userId) {
    const job = jobs.get(userId);
    if (!job) throw new Error('no v8 timed transfer job to resume');
    if (job.status === 'running') return publicJob(job);
    if (job.status === 'complete') throw new Error('the v8 timed transfer job is already complete');
    if (job.currentIndex >= job.targets.length) throw new Error('the v8 timed transfer job has no remaining wallets');

    job.status = 'running';
    job.stoppedAt = null;
    job.updatedAt = iso(nowFn());
    // Honour whatever was left of the interval when it was stopped, rather than firing
    // immediately and bunching two transfers together.
    const oldDue = job.nextRunAt ? Date.parse(job.nextRunAt) : nowFn();
    const delayMs = Math.max(0, oldDue - nowFn());
    log(userId, `[v8] timed Relay transfer resumed at ${job.currentIndex}/${job.targets.length}`, {
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

  function isRunning(userId) {
    const job = jobs.get(userId);
    return Boolean(job && (job.status === 'running' || job.inFlight));
  }

  function reset() {
    for (const job of jobs.values()) clear(job);
    jobs.clear();
  }

  return { start, stop, resume, status, isRunning, _runNext: runNext, _reset: reset, _jobs: jobs };
}

const singleton = createTimedTransferManager();

module.exports = singleton;
module.exports.createTimedTransferManager = createTimedTransferManager;
module.exports.DEFAULT_INTERVAL_MINUTES = DEFAULT_INTERVAL_MINUTES;
module.exports.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
module.exports.MAX_INTERVAL_MS = MAX_INTERVAL_MS;
module.exports._private = { intervalMsFrom, publicJob };
