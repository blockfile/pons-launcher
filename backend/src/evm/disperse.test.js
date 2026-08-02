'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.DISPERSER_ADDRESS = '0x1234567890123456789012345678901234567890';

const { shouldBatch, buildDisperseTx, BATCH_THRESHOLD } = require('./disperse');
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
