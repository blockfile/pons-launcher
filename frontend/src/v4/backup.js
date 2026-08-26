import { getApiKey } from '../api.js';

/**
 * Download the private keys of V4's wallets only.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V4 operator backing up a campaign should not be handed v1's dev key in the
 * same file — and the campaign gate only needs V4's wallets on record.
 */
export async function downloadV4Backup({ minAgeDays, walletIds, includeFunders = true, fundersOnly = false } = {}) {
  // fundersOnly is the funding-wallet-only export — no seeds. An explicit seed set (a
  // per-section export — "the usable wallets in THIS pool") otherwise takes precedence
  // over the age filter. A withdrawn seed is simply never in the set, so a per-section
  // export cannot re-export one held out of the pool. includeFunders decides whether the
  // funding wallets ride along: the full backup keeps them (default true), a filtered
  // export can leave them out.
  const ids = Array.isArray(walletIds) && walletIds.length ? walletIds : null;
  const body = { confirm: true };
  if (fundersOnly) body.fundersOnly = true;
  else if (ids) body.walletIds = ids;
  else if (minAgeDays) body.minAgeDays = minAgeDays;
  if (!fundersOnly && includeFunders === false) body.includeFunders = false;

  const res = await fetch('/api/v4/wallets/backup', {
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
  // The filter goes in the FILENAME, not only inside the file. Two downloads a
  // week apart otherwise differ by one character of date and carry completely
  // different sets — and the one that matters is the one holding fewer keys.
  // The filename records BOTH the filter and whether the funders rode along, so two
  // downloads a week apart are never mistaken for one another.
  const noFunders = includeFunders === false ? '-nofunders' : '';
  const tag = fundersOnly
    ? '-funders'
    : ids
      ? `-selected${noFunders}`
      : minAgeDays
        ? `-seasoned-${minAgeDays}d${noFunders}`
        : '';
  a.download = `pons-v4-wallets${tag}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  if (fundersOnly) {
    return `Backed up ${json.wallets.length} funding wallet key(s) — no seeds. Keep this file offline.`;
  }
  const funderNote = includeFunders === false ? 'no funding wallets' : 'plus every funding wallet';
  if (ids) {
    return `Backed up ${json.wallets.length} key(s) — the wallets you selected, ${funderNote}. Keep this file offline.`;
  }
  return minAgeDays
    ? `Backed up ${json.wallets.length} key(s) — seed wallets funded ${minAgeDays}+ days ago, ${funderNote}. Keep this file offline.`
    : `Backed up ${json.wallets.length} V4 wallet key(s). Keep this file offline.`;
}
