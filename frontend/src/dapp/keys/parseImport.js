/**
 * Wallet import: pasted text, CSV, the console's JSON backups, or its XLSX
 * exports -> [{address, privateKey}]. Parsed in the browser; nothing is sent.
 *
 * WHAT IT ACCEPTS
 *   paste / .txt   one wallet per line: a key (64 hex, 0x optional), or
 *                  "address,key" / "address key" / "key address" (space, tab,
 *                  comma, semicolon or pipe between them). V8's keys-only export
 *                  (frontend/src/v8/backup.js, one key per line) is this shape.
 *   CSV            a header row naming the columns, e.g. the console's
 *                  `role,label,address,privateKey` (frontend/src/api.js:136).
 *   JSON           the console's backups {..., wallets: [{address, privateKey, ...}]}
 *                  (backend/src/routes/wallets.js:403-425 and every /vN/wallets/backup
 *                  route), a bare array of those, one {address, privateKey}
 *                  (POST /wallets/export), or an array of key strings.
 *   XLSX           a header row with 'Public address' / 'Address' and 'Private key'
 *                  (frontend/src/api.js:133, v4/backupRows.js:16, v4/V4SeedPanel.jsx:740),
 *                  matched case-insensitively; without one, any 64-hex cell is the key.
 *
 * VALIDATION. Every key must derive a real secp256k1 address (ethers SigningKey). When
 * the row also names an address, the key must derive THAT address: a key pasted
 * against the wrong row is refused, never imported under the wrong label.
 * Duplicates (same address) keep the first row.
 *
 * NO KEY IN ANY MESSAGE. A reject is {row, reason} with a fixed reason. Library
 * error messages are never passed through: some secp256k1 libraries print the
 * offending scalar in their range errors.
 *
 * Row numbers: 1-based line (paste/CSV), sheet row (XLSX), array position (JSON).
 * Row 0 means the input as a whole.
 */
import { SigningKey, computeAddress } from 'ethers';
import { readXlsxRows } from './xlsxRead.js';

const KEY_RE = /^(?:0x)?([0-9a-fA-F]{64})$/;
const ADDR_RE = /^(?:0x)?([0-9a-fA-F]{40})$/;
const TOKEN_SPLIT = /[\s,;|]+/;
const LINE_SPLIT = /\r\n|\r|\n/;
const HEADERISH = /address|key/i;
const TAB = String.fromCharCode(9);
const BOM = 0xfeff;

const ADDRESS_HEADERS = new Set(['address', 'public address', 'publicaddress', 'public_address', 'wallet', 'wallet address']);
const KEY_HEADERS = new Set(['private key', 'privatekey', 'private_key', 'key', 'pk']);
const NO_COLS = { key: -1, address: -1, width: 0 };

/** Import stops here: the page sells from bundles, not from thousands of wallets. */
export const MAX_WALLETS = 1000;

const REASON = {
  noKey: 'no private key in this row',
  twoKeys: 'more than one private key in this row',
  twoAddrs: 'more than one address in this row',
  badKey: 'not a valid private key',
  badAddr: 'the address in this row is not a valid address',
  mismatch: 'the key does not match the address in this row',
};

function clean(cell) {
  return String(cell ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function headerIndex(cells, names) {
  return cells.findIndex((c) => names.has(clean(c).toLowerCase().replace(/\s+/g, ' ')));
}

/** A row that names columns and holds neither a key nor an address. */
function isHeader(cells) {
  const values = cells.map(clean).filter(Boolean);
  if (!values.length) return false;
  if (values.some((v) => KEY_RE.test(v) || ADDR_RE.test(v))) return false;
  return values.some((v) => HEADERISH.test(v));
}

/**
 * One row of cells -> {row, key, address} | {row, reject} | null (empty row).
 * `cols` are the header's column indexes (-1 = not named) and its width. A named
 * column is trusted; the whole row is scanned only when no column was named, or
 * when the row is WIDER than the header (an unquoted delimiter inside a label
 * shifted the columns). Two keys or two addresses in a scanned row are refused,
 * never guessed.
 */
function candidateFromCells(row, cells, cols) {
  const values = cells.map(clean).filter(Boolean);
  if (!values.length) return null;
  const shifted = cells.length > cols.width;

  let key = null;
  let address = null;
  if (cols.key >= 0) {
    const m = KEY_RE.exec(clean(cells[cols.key]));
    if (m) key = m[1];
  }
  if (cols.address >= 0) {
    const m = ADDR_RE.exec(clean(cells[cols.address]));
    if (m) address = m[1];
  }
  if (!key && (cols.key < 0 || shifted)) {
    const keys = values.map((v) => KEY_RE.exec(v)).filter(Boolean);
    if (keys.length > 1) return { row, reject: REASON.twoKeys };
    if (keys.length === 1) key = keys[0][1];
  }
  if (!address && (cols.address < 0 || shifted)) {
    const addrs = values.map((v) => ADDR_RE.exec(v)).filter(Boolean);
    if (addrs.length > 1) return { row, reject: REASON.twoAddrs };
    if (addrs.length === 1) address = addrs[0][1];
  }
  if (!key) return { row, reject: REASON.noKey };
  return { row, key, address };
}

/**
 * Rows -> candidates. `splitRow(raw, asTable)` returns the row's cells: as table
 * columns (header mode) or as free tokens. The first non-empty row may be a header.
 */
function candidatesFromRows(rows, splitRow) {
  const out = [];
  let cols = null;
  let first = true;
  rows.forEach((raw, i) => {
    const row = i + 1;
    const tokens = splitRow(raw, false);
    if (!tokens.some((c) => clean(c))) return;
    if (first) {
      first = false;
      const headerCells = splitRow(raw, true);
      if (isHeader(headerCells)) {
        cols = {
          key: headerIndex(headerCells, KEY_HEADERS),
          address: headerIndex(headerCells, ADDRESS_HEADERS),
          width: headerCells.length,
        };
        return;
      }
    }
    const c = candidateFromCells(row, cols ? splitRow(raw, true) : tokens, cols || NO_COLS);
    if (c) out.push(c);
  });
  return out;
}

function delimiterOf(line) {
  if (line.includes(TAB)) return TAB;
  if (line.includes(',')) return ',';
  if (line.includes(';')) return ';';
  return null;
}

function candidatesFromText(text) {
  const lines = text.split(LINE_SPLIT);
  const delim = delimiterOf(lines.find((l) => l.trim()) || '');
  const splitRow = (line, asTable) => (asTable && delim ? line.split(delim) : line.trim().split(TOKEN_SPLIT));
  return candidatesFromRows(lines, splitRow);
}

function pick(obj, names) {
  for (const k of names) if (typeof obj[k] === 'string') return obj[k];
  return null;
}

function candidatesFromJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { candidates: [], rejects: [{ row: 0, reason: 'the file is not valid JSON' }] };
  }
  const KEYS = ['privateKey', 'private_key', 'privatekey', 'key', 'pk'];
  const ADDRS = ['address', 'publicAddress', 'public_address'];
  let list = null;
  if (Array.isArray(json)) list = json;
  else if (json && Array.isArray(json.wallets)) list = json.wallets;
  else if (json && typeof json === 'object' && pick(json, KEYS) !== null) list = [json];
  if (!list) return { candidates: [], rejects: [{ row: 0, reason: 'no wallets found in this JSON' }] };

  const candidates = list.map((item, i) => {
    const row = i + 1;
    const isObj = item !== null && typeof item === 'object';
    const rawKey = typeof item === 'string' ? item : isObj ? pick(item, KEYS) : null;
    if (rawKey === null) return { row, reject: REASON.noKey };
    const k = KEY_RE.exec(clean(rawKey));
    if (!k) return { row, reject: REASON.badKey };
    const rawAddr = isObj ? pick(item, ADDRS) : null;
    if (rawAddr === null || !clean(rawAddr)) return { row, key: k[1], address: null };
    const a = ADDR_RE.exec(clean(rawAddr));
    if (!a) return { row, reject: REASON.badAddr };
    return { row, key: k[1], address: a[1] };
  });
  return { candidates, rejects: [] };
}

function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Validate candidates -> wallets + rejects. The only place a key becomes a wallet. */
function finish(candidates, rejects) {
  const wallets = [];
  const seen = new Map(); // lower-case address -> first row
  for (const c of candidates) {
    if (c.reject) {
      rejects.push({ row: c.row, reason: c.reject });
      continue;
    }
    if (wallets.length >= MAX_WALLETS) {
      rejects.push({ row: c.row, reason: `import stops at ${MAX_WALLETS} wallets` });
      break;
    }
    let wallet;
    try {
      // SigningKey + computeAddress, not an ethers Wallet (walletStore.js says why).
      const key = new SigningKey(`0x${c.key.toLowerCase()}`);
      wallet = { address: computeAddress(key.publicKey), privateKey: key.privateKey };
    } catch {
      rejects.push({ row: c.row, reason: REASON.badKey });
      continue;
    }
    const derived = wallet.address.toLowerCase();
    if (c.address && derived !== `0x${c.address.toLowerCase()}`) {
      rejects.push({ row: c.row, reason: REASON.mismatch });
      continue;
    }
    if (seen.has(derived)) {
      rejects.push({ row: c.row, reason: `duplicate of row ${seen.get(derived)}` });
      continue;
    }
    seen.set(derived, c.row);
    wallets.push({ address: wallet.address, privateKey: wallet.privateKey });
  }
  return { wallets, rejects };
}

function parseText(raw) {
  const text = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  const head = text.trimStart()[0];
  if (head === '{' || head === '[') {
    const { candidates, rejects } = candidatesFromJson(text);
    return finish(candidates, rejects);
  }
  return finish(candidatesFromText(text), []);
}

/**
 * @param {{ text?: string, file?: { name: string, bytes: Uint8Array|ArrayBuffer } }} input
 *   a file wins over text when both are given
 * @returns {Promise<{ wallets: {address: string, privateKey: string}[], rejects: {row: number, reason: string}[] }>}
 *   address checksummed; privateKey 0x + 64 lower-case hex. The caller hands
 *   `wallets` straight to walletStore.addWallets and drops it — never into React
 *   state, props, a log or a request.
 */
export async function parseImport({ text, file } = {}) {
  if (file) {
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    const name = String(file.name || '');
    if (isZip(bytes) || /\.xlsx$/i.test(name)) {
      let rows;
      try {
        rows = await readXlsxRows(bytes);
      } catch (err) {
        return { wallets: [], rejects: [{ row: 0, reason: err.message }] };
      }
      return finish(candidatesFromRows(rows, (cells) => cells), []);
    }
    if (/\.xls$/i.test(name)) {
      return { wallets: [], rejects: [{ row: 0, reason: 'old .xls files are not supported: save it as .xlsx or CSV' }] };
    }
    return parseText(new TextDecoder('utf-8').decode(bytes));
  }
  if (typeof text === 'string') return parseText(text);
  return { wallets: [], rejects: [{ row: 0, reason: 'nothing to import' }] };
}
