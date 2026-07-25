# Logo upload — design

**Date:** 2026-07-25
**Status:** approved, ready for planning

## Problem

The Logo field in the launch console is a URL text input. The operator has to
host an image somewhere themselves and paste the link. ponsfamily.com's own
`/launchpad/create` takes a **file**, pins it to public IPFS, and puts the
resulting `ipfs://<cid>` in the token's on-chain `logo` string.

Since these tokens are deployed through ponsfamily's factory and displayed on
ponsfamily's site, the launcher should mirror that flow exactly.

## What ponsfamily does

Read from their production bundle (`0fecmjhf6tnd3.js`) on 2026-07-25:

```
POST https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image
Content-Type: multipart/form-data
  image=<file>
→ 200 { "uri": "ipfs://<cid>" }
→ non-2xx { "error": "<message>" }
```

Their site falls back to a same-origin `/api/ipfs/image` when the gateway URL is
unset. The endpoint is **unauthenticated** — no wallet, no signature, no nonce.
The "I understand that selected artwork will be moderated and uploaded to public
IPFS" checkbox is a purely client-side gate on the file picker.

Client-side validation before the request:

| Rule | Value |
|---|---|
| Accepted MIME | `image/png`, `image/jpeg`, `image/webp` |
| Size | `> 0` and `<= 5242880` (5 MB) |

Their error copy also mentions GIF, but `image/gif` is absent from the accepted
set. We mirror the **set**, not the copy.

The returned `uri` is used verbatim as `logo` in their `launchToken` call — the
same field this launcher already sends. Pinning through their worker therefore
produces tokens byte-identical to native launches and guarantees their own site
can resolve the image (they render it via `https://gateway.pinata.cloud/ipfs/<cid>`).

## Decisions

1. **Pin through ponsfamily's worker**, not our own pinning-service account.
   Chosen because the token lives on their launchpad and should mirror it; also
   needs no API key. Cost: a dependency on an undocumented third-party endpoint,
   mitigated by making the URL configurable.
2. **Upload-only** — no paste-a-URL fallback. Mirrors their form. A logo is
   required for a launch there, so the same is true here.
3. **Proxy through our backend** rather than posting to the worker from the
   browser. The worker's CORS policy is presumably scoped to `ponsfamily.com`
   and would reject our origin; the proxy also keeps the existing `API_KEY`
   middleware and the single-origin nginx story intact.

## Design

### Backend — `POST /api/logo`

New route in `backend/src/routes/launch.js`, guarded by `requireApiKey`.

- Body parsing: `express.raw({ type: ACCEPTED_TYPES, limit: '5mb' })` mounted on
  this route only. The global `express.json({ limit: '1mb' })` is untouched.
- Rejects with 400: unsupported `content-type`, empty body, body `> 5 MB`.
  Same thresholds as their client, so we fail fast instead of paying a round trip.
- Wraps the bytes in a `FormData` with a `Blob` under field name `image` and
  `POST`s to the configured upload URL with Node 20's built-in `fetch`.
  **No new dependency** — no multer, no form-data package.
- Validates the response shape: `uri` must match `^ipfs://[A-Za-z0-9]+`.
  A worker that returns 200 with junk must not become an on-chain logo string.
- Responds `{ uri, gatewayUrl }`, where `gatewayUrl` is
  `https://gateway.pinata.cloud/ipfs/<cid>` for the preview.
- Upstream failures surface as the worker's own `error` message, prefixed so the
  operator can tell whose fault it is.

New unit in `backend/src/ipfs/upload.js` so the route stays thin and the logic
is testable without HTTP. Two exports:

- `assertUploadable(mime, size)` — the pure guard (type, non-empty, 5 MB),
  throwing the operator-facing message.
- `uploadImage(buffer, mime)` — the worker call and response validation.

The route is then a five-line wrapper around the two.

### Config

`backend/src/config.js`, mirrored in `backend/.env.example`:

| Var | Default |
|---|---|
| `PONS_IPFS_UPLOAD_URL` | `https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image` |
| `IPFS_GATEWAY_URL` | `https://gateway.pinata.cloud/ipfs/` |

Both are undocumented third-party URLs that can move without notice, which is
the whole reason they are configurable rather than inlined.

### Frontend — Logo field

`frontend/src/components/LaunchForm.jsx`, replacing the `Logo URL` input:

```
Logo
[x] I understand the artwork will be moderated and uploaded to public IPFS.
┌──────────────────────────────────────┐
│ ┌────┐                               │
│ │IMG │  ponscat.png · 41 KB    [x]   │
│ └────┘  ipfs://bafkrei…3q4           │
└──────────────────────────────────────┘
   PNG, JPEG or WebP · 5 MB max
```

- Before the checkbox is ticked, the picker is disabled and reads
  `Confirm public upload first` — their wording.
- On pick: mirror their guards (type, size) client-side, show an instant local
  preview via `URL.createObjectURL`, then `POST` the file to `/api/logo`.
- Object URLs are revoked on replace and on unmount — no leaked blobs.
- While in flight the field shows `Uploading image…` and **Preflight and
  LAUNCH are disabled**. A pre-signed bundle must never be built against a
  half-set logo.
- On success `f.logo` holds the `ipfs://<cid>` string; the thumbnail switches to
  the gateway URL. On failure `f.logo` is cleared and the error is shown inline.
- Clearing the file clears `f.logo`.

`frontend/src/api.js` gains `upload(file)` alongside `api()` — same `x-api-key`
header, but the raw file as the body and the file's own MIME as content-type.
It cannot reuse `api()`, which is JSON-only.

### Deployment

`deploy/nginx.conf` needs `client_max_body_size 6m;` in the server block.
nginx defaults to 1 MB, so today a 5 MB logo would 413 before reaching the app.

### Unchanged

`f.logo` remains a plain string in `params.logo`. `toTokenParams`,
`predictTokenAddress`, the CREATE2 salt and every pre-signed bundle buy are
untouched — the upload merely has to finish before Preflight or Launch, which
the disabled button state enforces.

## Testing

`backend/src/ipfs/upload.test.js`, `node --test`, matching the existing style —
plain units with a hand-rolled fake, no HTTP layer and no new dev dependency:

- `assertUploadable` — accepts each of the three MIME types; rejects
  `image/gif`, `text/html`, a zero-byte body and 5 MB + 1.
- `uploadImage` with `globalThis.fetch` stubbed — happy path returns the `uri`;
  a 200 carrying a missing or malformed `uri` throws; a non-2xx surfaces the
  worker's own `error` text; the outgoing body is a `FormData` whose `image`
  field holds the bytes.

Not covered by automated tests: a real round trip to the pons worker. Verified
manually once against a small PNG, since hitting a third party in CI is neither
reliable nor polite.

## Risks

- **The worker is a third-party undocumented endpoint.** It can change shape or
  disappear. Mitigation: configurable URL, response-shape validation, and an
  error message that names the upstream. If it goes down, launches are blocked —
  accepted, because the same is true on ponsfamily's own site.
- **Moderation.** Their copy says artwork is moderated. If a pin is later
  rejected, the on-chain `logo` string still points at a dead CID. Out of our
  control and identical to launching from their UI.
