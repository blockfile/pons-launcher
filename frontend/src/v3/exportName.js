/**
 * The filename of a V3 key export: {count}pcs-V3-{what}[-{suffix}]-{date}.{ext},
 * e.g. 30pcs-V3-bundle-wallets-2026-09-11.json.
 *
 * `what` comes from what the file HOLDS, not from what was asked for: when every
 * wallet in it has the same role it is that role's word; a mixed file is plain
 * "wallets", or "all-wallets" when nothing narrowed it. A narrowed export keeps its
 * qualifier in front ("selected"). A name built from the request alone has already
 * lied once — a "nofunders" export that held a funding wallet.
 *
 * V3's own copy, per the tab-isolation rule: every tab has one. Pure — no fetch, no
 * DOM, no api.js — so `node --test` can import it.
 */
const ROLE_WORD = { v3dev: 'treasury', v3main: 'main', v3bundle: 'bundle' };

export function v3ExportName({ wallets = [], qualifier = '', suffix = '', ext = 'json', date = new Date() } = {}) {
  const roles = new Set(wallets.map((w) => w?.role));
  const kind = roles.size === 1 ? ROLE_WORD[[...roles][0]] || '' : '';
  const noun = wallets.length === 1 ? 'wallet' : 'wallets';
  const what = [qualifier || (kind ? '' : 'all'), kind, noun].filter(Boolean).join('-');
  return `${wallets.length}pcs-V3-${what}${suffix ? `-${suffix}` : ''}-${date.toISOString().slice(0, 10)}.${ext}`;
}
