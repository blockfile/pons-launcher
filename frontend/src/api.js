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
