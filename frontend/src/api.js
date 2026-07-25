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
