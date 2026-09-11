import { rolesFor } from '../variant.js';

/**
 * Which wallets a v1/v2 key export actually covers.
 *
 * Its own module, and pure, because it is the thing that has to be RIGHT: the
 * shared BackupControls used to hand over `ks.exportAll()` — every key the
 * console holds, V3 through V8 included — from a button that sits beside the
 * v1/v2 bundle. The backend is scoped now and is what decides what the file
 * contains; this decides what the DIALOG SAYS the file contains, and a dialog
 * that names the wrong count on a key export is its own hazard.
 *
 * The two have to agree, and they are deliberately not shared: the backend copy
 * is what actually reads keys and must not be reachable from a bundle the
 * browser can be served a stale version of. Same argument as variant.js, which
 * this leans on for the role pair.
 *
 * THE TAB'S OWN TWO ROLES ARE THE FLOOR. `role` and `walletIds` only ever
 * narrow it, so no argument shape can widen the answer to another tab's wallet
 * — an id naming a v4 seed simply matches nothing.
 */

/** Every wallet this launcher owns: its dev wallet and its bundle wallets. */
export function tabWallets(wallets, variant = 'v1') {
  const roles = rolesFor(variant);
  return (wallets || []).filter((w) => w?.role === roles.dev || w?.role === roles.bundle);
}

/**
 * The wallets one export covers, and what KIND of export it is.
 *
 *   { walletIds } — exactly those, intersected with the tab (wins over role).
 *                   An empty array is a real, empty selection: the caller only
 *                   passes one when rows are ticked, and treating it as "all"
 *                   is how a scoped export quietly becomes a whole-tab one.
 *   { role }      — one tier: the tab's dev role, or its bundle role. A role
 *                   this tab does not own matches nothing.
 *   neither       — the whole tab.
 *
 * Returns { kind, wallets, tabCount } — tabCount is the tab's total, so a
 * filtered dialog can say "N of M" without recomputing the floor.
 */
export function resolveBackupScope(wallets, { variant = 'v1', role = null, walletIds = null } = {}) {
  const tab = tabWallets(wallets, variant);
  if (Array.isArray(walletIds)) {
    const wanted = new Set(walletIds.map(String));
    return { kind: 'selected', wallets: tab.filter((w) => wanted.has(String(w.id))), tabCount: tab.length };
  }
  if (role) {
    return { kind: 'role', wallets: tab.filter((w) => w.role === role), tabCount: tab.length };
  }
  return { kind: 'all', wallets: tab, tabCount: tab.length };
}

/**
 * The word the dialog uses for a tier. Roles are per-variant strings ('bundle'
 * vs 'v2bundle'), and a key-export dialog is the last place to be loose about
 * which keys are in the file.
 */
export function tierWord(role, variant = 'v1') {
  const roles = rolesFor(variant);
  if (role === roles.dev) return 'dev';
  if (role === roles.bundle) return 'bundle';
  return role || '';
}

/**
 * The filename of a V1/V2 key export: {count}pcs-{TAB}-{what}-{date}.{ext},
 * e.g. 31pcs-V2-bundle-wallets-2026-09-11.xlsx.
 *
 * `what` comes from what the file HOLDS, not from what was asked for: when every
 * wallet in it has the same role it is that role's word; a mixed file is plain
 * "wallets", or "all-wallets" when nothing narrowed it. A narrowed export keeps
 * its qualifier in front ("selected"). A name built from the request alone has
 * already lied once — a V4 "nofunders" export that held a funding wallet.
 *
 * NOT tierWord. That hands an unknown role back raw, which a dialog sentence can
 * survive and a filename cannot: "v2bundle" in a V1 file's name claims keys the
 * file does not hold. Only this tab's own two roles ever become a word, and the
 * comparison is explicit rather than a lookup table, so no role string can reach
 * an inherited property and put something stranger in the name.
 *
 * The date is UTC, like the exportedAt it is normally handed.
 *
 * The V1/V2 pair's own copy, per the tab-isolation rule: every tab has one.
 */
export function backupFileName({
  variant = 'v1',
  wallets = [],
  qualifier = '',
  ext = 'json',
  date = new Date(),
} = {}) {
  const roles = rolesFor(variant);
  const list = wallets || [];
  const held = new Set(list.map((w) => w?.role));
  const only = held.size === 1 ? [...held][0] : undefined;
  const kind = only === roles.dev ? 'dev' : only === roles.bundle ? 'bundle' : '';
  const noun = list.length === 1 ? 'wallet' : 'wallets';
  const what = [qualifier || (kind ? '' : 'all'), kind, noun].filter(Boolean).join('-');
  return `${list.length}pcs-${variant.toUpperCase()}-${what}-${date.toISOString().slice(0, 10)}.${ext}`;
}
