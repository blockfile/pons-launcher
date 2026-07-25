# Logo Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Logo URL text input with a file upload that pins the image to public IPFS through ponsfamily.com's own uploader, mirroring their `/launchpad/create` form.

**Architecture:** The browser POSTs the raw file bytes to a new `POST /api/logo` on our Express backend, which re-posts them as multipart to the pons IPFS worker and returns the `ipfs://<cid>` URI. That URI becomes `f.logo` — a plain string, exactly as today — so nothing downstream of the form changes. The backend proxies rather than letting the browser call the worker directly, because the worker's CORS policy is presumably scoped to `ponsfamily.com` and because the proxy keeps the existing `x-api-key` gate and single-origin nginx setup intact.

**Tech Stack:** Node 20 (built-in `fetch`, `FormData`, `Blob` — no new dependencies), Express 4, React 19, Vite, `node:test`.

## Global Constraints

- **Accepted MIME types: `image/png`, `image/jpeg`, `image/webp` only.** No GIF. ponsfamily's error copy mentions GIF but their accepted set excludes it; mirror the set, not the copy.
- **Max size: 5242880 bytes (5 MB), and the body must be non-empty.** Same thresholds as their client.
- **Upload endpoint:** `https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image`, multipart field name `image`, response `{ uri: "ipfs://<cid>" }` or `{ error }`. Unauthenticated.
- **No new npm dependencies.** No multer, no form-data, no supertest.
- **No paste-a-URL fallback.** Upload is the only way to set a logo, as on their form.
- **Backend is CommonJS (`'use strict'`, `require`); frontend is ESM.** Follow the file you are editing.
- Tests are plain `node:test` units with hand-rolled fakes — no HTTP-layer tests. Run with `npm test --workspace backend`.
- Commit with `git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit …` — this repo has no configured git identity and a bare `git commit` fails.

---

### Task 1: IPFS upload module

The pure logic — validation and the worker call — with no Express involved, so it is testable without HTTP.

**Files:**
- Create: `backend/src/ipfs/upload.js`
- Create: `backend/src/ipfs/upload.test.js`
- Modify: `backend/src/config.js:44-49` (add two config keys before the closing `}` of the `config` object)
- Modify: `backend/.env.example` (add a "Logo / IPFS" section after the "Pons launchpad" section)

**Interfaces:**
- Consumes: `config.ipfsUploadUrl`, `config.ipfsGatewayUrl` (added in this task).
- Produces:
  - `assertUploadable(mime: string, size: number) → string` — returns the normalised lowercase MIME, throws `Error` with operator-facing copy otherwise.
  - `uploadImage(buffer: Buffer, mime: string) → Promise<{ uri: string, gatewayUrl: string }>`.

- [ ] **Step 1: Add the config keys**

In `backend/src/config.js`, inside the `config` object, after the `apiKey` line:

```js
  // ponsfamily's own IPFS uploader — the same endpoint their /launchpad/create
  // form posts to, so our tokens carry the same kind of ipfs:// logo as a
  // launch made from their site. Undocumented, hence configurable.
  ipfsUploadUrl:
    process.env.PONS_IPFS_UPLOAD_URL ||
    'https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image',
  // Read-side gateway, used only to preview the pinned image in the console.
  ipfsGatewayUrl: (process.env.IPFS_GATEWAY_URL || 'https://gateway.pinata.cloud/ipfs/').replace(
    /\/?$/,
    '/'
  ),
```

- [ ] **Step 2: Document them in `backend/.env.example`**

Add after the `SWAP_ROUTER=` block:

```
# ── Logo / IPFS ──────────────────────────────────────────────────────────────
# The token logo is pinned through ponsfamily's own uploader, so the ipfs://
# URI that goes on chain is the same kind their site produces. Both URLs are
# undocumented third-party endpoints — override here if they move.
PONS_IPFS_UPLOAD_URL=https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image
IPFS_GATEWAY_URL=https://gateway.pinata.cloud/ipfs/
```

- [ ] **Step 3: Write the failing test**

Create `backend/src/ipfs/upload.test.js`. Note the env vars are set *before* `require` — `config.js` reads `process.env` at load time, the same pattern as `backend/src/wallets/keystore.test.js`.

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.PONS_IPFS_UPLOAD_URL = 'https://worker.test/public/ipfs/image';
process.env.IPFS_GATEWAY_URL = 'https://gateway.test/ipfs/';

const { assertUploadable, uploadImage } = require('./upload');

/** Swap global fetch for one call, capturing what the module sent. */
async function withFetch(respond, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const responds = (body, status = 200) => () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('assertUploadable accepts exactly the three types pons accepts', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(assertUploadable(t, 10), t);
  }
  assert.equal(assertUploadable('IMAGE/PNG; charset=binary', 10), 'image/png');
});

test('assertUploadable rejects gif, non-images, empty and oversize', () => {
  assert.throws(() => assertUploadable('image/gif', 10), /PNG, JPEG or WebP/);
  assert.throws(() => assertUploadable('text/html', 10), /PNG, JPEG or WebP/);
  assert.throws(() => assertUploadable('image/png', 0), /empty/);
  assert.throws(() => assertUploadable('image/png', 5 * 1024 * 1024 + 1), /smaller than 5 MB/);
});

test('uploadImage posts the bytes as multipart "image" and returns uri + gateway url', async () => {
  await withFetch(responds({ uri: 'ipfs://bafkreiabc123' }), async (calls) => {
    const out = await uploadImage(png, 'image/png');
    assert.deepEqual(out, {
      uri: 'ipfs://bafkreiabc123',
      gatewayUrl: 'https://gateway.test/ipfs/bafkreiabc123',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://worker.test/public/ipfs/image');
    assert.equal(calls[0].init.method, 'POST');
    const sent = calls[0].init.body.get('image');
    assert.equal(sent.type, 'image/png');
    assert.equal(sent.size, png.length);
  });
});

test('uploadImage surfaces the worker own error text', async () => {
  await withFetch(responds({ error: 'moderation rejected' }, 422), async () => {
    await assert.rejects(() => uploadImage(png, 'image/png'), /moderation rejected/);
  });
});

test('uploadImage refuses a 200 that carries no usable ipfs uri', async () => {
  await withFetch(responds({ uri: 'https://evil.example/x.png' }), async () => {
    await assert.rejects(() => uploadImage(png, 'image/png'), /ipfs/);
  });
});

test('uploadImage reports an unreachable worker as such', async () => {
  await withFetch(
    () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
    async () => {
      await assert.rejects(() => uploadImage(png, 'image/png'), /unreachable/);
    }
  );
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test --workspace backend`
Expected: FAIL — `Cannot find module './upload'`.

- [ ] **Step 5: Write the implementation**

Create `backend/src/ipfs/upload.js`:

```js
'use strict';

// Token logos are pinned through ponsfamily's own IPFS uploader rather than a
// pinning account of our own. The tokens are deployed on their launchpad and
// rendered on their site, so the ipfs:// URI that goes on chain should be the
// same kind their /launchpad/create form produces.

const config = require('../config');

// Mirrors their client exactly. Their error copy mentions GIF; their accepted
// set does not include it, and the set is what the worker enforces.
const ACCEPTED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);
const MAX_BYTES = 5 * 1024 * 1024;
const IPFS_URI = /^ipfs:\/\/[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * The guards their form applies before spending a round trip. Returns the
 * normalised MIME type; throws with copy meant for the operator.
 */
function assertUploadable(mime, size) {
  const type = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!ACCEPTED.has(type)) throw new Error('Use a PNG, JPEG or WebP image.');
  if (!size) throw new Error('The image is empty.');
  if (size > MAX_BYTES) throw new Error('Images must be smaller than 5 MB.');
  return type;
}

/** ipfs://<cid> → a browser-loadable URL, for the console preview only. */
function gatewayUrl(uri) {
  return config.ipfsGatewayUrl + String(uri).replace(/^ipfs:\/\//, '');
}

/**
 * Pin one image and return its ipfs:// URI. That string is what goes on chain
 * as TokenParams.logo, so a malformed response must never be passed through —
 * a bad logo is baked into the CREATE2 preimage and cannot be edited later.
 */
async function uploadImage(buffer, mime) {
  const type = assertUploadable(mime, buffer ? buffer.length : 0);

  const form = new FormData();
  form.append('image', new Blob([buffer], { type }), `logo.${ACCEPTED.get(type)}`);

  let res;
  try {
    res = await fetch(config.ipfsUploadUrl, { method: 'POST', body: form });
  } catch (err) {
    throw new Error(`pons IPFS uploader unreachable: ${err.message}`);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`pons IPFS upload failed: ${(json && json.error) || res.status}`);
  }
  const uri = json && typeof json.uri === 'string' ? json.uri : '';
  if (!IPFS_URI.test(uri)) {
    throw new Error('pons IPFS upload returned no usable ipfs:// uri');
  }

  return { uri, gatewayUrl: gatewayUrl(uri) };
}

module.exports = { assertUploadable, uploadImage, gatewayUrl, ACCEPTED, MAX_BYTES };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace backend`
Expected: PASS — all six new tests, plus the existing bundle/wallet suites still green.

- [ ] **Step 7: Commit**

```bash
git add backend/src/ipfs/upload.js backend/src/ipfs/upload.test.js backend/src/config.js backend/.env.example
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: pin token logos through the pons IPFS uploader"
```

---

### Task 2: `POST /api/logo` route

**Files:**
- Modify: `backend/src/routes/launch.js` (imports at :1-11, new route after the `/configs` route at :34)

**Interfaces:**
- Consumes: `uploadImage(buffer, mime)` from Task 1; `requireApiKey` from `backend/src/middleware/auth.js`.
- Produces: `POST /api/logo` — raw image body, `content-type` is the file's MIME, `x-api-key` header. Responds `200 { uri, gatewayUrl }` or `400 { error }` (the global error handler in `backend/server.js:44-48` already turns a thrown `Error` into that shape).

- [ ] **Step 1: Add the import**

In `backend/src/routes/launch.js`, after the `history` require:

```js
const { uploadImage } = require('../ipfs/upload');
```

- [ ] **Step 2: Add the route**

Insert after the `/configs` route, before `/preflight`:

```js
// POST /api/logo — pin an image and hand back its ipfs:// URI, which the form
// then submits as params.logo. Proxied rather than uploaded straight from the
// browser: the pons worker's CORS is scoped to their own origin, and going
// through here keeps the API key gate in front of it.
//
// express.raw is mounted per-route so the global 1 MB JSON limit is untouched.
router.post(
  '/logo',
  requireApiKey,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }),
  async (req, res, next) => {
    try {
      // A content-type express.raw did not match leaves req.body as {} — the
      // MIME check inside uploadImage rejects it with the right message.
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(await uploadImage(buf, req.get('content-type')));
    } catch (err) {
      next(err);
    }
  }
);
```

- [ ] **Step 3: Verify nothing regressed**

Run: `npm test --workspace backend`
Expected: PASS — unchanged from Task 1. (The route itself has no unit test by design; its logic lives in the tested module.)

- [ ] **Step 4: Manually verify against the real worker**

Start the API (`npm run dev:api`, `DRY_RUN=true`, blank `API_KEY`) and post a real PNG under 5 MB:

```bash
curl -s -X POST http://127.0.0.1:3100/api/logo \
  -H 'content-type: image/png' --data-binary @some-logo.png
```

Expected: `{"uri":"ipfs://bafkrei…","gatewayUrl":"https://gateway.pinata.cloud/ipfs/bafkrei…"}`, and opening the `gatewayUrl` shows the image. Then confirm the guard rails:

```bash
curl -s -X POST http://127.0.0.1:3100/api/logo -H 'content-type: image/gif' --data-binary @x.gif
# → {"error":"Use a PNG, JPEG or WebP image."}
```

This is the one step no automated test covers — hitting a third party in CI is neither reliable nor polite.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/launch.js
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: add POST /api/logo image upload route"
```

---

### Task 3: Logo field in the console

**Files:**
- Create: `frontend/src/components/LogoField.jsx`
- Modify: `frontend/src/api.js` (append `uploadLogo`)
- Modify: `frontend/src/components/LaunchForm.jsx:1-3` (imports), `:98-101` (replace the Logo URL label), `:165-172` (button disabled state)
- Modify: `frontend/src/styles.css` (append a `.logo*` block after the `.hint`/`.note` rules at :221-231)

**Interfaces:**
- Consumes: `POST /api/logo` from Task 2.
- Produces:
  - `uploadLogo(file: File) → Promise<{ uri, gatewayUrl }>` exported from `frontend/src/api.js`.
  - `<LogoField value onChange onUploading />` — `value` is the current `ipfs://` string (`''` when unset), `onChange(uri)` sets it, `onUploading(bool)` lets the parent disable Preflight/Launch.

- [ ] **Step 1: Add the upload client**

Append to `frontend/src/api.js`. It cannot reuse `api()`, which is JSON-only:

```js
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
```

- [ ] **Step 2: Write the LogoField component**

Create `frontend/src/components/LogoField.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { uploadLogo } from '../api.js';

// Mirrors ponsfamily's own create form: the same accepted types, the same 5 MB
// ceiling and the same acknowledgement before the picker unlocks. Checked here
// too so an oversized file fails instantly instead of after a round trip.
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

export default function LogoField({ value, onChange, onUploading }) {
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const objectUrl = useRef('');

  // Object URLs leak until revoked, and this component outlives many picks.
  function showPreview(url) {
    if (objectUrl.current && objectUrl.current !== url) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = url.startsWith('blob:') ? url : '';
    setPreview(url);
  }
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    []
  );

  function clear() {
    showPreview('');
    setFileName('');
    setError('');
    onChange('');
  }

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    onChange('');
    if (!ACCEPT.includes(file.type)) return setError('Use a PNG, JPEG or WebP image.');
    if (!file.size || file.size > MAX_BYTES) return setError('Images must be smaller than 5 MB.');

    showPreview(URL.createObjectURL(file));
    setFileName(file.name);
    setBusy(true);
    onUploading(true);
    try {
      const { uri, gatewayUrl } = await uploadLogo(file);
      onChange(uri);
      showPreview(gatewayUrl);
    } catch (err) {
      showPreview('');
      setFileName('');
      setError(err.message);
    } finally {
      setBusy(false);
      onUploading(false);
    }
  }

  return (
    <label className="wide logo">
      Logo
      <span className="logoConfirm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I understand that selected artwork will be moderated and uploaded to public IPFS.
      </span>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(',')}
        onChange={pick}
        style={{ display: 'none' }}
      />
      <span className="logoBox">
        {preview ? <img className="logoThumb" src={preview} alt="" /> : <span className="logoThumb empty" />}
        <span className="logoMeta">
          <button
            type="button"
            className="ghost"
            disabled={!confirmed || busy}
            onClick={() => input.current.click()}
          >
            {busy ? 'Uploading image…' : confirmed ? (value ? 'Replace image' : 'Choose image') : 'Confirm public upload first'}
          </button>
          <span className="hint">
            {error ? <span className="logoError">{error}</span> : value || `${fileName || 'PNG, JPEG or WebP'} · 5 MB max`}
          </span>
        </span>
        {value && !busy && (
          <button type="button" className="ghost" onClick={clear}>
            ✕
          </button>
        )}
      </span>
    </label>
  );
}
```

- [ ] **Step 3: Wire it into LaunchForm**

In `frontend/src/components/LaunchForm.jsx`, add the import beside the others:

```jsx
import LogoField from './LogoField.jsx';
```

Add the state next to `busy` (line 23):

```jsx
  const [uploading, setUploading] = useState(false);
```

Replace the whole `Logo URL` label (lines 98-101) with:

```jsx
        <LogoField
          value={f.logo}
          onChange={(logo) => setF((prev) => ({ ...prev, logo }))}
          onUploading={setUploading}
        />
```

`LogoField` renders its own `wide` label, so it spans the grid. Because it is wide, move it below the `Symbol` label only if the layout looks wrong — leaving it in place is fine.

Then block both actions while a pin is in flight — a bundle must never be pre-signed against a half-set logo (lines 165-172):

```jsx
      <div className="row">
        <Busy
          busy={busy === 'preflight'}
          disabled={uploading}
          className="ghost"
          onClick={() => act('preflight', () => api('/preflight', 'POST', body()))}
        >
          Preflight (signs, sends nothing)
        </Busy>
        <Busy busy={busy === 'launch'} disabled={uploading} className="danger" onClick={launch}>
          LAUNCH + BUNDLE
        </Busy>
      </div>
```

- [ ] **Step 4: Add the styles**

Append to `frontend/src/styles.css`:

```css
.logo .logoConfirm {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.logo .logoConfirm input {
  width: auto;
  padding: 0;
}
.logoBox {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #0f151d;
}
.logoThumb {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  object-fit: cover;
  background: #1d2531;
  flex: none;
}
.logoMeta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.logoMeta .hint {
  font-family: var(--mono);
  overflow-wrap: anywhere;
}
.logoError {
  color: var(--danger);
}
```

- [ ] **Step 5: Verify in the browser**

Run `npm run dev` and open http://localhost:5173.

Expected, in order:
1. The picker is disabled and reads `Confirm public upload first`.
2. Ticking the checkbox enables it; it reads `Choose image`.
3. Picking a GIF shows `Use a PNG, JPEG or WebP image.` and no request is made.
4. Picking a valid PNG shows the local thumbnail immediately, the button reads `Uploading image…`, and **Preflight and LAUNCH are both disabled** for the duration.
5. On success the hint shows `ipfs://…` and the thumbnail is served from the gateway.
6. `✕` clears it; Preflight then sends `params.logo: ""`.

Confirm with a Preflight (DRY_RUN) that the plan's `params.logo` carries the `ipfs://` string.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/LogoField.jsx frontend/src/components/LaunchForm.jsx frontend/src/api.js frontend/src/styles.css
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: upload the token logo instead of pasting a URL"
```

---

### Task 4: Deployment and docs

Without this, a 5 MB logo dies at nginx with a 413 that never reaches the app.

**Files:**
- Modify: `deploy/nginx.conf` (server block, near `proxy_read_timeout`)
- Modify: `README.md` (env var table around :117, and the flow description around :140)

- [ ] **Step 1: Raise the nginx body limit**

In `deploy/nginx.conf`, inside the `listen 443` server block, above `location / {`:

```nginx
    # Logo uploads are proxied to pons' IPFS worker; their cap is 5 MB and
    # nginx's default body limit is 1 MB, which would 413 before the app sees it.
    client_max_body_size 6m;
```

- [ ] **Step 2: Document the env vars**

Add to the env table in `README.md`, after the `SWAP_ROUTER` row:

```markdown
| `PONS_IPFS_UPLOAD_URL` | pons IPFS worker | Where token logos are pinned. Undocumented third-party endpoint |
| `IPFS_GATEWAY_URL` | `https://gateway.pinata.cloud/ipfs/` | Read-side gateway, used only for the console preview |
```

And amend the numbered flow line `3. FORM  name, symbol, logo, …` to note that the logo is a file pinned to IPFS before the launch is prepared.

- [ ] **Step 3: Verify the config parses**

Run: `sudo nginx -t -c /etc/nginx/nginx.conf` on the server after copying, or locally just re-read the diff if nginx is not installed.
Expected: `syntax is ok`.

- [ ] **Step 4: Commit**

```bash
git add deploy/nginx.conf README.md
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "docs: nginx body limit and IPFS env vars for logo upload"
```

---

## Self-Review

**Spec coverage:** `POST /api/logo` → Task 2. `upload.js` with `assertUploadable` + `uploadImage` → Task 1. Config vars → Task 1. Frontend field, checkbox gate, preview, object-URL cleanup, disabled launch buttons → Task 3. `api.js` `uploadLogo` → Task 3. nginx `client_max_body_size` → Task 4. Tests → Task 1. Manual round trip → Task 2 Step 4. No gaps.

**Type consistency:** `uploadImage` returns `{ uri, gatewayUrl }` in Task 1, consumed under those exact names by the route (Task 2) and by `LogoField` (Task 3). `assertUploadable(mime, size)` is called only inside `uploadImage`. `onUploading` is named identically in `LogoField`'s props and the `LaunchForm` call site.

**Known deviation from the spec:** the spec named the accepted-type constant a `Set`; the implementation uses a `Map` of MIME → extension, because the multipart part needs a filename with the right extension. Behaviour is identical.
