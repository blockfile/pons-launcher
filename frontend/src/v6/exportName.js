/**
 * The filename of a V6 key export: {count}pcs-V6-{what}[-{suffix}]-{date}.{ext},
 * e.g. 30pcs-V6-bundle-wallets-2026-09-11.json.
 *
 * `what` comes from what the file HOLDS, not from what was asked for: when every
 * wallet in it has the same role it is that role's word; a mixed file is plain
 * "wallets", or "all-wallets" when nothing narrowed it. A narrowed export keeps its
 * qualifier in front ("selected"). A name built from the request alone has already
 * lied once — a "nofunders" export that held a funding wallet.
 *
 * v6dev is written "treasury", not "dev": that is the word ROLES and every V6
 * panel use for it, so the file is named the way the tab talks.
 *
 * V6's own copy, per the tab-isolation rule: every tab has one. The role strings
 * are spelled out rather than imported so this stays a leaf module node --test can
 * load; exportName.test.js checks them against roles.js.
 */
const ROLE_WORD = { v6dev: 'treasury', v6main: 'main', v6bundle: 'bundle' };

export function v6ExportName({ wallets = [], qualifier = '', suffix = '', ext = 'json', date = new Date() } = {}) {
  const roles = new Set(wallets.map((w) => w?.role));
  const kind = roles.size === 1 ? ROLE_WORD[[...roles][0]] || '' : '';
  const noun = wallets.length === 1 ? 'wallet' : 'wallets';
  const what = [qualifier || (kind ? '' : 'all'), kind, noun].filter(Boolean).join('-');
  return `${wallets.length}pcs-V6-${what}${suffix ? `-${suffix}` : ''}-${date.toISOString().slice(0, 10)}.${ext}`;
}
