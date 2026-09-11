import { getApiKey } from '../api.js';
import { v5ExportName } from './exportName.js';

/**
 * Download the private keys of V5's wallets only — the launcher (v5dev) and its
 * bundle wallets.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V5 operator backing up their launcher and bundle wallets should get exactly
 * those, and not another tab's keys in the same file. Mirrors v3/backup.js.
 *
 * `walletIds` is the "export selected" path: an array of walletIds narrows the
 * file to exactly those wallets (the backend still filters to v5 roles first, so
 * a stray id can never pull in another tab's key). Omitted, or empty, exports
 * every v5 wallet.
 *
 * The FILENAME is read from what came back, not from what was asked for — the
 * count, and the role when every wallet in it shares one, with "selected" in
 * front of a hand-picked export (see exportName.js): 31pcs-V5-all-wallets-….json,
 * 3pcs-V5-selected-bundle-wallets-….json.
 */
export async function downloadV5Backup(walletIds) {
  const subset = Array.isArray(walletIds) && walletIds.length > 0;
  const res = await fetch('/api/v5/wallets/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': getApiKey() },
    body: JSON.stringify(subset ? { confirm: true, walletIds } : { confirm: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'backup failed');

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = v5ExportName({ wallets: json.wallets, qualifier: subset ? 'selected' : '' });
  a.click();
  URL.revokeObjectURL(url);
  return `Backed up ${json.wallets.length} V5 wallet key(s)${
    subset ? ' (selected)' : ''
  }. Keep this file offline.`;
}
