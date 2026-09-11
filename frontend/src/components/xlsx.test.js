import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildXlsx, crc32 } from './xlsx.js';

const dec = new TextDecoder();

// Read the ZIP the way an unzipper does — end record → central directory → local
// headers — so a wrong offset or size fails here, not in Excel.
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50, 'end-of-central-directory signature');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const entries = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(v.getUint32(p, true), 0x02014b50, 'central directory signature');
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(v.getUint32(local, true), 0x04034b50, `${name}: local header signature`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    entries[name] = { method, crc, data, text: dec.decode(data) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('crc32 matches the standard check value and Node’s own implementation', () => {
  const check = new TextEncoder().encode('123456789');
  assert.equal(crc32(check), 0xcbf43926);
  assert.equal(crc32(check), zlib.crc32(check));
});

test('an XLSX is a valid stored ZIP holding the six parts Excel needs, each CRC correct', () => {
  const z = readZip(buildXlsx([['Public address', 'Private key'], ['0xabc', '0xdef']]));
  assert.deepEqual(
    Object.keys(z).sort(),
    [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ].sort()
  );
  for (const [name, e] of Object.entries(z)) {
    assert.equal(e.method, 0, `${name} is stored`);
    assert.equal(e.crc, zlib.crc32(e.data), `${name} CRC`);
  }
});

test('every cell is an inline string, the header row is bold, and values are escaped', () => {
  const key = `0x${'0'.repeat(63)}1`;
  const z = readZip(buildXlsx([['Public address', 'Private key'], ['0x12<&>"', key]]));
  const sheet = z['xl/worksheets/sheet1.xml'].text;
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Public address<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B1" t="inlineStr" s="1">/);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">0x12&lt;&amp;&gt;&quot;<\/t>/);
  assert.ok(sheet.includes(key), 'a key survives verbatim — never a number');
  assert.doesNotMatch(sheet, /t="n"|<v>/);
  assert.match(z['xl/styles.xml'].text, /<b\/>/);
});

test('column widths are written when given', () => {
  const z = readZip(buildXlsx([['a', 'b']], { colWidths: [46, 70] }));
  assert.match(
    z['xl/worksheets/sheet1.xml'].text,
    /<col min="1" max="1" width="46" customWidth="1"\/><col min="2" max="2" width="70" customWidth="1"\/>/
  );
});

test('a sheet name Excel would refuse is cleaned and capped at 31 characters', () => {
  const z = readZip(buildXlsx([['a']], { sheetName: `V2/bundle: [wallets]*?${'x'.repeat(40)}` }));
  const m = z['xl/workbook.xml'].text.match(/<sheet name="([^"]*)"/);
  assert.ok(m && m[1].length <= 31 && !/[\\/?*[\]:]/.test(m[1]));
});
