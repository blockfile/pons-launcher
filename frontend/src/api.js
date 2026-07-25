// The API key lives in module scope for the life of the tab and is never
// persisted — localStorage would expose it to anything else on the origin.
let apiKey = '';

export function setApiKey(key) {
  apiKey = key || '';
}

export async function api(path, method = 'GET', body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
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
