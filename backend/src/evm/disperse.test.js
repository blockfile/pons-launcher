'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The disperser list lives beside the history file. Point both at a temp dir
// so a real dispersers.json on the developer's machine cannot decide what
// these assertions see.
process.env.HISTORY_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pons-disperse-')), 'launches.json');

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
process.env.DISPERSER_ADDRESSES = [A, B, C].join(',');

const { shouldBatch, buildDisperseTx, splitAcross, BATCH_THRESHOLD } = require('./disperse');
const { Interface, parseEther } = require('ethers');
const { DISPERSE_ABI } = require('./disperse');

const iface = new Interface(DISPERSE_ABI);
const addr = (n) => '0x' + String(n).repeat(40).slice(0, 40);

test('batching is only used where it is actually cheaper', () => {
  // Measured on this chain: 3 recipients batched cost 68,847 gas against
  // 63,585 sent individually. Below the threshold the loop wins.
  assert.equal(shouldBatch(1), false);
  assert.equal(shouldBatch(4), false);
  assert.equal(shouldBatch(BATCH_THRESHOLD), true);
  assert.equal(shouldBatch(20), true);
});

test('equal amounts use the calldata-cheap variant', async () => {
  const targets = [1, 2, 3, 4, 5].map((n) => ({ address: addr(n), value: parseEther('0.05') }));
  const tx = await buildDisperseTx(targets);
  const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });

  assert.equal(parsed.name, 'disperseEqual');
  assert.equal(parsed.args[0].length, 5);
  assert.equal(parsed.args[1], parseEther('0.05'));
  assert.equal(tx.value, parseEther('0.25'), 'value must be the exact sum');
});

test('mixed amounts use the per-recipient variant', async () => {
  const targets = [
    { address: addr(1), value: parseEther('0.01') },
    { address: addr(2), value: parseEther('0.02') },
    { address: addr(3), value: parseEther('0.03') },
  ];
  const tx = await buildDisperseTx(targets);
  const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });

  assert.equal(parsed.name, 'disperse');
  assert.deepEqual(
    parsed.args[1].map((v) => v.toString()),
    [parseEther('0.01'), parseEther('0.02'), parseEther('0.03')].map((v) => v.toString())
  );
  // The contract requires msg.value to equal the sum exactly, so a mismatch
  // here would revert every batch.
  assert.equal(tx.value, parseEther('0.06'));
});

test('an empty batch is refused rather than sent', async () => {
  await assert.rejects(() => buildDisperseTx([]), /nothing to disperse/);
});


// ── splitting across several contracts ────────────────────────────────────

test('twenty wallets split evenly across three contracts', () => {
  const targets = Array.from({ length: 20 }, (_, i) => ({ address: addr((i % 9) + 1), value: 1n }));
  const chunks = splitAcross(targets);

  assert.equal(chunks.length, 3, 'one transaction per contract');
  assert.deepEqual(chunks.map((c) => c.targets.length), [7, 7, 6]);
  // Every recipient must appear exactly once — a split that drops or duplicates
  // one would under- or double-fund a wallet.
  assert.equal(chunks.reduce((n, c) => n + c.targets.length, 0), 20);
  assert.deepEqual(chunks.map((c) => c.disperser), [A, B, C]);
});

test('chunks are contiguous, so a failed batch names exactly who missed out', () => {
  const targets = Array.from({ length: 9 }, (_, i) => ({ address: addr(i + 1), value: 1n }));
  const chunks = splitAcross(targets);
  assert.deepEqual(chunks.map((c) => c.targets.map((t) => t.address)), [
    [addr(1), addr(2), addr(3)],
    [addr(4), addr(5), addr(6)],
    [addr(7), addr(8), addr(9)],
  ]);
});

test('more contracts than recipients leaves the extras unused', () => {
  const chunks = splitAcross([{ address: addr(1), value: 1n }, { address: addr(2), value: 1n }]);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.reduce((n, c) => n + c.targets.length, 0), 2);
});

test('each chunk builds against its own contract', async () => {
  const targets = Array.from({ length: 6 }, (_, i) => ({ address: addr(i + 1), value: parseEther('0.01') }));
  const chunks = splitAcross(targets);
  for (const chunk of chunks) {
    const tx = await buildDisperseTx(chunk.targets, chunk.disperser);
    assert.equal(tx.to.toLowerCase(), chunk.disperser.toLowerCase());
  }
});
