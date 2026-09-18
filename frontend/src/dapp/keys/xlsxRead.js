/**
 * A minimal XLSX reader: the first worksheet as rows of strings. No dependency.
 *
 * WHY NOT A LIBRARY. The file being read holds private keys, in a page that holds
 * them in memory. A spreadsheet library is a large third-party tree on exactly
 * that path (spec: Security, "Dependencies"). What is needed is small: an XLSX is
 * a ZIP of XML parts. This reads the ZIP the way an unzipper does — end record ->
 * central directory -> local headers — and inflates "deflate" entries with the
 * platform's own DecompressionStream('deflate-raw') (browsers; Node 18+ for tests).
 *
 * WHAT IT UNDERSTANDS. Stored (method 0) and deflated (method 8) entries, each
 * checked against its CRC-32 (a raw deflate stream carries no checksum of its own,
 * and a corrupted key that still parses would import the WRONG wallet). The first
 * <sheet> of xl/workbook.xml, located through xl/_rels/workbook.xml.rels. Cells
 * that are shared strings (t="s"), inline strings (t="inlineStr"), or plain <v>
 * values. Everything else (styles, formulas, dates) is ignored: a key and an
 * address are text.
 *
 * The console's own writer (frontend/src/components/xlsx.js buildXlsx) writes
 * stored entries and inline strings; Excel and LibreOffice re-save as deflate and
 * shared strings. Both are covered.
 */
import { crc32 } from './crc32.js';

const dec = new TextDecoder('utf-8', { fatal: false });

// A spreadsheet of a few thousand wallets is well under 1 MB. These caps only
// stop a hostile or broken file from exhausting the tab.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 4096;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function fail(message) {
  return new Error(`not a readable XLSX file: ${message}`);
}

/** Locate the end-of-central-directory record (it may be followed by a comment). */
function findEocd(view) {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - 0xffff);
  for (let p = last; p >= first; p -= 1) {
    if (view.getUint32(p, true) === SIG_EOCD) return p;
  }
  throw fail('no ZIP end record');
}

/**
 * The ZIP's table of contents: lower-cased name -> entry.
 * Sizes come from the CENTRAL directory, which is right even when the local
 * header defers them to a data descriptor (flag bit 3).
 */
function readDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw fail('too many entries');
  if (cdOffset === 0xffffffff || cdOffset + cdSize > bytes.byteLength) throw fail('bad central directory');

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) throw fail('bad central directory entry');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)).split('\\').join('/');
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw fail('ZIP64 is not supported');
    entries.set(name.toLowerCase(), { name, flags, method, crc, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { view, entries };
}

async function inflateRaw(data, limit) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw fail('an entry inflates past its declared size');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

async function entryBytes(bytes, dir, entry) {
  const { view } = dir;
  const at = entry.localOffset;
  if (at + 30 > bytes.byteLength || view.getUint32(at, true) !== SIG_LOCAL) throw fail(`bad local header for ${entry.name}`);
  if (entry.flags & 0x1) throw fail('password-protected files are not supported');
  if (entry.size > MAX_ENTRY_BYTES) throw fail(`${entry.name} is too large`);
  // The LOCAL name/extra lengths, which may differ from the central directory's.
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compSize;
  if (end > bytes.byteLength) throw fail(`${entry.name} runs past the end of the file`);
  const raw = bytes.subarray(start, end);

  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) {
    try {
      data = await inflateRaw(raw, entry.size);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('not a readable XLSX file')) throw err;
      throw fail(`${entry.name} is corrupt`);
    }
  } else throw fail(`${entry.name} uses compression method ${entry.method}`);

  if (data.byteLength !== entry.size || crc32(data) !== entry.crc) throw fail(`${entry.name} is corrupt (CRC mismatch)`);
  return data;
}

async function readText(bytes, dir, path) {
  const entry = dir.entries.get(path.toLowerCase());
  if (!entry) return null;
  return dec.decode(await entryBytes(bytes, dir, entry));
}

// ── XML, just enough ──────────────────────────────────────────────────────

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the five named entities and numeric character references. */
export function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] !== '#') return NAMED[e];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Attributes of one start tag, keyed by local name (prefix dropped) AND by the full qualified name. */
function attrs(tagText) {
  const out = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagText))) {
    const value = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
    out[m[1]] = value;
    const local = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : m[1];
    if (!(local in out)) out[local] = value;
  }
  return out;
}

/** The concatenated text of every <t> in a fragment (rich-text runs), phonetic runs removed. */
function textOf(fragment) {
  const clean = fragment.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let s = '';
  const re = /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;
  let m;
  while ((m = re.exec(clean))) s += m[1] ? unescapeXml(m[1]) : '';
  return s;
}

/** 'A' -> 0, 'Z' -> 25, 'AA' -> 26. */
export function columnIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Resolve a relationship Target against the xl/ folder the workbook lives in. */
function resolveTarget(target) {
  const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function relationships(relsXml) {
  const rels = [];
  if (!relsXml) return rels;
  const re = /<(?:\w+:)?Relationship\b([^>]*)>/g;
  let m;
  while ((m = re.exec(relsXml))) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) rels.push({ id: a.Id, type: a.Type || '', target: resolveTarget(a.Target) });
  }
  return rels;
}

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : '');
  return out;
}

function sheetRows(xml, sst) {
  const rows = [];
  const rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
  const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let nextRow = 0;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const ra = attrs(rm[1]);
    const r = /^\d+$/.test(ra.r || '') ? Number(ra.r) - 1 : nextRow;
    nextRow = r + 1;
    const cells = [];
    let nextCol = 0;
    const body = rm[2] || '';
    cellRe.lastIndex = 0;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const ca = attrs(cm[1]);
      const ref = /^([A-Za-z]+)\d*$/.exec(ca.r || '');
      const c = ref ? columnIndex(ref[1]) : nextCol;
      nextCol = c + 1;
      const inner = cm[2] || '';
      let value = '';
      if (ca.t === 'inlineStr') {
        const is = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(inner);
        value = is ? textOf(is[1]) : '';
      } else {
        const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        const raw = v ? unescapeXml(v[1]) : '';
        if (ca.t === 's') {
          const i = Number(raw.trim());
          value = Number.isInteger(i) && i >= 0 && i < sst.length ? sst[i] : '';
        } else value = raw;
      }
      if (c > 16383) continue; // past Excel's last column (XFD): malformed, skip
      while (cells.length < c) cells.push('');
      cells[c] = value;
    }
    if (r > 1048575) continue; // past Excel's last row: malformed, skip
    while (rows.length < r) rows.push([]);
    rows[r] = cells;
  }
  return rows;
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes the .xlsx file
 * @returns {Promise<string[][]>} the first worksheet; rows[i] is sheet row i+1,
 *   rows[i][j] is column j (A = 0). Missing rows are [], missing cells ''.
 * @throws Error('not a readable XLSX file: ...') — never includes cell content
 */
export async function readXlsxRows(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.byteLength < 22) throw fail('too short');
  if (buf.byteLength > MAX_FILE_BYTES) throw fail('larger than 16 MB');
  const dir = readDirectory(buf);

  const workbook = await readText(buf, dir, 'xl/workbook.xml');
  if (workbook === null) throw fail('no xl/workbook.xml');
  const rels = relationships(await readText(buf, dir, 'xl/_rels/workbook.xml.rels'));

  // The FIRST <sheet> in workbook order is the first tab, whatever its file name.
  const firstSheet = /<(?:\w+:)?sheet\b([^>]*)>/.exec(workbook);
  let sheetPath = null;
  if (firstSheet) {
    const a = attrs(firstSheet[1]);
    const rel = rels.find((x) => x.id === a.id);
    if (rel) sheetPath = rel.target;
  }
  if (!sheetPath || !dir.entries.has(sheetPath.toLowerCase())) sheetPath = 'xl/worksheets/sheet1.xml';
  const sheet = await readText(buf, dir, sheetPath);
  if (sheet === null) throw fail('no worksheet');

  const sstRel = rels.find((x) => /\/sharedStrings$/.test(x.type));
  const sstXml = (sstRel && (await readText(buf, dir, sstRel.target))) || (await readText(buf, dir, 'xl/sharedStrings.xml'));
  return sheetRows(sheet, sharedStrings(sstXml));
}
