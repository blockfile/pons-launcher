'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const plan = require('./plan');

/** A controllable clock and timer table. No real time passes in this file. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return { id, unref() {} };
    },
    clearTimeout: (h) => h && timers.delete(h.id),
    /**
     * Move the clock forward WITHOUT running anything that was due in between.
     *
     * This is what OS sleep, hibernate, a suspended VM and a hung Relay fetch
     * all look like from inside the process: time passed, timers did not fire,
     * and nothing restarted. It is the only way to reproduce a mid-run backlog
     * without going through resumeAll(), which re-slots one for free.
     */
    advance(ms) {
      now += ms;
    },
    /** Advance to the next due timer and run it. Returns false when idle. */
    async tick() {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return false;
      const [id, timer] = due;
      timers.delete(id);
      now = Math.max(now, timer.at);
      await timer.fn();
      return true;
    },
    async drain(max = 500) {
      let n = 0;
      while (n < max && (await this.tick())) n++;
      return n;
    },
    pending: () => timers.size,
  };
}

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4run-'));
  process.env.HISTORY_PATH = path.join(dir, 'launches.json');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./store')];
  delete require.cache[require.resolve('./runner')];
  const store = require('./store');
  store._reset();
  return { store, dir };
}

function makeCampaign(store, { id = 'c1', masterWalletId = 'm1', count = 4, now = 1_000_000 } = {}) {
  const ids = Array.from({ length: count }, (_, i) => `s${i}`);
  const built = plan.generate({
    walletIds: ids,
    addresses: Object.fromEntries(ids.map((w, i) => [w, `0x${String(i + 1).padStart(40, '0')}`])),
    params: plan.normaliseParams({ days: 1, perDayMin: count, perDayMax: count }),
    seed: 'fixed-seed',
    now,
  });
  const campaign = {
    id,
    name: id,
    status: 'running',
    seed: built.seed,
    createdAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(),
    completedAt: null,
    haltedAt: null,
    haltReason: null,
    masterWalletId,
    params: built.params,
    transfers: built.transfers,
    consecutiveFailures: 0,
  };
  store.storeFor('u').create(campaign);
  return campaign;
}

function runnerWith(store, clock, transfer) {
  const { createRunner } = require('./runner');
  return createRunner({
    storeForFn: store.storeFor,
    transferFn: transfer,
    keystoreForFn: () => ({ list: () => [], signer: () => ({}) }),
    activityForFn: () => ({ record() {} }),
    rolesResolve: () => ({ id: 'm1', address: '0x' + '1'.repeat(40) }),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    nowFn: clock.now,
  });
}

test('a campaign sends every transfer and completes', async () => {
  const { store } = env();
  const clock = fakeClock();
  const sent = [];
  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    sent.push(toAddress);
    return { hash: '0x' + 'a'.repeat(64), requestId: null, depositAddress: '0x' + 'b'.repeat(40) };
  });

  makeCampaign(store);
  runner.resumeAll();
  await clock.drain();

  assert.equal(sent.length, 4);
  assert.equal(store.storeFor('u').get('c1').status, 'complete');
  // THE REAPER, WHICH NOTHING ELSE PINS. fire()'s tail deletes the job on
  // every terminal path; deleting that line leaves every other v4 test green,
  // because the double-send guard it looks like is pinned separately (see
  // 'pause then resume during an in-flight send'). What leaks without it is a
  // job object per finished campaign and a stale armed() row claiming a timer
  // that does not exist.
  assert.equal(runner._jobs.size, 0, 'a finished campaign left its job behind');
});

test('a failed transfer is re-slotted and retried, not abandoned at once', async () => {
  const { store } = env();
  const clock = fakeClock();
  let calls = 0;
  const runner = runnerWith(store, clock, async () => {
    calls++;
    if (calls === 1) throw new Error('relay hiccup');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 2 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  assert.equal(c.status, 'complete');
  const retried = c.transfers.find((t) => t.attempts.length > 0);
  assert.equal(retried.attempts.length, 1);
  assert.equal(retried.status, 'sent');
  assert.equal(runner._jobs.size, 0, 'a finished campaign left its job behind');
});

test('three consecutive failures halt the campaign', async () => {
  const { store } = env();
  const clock = fakeClock();
  let calls = 0;
  const runner = runnerWith(store, clock, async () => {
    calls++;
    throw new Error('relay is down');
  });

  makeCampaign(store, { count: 10 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  assert.equal(c.status, 'halted');
  assert.match(c.haltReason, /relay is down/);
  // THREE, not "eventually". A campaign that halts on the fourth or the tenth
  // failure has already spent slots it cannot get back — every extra attempt
  // against a systemic fault (Relay down, funding wallet dry) burns a wallet's
  // scheduled slot for nothing. Asserting only "it halted" passes an
  // implementation with any threshold at all, so pin the number itself.
  assert.equal(calls, 3, 'the campaign halted after the wrong number of failures');
  assert.equal(c.consecutiveFailures, 3);
  assert.equal(
    c.transfers.reduce((n, t) => n + t.attempts.length, 0),
    3,
    'a halted campaign recorded more attempts than the threshold allows'
  );
  // It must stop, not burn the remaining slots.
  assert.ok(c.transfers.filter((t) => t.status === 'pending').length > 0);
  assert.equal(runner._jobs.size, 0, 'a finished campaign left its job behind');
});

test('a success resets the consecutive-failure counter', async () => {
  const { store } = env();
  const clock = fakeClock();
  let n = 0;
  // fail, fail, succeed, fail, fail, succeed … never three in a row
  const runner = runnerWith(store, clock, async () => {
    n++;
    if (n % 3 !== 0) throw new Error('flaky');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 3 });
  runner.resumeAll();
  await clock.drain();

  assert.notEqual(store.storeFor('u').get('c1').status, 'halted');
});

test('a transfer is abandoned after three attempts, and the campaign goes on', async () => {
  const { store } = env();
  const clock = fakeClock();

  // WHICH transfer is cursed is chosen by DUE ORDER, not by which address
  // happens to end in a "1". plan.generate returns transfers sorted by dueAt,
  // and the seeded schedule for count: 8 funds the wallets in the order
  // 5 2 6 3 8 1 4 7 — so "the address ending in 1" is sixth of eight, and the
  // test passed only because two transfers happened to follow it. Curse the
  // genuinely last one instead and its three failures run back to back, which
  // halts the campaign: `assert.equal(c.status, 'complete')` would then fail
  // against a CORRECT implementation. The natural response to that is to weaken
  // the assertion, which is how a real guarantee gets quietly deleted — so pin
  // the position instead.
  const built = makeCampaign(store, { count: 8 });
  const dueOrder = built.transfers.map((t) => t.address);
  const cursedAddress = dueOrder[0];

  const outcomes = [];
  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    if (toAddress === cursedAddress) {
      outcomes.push('fail');
      throw new Error('this one is cursed');
    }
    outcomes.push('ok');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  runner.resumeAll();
  await clock.drain();

  // The premise, asserted rather than assumed: this test only means what it
  // says while the cursed transfer's failures are separated by successes. If a
  // change to plan.js or to the retry gap ever breaks that, it fails HERE,
  // naming the reason — instead of failing below, where it would look like the
  // runner had wrongly halted a campaign it was right to halt.
  assert.ok(
    !outcomes.join(',').includes('fail,fail,fail'),
    `the cursed transfer failed three times in a row (${outcomes.join(',')}) — the campaign is ` +
      'then right to halt, and this test is no longer testing abandonment'
  );

  const c = store.storeFor('u').get('c1');
  const cursed = c.transfers.find((t) => t.address === cursedAddress);
  assert.equal(cursed.status, 'abandoned');
  assert.equal(cursed.attempts.length, 3);
  assert.equal(c.status, 'complete');
  // Abandoned, not silently retried forever, and not counted as funded.
  assert.equal(c.transfers.filter((t) => t.status === 'sent').length, 7);
  assert.equal(runner._jobs.size, 0, 'a finished campaign left its job behind');
});

test('a restart re-arms from disk and does not fire a burst', async () => {
  const { store } = env();
  const clock = fakeClock();
  const times = [];
  const runner = runnerWith(store, clock, async () => {
    times.push(clock.now());
    return { hash: '0x' + 'a'.repeat(64) };
  });

  // Every transfer is already overdue — the shape of a six-hour outage.
  makeCampaign(store, { count: 5, now: clock.now() - 10 * 60 * 60 * 1000 });
  runner.resumeAll();
  await clock.drain();

  assert.equal(times.length, 5);
  // Re-slotted, not bunched: no two sends land in the same instant.
  assert.equal(new Set(times).size, 5, 'overdue transfers were fired as a burst');
});

test('two campaigns on two funding wallets run in parallel', async () => {
  const { store } = env();
  const clock = fakeClock();
  const byCampaign = { c1: 0, c2: 0 };
  const runner = runnerWith(store, clock, async ({ campaignId }) => {
    byCampaign[campaignId]++;
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 3 });
  makeCampaign(store, { id: 'c2', masterWalletId: 'm2', count: 3 });
  runner.resumeAll();
  await clock.drain();

  assert.equal(byCampaign.c1, 3);
  assert.equal(byCampaign.c2, 3);
  assert.equal(runner._jobs.size, 0, 'a finished campaign left its job behind');
});

test('a campaign refuses to start on a funding wallet already running', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));

  makeCampaign(store, { id: 'c1', masterWalletId: 'm1' });
  runner.resumeAll();

  assert.throws(
    () => runner.start('u', { id: 'c2', masterWalletId: 'm1', status: 'running', transfers: [], consecutiveFailures: 0 }),
    /m1|already/
  );
});

test('pause stops the clock and resume picks up where it stopped', async () => {
  const { store } = env();
  const clock = fakeClock();
  let sends = 0;
  const runner = runnerWith(store, clock, async () => {
    sends++;
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 6 });
  runner.resumeAll();
  await clock.tick();
  runner.pause('u', 'c1');
  const afterPause = sends;
  await clock.drain();
  assert.equal(sends, afterPause, 'a paused campaign kept sending');

  runner.resume('u', 'c1');
  await clock.drain();
  assert.equal(sends, 6);
});

test('pause then resume during an in-flight send does not send it twice', async () => {
  const { store } = env();
  const clock = fakeClock();
  const sent = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let firstSend = true;

  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    sent.push(toAddress);
    // The first Relay call hangs — seconds in production, forever here.
    if (firstSend) {
      firstSend = false;
      await gate;
    }
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 4 });
  runner.resumeAll();

  // Fire the first timer WITHOUT awaiting it: the send is now in flight.
  const inFlight = clock.tick();
  await Promise.resolve();
  assert.equal(sent.length, 1, 'the first send did not start');

  // The operator decides it is stuck, pauses, and resumes — the whole sequence
  // is two clicks, and the Relay call is still awaiting throughout.
  runner.pause('u', 'c1');
  runner.resume('u', 'c1');
  await clock.drain();

  // The re-armed timer must NOT start a second send. Nothing has been written
  // yet, so the next pending transfer is still the one in flight: a second send
  // would be the same amount to the same address, from the same funding wallet,
  // on the same nonce — either a double-fund or a silent mempool replacement.
  assert.equal(sent.length, 1, 'the in-flight transfer was sent a second time');

  release();
  await inFlight;
  await clock.drain();

  assert.equal(sent.length, 4);
  assert.equal(new Set(sent).size, 4, 'a transfer was sent twice');
  assert.equal(store.storeFor('u').get('c1').status, 'complete');
  assert.equal(runner._jobs.size, 0, 'a finished campaign left its job behind');
});

test('start checks the funding wallet on disk, not the one it was handed', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));

  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 2 });
  const c2 = makeCampaign(store, { id: 'c2', masterWalletId: 'm1', count: 2 });
  store.storeFor('u').update('c2', { status: 'paused' });
  runner.resumeAll();

  // c2 is on m1 and always will be — start() does not move a stored campaign to
  // another funding wallet. A caller whose in-memory object claims otherwise
  // must not be able to walk past the check on the strength of that claim, or
  // the campaign is armed against a free wallet and then signs from a busy one.
  assert.throws(() => runner.start('u', { ...c2, masterWalletId: 'm9' }), /m1|already/);

  const s = store.storeFor('u');
  assert.equal(s.running().length, 1);
  assert.equal(s.get('c2').status, 'paused');
  assert.equal(s.get('c2').masterWalletId, 'm1');
});

test('resumeAll refuses to arm two running campaigns on one funding wallet', async () => {
  const { store } = env();
  const clock = fakeClock();
  const byCampaign = { c1: 0, c2: 0 };
  const runner = runnerWith(store, clock, async ({ campaignId }) => {
    byCampaign[campaignId]++;
    return { hash: '0x' + 'a'.repeat(64) };
  });

  // The shape a crash between store.create and runner.start leaves on disk —
  // or a restored backup. resumeAll is the one entry point that trusts a file
  // rather than a live decision, so it has to make the check itself.
  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 3 });
  makeCampaign(store, { id: 'c2', masterWalletId: 'm1', count: 3 });
  runner.resumeAll();
  await clock.drain();

  const s = store.storeFor('u');
  assert.equal(byCampaign.c1 + byCampaign.c2, 3, 'more than one campaign sent from wallet m1');
  assert.ok(byCampaign.c1 === 0 || byCampaign.c2 === 0, 'both campaigns sent from one funding wallet');

  const parked = [s.get('c1'), s.get('c2')].filter((c) => c.status === 'paused');
  assert.equal(parked.length, 1, 'the loser was not parked');
  assert.match(parked[0].pauseReason, /m1/);
  assert.equal(s.running().length, 0);
});

test('resumeAll separates parked campaigns from resumed ones in its return value', async () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));

  // Same clash as above — two running campaigns on one funding wallet — but
  // this test is about what resumeAll() REPORTS, not what it does to the
  // store. A caller (server.js's boot log) that only inspected one array must
  // be able to tell "actually funding" apart from "sitting paused" without
  // re-deriving it from campaign status itself.
  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 3 });
  makeCampaign(store, { id: 'c2', masterWalletId: 'm1', count: 3 });
  const { resumed, parked } = runner.resumeAll();

  assert.equal(resumed.length, 1, 'exactly one campaign actually resumed');
  assert.equal(parked.length, 1, 'exactly one campaign was parked');
  assert.equal(resumed[0].id, 'c1', 'the earlier-started campaign is the one that resumed');
  assert.equal(parked[0].id, 'c2', 'the later-started campaign is the one that was parked');
  assert.equal(parked[0].status, 'paused');

  await clock.drain();
});

test('resumeAll forgets a parked loser, clearing any timer it already held', async () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));

  // c2 starts out alone on m1, so the first resumeAll() arms it — a real
  // timer goes into the fake clock's table.
  makeCampaign(store, { id: 'c2', masterWalletId: 'm1', count: 3, now: clock.now() });
  const first = runner.resumeAll();
  assert.equal(first.resumed.length, 1);
  assert.equal(clock.pending(), 1, 'c2 should hold one live timer after the first resumeAll');

  // A restored backup introduces an OLDER campaign on the same wallet — the
  // exact scenario the review flagged: resumeAll() runs twice in one process
  // and the winner changes between runs.
  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 3, now: clock.now() - 60_000 });
  runner.resumeAll();

  const s = store.storeFor('u');
  assert.equal(s.get('c1').status, 'running', 'the earlier-started campaign should now hold the wallet');
  assert.equal(s.get('c2').status, 'paused', 'the later-started campaign should be parked');

  // c2's timer from the FIRST resumeAll must have been cleared, not left
  // stranded. Only c1's freshly-armed timer should remain in the clock's
  // table — a stranded timer here is a dead setTimeout in production that
  // the process never needed, and a leaked entry in the runner's job map.
  assert.equal(clock.pending(), 1, "c2's stale timer from the first resumeAll was not cleared");
  assert.ok(!runner.armed().some((j) => j.campaignId === 'c2'), 'c2 should have no job entry left after being parked');
});

test('cancel is final — resume refuses it', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));
  makeCampaign(store);
  runner.resumeAll();
  runner.cancel('u', 'c1');
  assert.equal(store.storeFor('u').get('c1').status, 'cancelled');
  assert.throws(() => runner.resume('u', 'c1'), /cancelled/);
  assert.equal(runner._jobs.size, 0, 'a finished campaign left its job behind');
});

// ── a store that fails AFTER the money has left ─────────────────────────────

/**
 * Replace one store method with a failing one.
 *
 * The shape being reproduced is not exotic. store.persist() rewrites the WHOLE
 * campaign file on every transfer update — a 400-wallet campaign does that
 * eight hundred-odd times — and on Windows `fs.renameSync` over an existing
 * file transiently returns EPERM or EBUSY under an AV scanner or the search
 * indexer. ENOSPC does the same thing on any platform.
 */
function breakStore(store, method, when) {
  const s = store.storeFor('u');
  const real = s[method].bind(s);
  s[method] = (...args) => {
    if (when(...args)) {
      const err = new Error('ENOSPC: no space left on device, write');
      err.code = 'ENOSPC';
      throw err;
    }
    return real(...args);
  };
  return real;
}

test('a store write that fails AFTER a successful send never re-sends that transfer', async () => {
  const { store } = env();
  const clock = fakeClock();
  const sent = [];
  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    sent.push(toAddress);
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 4 });

  // The first `status: 'sent'` write refuses. The ETH has already gone.
  let injected = false;
  breakStore(store, 'updateTransfer', (_id, _tid, patch) => {
    if (injected || patch.status !== 'sent') return false;
    injected = true;
    return true;
  });

  runner.resumeAll();
  await clock.drain();

  // THE ASSERTION THE WHOLE FINDING IS ABOUT. onSuccess() used to sit inside
  // fire()'s `try`, so this threw into `catch (err) -> onFailure(...)`, which
  // treated a completed send as a failed one: the transfer went back to
  // `pending` and the next tick sent it again. One seed wallet then held two
  // funding edges from one master — precisely the fingerprint this feature
  // exists to erase — and the campaign carried on to report `complete`, with
  // nothing an operator could see.
  assert.equal(sent.length, 1, 'a transfer whose send had already succeeded was sent a second time');
  assert.equal(new Set(sent).size, sent.length, 'one address was funded twice from one funding wallet');

  const c = store.storeFor('u').get('c1');
  assert.notEqual(c.status, 'complete', 'a campaign that lost the record of a send reported success');
  assert.equal(c.status, 'halted');
  assert.match(c.haltReason, /ENOSPC/);
  assert.equal(runner._jobs.size, 0);

  // And it must survive the operator's obvious next move. The store still
  // records that transfer as `pending`, so nothing on disk can stop a resume
  // from sending it again — only the in-process record of the send itself can.
  runner.resume('u', 'c1');
  await clock.drain();
  assert.equal(sent.length, 1, 'resuming re-sent a transfer that had already left the funding wallet');
  assert.equal(store.storeFor('u').get('c1').status, 'halted');
});

test('a store write that fails on the FAILURE path halts rather than crashing the process', async () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => {
    throw new Error('relay is down');
  });

  makeCampaign(store, { count: 4 });
  // onFailure() writes too, so it fails for exactly the same reasons.
  breakStore(store, 'updateTransfer', (_id, _tid, patch) => Boolean(patch.attempts));

  runner.resumeAll();
  // The bug is that this REJECTS: the throw escaped fire(), arm()'s catch
  // called halt(), halt() wrote to the same broken store and threw as well —
  // and the timer callback is async, so that is an unhandled rejection, which
  // Node >= 15 turns into process exit. Every other campaign, and every other
  // tab's work, goes with it.
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  assert.equal(c.status, 'halted');
  assert.match(c.haltReason, /relay is down/);
  assert.match(c.haltReason, /could not be recorded/);
  assert.equal(runner._jobs.size, 0);
});

test('a store that refuses the halt write too stops quietly instead of throwing out of the timer', async () => {
  const { store } = env();
  const clock = fakeClock();
  let sends = 0;
  const runner = runnerWith(store, clock, async () => {
    sends++;
    throw new Error('relay is down');
  });

  makeCampaign(store, { count: 4 });
  // Nothing can be written at all: not the attempt, not the re-slot, not the
  // halt. There is then no way to record that the campaign stopped — so it
  // has to at least actually stop, without taking the process with it.
  breakStore(store, 'updateTransfer', () => true);
  breakStore(store, 'update', () => true);

  runner.resumeAll();
  await clock.drain();

  assert.ok(sends >= 1, 'the campaign never even tried');
  assert.equal(runner._jobs.size, 0, 'the runner kept a job for a campaign it could not stop');
  assert.equal(clock.pending(), 0, 'a campaign that could not be halted was left armed');
});

// ── a backlog that appears mid-run, with no restart ─────────────────────────

test('a mid-run backlog is spread, not fired as a burst, with no restart to re-slot it', async () => {
  const { store } = env();
  const clock = fakeClock();
  const times = [];
  let stalled = false;
  const runner = runnerWith(store, clock, async () => {
    times.push(clock.now());
    // The first send hangs for eight hours and the process never restarts: an
    // OS sleep, a suspended VM, or a Relay fetch with no timeout holding
    // job.inFlight for its whole duration. resumeAll() — which was the only
    // caller that re-slotted a backlog — is never reached.
    if (!stalled) {
      stalled = true;
      clock.advance(8 * 60 * 60 * 1000);
    }
    return { hash: '0x' + 'a'.repeat(64) };
  });

  const built = makeCampaign(store, { count: 6 });

  // The premise, asserted rather than assumed: the stall really does strand
  // several transfers. If plan.js ever schedules this campaign so that nothing
  // is overdue after eight hours, the test below would keep passing while
  // testing nothing at all.
  const stallEnd = built.transfers[0].dueAt + 8 * 60 * 60 * 1000;
  const stranded = built.transfers.slice(1).filter((t) => t.dueAt <= stallEnd).length;
  assert.ok(stranded >= 3, `the stall only stranded ${stranded} transfer(s) — that is not a backlog`);

  runner.resumeAll();
  await clock.drain();

  assert.equal(times.length, 6, 'not every transfer was sent');

  // arm() schedules at Math.max(0, dueAt - now) — zero for anything overdue —
  // and fire()'s tail re-arms straight away, so without a re-slot here the
  // transfers stranded by the stall leave the funding wallet on the same
  // millisecond, one after another. That is the batch-funding pattern the
  // campaign spends three weeks avoiding, reproduced in a single tick.
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.equal(new Set(times).size, times.length, `sends bunched onto one instant: gaps ${gaps.join(', ')}`);
  assert.equal(
    gaps.filter((g) => g < 60_000).length,
    0,
    `sends left the funding wallet less than a minute apart: gaps ${gaps.join(', ')}`
  );

  assert.equal(store.storeFor('u').get('c1').status, 'complete');
  assert.equal(runner._jobs.size, 0);
});

// ── two campaigns racing for the same seed wallets ──────────────────────────

test('start refuses seed wallets another campaign has already claimed', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));

  // c1 claims s0…s3 on funding wallet m1.
  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 4 });
  runner.resumeAll();

  // THE RACE routes/v4.js cannot close on its own. It runs assertUnclaimed and
  // then awaits twice — a fee estimate and an RPC balance read — before
  // reaching this call. Two POST /v4/campaigns inside that window both pass the
  // route's check, because it compares against OTHER campaigns only and
  // neither is in the store yet. Different funding wallets, so the nonce guard
  // waves both through; and with `walletIds` omitted both resolve to "every
  // v4seed wallet", so the overlap is total. Parallel campaigns are this
  // feature's headline capability, so two created back to back is expected
  // usage, not an edge case.
  const clash = {
    id: 'c2',
    name: 'c2',
    masterWalletId: 'm2',
    consecutiveFailures: 0,
    transfers: [
      {
        id: '1-1',
        walletId: 's2',
        address: '0x' + '3'.padStart(40, '0'),
        amountEth: '0.001',
        dueAt: clock.now() + 60_000,
        status: 'pending',
        attempts: [],
      },
    ],
  };
  assert.throws(() => runner.start('u', clash), /claimed/i);

  const s = store.storeFor('u');
  assert.equal(s.get('c2'), null, 'the clashing campaign was written to the store anyway');
  assert.equal(s.running().length, 1);
  // s2 must still have exactly one funding edge, from exactly one master.
  const owners = s.campaigns().filter((c) => c.transfers.some((t) => t.walletId === 's2'));
  assert.equal(owners.length, 1);

  // The other direction, so the guard cannot be "refuse every second
  // campaign": fresh seed wallets on a free funding wallet still start.
  const fine = {
    id: 'c3',
    name: 'c3',
    masterWalletId: 'm2',
    consecutiveFailures: 0,
    transfers: [
      {
        id: '1-1',
        walletId: 'brand-new',
        address: '0x' + '9'.repeat(40),
        amountEth: '0.001',
        dueAt: clock.now() + 60_000,
        status: 'pending',
        attempts: [],
      },
    ],
  };
  assert.doesNotThrow(() => runner.start('u', fine));
  assert.equal(s.get('c3').status, 'running');
});
