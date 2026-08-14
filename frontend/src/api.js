// The API key lives in module scope for the life of the tab, mirrored into
// sessionStorage so that a refresh does not cost the operator a re-paste.
//
// sessionStorage, NOT localStorage. localStorage is shared by every tab on the
// origin and survives until something explicitly clears it, so a key written
// there outlives the session that needed it and is readable by anything that
// ever runs on this origin — for a credential that can spend every wallet the
// console holds, that is too long a life and too wide an audience.
// sessionStorage is scoped to this one tab: a refresh keeps the key, closing
// the tab discards it, and a second tab starts blank.
//
// Deployments that inject the key at nginx (see deploy/nginx-rhbond.conf) never
// call setApiKey at all, so in that arrangement nothing is stored anywhere.
const STORAGE_KEY = 'pons-launcher.apiKey';

// Storage can be disabled outright, and a console that refuses to load because
// of a browser setting is worse than one that asks for the key again.
function readStored() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

let apiKey = readStored();

/** The key this tab is using, if any. Read once at mount to seed the field. */
export function getApiKey() {
  return apiKey;
}

export function setApiKey(key) {
  apiKey = key || '';
  try {
    if (apiKey) sessionStorage.setItem(STORAGE_KEY, apiKey);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not fatal — the key still works for this page view.
  }
}

/**
 * Raise a visible notice. Every blocked action and every completed one can flag
 * itself here, and a single listener (see Toaster) shows it — so a refusal is
 * never a silent failure into a panel a page away. `kind` is 'error' | 'ok' |
 * 'info'.
 */
export function notify(message, kind = 'info') {
  if (typeof window !== 'undefined' && message) {
    window.dispatchEvent(new CustomEvent('pons:notice', { detail: { message: String(message), kind } }));
  }
}

export async function api(path, method = 'GET', body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) {
    const message = json.error || `${res.status}`;
    // A blocked mutation always announces itself. Background reads (price, gas,
    // configs) fail quietly — their callers already handle it — so only
    // non-GET refusals raise a toast.
    if (method !== 'GET') notify(message, 'error');
    throw new Error(message);
  }
  return json;
}

/**
 * Download every wallet's private key as a file.
 *
 * The keys go straight from the response into a Blob and never touch the DOM:
 * anything rendered on screen can be screenshotted, shoulder-surfed, or left
 * open in a tab. `format` is 'json' or 'csv' — csv because checking twenty
 * addresses is a spreadsheet job.
 */
export async function downloadBackup(format = 'json') {
  const data = await api('/wallets/backup', 'POST', { confirm: true });

  const body =
    format === 'csv'
      ? ['role,label,address,privateKey']
          .concat(data.wallets.map((w) => [w.role, w.label, w.address, w.privateKey].join(',')))
          .join('\n')
      : JSON.stringify(data, null, 2);

  const stamp = data.exportedAt.slice(0, 10);
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `pons-wallets-${stamp}.${format}`;
  a.click();
  URL.revokeObjectURL(url);

  return `${data.count} keys written to pons-wallets-${stamp}.${format} — store it offline`;
}

/**
 * The raw file is the request body — the backend re-wraps it as multipart for
 * the pons worker. Same API key gate as every other mutating route.
 */
export async function uploadLogo(file) {
  const res = await fetch('/api/logo', {
    method: 'POST',
    headers: { 'content-type': file.type, 'x-api-key': apiKey },
    body: file,
  });
  const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}
