/**
 * Which wallet roles each launcher owns — the console's mirror of
 * backend/src/wallets/variants.js.
 *
 * The two files have to agree, and they are deliberately NOT shared: the
 * backend copy is what actually decides which key signs, and it must not be
 * reachable from a bundle the browser can be served a stale version of. The
 * console's copy only decides which wallets it DRAWS. If they ever drift, the
 * console shows the wrong list and the backend still spends the right wallet,
 * which is the safe direction for the disagreement to fall.
 *
 * Every request that spends carries `variant` in its body. Omitting it means
 * v1 on both sides, so nothing that predates this file changes behaviour.
 */
export const VARIANTS = {
  // `dispersers` must match the backend's copy exactly — it is what decides
  // whether the disperser step is in this launcher's plan at all. It was
  // missing here once, and because `undefined` is falsy the step vanished from
  // BOTH launchers rather than just v2. The test beside this file now compares
  // every shared field for that reason.
  v1: { dev: 'dev', bundle: 'bundle', dispersers: true, label: 'V1' },
  v2: { dev: 'v2dev', bundle: 'v2bundle', dispersers: false, label: 'V2' },
  // v5 (letscash) funds through the SAME shared spine with its own role strings —
  // must mirror the backend's VARIANTS.v5 exactly (the drift test enforces it).
  v5: { dev: 'v5dev', bundle: 'v5bundle', dispersers: false, label: 'V5' },
};

export const DEFAULT_VARIANT = 'v1';

/** The role pair for a variant. Unknown names fall back to v1's — see below. */
export function rolesFor(variant = DEFAULT_VARIANT) {
  // The console falls back where the backend throws, and the asymmetry is
  // deliberate. Here a bad name would blank the screen; there it would point a
  // spend at the wrong wallets. Showing v1's wallets is recoverable, and the
  // request the panel then makes still names the variant the operator chose,
  // so the backend refuses it loudly rather than spending anything.
  return VARIANTS[variant] || VARIANTS[DEFAULT_VARIANT];
}

/** Is this wallet one of the variant's bundle wallets? */
export function isBundle(wallet, variant = DEFAULT_VARIANT) {
  return wallet?.role === rolesFor(variant).bundle;
}

/** Is this wallet the variant's dev wallet? */
export function isDev(wallet, variant = DEFAULT_VARIANT) {
  return wallet?.role === rolesFor(variant).dev;
}
