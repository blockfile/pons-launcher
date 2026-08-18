/**
 * Which wallets V4 draws, and the handful of formatters its panels share — the
 * console's mirror of backend/src/v4/roles.js.
 *
 * DELIBERATELY NOT AN ENTRY IN variant.js, for the same reason v3/roles.js is
 * not. That file mirrors variants.js, the table v1 and v2 share, and V4 shares
 * no lookup with either of them on the backend — a V4 entry there would put the
 * drawing side back together after the spending side had been kept apart, which
 * is the worst of both.
 *
 * As with variant.js, this copy only decides what is DRAWN. The backend copy is
 * what decides which key signs, and it is not reachable from a bundle the
 * browser can be served a stale version of. If the two ever drift, the console
 * shows the wrong list and the backend still refuses the request, which is the
 * safe direction for the disagreement to fall.
 */

export const ROLES = {
  master: 'v4master',
  seed: 'v4seed',
};

/**
 * How many seed wallets one generate call may ask for.
 *
 * The backend's own ceiling (MAX_GENERATE_COUNT in routes/v4.js): adding a
 * wallet rewrites the whole keystore file, so one call is quadratic in bytes
 * written and it runs on the event loop every other tab's requests share. The
 * field is capped here so the console never OFFERS a number the server will
 * refuse. The refusal itself still lives on the server — this is the shape of
 * the form, not the guard.
 */
export const MAX_GENERATE = 200;

/** Balances and amounts arrive as decimal strings. Six places, the same precision v4/plan.js quotes at. */
export const eth = (v) => (v == null || v === '' ? null : Number(v).toFixed(6));

/** A compact count with its noun, so panels stop writing this inline. */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * THIS IS THE READOUT THAT SEPARATES A QUIET CAMPAIGN FROM A STOPPED ONE. A
 * seasoning campaign sends about once an hour and the tab may be left open for
 * weeks, so a counter alone says nothing: 118 sent looks identical whether the
 * last one left six minutes ago or six days ago. "last sent 34m ago" is normal
 * and "last sent 2.4 days ago" is a fault, and neither is visible in a count.
 */
export function ago(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return null;
  const ms = Math.max(0, now - then);
  if (ms < MINUTE_MS) return 'just now';
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ${Math.round((ms % HOUR_MS) / MINUTE_MS)}m ago`;
  return `${(ms / DAY_MS).toFixed(1)} days ago`;
}

/**
 * A wall-clock time — with the date attached whenever it is not today.
 *
 * A bare "15:12" on a schedule that runs for three weeks is ambiguous by a
 * fortnight, and the one thing an operator reads it for is whether the next
 * send is imminent or tomorrow.
 */
export function clock(iso, now = Date.now()) {
  const at = new Date(iso || '');
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
