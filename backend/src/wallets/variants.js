/**
 * Which wallet roles each launcher owns.
 *
 * The keystore has always been able to hold both sets — see ROLES in
 * keystore.js — but every money path reached for them by name: devWallet() and
 * bundleWallets() are role === 'dev' and role === 'bundle', hardcoded. That was
 * correct while there was one launcher and wrong the moment there were two,
 * because it meant a second launcher could only ever spend the first one's
 * wallets.
 *
 * This is the whole of the separation. A variant is a pair of role names, and
 * the money paths take one instead of assuming v1's. Everything else — the
 * encryption, the archive, the backups, the singleton rule, the activity log —
 * is untouched and shared, which is the point: the two launchers differ in
 * WHICH wallets they spend and in nothing else.
 *
 * DEFAULTS MATTER MORE THAN THE FEATURE. Every caller that does not name a
 * variant gets v1, resolved to the same two role strings the code had inline
 * before. A v1 run that passes nothing must behave exactly as it did, because
 * v1 is the launcher that moves real money today and this file is not worth one
 * ETH of regression.
 */
const VARIANTS = {
  // `dispersers` is whether the launcher batches funding through a deployed
  // Disperse contract. v1 does; v2 funds with individual transfers and has no
  // step 2 at all. It is a property of the launcher rather than a setting,
  // because the whole point of the disperser is to survive rate limiting on a
  // large fan-out, and a launcher that is not doing that fan-out has nothing to
  // batch — offering the step anyway would be a control that costs gas to
  // deploy and then never gets used.
  v1: { dev: 'dev', bundle: 'bundle', dispersers: true },
  // v2 owns these outright. The distributor strategy used to hold v2dev and
  // v2bundle; it moved to distdev/distfunding/distbundle when this launcher
  // took them, so nothing else can reach them — see the note above ROLES in
  // keystore.js.
  v2: { dev: 'v2dev', bundle: 'v2bundle', dispersers: false },
  // v5 is the letscash (CashCat) bundler. It funds through this SHARED spine (its
  // routes/v5.js header says so) but owns its OWN role strings — 'v5dev' /
  // 'v5bundle', already in keystore.js's ROLES — so a v5 fund resolves v5's dev as
  // the source and v5's bundle as the targets, and can never reach v1/v2's wallets.
  // No dispersers: like v2 it funds with individual transfers (letscash's bundle
  // primitive is an untaxed TOKEN fan-out, not a big ETH fan-out that needs
  // batching through a Disperse contract).
  v5: { dev: 'v5dev', bundle: 'v5bundle', dispersers: false },
};

const DEFAULT_VARIANT = 'v1';

/**
 * Resolve a variant name to its role pair.
 *
 * Unknown names throw rather than falling back. A typo that silently resolved
 * to v1 would point a v2 request at v1's funded wallets, which is the single
 * worst outcome this module can produce — the roles exist to make that
 * impossible, so the failure has to be loud.
 */
function roles(variant = DEFAULT_VARIANT) {
  const found = VARIANTS[variant];
  if (!found) {
    throw new Error(`unknown launcher variant "${variant}" — expected ${Object.keys(VARIANTS).join(' or ')}`);
  }
  return found;
}

/** The dev/signer wallet for a variant, or throw naming the role that is missing. */
function devWalletFor(ks, variant = DEFAULT_VARIANT) {
  const { dev } = roles(variant);
  // v1 keeps its own accessor so its error message — the one operators have
  // been reading for months — does not change wording.
  if (dev === 'dev') return ks.devWallet();
  const found = ks.walletWithRole(dev);
  if (!found) throw new Error(`no ${dev} wallet in the keystore — generate or import one first`);
  return found;
}

/** Every bundle wallet for a variant. */
function bundleWalletsFor(ks, variant = DEFAULT_VARIANT) {
  const { bundle } = roles(variant);
  return bundle === 'bundle' ? ks.bundleWallets() : ks.walletsWithRole(bundle);
}

/** Does this launcher batch its funding through a Disperse contract? */
function usesDispersers(variant = DEFAULT_VARIANT) {
  return roles(variant).dispersers === true;
}

module.exports = {
  VARIANTS,
  DEFAULT_VARIANT,
  roles,
  devWalletFor,
  bundleWalletsFor,
  usesDispersers,
};
