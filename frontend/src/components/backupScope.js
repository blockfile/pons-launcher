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
