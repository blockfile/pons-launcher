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

  function key(userId, campaignId) {
    return `${userId}:${campaignId}`;
  }

  function log(userId, summary, detail = {}) {
    activityForFn(userId).record('v4', summary, detail);
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

    const next = nextPending(campaign);
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
        halt(userId, campaignId, errorMessage(err));
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

    job.inFlight = true;
    try {
      const ks = keystoreForFn(userId);
      const fromWallet = rolesResolve(ks, masterWalletId);
      const out = await transferFn(
        { campaignId, walletId, toAddress, amountWei: parseEther(String(amountEth)), fromWallet },
        { ...relayDeps, keystore: ks }
      );
      onSuccess(userId, campaignId, transferId, out);
    } catch (err) {
      onFailure(userId, campaignId, transferId, err);
    } finally {
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
    // Deep-copied at the door. A shallow spread would put the CALLER's
    // `transfers` array into the store, so the caller would still hold a live
    // handle on the plan the runner is mutating. The round trip is lossless for
    // anything the store could persist, because persist() serialises the same
    // way.
    else store.create(JSON.parse(JSON.stringify({ ...campaign, ...fresh, createdAt: campaign.createdAt || at })));

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
   */
  function resumeAll() {
    const resumed = [];
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
          const parked = statusOf(userId, campaignId);
          if (parked) resumed.push(parked);
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
    return resumed;
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
  }

  return { start, pause, resume, cancel, resumeAll, status, armed, _reset, _jobs: jobs };
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
