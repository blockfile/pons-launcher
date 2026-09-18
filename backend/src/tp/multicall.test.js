'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');

const C = require('./constants');
const { aggregate3, decodeSlot, one, mcIface, MULTICALL_CHUNK } = require('./multicall');
const { fakeChain } = require('./test-helpers/fakeChain');

const ETH_BAL = 'function getEthBalance(address addr) view returns (uint256)';
const addr = (i) => '0x' + i.toString(16).padStart(40, '0');

test('aggregate3 chunks at 250 calls and keeps every slot in position', async () => {
  assert.equal(MULTICALL_CHUNK, 250);
  const fc = fakeChain();
  fc.on(C.MULTICALL3, ETH_BAL, ([a]) => [BigInt(a) * 10n]);
  const calls = Array.from({ length: 300 }, (_, i) => ({
    target: C.MULTICALL3,
    callData: mcIface.encodeFunctionData('getEthBalance', [addr(i + 1)]),
  }));
  const slots = await aggregate3(fc.provider, calls);
  assert.equal(slots.length, 300);
  assert.equal(fc.count('aggregate3'), 2);
  assert.equal(one(mcIface, 'getEthBalance', slots[0]), 10n);
  assert.equal(one(mcIface, 'getEthBalance', slots[299]), 3000n);
});

test('a reverting inner call is a failed slot that decodes to null; the batch still answers', async () => {
  const fc = fakeChain();
  const token = addr(0xabc);
  const erc20 = new Interface(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
  fc.on(token, 'function decimals() view returns (uint8)', () => [18]);
  fc.on(token, 'function symbol() view returns (string)', () => {
    throw new Error('revert');
  });
  const slots = await aggregate3(fc.provider, [
    { target: token, callData: erc20.encodeFunctionData('decimals') },
    { target: token, callData: erc20.encodeFunctionData('symbol') },
  ]);
  assert.equal(one(erc20, 'decimals', slots[0]), 18n);
  assert.equal(slots[1].success, false);
  assert.equal(decodeSlot(erc20, 'symbol', slots[1]), null);
  assert.equal(one(erc20, 'symbol', slots[1]), null);
});

test('blockTag is forwarded to the provider; an empty list makes no request', async () => {
  const fc = fakeChain();
  fc.on(C.MULTICALL3, ETH_BAL, () => [1n]);
  await aggregate3(
    fc.provider,
    [{ target: C.MULTICALL3, callData: mcIface.encodeFunctionData('getEthBalance', [addr(1)]) }],
    { blockTag: 1234 }
  );
  assert.equal(fc.log.find((l) => l.name === 'aggregate3').blockTag, 1234);
  assert.deepEqual(await aggregate3(fc.provider, []), []);
  assert.equal(fc.count('aggregate3'), 1);
});
