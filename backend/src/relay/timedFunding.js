'use strict';

// Server-side scheduler for v2 Relay funding.
//
// The browser should be able to close without killing the funding cadence, so
// the timer lives here, not in React. It deliberately calls the existing
// fundV2Bundle() helper with ONE target at a time: all v2-only checks, Relay
// quote validation and refreshed fee handling stay in one place.

const { randomUUID } = require('crypto');
const relayFunding = require('./funding');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;

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

function publicTarget(job, target, index) {
  let state = 'pending';
  if (index < job.currentIndex) state = 'done';
  if (index === job.currentIndex && job.status === 'running') state = job.inFlight ? 'funding' : 'next';
  return { ...target, index, state };
}

function publicJob(job) {
  if (!job) return { protocol: 'v2', mode: 'relay-solver-timed', status: 'idle', running: false };
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

  async function runNext(userId) {
    const job = jobs.get(userId);
    if (!job || job.status !== 'running' || job.inFlight) return publicJob(job);

    if (job.currentIndex >= job.targets.length) {
      job.status = 'complete';
      job.completedAt = iso(nowFn());
      job.nextRunAt = null;
      job.updatedAt = job.completedAt;
      log(userId, `[v2] timed Relay funding complete: ${job.results.length}/${job.targets.length} wallet(s) attempted`, {
        mode: job.mode,
        jobId: job.id,
        sent: job.results.filter((r) => r.hash || r.simulated).length,
        failed: job.results.filter((r) => r.error || r.status === 'failed').length,
      });
      return publicJob(job);
    }

    const index = job.currentIndex;
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

      if (job.status !== 'running') return publicJob(job);

      if (job.currentIndex >= job.targets.length) {
        job.status = 'complete';
        job.completedAt = iso(nowFn());
        job.nextRunAt = null;
        job.updatedAt = job.completedAt;
        log(userId, `[v2] timed Relay funding complete: ${job.results.length}/${job.targets.length} wallet(s) attempted`, {
          mode: job.mode,
          jobId: job.id,
          sent: job.results.filter((r) => r.hash || r.simulated).length,
          failed: job.results.filter((r) => r.error || r.status === 'failed').length,
        });
      } else {
        schedule(job, job.intervalMs);
      }
    }

    return publicJob(job);
  }

  function start(userId, targets, { intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}) {
    const existing = jobs.get(userId);
    if (existing?.status === 'running') throw new Error('a v2 timed funding job is already running');
    if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');

    const ks = keystoreForFn(userId);
    const planned = relayFunding._private.planTargets(targets, ks);
    const intervalMs = intervalMsFrom(intervalMinutes, { minIntervalMs });
    const startedAt = iso(nowFn());
    const job = {
      id: idFn(),
      userId,
      protocol: 'v2',
      mode: 'relay-solver-timed',
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
    log(userId, `[v2] timed Relay funding started for ${job.targets.length} wallet(s)`, {
      mode: job.mode,
      jobId: job.id,
      intervalMinutes: job.intervalMs / 60_000,
      targets: job.targets,
    });
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
module.exports._private = { intervalMsFrom, publicJob };
