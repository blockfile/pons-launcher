# Per-user wallets — design

**Date:** 2026-07-26
**Status:** approved, ready for planning

## Problem

The console is single-tenant. There is one keystore, one dev wallet, and one
launch history, shared by everyone who can get past nginx basic auth. Adding a
second htpasswd account today hands that person the first account's dev wallet,
bundle wallets, funds, and the ability to export every private key.

The goal: several people use the same deployment, each with their own wallets,
and none of them can see or spend another's.

## Decisions

1. **Identity is a per-user API key.** One key per user, presented as
   `x-api-key`. The key identifies the caller everywhere — console and API,
   both hostnames, one code path. Revoking a user is deleting their key.
   Rejected: trusting an nginx-supplied username header, because
   `api.rhbond.xyz` has no basic auth and would carry no identity at all.
2. **Everything is private.** Wallets, funding, sweeps and launch history.
   A user cannot observe another user exists.
3. **No admin.** Nobody can read another user's wallets or keys through the
   app. Server access is the escape hatch; the keystore files are on disk.

## Architecture

### Users

`backend/data/users.json`, mode 0600:

```json
{
  "version": 1,
  "users": [
    { "id": "u_9f2c…", "name": "ivan", "keyHash": "<sha256 hex>", "createdAt": "…" }
  ]
}
```

Only the SHA-256 of the key is stored. The key is generated with
`crypto.randomBytes(32)` and printed **once**, at creation. A lost key is
replaced, not recovered.

Users are created by CLI, never over HTTP:

```
npm run user:add -- <name>            # prints the key once
npm run user:add -- <name> --adopt    # also claims the legacy keystore
npm run user:list                     # names and creation dates, no keys
npm run user:remove -- <name>         # keeps their keystore file on disk
```

There is no admin role, so there is no one the app could authorise to create
users through the API. The CLI requires shell access, which is the correct bar.

### Resolving a request

`middleware/auth.js` gains `resolveUser`, replacing `requireApiKey`:

1. No `users.json`, or it is empty → `req.user = { id: 'default', name: 'default' }`.
   **This is what makes today's deployments keep working**: with no users file,
   behaviour is identical to the current single-tenant app, including a blank
   `API_KEY` meaning "open".
2. `users.json` exists → the request must carry an `x-api-key` that hashes to a
   known user. Otherwise `401`. `config.API_KEY` is ignored once users exist —
   two competing notions of a key would be a way to get one wrong.

`GET /api/health` gains `user` (the resolved name) so the console can show who
it is acting as, and `multiUser` so it knows whether the key field is required.

### Per-user state

| Today | Per user |
|---|---|
| `data/wallets.keystore.json` | `data/wallets.<userId>.keystore.json` |
| `data/launches.json` | `data/launches.<userId>.json` |

The `default` user maps to the legacy paths exactly, so nothing moves on disk
for an existing install. `--adopt` renames the legacy files to the new user's,
which is how the current wallets get carried into a named account.

Both files stay encrypted under the single server-wide `KEYSTORE_PASSPHRASE`.
Per-user passphrases were rejected: they would have to be held by the server to
sign a launch anyway, so they would add ceremony without adding protection.

### The refactor this forces

`keystore.js` and `store/history.js` are singletons with module-level caches.
They become factories:

```js
const ks = keystoreFor(userId);   // memoised per user
ks.list(); ks.devWallet(); ks.signer(id, provider); …
```

`funding.js` and `bundle/prepare.js` currently `require` the keystore directly.
They take it as a parameter instead:

```js
disperse(targets, { keystore })
sweep(opts, { keystore })
prepare(input, { keystore })
```

Routes resolve the instance once from `req.user` and pass it down. `fire.js`
needs no change — it never touches keys, only raw signed transactions.

This is the risky part of the work, because it runs through the launch path.
The safeguard is the fallback in step 1: with no `users.json`, every call
resolves to `default`, the same files are read, and the existing tests must
pass unchanged.

### Frontend

Small. The API key field already exists and now identifies you rather than just
authorising you.

- The instrument strip shows `signed in as <name>` when multi-user is on.
- The key field is hidden when `/api/health` reports the request already
  resolved to a user (nginx injected it) and shown when it did not.
- No other panel changes: every route already returns only the caller's data.

### nginx

So nobody types a key, each basic-auth user is mapped to theirs in the console
server block only:

```nginx
map $remote_user $user_key {
    default "";
    ivan    "<ivan's key>";
    alice   "<alice's key>";
}
…
proxy_set_header x-api-key $user_key;   # replaces anything the client sent
```

`api.rhbond.xyz` keeps no basic auth and no injection: callers there present
their own key, which is the point of having one.

## Testing

- `users.js` — create/list/remove, key hashing, a key that matches nothing, and
  that the raw key is never written to disk.
- `auth.js` — no users file resolves to `default`; with users, a good key
  resolves to that user, a bad key 401s, and a missing key 401s.
- `keystore.js` — two users' stores do not see each other's wallets; `default`
  reads the legacy path; the existing single-tenant tests pass untouched.
- `prepare.js` — a launch prepared for user A signs only A's wallets, and a
  wallet id belonging to B is rejected as unknown rather than used.
- Manual: two users in a browser, each seeing only their own wallets, and the
  `--adopt` migration on a copy of a real keystore.

## Risks

- **The refactor crosses the launch path.** Mitigated by the `default`
  fallback, by the existing suite having to pass unchanged, and by a dry-run
  launch as the acceptance check.
- **A lost key locks a user out of their funds** via the app. The keystore file
  still exists on disk and the server passphrase still decrypts it, so recovery
  is possible with shell access. Documented, not automated.
- **Wallet ids are UUIDs and now cross a trust boundary.** Every route that
  takes an id must resolve it through the caller's keystore, never globally —
  otherwise user B could delete or export user A's wallet by guessing an id.
  This is the single most important thing for the implementation to get right,
  and it is what the `prepare.js` test above exists to check.
