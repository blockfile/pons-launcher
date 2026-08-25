/**
 * Which wallets v5 — the letscash.fun (CashCat) bundler — draws, and the handful
 * of formatters its panels share. The console's mirror of backend/src/v5/roles.js.
 *
 * DELIBERATELY NOT AN ENTRY IN variant.js, for the same reason v3/roles.js and
 * v4/roles.js are not. That file mirrors variants.js, the table v1 and v2 share,
 * and v5 shares no lookup with any of them on the backend — a v5 entry there
 * would put the drawing side back together after the spending side had been kept
 * apart, which is the worst of both.
 *
 * As with variant.js, this copy only decides what is DRAWN. The backend copy is
 * what decides which key signs, and it is not reachable from a bundle the browser
 * can be served a stale version of. If the two ever drift, the console shows the
 * wrong list and the backend still refuses the request, which is the safe
 * direction for the disagreement to fall.
 *
 * TWO ROLES:
 *   dev     the launcher wallet. Signs the letscash launch and its atomic first
 *           buy — a SINGLETON, so the panel offers "create" only until one exists.
 *   bundle  the wallets the first-buy supply is fanned out to. Plural.
 */

export const ROLES = {
  dev: 'v5dev',
  bundle: 'v5bundle',
};

/**
 * How many bundle wallets one generate call may ask for.
 *
 * The backend's own ceiling (count must be 1-100 in routes/v5.js). Capped here so
 * the console never OFFERS a number the server will refuse — the refusal itself
 * still lives on the server; this is the shape of the form, not the guard.
 */
export const MAX_GENERATE = 100;

/** Balances arrive as decimal strings. Six places everywhere in this console. */
export const eth = (v) => Number(v || 0).toFixed(6);

/** A compact count with its noun, so panels stop writing this inline. */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
