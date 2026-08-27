import { getApiKey } from '../api.js';

/**
 * Download the private keys of V7's wallets only.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V7 operator backing up their treasury, main and bundle wallets should get
 * exactly those, and not another tab's keys in the same file.
 */
export async function downloadV7Backup() {
  const res = await fetch('/api/v7/wallets/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': getApiKey() },
    body: JSON.stringify({ confirm: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'backup failed');

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pons-v7-wallets-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return `Backed up ${json.wallets.length} V7 wallet key(s). Keep this file offline.`;
}
