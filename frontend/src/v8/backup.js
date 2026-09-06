import { getApiKey } from '../api.js';

/**
 * Download the private keys of V8's wallets only.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V8 operator backing up the source wallet and its destinations should get
 * exactly those, and not another tab's keys in the same file.
 *
 * Optionally NARROWED, so a single panel can back up only its own wallets
 * (role) or the operator can export a hand-picked selection (walletIds). With
 * neither, this is the full V8 backup. The filter also goes in the FILENAME,
 * not only inside the file, so two downloads a day apart are never mistaken for
 * one another — the one that matters is usually the one holding fewer keys.
 *
 * THIS IS THE ONLY COPY. The keys are random and have no mnemonic behind them:
 * they exist in one encrypted file on one machine, and this tab is about to
 * send real ETH to every one of them. Lose the file before the keys are
 * exported and the ETH is gone with it.
 *
 * TWO FORMATS, one endpoint. `json` is the full record — address, label, role,
 * createdAt and the key — which is what a backup is for: months later you need to
 * know WHICH wallet a key belongs to. `keys` is the bare private keys, one per
 * line, for pasting straight into another tool's import box. It is strictly less
 * information, never more, so it is an export shape and not a second permission.
 */
export async function downloadV8Backup({ role = null, roleLabel = '', walletIds = null, format = 'json' } = {}) {
  // An empty selection is treated as no selection, so a mis-wired caller can
  // never ask for a file with nothing in it.
  const ids = Array.isArray(walletIds) && walletIds.length ? walletIds : null;
  const body = { confirm: true };
  if (ids) body.walletIds = ids;
  else if (role) body.role = role;

  const res = await fetch('/api/v8/wallets/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': getApiKey() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(json.error || 'backup failed');

  const wallets = Array.isArray(json.wallets) ? json.wallets : [];
  // Bare keys, newline-separated, with a trailing newline so the last line is a
  // complete line — some importers drop an unterminated one.
  const keysOnly = format === 'keys';
  const body2 = keysOnly
    ? wallets.map((w) => w.privateKey).filter(Boolean).join('\n') + '\n'
    : JSON.stringify(json, null, 2);
  const blob = new Blob([body2], { type: keysOnly ? 'text/plain' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const tag = ids ? '-selected' : roleLabel ? `-${roleLabel}` : '';
  a.download = `pons-v8-wallets${tag}${keysOnly ? '-keys' : ''}-${new Date().toISOString().slice(0, 10)}.${keysOnly ? 'txt' : 'json'}`;
  a.click();
  URL.revokeObjectURL(url);

  const shape = keysOnly ? 'private key(s), one per line' : 'wallet key(s)';
  if (ids) return `Backed up ${wallets.length} selected V8 ${shape}. Keep this file offline.`;
  if (roleLabel) return `Backed up ${wallets.length} V8 ${roleLabel} ${shape}. Keep this file offline.`;
  return `Backed up ${wallets.length} V8 ${shape}. Keep this file offline.`;
}
