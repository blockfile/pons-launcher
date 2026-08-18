import { getApiKey } from '../api.js';

/**
 * Download the private keys of V4's wallets only.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V4 operator backing up a campaign should not be handed v1's dev key in the
 * same file — and the campaign gate only needs V4's wallets on record.
 */
export async function downloadV4Backup() {
  const res = await fetch('/api/v4/wallets/backup', {
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
  a.download = `pons-v4-wallets-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return `Backed up ${json.wallets.length} V4 wallet key(s). Keep this file offline.`;
}
