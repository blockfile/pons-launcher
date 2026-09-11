# Export filenames across all tabs, and a V2 XLSX export

Date: 2026-09-11. Approved in conversation the same day.

## Filenames

Every key export on every tab (V1–V8) is named

    {count}pcs-{TAB}-{what}[-{suffix}]-{YYYY-MM-DD}.{ext}

e.g. `100pcs-V4-funding-wallets-2026-09-11.json`. No spaces (operator's choice). The
`pons-` prefix is dropped. The date stays UTC (`toISOString().slice(0, 10)`), as today.

- `count` — the number of wallets actually in the file (`json.wallets.length`).
- `what` is derived from the file's CONTENTS, not from the request — a 2026-09-11 V4
  "nofunders" export actually held a funding wallet, and a request-derived name would
  have lied:
  - every wallet in the file has the same role → that role's word + `wallet(s)`;
  - mixed roles → plain `wallets`;
  - a narrowing qualifier is prefixed: `selected` (a ticked-rows export), V4's
    `seasoned-{N}d` (age filter);
  - mixed roles AND no qualifier (the full backup) → `all-wallets`;
  - exactly one wallet → singular `wallet`.
- `suffix` — only V8's bare-keys text file: `keys`.
- Role words: V1/V2/V5 dev→`dev`, bundle→`bundle`; V3/V6/V7 dev→`treasury`, main→`main`,
  bundle→`bundle`; V4 v4master→`funding`, v4seed→`seed`; V8 main→`main`, bundle→`bundle`.
- The V4 hand-off log CSV (addresses/tabs/times, no keys) follows the same shape with its
  row count: `42pcs-V4-handoffs-v3-2026-09-11.csv` (the search tag is kept).

Each tab owns its own copy of the naming function (tab-isolation rule), in a pure module
so it is unit-testable without the browser: `frontend/src/vN/exportName.js` for V3–V8,
and `frontend/src/components/backupScope.js` for the V1/V2 pair (already pure, already
the V1/V2 scope module).

## V2 XLSX

- The V2 export dialog's "Write it as CSV" checkbox becomes a format select:
  JSON / CSV / XLSX. V1 gets the same select with JSON / CSV only.
- XLSX: one sheet, a bold header row `Public address | Private key`, one row per wallet.
  No seed-phrase column — the keystore holds private keys only; no wallet has a phrase.
- Every cell is an inline string, so Excel never reinterprets a key.
- Written by a small in-repo writer (`frontend/src/components/xlsx.js`, ZIP "stored"
  entries + CRC-32) — no new dependency on a key-export path. Unit-tested (ZIP structure,
  CRCs checked against Node's own `zlib.crc32`, XML escaping) and verified once with
  Python openpyxl.

## Out of scope

Export contents, scopes, confirm dialogs and backend routes are unchanged.
