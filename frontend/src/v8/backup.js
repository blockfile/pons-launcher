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
 */
export async function downloadV8Backup({ role = null, roleLabel = '', walletIds = null } = {}) {
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
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const tag = ids ? '-selected' : roleLabel ? `-${roleLabel}` : '';
  a.download = `pons-v8-wallets${tag}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  if (ids) return `Backed up ${wallets.length} selected V8 wallet key(s). Keep this file offline.`;
  if (roleLabel) return `Backed up ${wallets.length} V8 ${roleLabel} wallet key(s). Keep this file offline.`;
  return `Backed up ${wallets.length} V8 wallet key(s). Keep this file offline.`;
}
