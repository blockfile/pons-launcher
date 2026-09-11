/**
 * The filename of a V8 key export: {count}pcs-V8-{what}[-{suffix}]-{date}.{ext},
 * e.g. 5pcs-V8-destination-wallets-2026-09-11.json, or for the bare-keys text file
 * 5pcs-V8-destination-wallets-keys-2026-09-11.txt.
 *
 * `what` comes from what the file HOLDS, not from what was asked for: when every
 * wallet in it has the same role it is that role's word; a mixed file is plain
 * "wallets", or "all-wallets" when nothing narrowed it. A narrowed export keeps its
 * qualifier in front ("selected"). A name built from the request alone has already
 * lied once — a "nofunders" export that held a funding wallet.
 *
 * THE PANEL'S WORD, NOT THE ROLE'S. The V8 tab calls these wallets "source" and
 * "destination" on screen, and its filenames always did too — so the file says
 * that, not the ROLES names (v8main / v8bundle). A backup is matched to the panel it
 * came from by the words on both.
 *
 * V8's own copy, per the tab-isolation rule: every tab has one. The role strings
 * are spelled out rather than imported so this stays a leaf module node --test can
 * load; exportName.test.js checks them against roles.js.
 */
const ROLE_WORD = { v8main: 'source', v8bundle: 'destination' };

export function v8ExportName({ wallets = [], qualifier = '', suffix = '', ext = 'json', date = new Date() } = {}) {
  const roles = new Set(wallets.map((w) => w?.role));
  const kind = roles.size === 1 ? ROLE_WORD[[...roles][0]] || '' : '';
  const noun = wallets.length === 1 ? 'wallet' : 'wallets';
  const what = [qualifier || (kind ? '' : 'all'), kind, noun].filter(Boolean).join('-');
  return `${wallets.length}pcs-V8-${what}${suffix ? `-${suffix}` : ''}-${date.toISOString().slice(0, 10)}.${ext}`;
}
