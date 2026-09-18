/**
 * TEST FIXTURES ONLY (imported by *.test.js, never by the app): pull a ZIP
 * apart and pack it again, stored or deflated, so the XLSX reader is tested
 * against both entry kinds without a binary fixture checked into the repo.
 */
import { crc32 } from './crc32.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Every entry of a ZIP whose entries are STORED (what buildXlsx writes). */
export function unzipStored(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (v.getUint32(eocd, true) !== 0x06054b50) throw new Error('fixture: no end record');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i += 1) {
    const method = v.getUint16(p + 10, true);
    if (method !== 0) throw new Error('fixture: expected stored entries');
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    files.push({ name, data: bytes.slice(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function deflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Pack [{name, data: Uint8Array|string}] into a ZIP. `deflate: true` compresses
 * every entry with CompressionStream('deflate-raw') (method 8), as Excel does.
 */
export async function zip(files, { deflate = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const body = deflate ? await deflateRaw(data) : data;
    const nameBytes = enc.encode(f.name);
    const crc = crc32(data);
    const method = deflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    parts.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const chunk of all) {
    out.set(chunk, o);
    o += chunk.length;
  }
  return out;
}

/** Re-pack a stored ZIP (e.g. buildXlsx output) with every entry deflated. */
export async function deflateAll(storedZip) {
  return zip(unzipStored(storedZip), { deflate: true });
}
