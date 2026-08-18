'use strict';

/**
 * The engine that actually sends a seasoning campaign.
 *
 * plan.js rolled every dice up front and store.js wrote the result to disk. This
 * file does one job: read that plan, send whatever is due, and write down what
 * happened — for up to ninety days, unattended, across restarts.
 *
 * The shape is the one relay/timedFunding.js established and v3/engine.js
 * followed: a Map of jobs, one re-armed `setTimeout`, `unref`'d so it never
 * holds the process open, every dependency injectable so the tests drive a fake
 * clock instead of waiting three weeks. It differs from both in four ways that
 * are worth stating, because each one is the reason a bug is not possible.
 *
 * ── 1. THE STATE LIVES ON DISK, NOT IN THE JOB ───────────────────────────────
 *
 * v3's job object IS the run; a restart loses it, and that is acceptable there
 * because a v3 run is minutes long and every step waits for its own receipt. A
 * seasoning campaign is weeks long. So the job objects here hold NOTHING but a
 * timer handle and an in-flight flag: every fact about the campaign — which
 * transfers have gone, how many times each one failed, whether the campaign is
 * halted — is read from and written to the store. Killing this process and
 * starting it again loses only the timers, and resumeAll() rebuilds those.
 *
 * ── 2. ONE RUNNING CAMPAIGN PER FUNDING WALLET, ENFORCED AT start() ──────────
 *
 * relay.transfer() reads getTransactionCount(from, 'pending') and then signs
 * with that nonce. Two transfers leaving the SAME funding wallet at the same
 * moment both read the same value, and the second broadcast silently REPLACES
 * the first in the mempool. There is no error anywhere: one transfer simply
 * vanishes, and the campaign records a wallet as funded that never received
 * anything. That wallet then sits in the seasoning set looking ready and is not.
 *
 * So start() REFUSES a campaign whose funding wallet already has a running
 * campaign. It refuses rather than queues, deliberately: a queued campaign would
 * sit silently doing nothing for a fortnight while the operator believed it was
 * seasoning, which is a worse failure than being told no at the door.
 *
 * Two DIFFERENT funding wallets have independent nonce sequences and are
 * therefore safe to run at the same time. That is the whole reason `v4master` is
 * plural (see roles.js) and the whole reason parallel campaigns are possible.
 *
 * ── 3. ONE SEND AT A TIME PER CAMPAIGN ───────────────────────────────────────
 *
 * The same nonce collision arrives by a second route: a Relay call can be slow,
 * and if the next timer fires while one is still in flight, two sends leave the
 * same funding wallet at once. `job.inFlight` is what stops that. It is not a
 * tidiness flag.
 *
 * ── 4. TWO FAILURE COUNTERS, WHICH ARE NOT THE SAME COUNTER ──────────────────
 *
 * PER TRANSFER (`attempts[]`, MAX_ATTEMPTS): a failed attempt is appended, the
 * transfer is re-slotted to a fresh random gap in the future and stays pending.
 * At three attempts it is `abandoned` and the campaign carries on without it.
 * One dud address must not end a three-week run.
 *
 * PER CAMPAIGN (`consecutiveFailures`, HALT_AFTER_CONSECUTIVE_FAILURES): every
 * failed attempt increments it and ANY success resets it to zero. At three the
 * campaign halts. This is the systemic-fault detector: Relay down, funding
 * wallet dry, RPC unreachable. Without it a dry wallet would burn through four
 * hundred slots overnight and abandon every wallet in the plan.
 *
 * They interact on purpose. Because a success resets the campaign counter, a
 * single transfer can only ever reach `abandoned` if OTHER transfers succeeded
 * in between its failures — three failures with nothing succeeding between them
 * halts the campaign first, which is exactly the right order: a fault that looks
 * systemic is treated as systemic.
 *
 * ── AND: BOOT MUST NEVER FIRE A BURST ────────────────────────────────────────
 *
 * resumeAll() re-arms every running campaign. Any transfer already overdue gets
 * a FRESH dueAt spread into the future — never fired at once, and never two on
 * the same instant. Firing six hours of backlog in one minute reproduces, in
 * that minute, precisely the batch-funding pattern the campaign has spent three
 * weeks avoiding. The outage would undo the seasoning.
 *
 * ── A NOTE ON THE STORE'S LIVE REFERENCES ────────────────────────────────────
 *
 * store.get(), store.running() and the arrays inside them hand back the REAL
 * objects out of the store's in-memory cache, not copies. Mutating one in place
 * changes what the cache says and never touches the file, so the change is lost
 * at the next restart — silently, in the one feature whose entire purpose is
 * surviving restarts. Every write in this file therefore goes through
 * store.update() or store.updateTransfer(), and `attempts` is rebuilt as a NEW
 * array rather than pushed to. Anything read out of the store here is read-only.
 */

const fs = require('fs');
const path = require('path');
const { parseEther } = require('ethers');

const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const defaultStore = require('./store');
const defaultRelay = require('./relay');
const plan = require('./plan');
const rng = require('./rng');
const roles = require('./roles');

/** Failed sends of ONE transfer before it is given up on. */
const MAX_ATTEMPTS = 3;
/** Failed sends in a row, across any transfers, before the CAMPAIGN stops. */
const HALT_AFTER_CONSECUTIVE_FAILURES = 3;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function errorMessage(err) {
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

function label(campaign, campaignId) {
  return campaign?.name || campaign?.id || campaignId;
}

/** How long the process was away, in words an operator can act on. */
function humanGap(ms) {
  if (ms >= plan.DAY_MS) return `${(ms / plan.DAY_MS).toFixed(1)} days`;
  if (ms >= HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)} hours`;
  return `${Math.max(1, Math.round(ms / MINUTE_MS))} minutes`;
}

/**
 * Which users have a campaigns file.
 *
 * The store is per-user and memoised by id; nothing in it enumerates users, and
 * at boot there is no request to take a user from. The filenames are the list —
 * this is the inverse of store.pathFor.
 */
function defaultUsers() {
  const dir = path.dirname(config.historyPath);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_err) {
    // No data directory yet: a fresh install with nothing to resume.
    return [];
  }
  const users = [];
  for (const name of names) {
    // Anchored, so `seasoning.json.tmp` and `seasoning.json.corrupt-*` — both
    // of which the store can leave behind — are not read as user ids.
    const match = /^seasoning(?:\.(.+))?\.json$/.exec(name);
    if (match) users.push(match[1] || 'default');
  }
  return users;
}

/** Resolve the funding wallet. V4's masters and nothing else. */
function defaultResolve(ks, walletId) {
  const wallet = roles.masters(ks).find((w) => w.id === walletId);
  if (!wallet) {
    throw new Error(`funding wallet ${walletId} is not a ${roles.ROLES.master} wallet in this keystore`);
  }
  return wallet;
}

/** The real money path. Injected in tests; nothing here touches a network. */
function defaultTransfer({ fromWallet, toAddress, amountWei }, ctx = {}) {
  return defaultRelay.transfer({ fromWallet, toAddress, amountWei }, ctx);
}

/** The gap range this campaign was planned with, with defaults for safety. */
function gapRange(campaign) {
  const params = campaign?.params || {};
  const min = Number(params.gapMinMs);
  const max = Number(params.gapMaxMs);
  const gapMinMs = Number.isFinite(min) && min > 0 ? min : plan.DEFAULTS.gapMinMs;
  const gapMaxMs = Number.isFinite(max) && max >= gapMinMs ? max : gapMinMs;
  return { gapMinMs, gapMaxMs };
}

/**
 * A fresh gap from the campaign's own range.
 *
 * Seeded from the campaign seed and a caller-supplied tag rather than from
 * Math.random, for the same reason plan.js is: the operator has to be able to
 * show after the fact that the schedule was not re-rolled by something
 * unaccountable, and a test has to be able to run this without flaking.
 */
function gapFor(campaign, tag) {
  const { gapMinMs, gapMaxMs } = gapRange(campaign);
  const r = rng.make(`${campaign.seed || campaign.id}:${tag}`);
  return Math.max(1, Math.round(gapMinMs + r.next() * (gapMaxMs - gapMinMs)));
}

/** Pending transfer due soonest — the only one the runner ever looks at. */
function nextPending(campaign) {
  let next = null;
  for (const t of campaign.transfers || []) {
    if (t.status !== 'pending') continue;
    if (!next || t.dueAt < next.dueAt) next = t;
  }
  return next;
}

/**
 * Oldest campaign first, ties broken by id.
 *
 * Used to decide which of two campaigns sharing a funding wallet keeps it at
 * boot. Deterministic on purpose: an operator restarting the process twice must
 * not get a different winner the second time, or the "loser" would have half a
 * nonce sequence on chain from each run.
 */
function byStartedAt(a, b) {
  const at = Date.parse(a?.startedAt || a?.createdAt || '') || 0;
  const bt = Date.parse(b?.startedAt || b?.createdAt || '') || 0;
  if (at !== bt) return at - bt;
  return String(a?.id).localeCompare(String(b?.id));
}

function tally(campaign) {
  const counts = { total: 0, pending: 0, sent: 0, abandoned: 0 };
  for (const t of campaign.transfers || []) {
    counts.total += 1;
    if (t.status === 'pending') counts.pending += 1;
    else if (t.status === 'abandoned') counts.abandoned += 1;
    else counts.sent += 1;
  }
  return counts;
}

function createRunner(deps = {}) {
  const storeForFn = deps.storeForFn || defaultStore.storeFor;
  const transferFn = deps.transferFn || defaultTransfer;
  const keystoreForFn = deps.keystoreForFn || keystoreFor;
  const activityForFn = deps.activityForFn || activityFor;
  const rolesResolve = deps.rolesResolve || defaultResolve;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const nowFn = deps.nowFn || Date.now;
  const usersFn = deps.usersFn || defaultUsers;
  // Passed straight through to the Relay client, so a test can hand it the
  // same fakes this runner got.
  const relayDeps = deps.relayDeps || {};

  /**
   * Live timers, keyed by `${userId}:${campaignId}` — by CAMPAIGN, not by user,
   * because one user runs several campaigns at once. A Map keyed by user would
   * have made the second campaign silently replace the first.
   */
  const jobs = new Map();

  /**
   * Every transfer whose Relay call has RESOLVED SUCCESSFULLY in this process.
   *
   * THE ETH HAS LEFT AND NO LATER FACT CAN UNDO THAT. Everything else the
   * runner knows lives on disk (see the file header), but "did this send
   * happen" cannot: the disk is precisely the thing that has failed whenever
   * this set matters. store.persist() rewrites the whole file on every
   * transfer update — eight hundred-odd writes for a 400-wallet campaign — and
   * on Windows fs.renameSync over an existing file transiently returns EPERM
   * or EBUSY under an AV scanner or the search indexer. A send followed by a
   * failed write leaves the transfer reading `pending`, and re-sending it gives
   * one seed wallet TWO funding edges from one master, which is the single
   * pattern this whole feature exists to erase.
   *
   * So this is the authority fire() consults before it sends, and it outranks
   * the store. Bounded by the transfers this process has actually sent — a few
   * hundred short strings per campaign — so it is never pruned: pruning it is
   * the only way it could ever fail to answer, and what it answers is the one
   * question that must never be got wrong.
   */
  const sentTransfers = new Set();

  function key(userId, campaignId) {
    return `${userId}:${campaignId}`;
  }

  function sentKey(userId, campaignId, transferId) {
    return `${userId}:${campaignId}:${transferId}`;
  }

  /**
   * Activity logging, which must never itself be the thing that breaks a send
   * path. Every caller below is either reporting money that has already moved
   * or explaining why a campaign is stopping; an unwritable activity file is
   * not a reason to turn either of those into an exception.
   */
  function log(userId, summary, detail = {}) {
    try {
      activityForFn(userId).record('v4', summary, detail);
    } catch (err) {
      // Swallowed on purpose: a campaign must not die because its own audit
      // trail could not be written. But it must not vanish either. The store
      // and the activity log share a directory, so the failure that silences
      // one usually silences both — and then a campaign can stop with no
      // record in ANY channel. stderr is the only sink that is not on the
      // disk that just failed, so the last word goes there.
      console.error(`[v4] could not record activity for ${userId}: ${errorMessage(err)} — ${summary}`);
    }
  }

  function clearTimer(userId, campaignId) {
    const job = jobs.get(key(userId, campaignId));
    if (job?.timer) clearTimeoutFn(job.timer);
    if (job) job.timer = null;
  }

  /**
   * Drop a campaign's timer, and its job with it — UNLESS a send is in flight.
   *
   * THE JOB OBJECT IS THE SOLE HOLDER OF `inFlight`. Deleting it while a Relay
   * call is still awaiting throws that flag away, and arm() then mints a fresh
   * job with `inFlight: false` — so the next timer sails through fire()'s guard
   * and a SECOND send leaves the same funding wallet on the same nonce. Worse,
   * the first send has written nothing yet, so nextPending() still returns the
   * same transfer: the same wallet is funded twice, or one deposit silently
   * replaces the other in the mempool.
   *
   * It needs no exotic sequence. A Relay call takes seconds; an operator who
   * thinks a campaign is stuck clicks pause and then resume.
   *
   * So an in-flight job survives with only its timer cleared, and fire()'s own
   * tail is what finally deletes it — by which point `inFlight` is false and
   * there is nothing left to protect.
   */
  function forget(userId, campaignId) {
    const k = key(userId, campaignId);
    const job = jobs.get(k);
    if (!job) return;
    if (job.timer) clearTimeoutFn(job.timer);
    job.timer = null;
    if (!job.inFlight) jobs.delete(k);
  }

  // ── reading and reporting ─────────────────────────────────────────────────

  function statusOf(userId, campaignId) {
    const campaign = storeForFn(userId).get(campaignId);
    if (!campaign) return null;
    const job = jobs.get(key(userId, campaignId));
    const next = nextPending(campaign);
    return {
      id: campaign.id,
      name: campaign.name || campaign.id,
      // 'season' for everything written before splits existed, which is what
      // those campaigns were. Carried out to the console so a split is not read
      // as a very short seasoning run that fed the wrong wallets.
      kind: campaign.kind || 'season',
      status: campaign.status,
      masterWalletId: campaign.masterWalletId,
      ...tally(campaign),
      consecutiveFailures: campaign.consecutiveFailures || 0,
      nextDueAt: next ? next.dueAt : null,
      nextDueIso: next ? iso(next.dueAt) : null,
      startedAt: campaign.startedAt || null,
      completedAt: campaign.completedAt || null,
      haltedAt: campaign.haltedAt || null,
      haltReason: campaign.haltReason || null,
      pausedAt: campaign.pausedAt || null,
      pauseReason: campaign.pauseReason || null,
      armed: Boolean(job?.timer),
      inFlight: Boolean(job?.inFlight),
    };
  }

  // ── re-slotting ───────────────────────────────────────────────────────────

  /**
   * Give every overdue transfer a fresh time, strictly increasing from now.
   *
   * Called at boot and on resume — the two moments a backlog can exist. The
   * cursor walks forward by one fresh gap per transfer, so nothing fires at
   * once and NO TWO SHARE AN INSTANT. Colliding with a transfer that was not
   * overdue is nudged past by a millisecond rather than allowed, because two
   * sends on the same tick is the exact shape being avoided.
   */
  function reslotOverdue(userId, campaignId) {
    const store = storeForFn(userId);
    const campaign = store.get(campaignId);
    if (!campaign) return { count: 0, gapMs: 0 };

    const now = nowFn();
    const overdue = (campaign.transfers || [])
      .filter((t) => t.status === 'pending' && t.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt);
    if (!overdue.length) return { count: 0, gapMs: 0 };

    // Read before anything is written: these are live objects and updateTransfer
    // will change the very fields being measured.
    const oldest = overdue[0].dueAt;
    const moving = new Set(overdue.map((t) => t.id));
    const taken = new Set(
      (campaign.transfers || [])
        .filter((t) => t.status === 'pending' && !moving.has(t.id))
        .map((t) => t.dueAt)
    );
    const ids = overdue.map((t) => t.id);

    let cursor = now;
    ids.forEach((transferId, i) => {
      cursor += gapFor(campaign, `reslot:${now}:${transferId}:${i}`);
      while (taken.has(cursor)) cursor += 1;
      taken.add(cursor);
      store.updateTransfer(campaignId, transferId, { dueAt: cursor });
    });

    return { count: ids.length, gapMs: now - oldest, oldestDueAt: oldest };
  }

  /** Where a failed transfer goes next: forward, and not onto anyone else. */
  function reslotOne(campaign, transfer, attemptNo) {
    const taken = new Set(
      (campaign.transfers || [])
        .filter((t) => t.status === 'pending' && t.id !== transfer.id)
        .map((t) => t.dueAt)
    );
    let at = nowFn() + gapFor(campaign, `retry:${transfer.id}:${attemptNo}`);
    while (taken.has(at)) at += 1;
    return at;
  }

  // ── the timer ─────────────────────────────────────────────────────────────

  /** Point the campaign's single timer at its next pending transfer. */
  function arm(userId, campaignId) {
    clearTimer(userId, campaignId);

    const campaign = storeForFn(userId).get(campaignId);
    if (!campaign || campaign.status !== 'running') {
      forget(userId, campaignId);
      return null;
    }

    // A BACKLOG CAN APPEAR MID-RUN, WITH NO RESTART TO CLEAR IT.
    //
    // resume() and resumeAll() re-slot overdue transfers because those are the
    // two moments a backlog is obvious. They are not the only two moments it
    // exists. OS sleep, hibernate or a suspended VM stops the timers without
    // stopping the process; a hung Relay fetch holds `job.inFlight` for its
    // whole duration and Node's fetch has no default timeout. Neither
    // restarts anything, so neither reaches the two call sites that used to
    // be the only ones — and this function then schedules every overdue
    // transfer at Math.max(0, …) = 0ms, with fire()'s tail re-arming straight
    // away. An overnight suspend at 20min–4h gaps strands four or five
    // transfers, which then leave the funding wallet back to back, in one
    // burst, from one master: the batch-funding fingerprint the campaign has
    // spent three weeks avoiding, reproduced in a minute.
    //
    // reslotOverdue() is idempotent — a no-op when nothing is overdue, which
    // is every normal tick — so this is safe to run on every arm, and arming
    // is the one thing that happens on every path into the timer.
    const spread = reslotOverdue(userId, campaignId);
    if (spread.count) {
      log(
        userId,
        `[v4] "${label(campaign, campaignId)}" fell ${humanGap(spread.gapMs)} behind while running — ` +
          `${spread.count} overdue transfer(s) re-slotted into the future rather than sent at once`,
        {
          campaignId,
          reslotted: spread.count,
          gapMs: spread.gapMs,
          oldestDueAt: spread.oldestDueAt ? iso(spread.oldestDueAt) : null,
        }
      );
    }

    // Re-read rather than reuse `campaign`: reslotOverdue has just rewritten
    // the very dueAt values nextPending sorts on.
    const next = nextPending(storeForFn(userId).get(campaignId) || campaign);
    if (!next) return complete(userId, campaignId);

    // Reuse the existing job wherever there is one, so an `inFlight` set by a
    // send that is still awaiting is carried forward rather than reset. A fresh
    // object here is only ever correct when nothing is in flight, which is
    // exactly when there is no job in the map to reuse.
    const k = key(userId, campaignId);
    const job = jobs.get(k) || { userId, campaignId, timer: null, inFlight: false };
    jobs.set(k, job);

    job.nextDueAt = next.dueAt;
    job.timer = setTimeoutFn(async () => {
      job.timer = null;
      try {
        await fire(userId, campaignId);
      } catch (err) {
        // fire() handles a failed SEND itself. Anything reaching here is a bug
        // in the runner rather than in the money path, and must still stop the
        // campaign — a runner that silently stopped re-arming would look like a
        // campaign that had simply gone quiet.
        //
        // safeHalt, NOT halt. halt() writes to the store, and the likeliest
        // reason to be here at all is that the store is what failed. A throw
        // from halt() inside this catch is a rejection from an async timer
        // callback with nothing to catch it — an unhandled rejection, which
        // Node >= 15 turns into process exit. That would take down every other
        // campaign, and V1/V2/V3 with them, over one bad write.
        safeHalt(userId, campaignId, errorMessage(err));
      }
    }, Math.max(0, next.dueAt - nowFn()));
    if (typeof job.timer?.unref === 'function') job.timer.unref();

    return job;
  }

  // ── outcomes ──────────────────────────────────────────────────────────────

  function complete(userId, campaignId) {
    const store = storeForFn(userId);
    const campaign = store.get(campaignId);
    if (!campaign || campaign.status === 'complete') return null;

    const name = label(campaign, campaignId);
    const counts = tally(campaign);
    forget(userId, campaignId);
    store.update(campaignId, { status: 'complete', completedAt: iso(nowFn()) });
    log(userId, `[v4] "${name}" complete — ${counts.sent}/${counts.total} wallet(s) funded`, {
      campaignId,
      ...counts,
    });
    return null;
  }

  function halt(userId, campaignId, reason) {
    const store = storeForFn(userId);
    const campaign = store.get(campaignId);
    if (!campaign) return;

    const name = label(campaign, campaignId);
    const counts = tally(campaign);
    forget(userId, campaignId);
    store.update(campaignId, {
      status: 'halted',
      haltedAt: iso(nowFn()),
      haltReason: reason,
    });
    log(
      userId,
      `[v4] "${name}" halted after ${HALT_AFTER_CONSECUTIVE_FAILURES} failures in a row — ${reason}`,
      { campaignId, reason, ...counts }
    );
  }

  /**
   * halt(), with the one guarantee its callers on the failure paths need: it
   * cannot throw.
   *
   * halt() writes — `store.update({ status: 'halted' })` — and every caller of
   * this wrapper is already handling a store that has just refused a write. A
   * second throw from the stop path leaves the timer callback rejecting with
   * nothing above it, which is process exit. So the write is attempted, and if
   * it will not go, the timer is dropped anyway: a campaign that cannot record
   * that it stopped must at least actually stop.
   */
  function safeHalt(userId, campaignId, reason) {
    try {
      halt(userId, campaignId, reason);
    } catch (err) {
      try {
        forget(userId, campaignId);
      } catch (_err) {
        /* the map is in memory; there is nothing left to fall back to */
      }
      // This is the worst branch in the file, and the one an operator most
      // needs to see: the campaign has stopped but the store still says
      // `running`, so the next boot will re-arm it and re-send whatever was in
      // flight. That is the one path to a duplicate funding edge. It goes to
      // stderr as well as the activity log, because the store and the activity
      // log share a directory and this branch is usually reached because that
      // directory is what failed.
      console.error(
        `[v4] campaign ${campaignId} STOPPED BUT COULD NOT BE MARKED HALTED — ${errorMessage(err)}. ` +
          `Reason it stopped: ${reason}. The store still says running; reconcile this campaign by hand ` +
          'before resuming, and check the last transfer on chain before trusting the record.'
      );
      log(userId, `[v4] campaign ${campaignId} could not be marked halted — ${errorMessage(err)}`, {
        campaignId,
        reason,
        error: errorMessage(err),
      });
    }
  }

  function onSuccess(userId, campaignId, transferId, out) {
    const store = storeForFn(userId);
    store.updateTransfer(campaignId, transferId, {
      status: 'sent',
      hash: out?.hash ?? null,
      requestId: out?.requestId ?? null,
      depositAddress: out?.depositAddress ?? null,
      sentAt: iso(nowFn()),
    });
    // ANY success clears the campaign counter. This is what makes the counter a
    // systemic-fault detector rather than a running total of bad luck.
    store.update(campaignId, { consecutiveFailures: 0 });

    const campaign = store.get(campaignId);
    const counts = tally(campaign);
    const transfer = (campaign.transfers || []).find((t) => t.id === transferId);
    log(
      userId,
      `[v4] "${label(campaign, campaignId)}" funded ${counts.sent}/${counts.total}: ${transfer?.address}`,
      {
        campaignId,
        transferId,
        walletId: transfer?.walletId,
        address: transfer?.address,
        amountEth: transfer?.amountEth,
        hash: out?.hash ?? null,
        requestId: out?.requestId ?? null,
      }
    );
  }

  function onFailure(userId, campaignId, transferId, err) {
    const store = storeForFn(userId);
    const campaign = store.get(campaignId);
    const transfer = (campaign.transfers || []).find((t) => t.id === transferId);
    if (!transfer) return;

    const message = errorMessage(err);
    // A NEW array. Pushing onto transfer.attempts would mutate the store's live
    // object before the store had been asked to write anything.
    const attempts = [...(transfer.attempts || []), { at: iso(nowFn()), error: message }];

    const patch = { attempts };
    if (attempts.length >= MAX_ATTEMPTS) {
      // Given up on, and only on. The campaign is not this wallet.
      patch.status = 'abandoned';
      patch.abandonedAt = iso(nowFn());
    } else {
      patch.status = 'pending';
      patch.dueAt = reslotOne(campaign, transfer, attempts.length);
    }
    store.updateTransfer(campaignId, transferId, patch);

    const consecutiveFailures = (campaign.consecutiveFailures || 0) + 1;
    store.update(campaignId, { consecutiveFailures });

    log(
      userId,
      `[v4] "${label(campaign, campaignId)}" transfer to ${transfer.address} failed ` +
        `(attempt ${attempts.length}/${MAX_ATTEMPTS})${patch.status === 'abandoned' ? ', abandoned' : ', re-slotted'} — ${message}`,
      {
        campaignId,
        transferId,
        walletId: transfer.walletId,
        address: transfer.address,
        attempt: attempts.length,
        status: patch.status,
        consecutiveFailures,
        error: message,
      }
    );

    if (consecutiveFailures >= HALT_AFTER_CONSECUTIVE_FAILURES) halt(userId, campaignId, message);
  }

  /** Send whatever is due, once. Never two at a time from one funding wallet. */
  async function fire(userId, campaignId) {
    const job = jobs.get(key(userId, campaignId));
    // inFlight: a slow Relay call must not overlap the next tick, or the funding
    // wallet signs two transactions on the same nonce and one of them vanishes.
    if (!job || job.inFlight) return;

    const campaign = storeForFn(userId).get(campaignId);
    if (!campaign || campaign.status !== 'running') return;

    const transfer = nextPending(campaign);
    if (!transfer) {
      complete(userId, campaignId);
      return;
    }

    // Copied out before the await: `transfer` is the store's live object and
    // will have been rewritten by the time the send returns.
    const transferId = transfer.id;
    const walletId = transfer.walletId;
    const toAddress = transfer.address;
    const amountEth = transfer.amountEth;
    const masterWalletId = campaign.masterWalletId;
    const sk = sentKey(userId, campaignId, transferId);

    // THE LAST LINE OF DEFENCE, AND THE ONLY ONE THAT DOES NOT ASK THE DISK.
    //
    // nextPending() read the store, and a transfer whose send resolved but
    // whose 'sent' write did not land still reads `pending` there. Sending it
    // again would put a second funding edge between this master and this seed
    // — the one outcome the feature cannot survive. So refuse, and stop the
    // campaign rather than skip the transfer: skipping it would leave
    // nextPending() returning the same row on every tick, for ever, while the
    // console showed a campaign making progress.
    if (sentTransfers.has(sk)) {
      const reason =
        `transfer ${transferId} to ${toAddress} has already been sent from this process, but the ` +
        'campaign file still records it as pending — the store is not keeping up, and re-sending ' +
        'would fund that wallet twice from one master';
      log(userId, `[v4] "${label(campaign, campaignId)}" halted — ${reason}`, {
        campaignId,
        transferId,
        walletId,
        address: toAddress,
        reason,
      });
      safeHalt(userId, campaignId, reason);
      return;
    }

    job.inFlight = true;
    try {
      let out = null;
      let sendError = null;
      try {
        const ks = keystoreForFn(userId);
        const fromWallet = rolesResolve(ks, masterWalletId);
        out = await transferFn(
          { campaignId, walletId, toAddress, amountWei: parseEther(String(amountEth)), fromWallet },
          { ...relayDeps, keystore: ks }
        );
        // RECORDED BEFORE ANY BOOKKEEPING IS ATTEMPTED. From this line on the
        // ETH has left, whatever happens next.
        sentTransfers.add(sk);
      } catch (err) {
        sendError = err;
      }

      // THE SEND EITHER HAPPENED OR IT DID NOT, AND NOTHING BELOW MAY CHANGE
      // THAT ANSWER.
      //
      // onSuccess() used to sit inside the same `try` as the send. A store
      // write that failed AFTER the ETH had left therefore fell into the
      // catch and was handled as a failed SEND: onFailure() re-slotted the
      // transfer to `pending` and the next tick sent it again. The wallet was
      // funded twice, from one master, and the campaign went on to report
      // `complete` with nothing an operator could see. That is not exotic —
      // persist() rewrites the whole file on every one of ~800 updates per
      // campaign, and Windows returns EPERM/EBUSY from renameSync under an AV
      // scanner. Bookkeeping failures are handled on their own branches now,
      // and neither of them can reach onFailure().
      if (!sendError) {
        try {
          onSuccess(userId, campaignId, transferId, out);
        } catch (bookErr) {
          const reason =
            `${toAddress} WAS funded (${amountEth} ETH${out?.hash ? `, ${out.hash}` : ''}) but the ` +
            `campaign file could not record it — ${errorMessage(bookErr)}`;
          log(
            userId,
            `[v4] "${label(campaign, campaignId)}" halted — ${reason}. The transfer is NOT re-sent; ` +
              'fix the disk and check this wallet by hand before resuming.',
            {
              campaignId,
              transferId,
              walletId,
              address: toAddress,
              amountEth,
              hash: out?.hash ?? null,
              requestId: out?.requestId ?? null,
              error: errorMessage(bookErr),
            }
          );
          safeHalt(userId, campaignId, reason);
        }
      } else {
        try {
          onFailure(userId, campaignId, transferId, sendError);
        } catch (bookErr) {
          // onFailure() writes too, so it can fail for the same reasons. This
          // used to escape fire() entirely: arm()'s catch called halt(), which
          // wrote to the same broken store and threw as well, and the async
          // timer callback rejected with nothing above it — process exit on
          // Node >= 15, taking every other campaign and every other tab's
          // work with it.
          safeHalt(
            userId,
            campaignId,
            `${errorMessage(sendError)} (and the attempt could not be recorded — ${errorMessage(bookErr)})`
          );
        }
      }
    } finally {
      // Held across the bookkeeping above, not just the await: `inFlight` means
      // "this campaign is part-way through a transfer", and it is forget()'s
      // signal to preserve the job. Clearing it early would let halt()'s own
      // forget() drop the job while fire() still had a tail to run.
      job.inFlight = false;
    }

    // Re-read: onFailure may have halted, and a pause or cancel may have landed
    // while the send was in flight. Either way the campaign says what happens
    // next, not the closure that started the send.
    const after = storeForFn(userId).get(campaignId);
    if (after && after.status === 'running') arm(userId, campaignId);
    // Not running any more, and no longer in flight — so the job that forget()
    // was made to preserve has nothing left to preserve, and is dropped here.
    else forget(userId, campaignId);
  }

  // ── the public surface ────────────────────────────────────────────────────

  /**
   * The nonce invariant, checked at the door.
   *
   * `running()` is the right list to check against: a paused, halted, complete
   * or cancelled campaign holds no timer and signs nothing, so its funding
   * wallet is free. Only a genuinely running one can collide.
   */
  function assertFundingWalletFree(userId, campaignId, masterWalletId) {
    const clash = storeForFn(userId)
      .running()
      .find((c) => c.id !== campaignId && c.masterWalletId === masterWalletId);
    if (!clash) return;
    throw new Error(
      `funding wallet ${masterWalletId} is already running campaign "${label(clash, clash.id)}" — ` +
        'one campaign per funding wallet, because two campaigns sharing a wallet share its nonce ' +
        'and one of every pair of simultaneous sends would silently disappear'
    );
  }

  /**
   * The seed-wallet invariant, re-checked where nothing can await.
   *
   * routes/v4.js runs assertUnclaimed too — and then awaits twice before it
   * gets here: a fee estimate and an RPC balance read. Two POST /v4/campaigns
   * that land inside that window both pass the route's check and both reach
   * this function, and because the check compares against OTHER campaigns
   * only, neither sees the other. With different funding wallets the nonce
   * guard above waves them both through; with `walletIds` omitted both resolve
   * to "every v4seed wallet", so the overlap is total. Every seed in the
   * intersection then gets two funding edges from two masters — the exact
   * fingerprint the campaign exists to erase — and the console silently loses
   * half of it, because V4Console keys a plain map on walletId on the stated
   * assumption that at most one transfer anywhere ever names it.
   *
   * Parallel campaigns are this feature's headline capability, so an operator
   * creating two back to back inside an RPC round trip is expected usage, not
   * an edge case. Re-checking here closes the window because store.create()
   * is the next statement and JavaScript cannot interleave between them.
   */
  function assertSeedsUnclaimed(store, campaign) {
    const walletIds = [...new Set((campaign.transfers || []).map((t) => t.walletId).filter(Boolean))];
    if (!walletIds.length) return;

    const claimed = store.claimedSeedIds();
    const taken = walletIds.filter((id) => claimed.has(id));
    if (!taken.length) return;

    throw new Error(
      `${taken.length} wallet(s) are already claimed by another campaign: ${taken.slice(0, 5).join(', ')}` +
        `${taken.length > 5 ? '…' : ''}. A wallet funded twice has two funding edges.`
    );
  }

  function start(userId, campaign) {
    if (!campaign || !campaign.id) throw new Error('a campaign with an id is required');

    const store = storeForFn(userId);
    const at = iso(nowFn());
    const existing = store.get(campaign.id);

    // CHECK THE WALLET THAT WILL ACTUALLY SIGN, WHICH IS THE ONE ON DISK.
    //
    // For a campaign already in the store, `fresh` below deliberately does not
    // overwrite masterWalletId — restarting a campaign must not silently move
    // it to another funding wallet. So the stored value is what the sends will
    // come from, and checking the caller's field instead lets an object that
    // disagrees with disk walk straight past the invariant: `start` sees a free
    // wallet, arms a campaign, and the campaign then signs from a busy one.
    // Task 7's routes will build these objects from request bodies, which is
    // exactly the shape that disagrees.
    const masterWalletId = existing ? existing.masterWalletId : campaign.masterWalletId;
    if (!masterWalletId) throw new Error(`campaign ${campaign.id} has no funding wallet`);
    assertFundingWalletFree(userId, campaign.id, masterWalletId);

    const fresh = {
      status: 'running',
      startedAt: existing?.startedAt || campaign.startedAt || at,
      completedAt: null,
      haltedAt: null,
      haltReason: null,
      pauseReason: null,
      consecutiveFailures: 0,
    };
    if (existing) store.update(campaign.id, fresh);
    else {
      // Deep-copied at the door. A shallow spread would put the CALLER's
      // `transfers` array into the store, so the caller would still hold a live
      // handle on the plan the runner is mutating. The round trip is lossless
      // for anything the store could persist, because persist() serialises the
      // same way.
      const created = JSON.parse(JSON.stringify({ ...campaign, ...fresh, createdAt: campaign.createdAt || at }));
      // NOTHING MAY AWAIT BETWEEN THESE TWO LINES — that gap is the whole bug.
      // Only on the create branch: an existing campaign's own transfers are
      // already in claimedSeedIds(), so it would always collide with itself.
      assertSeedsUnclaimed(store, created);
      store.create(created);
    }

    const counts = tally(store.get(campaign.id));
    log(userId, `[v4] "${label(campaign, campaign.id)}" started — ${counts.pending} transfer(s) scheduled`, {
      campaignId: campaign.id,
      masterWalletId,
      ...counts,
    });

    arm(userId, campaign.id);
    return statusOf(userId, campaign.id);
  }

  function pause(userId, campaignId) {
    const store = storeForFn(userId);
    const campaign = store.get(campaignId);
    if (!campaign) throw new Error(`no campaign ${campaignId}`);
    if (campaign.status === 'cancelled') throw new Error(`campaign "${label(campaign, campaignId)}" was cancelled`);
    if (campaign.status !== 'running') return statusOf(userId, campaignId);

    const name = label(campaign, campaignId);
    const counts = tally(campaign);
    forget(userId, campaignId);
    store.update(campaignId, { status: 'paused', pausedAt: iso(nowFn()) });
    log(userId, `[v4] "${name}" paused with ${counts.pending} transfer(s) left`, { campaignId, ...counts });
    return statusOf(userId, campaignId);
  }

  function resume(userId, campaignId) {
    const store = storeForFn(userId);
    const campaign = store.get(campaignId);
    if (!campaign) throw new Error(`no campaign ${campaignId}`);
    // Terminal, and terminal in one direction only. Cancelling is how an
    // operator says the plan itself is wrong; restarting it would re-fund
    // wallets against a schedule they have already decided against.
    if (campaign.status === 'cancelled') {
      throw new Error(`campaign "${label(campaign, campaignId)}" was cancelled and cannot be resumed`);
    }
    if (campaign.status === 'complete') {
      throw new Error(`campaign "${label(campaign, campaignId)}" is already complete`);
    }
    if (campaign.status === 'running') {
      arm(userId, campaignId);
      return statusOf(userId, campaignId);
    }

    assertFundingWalletFree(userId, campaignId, campaign.masterWalletId);

    const name = label(campaign, campaignId);
    // A halted campaign resumes with a clean counter, or it would halt again on
    // the first failure after the operator had already fixed the fault.
    store.update(campaignId, {
      status: 'running',
      pausedAt: null,
      pauseReason: null,
      haltedAt: null,
      haltReason: null,
      consecutiveFailures: 0,
    });

    const gap = reslotOverdue(userId, campaignId);
    const counts = tally(store.get(campaignId));
    log(
      userId,
      `[v4] "${name}" resumed with ${counts.pending} transfer(s) left` +
        (gap.count ? `, ${gap.count} of them re-slotted after a ${humanGap(gap.gapMs)} pause` : ''),
      { campaignId, reslotted: gap.count, gapMs: gap.gapMs, ...counts }
    );

    arm(userId, campaignId);
    return statusOf(userId, campaignId);
  }

  function cancel(userId, campaignId) {
    const store = storeForFn(userId);
    const campaign = store.get(campaignId);
    if (!campaign) throw new Error(`no campaign ${campaignId}`);

    const name = label(campaign, campaignId);
    const counts = tally(campaign);
    forget(userId, campaignId);
    if (campaign.status !== 'cancelled') {
      store.update(campaignId, { status: 'cancelled', cancelledAt: iso(nowFn()) });
      log(userId, `[v4] "${name}" cancelled with ${counts.pending} transfer(s) unsent`, {
        campaignId,
        ...counts,
      });
    }
    return statusOf(userId, campaignId);
  }

  /**
   * Re-arm everything that was running when the process stopped. Called from
   * server.js at boot.
   *
   * The backlog is re-slotted, never fired. Six hours of overdue transfers sent
   * in one minute would reproduce, in that minute, exactly the batch-funding
   * pattern the campaign spent three weeks avoiding — an outage would undo the
   * seasoning rather than merely delay it. The gap is logged because it is the
   * one thing the operator cannot see from the plan.
   *
   * Returns `{ resumed, parked }`, kept as two separate arrays rather than one
   * — a campaign in `parked` is NOT funding, and a caller (server.js's boot
   * log) that folded the two together would tell an operator "N resumed" while
   * some of those N were actually sitting paused. See the park branch below
   * for why a parked campaign also has to `forget()` its job entry.
   */
  function resumeAll() {
    const resumed = [];
    const parked = [];
    for (const userId of usersFn()) {
      let running;
      try {
        running = storeForFn(userId).running();
      } catch (_err) {
        // One unreadable user's file must not stop every other campaign in the
        // deployment from being re-armed.
        continue;
      }

      // THE NONCE INVARIANT AT THE ONE ENTRY POINT THAT TRUSTS A FILE.
      //
      // start() refuses a second campaign on a funding wallet, but boot never
      // gets to make that decision — it re-arms whatever the file says. A crash
      // between writing a campaign and arming it, a restored backup, or any
      // caller that got the check wrong all leave two `running` campaigns
      // sharing a master wallet, and arming both puts the process on two nonce
      // sequences for one wallet within seconds of coming up. Boot is the worst
      // place to discover that, because nobody is watching a boot.
      //
      // The EARLIEST-STARTED campaign keeps the wallet: it is the one whose
      // sends are already on chain, so it owns the nonce sequence in progress.
      // The other is parked as `paused` — not halted, because nothing failed,
      // and not cancelled, because the operator will most likely want it on a
      // different funding wallet rather than gone.
      const claimed = new Map();

      for (const campaign of running.slice().sort(byStartedAt)) {
        const campaignId = campaign.id;
        const name = label(campaign, campaignId);
        const wallet = campaign.masterWalletId;
        const holder = wallet ? claimed.get(wallet) : null;

        if (holder) {
          const reason =
            `funding wallet ${wallet} is already running campaign "${holder}" — ` +
            'two campaigns on one wallet share its nonce, so one of every pair of ' +
            'simultaneous sends would silently disappear';
          // Clears any timer this campaign already held. Ordinarily there is
          // none — this is the first resumeAll() of the process — but if
          // resumeAll() ever runs twice in one process and the winner changes
          // (a restored backup introducing an older campaign, say), the
          // previous run may have armed THIS campaign before parking it now.
          // Without forget() here, that old timer and job entry are stranded:
          // fire()'s status guard still blocks the send, so it is a dead timer
          // and a leaked job, not a double-send — but a dead timer is still a
          // bug. Mirrors what pause() does for the same reason.
          forget(userId, campaignId);
          storeForFn(userId).update(campaignId, {
            status: 'paused',
            pausedAt: iso(nowFn()),
            pauseReason: reason,
          });
          log(userId, `[v4] "${name}" was NOT resumed at boot — ${reason}. Give it its own funding wallet and resume it.`, {
            campaignId,
            masterWalletId: wallet,
            heldBy: holder,
            reason,
          });
          const view = statusOf(userId, campaignId);
          if (view) parked.push(view);
          continue;
        }
        if (wallet) claimed.set(wallet, name);

        const gap = reslotOverdue(userId, campaignId);
        if (gap.count) {
          log(
            userId,
            `[v4] "${name}" was ${humanGap(gap.gapMs)} behind at boot — ` +
              `${gap.count} overdue transfer(s) re-slotted into the future rather than sent at once`,
            {
              campaignId,
              reslotted: gap.count,
              gapMs: gap.gapMs,
              oldestDueAt: gap.oldestDueAt ? iso(gap.oldestDueAt) : null,
            }
          );
        }
        arm(userId, campaignId);
        const view = statusOf(userId, campaignId);
        if (view) resumed.push(view);
      }
    }
    return { resumed, parked };
  }

  function status(userId, campaignId) {
    return statusOf(userId, campaignId);
  }

  /** Every campaign this runner currently holds a timer for. */
  function armed() {
    return [...jobs.values()].map((job) => ({
      userId: job.userId,
      campaignId: job.campaignId,
      nextDueAt: job.nextDueAt ?? null,
      inFlight: Boolean(job.inFlight),
    }));
  }

  function _reset() {
    for (const job of jobs.values()) {
      if (job.timer) clearTimeoutFn(job.timer);
      job.timer = null;
    }
    jobs.clear();
    sentTransfers.clear();
  }

  return { start, pause, resume, cancel, resumeAll, status, armed, _reset, _jobs: jobs, _sent: sentTransfers };
}

const singleton = createRunner();

module.exports = singleton;
module.exports.createRunner = createRunner;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.HALT_AFTER_CONSECUTIVE_FAILURES = HALT_AFTER_CONSECUTIVE_FAILURES;
module.exports._private = {
  defaultUsers,
  defaultResolve,
  gapFor,
  gapRange,
  nextPending,
  tally,
  humanGap,
  byStartedAt,
};
