import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../../components/xlsx.js';
import { readXlsxRows, columnIndex } from './xlsxRead.js';
import { zip, deflateAll } from './zipFixture.js';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const ROWS = [
  ['Public address', 'Private key'],
  ['0xabc', '0xdef'],
  ['a&b<c>', '"q"'],
];

test('columnIndex maps column letters to 0-based indexes', () => {
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('Z'), 25);
  assert.equal(columnIndex('AA'), 26);
  assert.equal(columnIndex('az'), 51);
  assert.equal(columnIndex('BA'), 52);
  assert.equal(columnIndex('XFD'), 16383);
});

test('reads the console writer’s own file (stored entries, inline strings)', async () => {
  assert.deepEqual(await readXlsxRows(buildXlsx(ROWS)), ROWS);
});

test('reads the same file re-packed with deflated entries (as Excel saves it)', async () => {
  const deflated = await deflateAll(buildXlsx(ROWS));
  assert.deepEqual(await readXlsxRows(deflated), ROWS);
});

test('accepts an ArrayBuffer as well as a Uint8Array', async () => {
  const bytes = buildXlsx(ROWS);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.deepEqual(await readXlsxRows(ab), ROWS);
});

test('follows workbook.xml.rels to the FIRST sheet, resolves shared strings, keeps row and column gaps', async () => {
  const files = [
    {
      name: 'xl/workbook.xml',
      data:
        `${HEAD}<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets>` +
        '<sheet name="Keys" sheetId="2" r:id="rId7"/><sheet name="Other" sheetId="1" r:id="rId1"/>' +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `${HEAD}<Relationships xmlns="${NS_PKG}">` +
        `<Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId7" Type="${NS_R}/worksheet" Target="/xl/worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId9" Type="${NS_R}/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/sharedStrings.xml',
      data:
        `${HEAD}<sst xmlns="${NS}" count="4" uniqueCount="4">` +
        '<si><t>Public address</t></si>' +
        '<si><t>Private key</t></si>' +
        '<si><r><rPr><b/></rPr><t>ab</t></r><r><t xml:space="preserve"> cd</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>' +
        '<si><t>x&amp;y &#65;&#x42;</t></si>' +
        '</sst>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `${HEAD}<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG SHEET</t></is></c></row></sheetData></worksheet>`,
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      data:
        `${HEAD}<worksheet xmlns="${NS}"><sheetData>` +
        '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s" s="1"><v>1</v></c></row>' +
        '<row r="3"><c r="A3"><v>42</v></c><c r="B3" t="s"><v>2</v></c><c r="C3" t="s"><v>3</v></c><c r="D3" s="2"/></row>' +
        '</sheetData></worksheet>',
    },
  ];
  const expected = [['Public address', '', 'Private key'], [], ['42', 'ab cd', 'x&y AB', '']];
  assert.deepEqual(await readXlsxRows(await zip(files)), expected);
  assert.deepEqual(await readXlsxRows(await zip(files, { deflate: true })), expected);
});

test('a corrupted entry is refused by its CRC, and the error never quotes cell content', async () => {
  const bytes = buildXlsx([['Public address', 'Private key'], ['0xabc', '0xdeadbeef']]);
  const at = Buffer.from(bytes).indexOf('0xdeadbeef');
  assert.ok(at > 0);
  bytes[at + 2] = 'f'.charCodeAt(0); // 0xdeadbeef -> 0xfeadbeef
  await assert.rejects(readXlsxRows(bytes), (err) => {
    assert.match(err.message, /not a readable XLSX file: .*CRC mismatch/);
    assert.ok(!err.message.includes('eadbeef'));
    return true;
  });
});

test('a file that is not a ZIP is refused', async () => {
  await assert.rejects(readXlsxRows(new TextEncoder().encode('address,key\n0xabc,0xdef\n'.repeat(3))), /not a readable XLSX file/);
  await assert.rejects(readXlsxRows(new Uint8Array(4)), /not a readable XLSX file: too short/);
});

test('a ZIP without a workbook is refused', async () => {
  await assert.rejects(readXlsxRows(await zip([{ name: 'hello.txt', data: 'hi' }])), /no xl\/workbook\.xml/);
});

test('a corrupted DEFLATED entry is refused (inflate error or CRC), never returned', async () => {
  const deflated = await deflateAll(buildXlsx(ROWS));
  // Every 7th byte of the file, flipped one at a time (compressed data, headers,
  // directory), must be refused or read back exactly — never as different cells.
  for (let i = 0; i < deflated.length - 22; i += 7) {
    const bytes = deflated.slice();
    bytes[i] ^= 0x5a;
    let rows = null;
    try {
      rows = await readXlsxRows(bytes);
    } catch (err) {
      assert.match(err.message, /^not a readable XLSX file: /);
      continue;
    }
    assert.deepEqual(rows, ROWS, `byte ${i} changed the cells without being detected`);
  }
});
