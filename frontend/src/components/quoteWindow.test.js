import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAY_TIMEOUT_MS,
  QUOTE_BATCH_SIZE,
  QUOTE_GAP_MS,
  formatSeconds,
  fundFailure,
  quoteWindow,
  timedAlternative,
} from './quoteWindow.js';

// The live settings the two 504s happened under: one wallet per quote, 15 s
// between quotes, nginx waiting 180 s.
const LIVE = { gapMs: 15_000, batchSize: 1, timeoutMs: 180_000 };

// ── THE RUN THAT CAUSED THIS ────────────────────────────────────────────────

test('the failure of record: 30 wallets is 7 min 30 s against a 3 min gateway', () => {
  const w = quoteWindow({ wallets: 30, ...LIVE });
  assert.equal(w.batches, 30, 'one wallet per batch at batchSize 1');
  assert.equal(w.ms, 450_000);
  assert.equal(w.duration, '7 min 30 s');
  assert.equal(w.limitLabel, '3 min');
  assert.equal(w.over, true);
});

test('one wallet is 15 s and is exactly what the untimed button is for', () => {
  const w = quoteWindow({ wallets: 1, ...LIVE });
  assert.equal(w.duration, '15 s');
  assert.equal(w.over, false);
  assert.match(w.sentence, /inside the gateway's 3 min/);
});

test('twelve wallets lands ON the gateway window, and on it is over it', () => {
  const w = quoteWindow({ wallets: 12, ...LIVE });
  assert.equal(w.ms, 180_000);
  assert.equal(w.duration, '3 min');
  assert.equal(w.over, true, 'equal to the timeout is not under it — there is no send phase left');
});

test('the limit at the live settings is eleven wallets, and eleven fits', () => {
  assert.equal(quoteWindow({ wallets: 0, ...LIVE }).maxWallets, 11);
  assert.equal(quoteWindow({ wallets: 11, ...LIVE }).over, false);
  assert.equal(quoteWindow({ wallets: 11, ...LIVE }).ms, 165_000);
  assert.equal(quoteWindow({ wallets: 12, ...LIVE }).over, true);
});

// ── THE ARITHMETIC HOLDS AT OTHER SETTINGS ──────────────────────────────────

test('the batch size divides the wallet count — it is never assumed to be one', () => {
  const w = quoteWindow({ wallets: 30, gapMs: 15_000, batchSize: 3, timeoutMs: 180_000 });
  assert.equal(w.batches, 10);
  assert.equal(w.ms, 150_000);
  assert.equal(w.over, false, 'three quotes per gap is a third of the wait');
  assert.equal(w.maxWallets, 33, '11 batches of 3');
});

test('a partial last batch still costs a whole gap', () => {
  assert.equal(quoteWindow({ wallets: 7, gapMs: 1000, batchSize: 3 }).batches, 3);
  assert.equal(quoteWindow({ wallets: 6, gapMs: 1000, batchSize: 3 }).batches, 2);
});

test('the backend default gap fits a whole bundle inside the window', () => {
  const w = quoteWindow({ wallets: 31, gapMs: QUOTE_GAP_MS, batchSize: QUOTE_BATCH_SIZE });
  assert.equal(w.ms, 124_000);
  assert.equal(w.over, false, '31 wallets at a 4 s gap is why this was never hit before');
  assert.equal(w.maxWallets, 44);
});

test('maxWallets is the largest count that lands strictly under, exact division or not', () => {
  // 180000 / 7000 = 25.71 → 25 batches (175 s), and 26 would be 182 s.
  assert.equal(quoteWindow({ gapMs: 7000, timeoutMs: 180_000 }).maxWallets, 25);
  assert.equal(quoteWindow({ wallets: 25, gapMs: 7000, timeoutMs: 180_000 }).over, false);
  assert.equal(quoteWindow({ wallets: 26, gapMs: 7000, timeoutMs: 180_000 }).over, true);
  // 180000 / 15000 = 12 exactly → 11, because 12 batches is the timeout itself.
  assert.equal(quoteWindow({ gapMs: 15_000, timeoutMs: 180_000 }).maxWallets, 11);
});

test('a raised nginx timeout raises the limit with it — the escape hatch is real', () => {
  const w = quoteWindow({ wallets: 30, gapMs: 15_000, batchSize: 1, timeoutMs: 900_000 });
  assert.equal(w.over, false);
  assert.equal(w.maxWallets, 59);
});

test('a gap so wide that one wallet cannot fit reports a limit of zero, not a negative', () => {
  const w = quoteWindow({ wallets: 1, gapMs: 300_000, timeoutMs: 180_000 });
  assert.equal(w.maxWallets, 0);
  assert.equal(w.over, true);
});

// ── NOTHING TO PROJECT AGAINST ──────────────────────────────────────────────

test('no quote gap configured means no projection and no warning', () => {
  const w = quoteWindow({ wallets: 30, gapMs: 0, timeoutMs: 180_000 });
  assert.equal(w.bounded, false);
  assert.equal(w.over, false);
  assert.equal(w.maxWallets, null);
  assert.equal(w.sentence, '', 'a run with no paced wait has nothing to promise');
});

test('no gateway timeout configured means the run is never called over', () => {
  const w = quoteWindow({ wallets: 30, gapMs: 15_000, timeoutMs: 0 });
  assert.equal(w.bounded, false);
  assert.equal(w.over, false);
  assert.equal(w.sentence, 'about 7 min 30 s of quoting before the first deposit');
});

test('an empty table projects nothing and warns about nothing', () => {
  const w = quoteWindow({ wallets: 0, ...LIVE });
  assert.equal(w.batches, 0);
  assert.equal(w.ms, 0);
  assert.equal(w.over, false);
  assert.equal(w.sentence, '');
});

test('garbage in does not produce a confident number', () => {
  const w = quoteWindow({ wallets: 'many', gapMs: null, batchSize: undefined, timeoutMs: NaN });
  assert.equal(w.wallets, 0);
  assert.equal(w.batchSize, 1);
  assert.equal(w.gapMs, 0);
  assert.equal(w.timeoutMs, GATEWAY_TIMEOUT_MS, 'an unreadable timeout falls back, it does not vanish');
  assert.equal(w.over, false);
});

test('the documented fallbacks are the backend config defaults', () => {
  assert.equal(QUOTE_BATCH_SIZE, 1);
  assert.equal(QUOTE_GAP_MS, 4000);
  assert.equal(GATEWAY_TIMEOUT_MS, 180_000, "nginx's proxy_read_timeout in deploy/nginx.conf");
});

// ── formatSeconds ───────────────────────────────────────────────────────────

test('a stopwatch, not a clock', () => {
  assert.equal(formatSeconds(0), '0 s');
  assert.equal(formatSeconds(15), '15 s');
  assert.equal(formatSeconds(59), '59 s');
  assert.equal(formatSeconds(60), '1 min');
  assert.equal(formatSeconds(165), '2 min 45 s');
  assert.equal(formatSeconds(450), '7 min 30 s');
  assert.equal(formatSeconds(-5), '0 s');
  assert.equal(formatSeconds('nope'), '0 s');
});

// ── WHAT TO DO INSTEAD ──────────────────────────────────────────────────────

test('the alternative is computed, and is the sentence the operator was owed', () => {
  assert.equal(
    timedAlternative({ wallets: 30 }),
    'timed funding, 4 per tick at 1 min — about 8 min for 30 wallets'
  );
});

test('the alternative follows the cap the server reports, not a constant', () => {
  assert.equal(
    timedAlternative({ wallets: 30, perTick: 2 }),
    'timed funding, 2 per tick at 1 min — about 15 min for 30 wallets'
  );
});

test('no wallets, no advice', () => {
  assert.equal(timedAlternative({ wallets: 0 }), '');
});

// ── THE 504 ─────────────────────────────────────────────────────────────────

test('a 504 is reported as a run still going, never as a failure', () => {
  const f = fundFailure({
    status: 504,
    message: '504 Gateway Time-out',
    wallets: 30,
    window: quoteWindow({ wallets: 30, ...LIVE }),
  });
  assert.equal(f.kind, 'timedOut');
  assert.match(f.headline, /gave up on the ANSWER, not the run/);
  assert.doesNotMatch(f.text, /^ERROR/);
  assert.match(f.text, /still quoting and sending/);
  assert.match(f.text, /nonce is the only reliable status/);
  assert.match(f.text, /Do not press this again\./);
  assert.match(f.text, /SECOND run/);
  assert.match(f.text, /7 min 30 s/, 'it quotes the projection it warned with beforehand');
});

test("Cloudflare's 524 is the same event and gets the same sentence", () => {
  const f = fundFailure({ status: 524, message: 'A timeout occurred', wallets: 30 });
  assert.equal(f.kind, 'timedOut');
  assert.match(f.text, /Do not press this again\./);
});

test('a 502 is NOT a timeout — a run that never started must not be called still going', () => {
  const f = fundFailure({ status: 502, message: '502 Bad Gateway', wallets: 30 });
  assert.equal(f.kind, 'failed');
  assert.equal(f.text, 'ERROR: 502 Bad Gateway');
});

test('an ordinary refusal is reported exactly as it always was', () => {
  const f = fundFailure({
    status: 400,
    message: 'v2 dev wallet has 0.1 ETH but Relay deposits need up to 0.5',
    wallets: 30,
  });
  assert.equal(f.kind, 'failed');
  assert.equal(f.lines.length, 0);
  assert.equal(f.text, 'ERROR: v2 dev wallet has 0.1 ETH but Relay deposits need up to 0.5');
});

test('no status at all is reported as AMBIGUOUS, not guessed either way', () => {
  const f = fundFailure({ status: null, message: 'Failed to fetch', wallets: 30 });
  assert.equal(f.kind, 'unknown');
  assert.match(f.text, /never returned an HTTP status/);
  assert.match(f.text, /dropped connection and a gateway that timed out look exactly alike/);
  assert.equal(f.lines.at(-1).crux, 'Do not press this again.', 'the double-fund clause is liftable');
  assert.match(f.text, /UNKNOWN, not failed/);
  assert.match(f.text, /Do not press this again\./, 'the same care, because it may have run');
});

test('the wallet count reads as English on the one-wallet case', () => {
  const f = fundFailure({ status: 504, message: 'x', wallets: 1 });
  assert.match(f.text, /to 1 wallet\./);
});
