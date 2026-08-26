/**
 * Which wallets V6 draws — the console's mirror of backend/src/v6/roles.js.
 *
 * DELIBERATELY NOT AN ENTRY IN variant.js. That file mirrors variants.js, the
 * table v1 and v2 share, and V6 shares no lookup with either of them on the
 * backend — adding one here would put the drawing side back together after the
 * spending side was kept apart, which is the worst of both.
 *
 * As with variant.js, this copy only decides what is DRAWN. The backend copy is
 * what decides which key signs, and it is not reachable from a bundle the
 * browser can be served a stale version of. If the two ever drift, the console
 * shows the wrong list and the backend still refuses the request, which is the
 * safe direction for the disagreement to fall.
 */

export const ROLES = {
  treasury: 'v6dev',
  main: 'v6main',
  bundle: 'v6bundle',
};

export const isTreasury = (w) => w?.role === ROLES.treasury;
export const isMain = (w) => w?.role === ROLES.main;
export const isBundle = (w) => w?.role === ROLES.bundle;

/** Balances arrive as decimal strings. Six places everywhere in this console. */
export const eth = (v) => Number(v || 0).toFixed(6);

/** A compact count with its noun, so panels stop writing this inline. */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
