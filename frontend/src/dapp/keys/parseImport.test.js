import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { buildXlsx } from '../../components/xlsx.js';
import { parseImport } from './parseImport.js';
import { deflateAll } from './zipFixture.js';

// Throwaway wallets, generated per run. No real key is ever written into a test.
function fresh(n) {
  return Array.from({ length: n }, () => {
    const w = Wallet.createRandom();
    return { address: w.address, key: w.privateKey, bare: w.privateKey.slice(2) };
  });
}

const enc = new TextEncoder();

/** Every reject is {row, reason} and no reason contains any of the keys. */
function assertNoKeyLeak(result, wallets) {
  const text = JSON.stringify(result.rejects).toLowerCase();
  for (const w of wallets) assert.ok(!text.includes(w.bare.toLowerCase()), 'a reject must never carry a key');
  for (const r of result.rejects) {
    assert.deepEqual(Object.keys(r).sort(), ['reason', 'row']);
    assert.equal(typeof r.row, 'number');
    assert.equal(typeof r.reason, 'string');
  }
}

test('paste: one key per line, 0x optional, "address,key" and "address key" forms, blank lines ignored', async () => {
  const [a, b, c, d] = fresh(4);
  const text = [a.key, '', `  ${b.bare}  `, `${c.address},${c.key}`, `${d.address} ${d.bare}`, ''].join('\n');
  const out = await parseImport({ text });
  assert.deepEqual(out.rejects, []);
  assert.deepEqual(
    out.wallets,
    [a, b, c, d].map((w) => ({ address: w.address, privateKey: w.key }))
  );
});

test('paste: windows line endings, tabs, "key address" order and a lower-case address all work', async () => {
  const [a, b] = fresh(2);
  const tab = String.fromCharCode(9);
  const text = `${a.key}${tab}${a.address.toLowerCase()}\r\n${b.address};${b.key}\r\n`;
  const out = await parseImport({ text });
  assert.deepEqual(out.rejects, []);
  assert.deepEqual(out.wallets.map((w) => w.address), [a.address, b.address]);
});

test('paste: a key against the wrong address is rejected by row, and the reason never carries the key', async () => {
  const [a, b] = fresh(2);
  const text = `${a.key}\n${a.address},${b.key}\nhello world\n${'0'.repeat(64)}\n${'f'.repeat(64)}`;
  const out = await parseImport({ text });
  assert.deepEqual(out.wallets.map((w) => w.address), [a.address]);
  assert.deepEqual(out.rejects, [
    { row: 2, reason: 'the key does not match the address in this row' },
    { row: 3, reason: 'no private key in this row' },
    { row: 4, reason: 'not a valid private key' },
    { row: 5, reason: 'not a valid private key' },
  ]);
  assertNoKeyLeak(out, [a, b]);
});

test('paste: two keys on one line are refused, not guessed', async () => {
  const [a, b] = fresh(2);
  const out = await parseImport({ text: `${a.key} ${b.key}` });
  assert.deepEqual(out.wallets, []);
  assert.deepEqual(out.rejects, [{ row: 1, reason: 'more than one private key in this row' }]);
  assertNoKeyLeak(out, [a, b]);
});

test('duplicates keep the first row and name it', async () => {
  const [a] = fresh(1);
  const out = await parseImport({ text: `${a.key}\n${a.bare}\n` });
  assert.equal(out.wallets.length, 1);
  assert.deepEqual(out.rejects, [{ row: 2, reason: 'duplicate of row 1' }]);
});

test('CSV: the console’s own role,label,address,privateKey export (api.js:136)', async () => {
  const [a, b] = fresh(2);
  const csv = ['role,label,address,privateKey', `bundle,bundle 1,${a.address},${a.key}`, `dev,dev,${b.address},${b.key}`].join('\n');
  const out = await parseImport({ file: { name: '2pcs-V1-all-wallets-2026-09-19.csv', bytes: enc.encode(csv) } });
  assert.deepEqual(out.rejects, []);
  assert.deepEqual(out.wallets.map((w) => w.address), [a.address, b.address]);
});

test('CSV: a label with an unquoted comma shifts the columns and is still read correctly', async () => {
  const [a] = fresh(1);
  const csv = `role,label,address,privateKey\nbundle,big, fat label,${a.address},${a.key}\n`;
  const out = await parseImport({ text: csv });
  assert.deepEqual(out.rejects, []);
  assert.equal(out.wallets[0].address, a.address);
});

test('CSV: a named key column is trusted — a tx hash in another column is never taken as the key', async () => {
  const [a] = fresh(1);
  const hash = `0x${'ab'.repeat(32)}`;
  const csv = `address,privateKey,txHash\n${a.address},${a.key},${hash}\n${a.address},,${hash}\n`;
  const out = await parseImport({ text: csv });
  assert.deepEqual(out.wallets.map((w) => w.address), [a.address]);
  assert.deepEqual(out.rejects, [{ row: 3, reason: 'no private key in this row' }]);
});

test('JSON: the console backup shape {wallets:[{id, address, role, label, privateKey}]}', async () => {
  const [a, b] = fresh(2);
  const backup = {
    exportedAt: '2026-09-19T00:00:00.000Z',
    chainId: 4663,
    count: 2,
    variant: 'v1',
    scope: 'all',
    note: 'Every V1 wallet',
    warning: 'These private keys control real funds.',
    wallets: [
      { id: 'w1', address: a.address, role: 'bundle', label: 'b1', privateKey: a.key },
      { id: 'w2', address: b.address, role: 'dev', label: 'dev', privateKey: b.key },
    ],
  };
  const out = await parseImport({ file: { name: 'backup.json', bytes: enc.encode(JSON.stringify(backup, null, 2)) } });
  assert.deepEqual(out.rejects, []);
  assert.deepEqual(out.wallets, [a, b].map((w) => ({ address: w.address, privateKey: w.key })));
});

test('JSON: a bare array, a single exported wallet, and an array of key strings', async () => {
  const [a, b, c] = fresh(3);
  const arr = await parseImport({ text: JSON.stringify([{ address: a.address, privateKey: a.key }]) });
  assert.deepEqual(arr.wallets.map((w) => w.address), [a.address]);
  const one = await parseImport({ text: JSON.stringify({ address: b.address, privateKey: b.key }) });
  assert.deepEqual(one.wallets.map((w) => w.address), [b.address]);
  const keys = await parseImport({ text: JSON.stringify([c.key, c.bare]) });
  assert.deepEqual(keys.wallets.map((w) => w.address), [c.address]);
  assert.deepEqual(keys.rejects, [{ row: 2, reason: 'duplicate of row 1' }]);
});

test('JSON: mismatched and missing keys are rejected by position, without the key', async () => {
  const [a, b] = fresh(2);
  const out = await parseImport({
    text: JSON.stringify({
      wallets: [
        { address: a.address, privateKey: b.key },
        { address: b.address },
        { address: 'not-an-address', privateKey: a.key },
        { address: a.address, privateKey: a.key },
      ],
    }),
  });
  assert.deepEqual(out.wallets.map((w) => w.address), [a.address]);
  assert.deepEqual(out.rejects, [
    { row: 1, reason: 'the key does not match the address in this row' },
    { row: 2, reason: 'no private key in this row' },
    { row: 3, reason: 'the address in this row is not a valid address' },
  ]);
  assertNoKeyLeak(out, [a, b]);
});

test('JSON: broken JSON and JSON without wallets are one row-0 reject', async () => {
  assert.deepEqual(await parseImport({ text: '{"wallets": [' }), {
    wallets: [],
    rejects: [{ row: 0, reason: 'the file is not valid JSON' }],
  });
  assert.deepEqual(await parseImport({ text: '{"hello": 1}' }), {
    wallets: [],
    rejects: [{ row: 0, reason: 'no wallets found in this JSON' }],
  });
});

test('XLSX: the console’s Public address | Private key export, stored AND deflated', async () => {
  const [a, b] = fresh(2);
  const stored = buildXlsx([['Public address', 'Private key'], [a.address, a.key], [b.address, b.key]], {
    sheetName: 'Wallets',
  });
  for (const bytes of [stored, await deflateAll(stored)]) {
    const out = await parseImport({ file: { name: '2pcs-V2-all-wallets-2026-09-19.xlsx', bytes } });
    assert.deepEqual(out.rejects, []);
    assert.deepEqual(out.wallets, [a, b].map((w) => ({ address: w.address, privateKey: w.key })));
  }
});

test('XLSX: V4’s five-column sheet and the hand-off sheet (Address | Tab | Handed off at | Private key)', async () => {
  const [a, b] = fresh(2);
  const v4 = buildXlsx([
    ['Public address', 'Private key', 'Type', 'Funded at', 'Days since funded'],
    [a.address, a.key, 'seed', '2026-09-01T00:00:00.000Z', '18'],
  ]);
  const handoff = buildXlsx([
    ['Address', 'Tab', 'Handed off at', 'Private key'],
    [b.address, 'v3', '2026-09-10T00:00:00.000Z', b.key],
  ]);
  assert.deepEqual((await parseImport({ file: { name: 'v4.xlsx', bytes: v4 } })).wallets.map((w) => w.address), [a.address]);
  assert.deepEqual((await parseImport({ file: { name: 'h.xlsx', bytes: handoff } })).wallets.map((w) => w.address), [b.address]);
});

test('XLSX: no header row — any 64-hex cell is the key; a mismatched address row is rejected by sheet row', async () => {
  const [a, b] = fresh(2);
  const bytes = buildXlsx([[a.key], [''], [b.address, a.key]]);
  const out = await parseImport({ file: { name: 'keys.xlsx', bytes } });
  assert.deepEqual(out.wallets.map((w) => w.address), [a.address]);
  assert.deepEqual(out.rejects, [{ row: 3, reason: 'the key does not match the address in this row' }]);
  assertNoKeyLeak(out, [a, b]);
});

test('XLSX: a file that is not a spreadsheet is one row-0 reject; .xls is refused by name', async () => {
  const bad = await parseImport({ file: { name: 'x.xlsx', bytes: enc.encode('PK not really a zip file at all') } });
  assert.equal(bad.wallets.length, 0);
  assert.equal(bad.rejects.length, 1);
  assert.equal(bad.rejects[0].row, 0);
  assert.match(bad.rejects[0].reason, /not a readable XLSX file/);
  const xls = await parseImport({ file: { name: 'old.xls', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) } });
  assert.deepEqual(xls.rejects, [{ row: 0, reason: 'old .xls files are not supported: save it as .xlsx or CSV' }]);
});

test('nothing to import', async () => {
  assert.deepEqual(await parseImport({}), { wallets: [], rejects: [{ row: 0, reason: 'nothing to import' }] });
});
