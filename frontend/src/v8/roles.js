/**
 * Which wallets V8 draws, and the handful of formatters its panels share — the
 * console's mirror of backend/src/v8/roles.js.
 *
 * DELIBERATELY NOT AN ENTRY IN variant.js, for the same reason v3/v4/v5/v6/v7
 * are not. That file mirrors variants.js, the table v1 and v2 share, and V8
 * shares no lookup with any of them on the backend — an entry there would put
 * the drawing side back together after the spending side had been kept apart,
 * which is the worst of both.
 *
 * As with variant.js, this copy only decides what is DRAWN. The backend copy is
 * what decides which key signs, and it is not reachable from a bundle the
 * browser can be served a stale version of. If the two ever drift, the console
 * shows the wrong list and the backend still refuses the request, which is the
 * safe direction for the disagreement to fall.
 *
 * TWO ROLES, AND NO OTHERS. V8 is not a launcher: there is no dev wallet
 * because nothing here signs a launch, and no treasury because the source IS
 * the treasury.
 *   main    the one wallet the ETH comes out of. A SINGLETON — the panel offers
 *           "create" only until one exists.
 *   bundle  the destinations. Plural, and deliberately uncapped.
 */

export const ROLES = {
  main: 'v8main',
  bundle: 'v8bundle',
};

export const isMain = (w) => w?.role === ROLES.main;
export const isBundle = (w) => w?.role === ROLES.bundle;

/**
 * How many destination wallets one generate call may ask for.
 *
 * NOT THE 31-WALLET CAP. That number is the length of the pons factory's
 * snipe-tax exemption list and binds only at a launch; V8 never launches, so
 * this tab holds as many wallets as the operator wants. What this is instead is
 * a budget for how long one REQUEST may block the event loop — key generation
 * is synchronous and the keystore is rewritten around it — so the answer to
 * "more than this" is another press, not a bigger number.
 *
 * Capped here so the console never OFFERS a count the server will refuse. The
 * refusal itself still lives on the server; this is the shape of the form.
 */
export const MAX_GENERATE = 100;

/** Balances arrive as decimal strings. Six places everywhere in this console. */
export const eth = (v) => Number(v || 0).toFixed(6);

/** A compact count with its noun, so panels stop writing this inline. */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whole days since an ISO timestamp (a wallet's createdAt), or null when absent. */
export const ageDays = (iso) => {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400000)) : null;
};

/**
 * A wall-clock time, with the date attached whenever it is not today.
 *
 * Timed funding runs for hours or days, so a bare "15:12" on the next-send line
 * is ambiguous by exactly the interval an operator is trying to read.
 */
export function clock(iso, now = Date.now()) {
  const at = new Date(iso || '');
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * The rows POST /v8/transfer and its timed twin take, built from the amounts
 * typed in the table.
 *
 * ONE DEFINITION, because three places read it: the transfer panel's button
 * (what it is about to send), the console's step line (what is queued), and the
 * timed start. A blank or zero row is not a target — it is a wallet the
 * operator chose to skip — so it is filtered out here rather than sent as a
 * zero the backend has to interpret.
 *
 * `walletId` is the wire name; `id` is what GET /v8/wallets returns. The
 * mapping happens here so no panel has to remember which side it is on.
 */
export function targetsFor(bundle, rows = {}) {
  return bundle
    .map((w) => ({ walletId: w.id, amountEth: rows[w.id]?.amount }))
    .filter((t) => Number(t.amountEth) > 0);
}

/** What a set of targets adds up to, as a number, for the totals on screen. */
export const totalEth = (targets) => targets.reduce((s, t) => s + Number(t.amountEth || 0), 0);
