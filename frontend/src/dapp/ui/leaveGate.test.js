import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAVE_WAIT_MS, inFlight, leaveWarning, leavingText, normalizeWork, pausedReason, waitForQuiet, waitingText } from './leaveGate.js';

const QUIET = { clicks: 0, sending: 0, legs: 0, owed: 0, owedAmount: '0', retryInMs: null, symbol: 'AMZN', decimals: 18 };
const E18 = '000000000000000000';

test('normalizeWork: missing, negative or garbage fields read as nothing pending', () => {
  assert.deepEqual(normalizeWork(null), { clicks: 0, sending: 0, legs: 0, owed: 0, owedAmount: '0', retryInMs: null, symbol: null, decimals: 18 });
  assert.deepEqual(normalizeWork({ clicks: -1, sending: 1.5, legs: 'x', owed: 2, owedAmount: 'lots', retryInMs: -5, symbol: '', decimals: 6 }), {
    clicks: 0,
    sending: 0,
    legs: 0,
    owed: 2,
    owedAmount: '0',
    retryInMs: null,
    symbol: null,
    decimals: 6,
  });
});

test('inFlight: a click being signed, a wallet still sending or a swap to send holds the leave; owed proceeds alone do not', () => {
  assert.equal(inFlight(QUIET), false);
  assert.equal(inFlight(null), false);
  assert.equal(inFlight({ ...QUIET, clicks: 1 }), true);
  assert.equal(inFlight({ ...QUIET, sending: 2 }), true);
  assert.equal(inFlight({ ...QUIET, legs: 1 }), true);
  assert.equal(inFlight({ ...QUIET, owed: 3, owedAmount: '5' }), false, 'a refused swap waits out a backoff: the visitor decides');
});

test('the texts name what is left, the pair token and the time, and say that sells are paused', () => {
  const t = waitingText('lock', { ...QUIET, sending: 2, legs: 1 }, 41_200);
  assert.match(t, /^Locking once/);
  assert.match(t, /2 wallets still sending/);
  assert.match(t, /1 AMZN → ETH swap to send/);
  assert.match(t, /up to 42 s/);
  assert.match(t, /New sells are paused/);
  assert.match(t, /keys, which leave this tab/);
  assert.match(waitingText('disconnect', { ...QUIET, clicks: 1, symbol: null }, 900), /^Disconnecting once .*1 sell click being signed \(up to 1 s\)/);
  assert.doesNotMatch(waitingText('lock', { ...QUIET, clicks: 1, symbol: null }, 900), /swaps are signed/, 'an ETH-quoted venue has no swap to wait for');
  assert.match(waitingText('switch', { ...QUIET, legs: 1 }, 5000), /^Switching accounts once/);
  assert.equal(pausedReason('lock'), 'sells are paused while your account locks');
  assert.equal(pausedReason('disconnect'), 'sells are paused while your account disconnects');
  assert.equal(pausedReason('nonsense'), 'sells are paused while your account locks');
  assert.match(leavingText('switch'), /^Switching accounts: saving your latest changes first/);
});

test('leaveWarning: nothing pending, nothing to confirm', () => {
  assert.equal(leaveWarning('lock', QUIET), null);
  assert.equal(leaveWarning('disconnect', null), null);
});

test('leaveWarning: proceeds a refused swap left in the pair token are named, with what the visitor can still do', () => {
  const work = { ...QUIET, owed: 2, owedAmount: `1234${E18.slice(0, 15)}`, retryInMs: 12_300 };
  const memoryOnly = leaveWarning('lock', work, { persisted: false });
  assert.match(memoryOnly, /2 wallets hold 1\.234 AMZN from sells this page has not turned into ETH yet/);
  assert.match(memoryOnly, /retries on its own in 13 s/);
  assert.match(memoryOnly, /If you lock now, this tab can no longer sign those swaps, and the AMZN stays in the wallets/);
  assert.match(memoryOnly, /Unlock again in this tab and press Convert/);
  assert.match(memoryOnly, /Once this tab is closed or reloaded the page no longer lists it/);
  assert.match(memoryOnly, /Lock anyway\? Cancel keeps everything as it is\.$/);
  const kept = leaveWarning('disconnect', { ...work, owed: 1, retryInMs: 0 }, { persisted: true });
  assert.match(kept, /1 wallet holds 1\.234 AMZN/);
  assert.match(kept, /retries on its own now/);
  assert.match(kept, /Connect and unlock again and press Convert/);
  assert.doesNotMatch(kept, /closed or reloaded/, 'the ledger is kept on this device: a later visit lists it');
  assert.match(kept, /Disconnect anyway\?/);
});

test('leaveWarning: still in flight after the wait', () => {
  const t = leaveWarning('switch', { ...QUIET, sending: 1, legs: 2 });
  assert.match(t, new RegExp(`^Still not done after ${LEAVE_WAIT_MS / 1000} s: 1 wallet still sending, 2 AMZN → ETH swaps to send\\.`));
  assert.match(t, /If you switch accounts now, this tab can no longer sign those swaps/);
  assert.match(t, /Switch accounts anyway\?/);
  const click = leaveWarning('lock', { ...QUIET, clicks: 1, symbol: null }, { waitedMs: 30_000 });
  assert.match(click, /^Still not done after 30 s: 1 sell click being signed\./);
  assert.match(click, /the click still being signed is not sent/);
  assert.doesNotMatch(click, /Convert/);
});

test('no text ever carries an address or a key: counts, one amount and a symbol only', () => {
  const HEX40 = /0x[0-9a-fA-F]{40}/;
  const all = [
    waitingText('lock', { ...QUIET, clicks: 1, sending: 1, legs: 1 }, 1000),
    leaveWarning('lock', { ...QUIET, sending: 1, owed: 1, owedAmount: '5' }),
    leaveWarning('disconnect', { ...QUIET, owed: 3, owedAmount: '7' }, { persisted: true }),
  ];
  for (const t of all) assert.doesNotMatch(t, HEX40);
});

function fakeClock() {
  let t = 1_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

test('waitForQuiet: nothing in flight answers at once and shows no waiting text', async () => {
  const c = fakeClock();
  const shown = [];
  const out = await waitForQuiet({ read: () => QUIET, onWait: (w) => shown.push(w), ...c });
  assert.equal(out, 'quiet');
  assert.deepEqual(shown, []);
  assert.equal(await waitForQuiet({ read: () => null, ...c }), 'quiet', 'no token open');
});

test('waitForQuiet: waits while something is in flight, re-reading every poll', async () => {
  const c = fakeClock();
  const reads = [
    { ...QUIET, sending: 1 },
    { ...QUIET, legs: 1 },
    { ...QUIET, legs: 1 },
    { ...QUIET, owed: 1, owedAmount: '9' },
  ];
  const shown = [];
  const out = await waitForQuiet({ read: () => reads.shift(), onWait: (w, left) => shown.push([w.sending, w.legs, left]), ...c, pollMs: 250 });
  assert.equal(out, 'quiet', 'owed proceeds alone end the wait: the confirmation takes over');
  assert.deepEqual(shown, [
    [1, 0, 60_000],
    [0, 1, 59_750],
    [0, 1, 59_500],
  ]);
});

test('waitForQuiet: the visitor takes it back', async () => {
  const c = fakeClock();
  let polls = 0;
  let cancelled = false;
  const out = await waitForQuiet({
    read: () => {
      polls += 1;
      if (polls === 3) cancelled = true;
      return { ...QUIET, sending: 1 };
    },
    isCancelled: () => cancelled,
    ...c,
  });
  assert.equal(out, 'cancelled');
  assert.equal(polls, 3);
});

test('waitForQuiet: gives up after the timeout and never sleeps past it', async () => {
  const c = fakeClock();
  const naps = [];
  const out = await waitForQuiet({
    read: () => ({ ...QUIET, sending: 1 }),
    now: c.now,
    sleep: async (ms) => {
      naps.push(ms);
      await c.sleep(ms);
    },
    timeoutMs: 1_000,
    pollMs: 300,
  });
  assert.equal(out, 'timeout');
  assert.deepEqual(naps, [300, 300, 300, 100]);
});
