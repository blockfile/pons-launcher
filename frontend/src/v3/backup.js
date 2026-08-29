import { getApiKey } from '../api.js';

// A v3 role → the word the panel uses for it, for the filename and the report.
const ROLE_WORD = { v3dev: 'treasury', v3main: 'main', v3bundle: 'bundle' };

/**
 * Download the private keys of V3's wallets only.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V3 operator backing up their treasury, main and bundle wallets should get
 * exactly those, and not another tab's keys in the same file.
 *
 * With no argument it is the full backup it has always been: every V3 wallet.
 * Optional narrowings, mirroring the backend:
 *   { walletIds } — exactly those wallets (the bundle table's "export selected").
 *   { role }      — one panel's wallets only (a per-panel export).
 * walletIds takes precedence, and an empty list is treated as no selection so a
 * mis-wired caller cannot ask for an empty file.
 */
export async function downloadV3Backup({ walletIds, role } = {}) {
  const ids = Array.isArray(walletIds) && walletIds.length ? walletIds : null;
  const body = { confirm: true };
  if (ids) body.walletIds = ids;
  else if (role) body.role = role;

  const res = await fetch('/api/v3/wallets/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': getApiKey() },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'backup failed');

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  // The filter rides in the FILENAME, not only inside the file: two downloads a
  // day apart otherwise differ by nothing but the date while holding completely
  // different sets of keys — and the one that matters holds fewer.
  const tag = ids ? '-selected' : role ? `-${ROLE_WORD[role] || role}` : '';
  a.href = url;
  a.download = `pons-v3-wallets${tag}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  if (ids) {
    return `Backed up ${json.wallets.length} selected V3 wallet key(s). Keep this file offline.`;
  }
  if (role) {
    return `Backed up ${json.wallets.length} V3 ${ROLE_WORD[role] || role} wallet key(s). Keep this file offline.`;
  }
  return `Backed up ${json.wallets.length} V3 wallet key(s). Keep this file offline.`;
}
