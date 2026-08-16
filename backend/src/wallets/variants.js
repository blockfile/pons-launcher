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
  v1: { dev: 'dev', bundle: 'bundle' },
  // v2 reuses the roles the distributor strategy already declared. They are
  // safe to take: BundlerV2Panel is switched off (SHOW_V2_BUNDLER === false)
  // because the pons v1 factory it targets has launchEnabled === false and a
  // provably empty whitelist, so nothing is currently spending them. If that
  // panel is ever revived, one of the two needs a third role rather than a
  // shared one — sharing is exactly the bug the roles were added to fix.
  v2: { dev: 'v2dev', bundle: 'v2bundle' },
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

module.exports = { VARIANTS, DEFAULT_VARIANT, roles, devWalletFor, bundleWalletsFor };
