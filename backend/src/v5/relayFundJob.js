'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — the PACING scheduler for Relay-solver bundle funding.
//
// The operator wants each bundle wallet funded through Relay with an 8-9s gap
// between transfers (both to stay under Relay's ~5-per-window /quote rate limit
// and so the deposits do not land as one obvious burst). The timer lives on the
// SERVER, not in React, so the browser can be closed without stopping the run —
// the same rationale as the pons v2 timed funder (relay/timedFunding.js), which
// this mirrors, but v5-owned (tab-isolation rule), seconds-based, and jittered.
//
// One wallet per tick via v5/relayFund.fundOneViaRelay; the next tick is scheduled
// a random 8-9s later. One job per account at a time. Everything chain- and
// time-touching is injectable so the state machine is fully testable offline.
// ─────────────────────────────────────────────────────────────────────────────

const { randomUUID } = require('crypto');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const relayFund = require('./relayFund');

const DEFAULT_MIN_GAP_MS = 8_000;
const DEFAULT_MAX_GAP_MS = 9_000;

const iso = (ms) => new Date(ms).toISOString();
const errorMessage = (err) => err?.shortMessage || err?.reason || err?.message || String(err);

function publicTarget(job, target, index) {
  let state = 'pending';
  if (index < job.currentIndex) state = 'done';
  if (index === job.currentIndex && job.status === 'running') state = job.inFlight ? 'funding' : 'next';
  return { walletId: target.walletId, address: target.address, amountEth: target.amountEth, index, state };
}

function publicJob(job) {
  if (!job) return { protocol: 'v5', mode: 'relay-solver-timed', status: 'idle', running: false };
  const sent = job.results.filter((r) => r.hash || r.simulated).length;
  const failed = job.results.filter((r) => r.error || r.status === 'failed').length;
  return {
    id: job.id,
    protocol: 'v5',
    mode: 'relay-solver-timed',
    status: job.status,
    running: job.status === 'running',
    inFlight: job.inFlight,
    minGapMs: job.minGapMs,
    maxGapMs: job.maxGapMs,
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

function createV5RelayFundManager({
  fundOne = relayFund.fundOneViaRelay,
  planTargets = relayFund.planV5Targets,
  keystoreForFn = keystoreFor,
  activityForFn = activityFor,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  idFn = randomUUID,
  randFn = Math.random,
  minGapMs = DEFAULT_MIN_GAP_MS,
  maxGapMs = DEFAULT_MAX_GAP_MS,
} = {}) {
  const jobs = new Map();

  const log = (userId, summary, detail = {}) => activityForFn(userId).record('fund', summary, detail);

  // A fresh random gap in [job.minGapMs, job.maxGapMs] for each step — the 8-9s
  // cadence, jittered so the deposits do not land on a fixed clock.
  const gapFor = (job) => Math.round(job.minGapMs + randFn() * Math.max(0, job.maxGapMs - job.minGapMs));

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
        log(job.userId, `[v5] timed Relay funding stopped — ${errorMessage(err)}`, { jobId: job.id, error: errorMessage(err) });
      }
    }, delayMs);
    if (typeof job.timer?.unref === 'function') job.timer.unref();
  }

  function finish(job) {
    job.status = 'complete';
    job.completedAt = iso(nowFn());
    job.nextRunAt = null;
    job.updatedAt = job.completedAt;
    log(job.userId, `[v5] timed Relay funding complete: ${job.results.length}/${job.targets.length} wallet(s) attempted`, {
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
    job.inFlight = true;
    job.updatedAt = iso(nowFn());

    const entry = {
      index,
      walletId: target.walletId,
      address: target.address,
      amountEth: target.amountEth,
      startedAt: iso(nowFn()),
      status: 'funding',
    };

    try {
      const ks = keystoreForFn(userId);
      const result = await fundOne({ walletId: target.walletId, amountEth: target.amountEth }, { keystore: ks });
      Object.assign(entry, result || {});
      entry.status = result?.error ? 'failed' : 'sent';
      entry.finishedAt = iso(nowFn());
      log(
        userId,
        `[v5] timed Relay funded ${index + 1}/${job.targets.length}: ${target.walletId}` + (entry.error ? ' failed before deposit' : ''),
        { jobId: job.id, walletId: target.walletId, address: target.address, amountEth: target.amountEth, requestId: entry.requestId, depositAddress: entry.depositAddress, hash: entry.hash, error: entry.error }
      );
    } catch (err) {
      entry.status = 'failed';
      entry.error = errorMessage(err);
      entry.finishedAt = iso(nowFn());
      log(userId, `[v5] timed Relay funding ${index + 1}/${job.targets.length} failed: ${target.walletId}`, {
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
      if (job.status === 'running') {
        if (job.currentIndex >= job.targets.length) finish(job);
        else schedule(job, gapFor(job));
      }
    }

    return publicJob(job);
  }

  function start(userId, targets, { minGapMs: reqMin, maxGapMs: reqMax } = {}) {
    const existing = jobs.get(userId);
    if (existing?.status === 'running') throw new Error('a v5 timed Relay funding job is already running for this account');

    const ks = keystoreForFn(userId);
    const planned = planTargets(targets, ks); // validates every target up front

    // Clamp the gap to the 8-9s band by default; allow a caller to widen it but
    // never below the floor that keeps Relay's rate limiter happy.
    const min = Math.max(minGapMs, Number(reqMin) > 0 ? Number(reqMin) : minGapMs);
    const max = Math.max(min, Number(reqMax) > 0 ? Number(reqMax) : maxGapMs);

    const startedAt = iso(nowFn());
    const job = {
      id: idFn(),
      userId,
      status: 'running',
      inFlight: false,
      minGapMs: min,
      maxGapMs: max,
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
    log(userId, `[v5] timed Relay funding started for ${job.targets.length} wallet(s) at ${min / 1000}-${max / 1000}s spacing`, {
      jobId: job.id,
      minGapMs: min,
      maxGapMs: max,
      targets: job.targets,
    });
    schedule(job, 0); // first wallet fires immediately; the rest are gapFor() apart
    return publicJob(job);
  }

  function stop(userId) {
    const job = jobs.get(userId);
    if (!job || job.status !== 'running') return publicJob(job);
    clear(job);
    job.status = 'stopped';
    job.stoppedAt = iso(nowFn());
    job.updatedAt = job.stoppedAt;
    log(userId, `[v5] timed Relay funding stopped at ${job.currentIndex}/${job.targets.length}`, {
      jobId: job.id,
      currentIndex: job.currentIndex,
      total: job.targets.length,
    });
    return publicJob(job);
  }

  function status(userId) {
    return publicJob(jobs.get(userId));
  }

  function reset() {
    for (const job of jobs.values()) clear(job);
    jobs.clear();
  }

  return { start, stop, status, _runNext: runNext, _reset: reset, _jobs: jobs };
}

const singleton = createV5RelayFundManager();
module.exports = singleton;
module.exports.createV5RelayFundManager = createV5RelayFundManager;
module.exports.publicJob = publicJob;
module.exports.DEFAULT_MIN_GAP_MS = DEFAULT_MIN_GAP_MS;
module.exports.DEFAULT_MAX_GAP_MS = DEFAULT_MAX_GAP_MS;
