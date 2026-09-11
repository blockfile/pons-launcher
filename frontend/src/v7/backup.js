import { getApiKey } from '../api.js';
import { v7ExportName } from './exportName.js';

/**
 * Download the private keys of V7's wallets only.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V7 operator backing up their treasury, main and bundle wallets should get
 * exactly those, and not another tab's keys in the same file.
 *
 * Optionally NARROWED, so a single panel can back up only its own wallets
 * (role) or the operator can export a hand-picked selection (walletIds). With
 * neither, this is the full V7 backup and is byte-identical to what it always
 * was. The FILENAME says what the file holds, read from the wallets that came
 * back rather than from the request (see exportName.js) — the count, the role
 * when every wallet in it shares one, "selected" in front of a hand-picked
 * export — so two downloads a day apart are never mistaken for one another; the
 * one that matters is usually the one holding fewer keys.
 */
export async function downloadV7Backup({ role = null, roleLabel = '', walletIds = null } = {}) {
  const ids = Array.isArray(walletIds) && walletIds.length ? walletIds : null;
  const body = { confirm: true };
  if (role) body.role = role;
  if (ids) body.walletIds = ids;

  const res = await fetch('/api/v7/wallets/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': getApiKey() },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'backup failed');

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = v7ExportName({ wallets: json.wallets, qualifier: ids ? 'selected' : '' });
  a.click();
  URL.revokeObjectURL(url);
  if (ids) return `Backed up ${json.wallets.length} selected V7 wallet key(s). Keep this file offline.`;
  if (roleLabel) return `Backed up ${json.wallets.length} V7 ${roleLabel} wallet key(s). Keep this file offline.`;
  return `Backed up ${json.wallets.length} V7 wallet key(s). Keep this file offline.`;
}
