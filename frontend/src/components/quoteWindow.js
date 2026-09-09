// HOW LONG THE UNTIMED v2 RELAY FUNDING RUN HOLDS ITS OWN REQUEST OPEN — and
// whether the gateway in front of this console will still be listening when it
// finishes.
//
// THE RUN THIS EXISTS FOR. The operator pressed "Relay 0.4303 ETH to 30
// wallets" and got 504 Gateway Time-out. Twice. Both runs continued on the
// server (the dev wallet's nonce went 7 → 29 after the first 504) and mostly
// succeeded, but the console could report neither progress nor outcome, and a
// half-finished funding run cannot be safely re-pressed: /api/v2/relay/fund does
// not skip a destination that already arrived.
//
// WHY IT TIMES OUT AT ALL. backend/src/relay/funding.js quotes EVERY wallet
// before it sends ANY deposit — quoteInBatches first, then the sends — because
// the nonce assignment downstream needs the full quoted list in order. Relay's
// per-IP quote budget is small (see timedRate.js capReason), so the quotes go
// out `relayQuoteBatchSize` at a time with `relayQuoteGapMs` between batches.
// One wallet per gap at a 15 s gap is 450 s of quoting with nothing on chain,
// against nginx's 180 s proxy_read_timeout (deploy/nginx.conf,
// deploy/nginx-rhbond.conf). The request dies; the run does not.
//
// SO THE ESTIMATE IS THE FEATURE. The untimed button is genuinely the right
// control for one or two wallets — one press, an immediate answer — and it was
// simply unbounded. This file gives it its limit, in the same arithmetic the
// backend paces by, so the console can say what a press costs BEFORE it is a
// press.
//
// Pure: no fetches, no state, no money. Numbers in, sentences out.

import { intervalLabel, timedRate, MAX_WALLETS_PER_TICK } from './timedRate.js';

// ── THE THREE NUMBERS, AND WHERE EACH ONE REALLY LIVES ──────────────────────
//
// All three are fallbacks ONLY — the values actually used come from the server,
// on the `quotePacing` block of GET /api/v2/relay/timed-fund (the one funding
// endpoint the console already polls). These are what to draw in the moment
// before that first poll answers, and they are the backend's own defaults so
// the two cannot silently disagree:
//
//   batch size / gap   backend/src/config.js relayQuoteBatchSize / relayQuoteGapMs
//   gateway timeout    backend/src/config.js gatewayTimeoutMs, whose default is
//                      the 180s proxy_read_timeout this repo's own nginx configs
//                      ship with, overridable with GATEWAY_TIMEOUT_MS for a
//                      deployment that has raised the directive.
//
// A deployment running a 15 s gap and a console that assumed 4 s would tell the
// operator a comfortable lie, which is worse than saying nothing, so nothing
// here is used once the server has spoken.
export const QUOTE_BATCH_SIZE = 1;
export const QUOTE_GAP_MS = 4000;
export const GATEWAY_TIMEOUT_MS = 180_000;

/** A span of seconds as an operator reads a stopwatch: "15 s", "2 min 45 s", "7 min 30 s". */
export function formatSeconds(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/**
 * THE PROJECTION.
 *
 * `ms` is batches × gap, and the trailing gap is deliberate — the backend takes
 * only (batches − 1) gaps between batches. That last one stands in for
 * everything the request still owes after the final quote and before it can
 * answer: the quote round-trips themselves, the fee refresh, the dev-wallet
 * balance read, and the N deposit broadcasts. Counting it is the same choice
 * timedRate.js makes for the same reason, and it errs toward warning early —
 * which for a trap that costs a 504 is the direction to err in.
 *
 * `maxWallets` is the largest count whose projection lands STRICTLY under the
 * gateway's window: the largest integer b with b × gap < timeout is
 * ceil(timeout / gap) − 1 (which is floor() when the division is not exact, and
 * one less when it is), times the batch size.
 *
 * A zero gap or a zero timeout means there is nothing to project against — no
 * pacing configured, or no proxy in front — so the run is `bounded: false` and
 * is never called over.
 *
 * @param {{wallets?: number, gapMs?: number, batchSize?: number, timeoutMs?: number}} o
 */
export function quoteWindow({
  wallets = 0,
  gapMs = QUOTE_GAP_MS,
  batchSize = QUOTE_BATCH_SIZE,
  timeoutMs = GATEWAY_TIMEOUT_MS,
} = {}) {
  const count = Math.max(0, Math.floor(Number(wallets)) || 0);
  const size = Math.max(1, Math.floor(Number(batchSize)) || 1);
  // An unreadable gap becomes "no pacing configured", which projects nothing and
  // therefore claims nothing — the honest reading of "we do not know yet".
  const gap = Math.max(0, Number(gapMs) || 0);
  // An unreadable TIMEOUT is the opposite case and takes the opposite default:
  // falling through to 0 would mean "no proxy in front", which silently disarms
  // the whole guard. Unknown means the documented 180 s, and an explicit 0 (only
  // an operator can write one) still means unbounded.
  const limitMs =
    timeoutMs == null || !Number.isFinite(Number(timeoutMs))
      ? GATEWAY_TIMEOUT_MS
      : Math.max(0, Number(timeoutMs));

  const batches = count ? Math.ceil(count / size) : 0;
  const ms = batches * gap;
  const seconds = ms / 1000;

  const bounded = gap > 0 && limitMs > 0;
  const maxWallets = bounded ? Math.max(0, Math.ceil(limitMs / gap) - 1) * size : null;
  const over = bounded && count > 0 && ms >= limitMs;

  const duration = formatSeconds(seconds);
  const limitLabel = formatSeconds(limitMs / 1000);

  let sentence = '';
  if (count > 0 && gap > 0) {
    sentence = bounded
      ? over
        ? `about ${duration} of quoting before the first deposit — past the gateway's ${limitLabel}`
        : `about ${duration} of quoting before the first deposit, inside the gateway's ${limitLabel}`
      : `about ${duration} of quoting before the first deposit`;
  }

  return {
    wallets: count,
    batchSize: size,
    batches,
    gapMs: gap,
    ms,
    seconds,
    timeoutMs: limitMs,
    bounded,
    over,
    maxWallets,
    duration,
    limitLabel,
    sentence,
  };
}

/**
 * WHAT TO DO INSTEAD, in the words of the control that can actually do it.
 *
 * The timed path is not a smaller version of this button, it is the other one:
 * the server holds the job, the browser may close, and it is paced at Relay's
 * measured budget rather than against a proxy's patience. Its arithmetic is
 * already written and already tested, so this only names the settings that fit
 * and lets timedRate do the sums.
 *
 * @param {{wallets?: number, perTick?: number, intervalMinutes?: number}} o
 */
export function timedAlternative({ wallets = 0, perTick = MAX_WALLETS_PER_TICK, intervalMinutes = 1 } = {}) {
  const rate = timedRate({ wallets, perTick, intervalMinutes, max: perTick });
  if (!rate.wallets) return '';
  return `timed funding, ${rate.perTick} per tick at ${intervalLabel(rate.intervalMinutes)} — ${rate.eta}`;
}

// ── AFTER THE PRESS: WHAT A DEAD REQUEST ACTUALLY MEANS ─────────────────────
//
// The statuses a proxy uses to say "I stopped waiting for the upstream", as
// opposed to "the upstream refused you". 504 is nginx's proxy_read_timeout,
// which is the one this console meets; 524 is Cloudflare's equivalent, kept
// here so putting this behind Cloudflare does not silently reclassify the same
// event as a failure. 502/503 are deliberately NOT in the set: those mean the
// backend was unreachable or down, and a run that never started must not be
// described as one that is still going.
const GATEWAY_TIMEOUT_STATUS = new Set([504, 524]);

/**
 * WHY A 504 IS NOT A FAILURE, said at the moment it is mistaken for one.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   'failed'   the server answered and refused — an ordinary error, unchanged.
 *   'timedOut' the GATEWAY answered, because the server had not. The deposits
 *              are still going out. This is the case that cost the operator a
 *              second press.
 *   'unknown'  nothing answered at all: fetch itself rejected, so there is no
 *              HTTP status to read. This CANNOT be told apart from a gateway
 *              timeout from the browser — a dropped connection and a proxy that
 *              gave up look identical here — and the honest report is the
 *              ambiguity, not a guess. Either way the request may have been
 *              received and executed, so it takes the same care as a 504.
 *
 * Every non-'failed' branch ends on the same sentence, because it is the one
 * that prevents the double-fund: pressing again starts a SECOND run, and
 * /api/v2/relay/fund does not skip wallets that already arrived. That sentence
 * comes out as a `crux` so the panel can lift it above the two explaining it —
 * the notice's own emphasis mechanism, no new colour — while `text` flattens
 * the whole thing for the plain readout.
 *
 * @param {{status?: number|null, message?: string, wallets?: number, window?: object}} o
 * @returns {{kind: 'failed'|'timedOut'|'unknown', headline: string,
 *            lines: Array<{crux?: string, text: string}>, text: string}}
 */
export function fundFailure({ status = null, message = '', wallets = 0, window: win = null } = {}) {
  const msg = String(message || '').trim() || 'no message';
  const count = Math.max(0, Math.floor(Number(wallets)) || 0);
  const plural = count === 1 ? 'wallet' : 'wallets';
  // `status == null` is the whole distinction — fetch rejecting outright leaves
  // no status to read, and Number(null) is 0, which is finite and would file the
  // ambiguous case as an ordinary refusal.
  const code = status == null ? null : Number(status);

  if (code !== null && Number.isFinite(code) && !GATEWAY_TIMEOUT_STATUS.has(code)) {
    return {
      kind: 'failed',
      headline: `ERROR: ${msg}`,
      lines: [],
      text: `ERROR: ${msg}`,
    };
  }

  const timedOut = code !== null && Number.isFinite(code) && GATEWAY_TIMEOUT_STATUS.has(code);
  const projected = win?.sentence
    ? ` The run was projected at ${win.duration} of quoting alone.`
    : '';

  const headline = timedOut
    ? `${code} Gateway Time-out${win?.limitLabel ? ` after ${win.limitLabel}` : ''} — the gateway gave up on the ANSWER, not the run.`
    : 'No answer came back — this is NOT a report that the funding failed.';

  const first = timedOut
    ? {
        text:
          `The proxy stopped waiting for a response. The server is still quoting and sending ` +
          `deposits to ${count} ${plural}.${projected}`,
      }
    : {
        text:
          `The request never returned an HTTP status (${msg}), and from the browser a dropped ` +
          `connection and a gateway that timed out look exactly alike. Treat it as UNKNOWN, not ` +
          `failed: the server may already have quoted and sent every deposit for ${count} ` +
          `${plural}.${projected}`,
      };

  const lines = [
    first,
    {
      text:
        "The dev wallet's nonce is the only reliable status — it climbs by one per deposit sent. " +
        'Read it, or re-read the wallet balances in a minute.',
    },
    {
      crux: 'Do not press this again.',
      text:
        'A second press starts a SECOND run, and this route does not skip wallets that already ' +
        'arrived — every wallet would be funded twice.',
    },
  ];

  return {
    kind: timedOut ? 'timedOut' : 'unknown',
    headline,
    lines,
    text: [headline, ...lines.map((l) => (l.crux ? `${l.crux} ${l.text}` : l.text))].join('\n\n'),
  };
}
