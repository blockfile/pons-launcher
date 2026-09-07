'use strict';

// Reading the launch salt back out of a signed launch transaction.
//
// This is the load-bearing half of fireV2's salt pin. On a paired launch the
// bundle's approvals are broadcast BEFORE the launch, and each one names the
// predicted curve as its spender — an address that exists only as a function of
// the salt. If the launch that follows carries a different salt, every approval
// and every buy names a curve that is never created and the bundle is lost.
//
// So the salt is read from the transaction's own bytes rather than from any
// field travelling beside them, and anything unreadable throws instead of
// answering. "No idea" must never be mistaken for "it matches".

const test = require('node:test');
const assert = require('node:assert');
const { Interface, Transaction, Wallet } = require('ethers');
const { saltFromLaunchTx } = require('./factory');
const { FACTORY_V2_ABI, FORWARDER_V2_ABI } = require('./abi');

const SALT = '0x' + 'ab'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);
const FACTORY = '0x' + 'fa'.repeat(20);
const FORWARDER = '0x' + 'ff'.repeat(20);
const PAIR = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const DEV = '0x' + '11'.repeat(20);

const LAUNCH_SIG =
  'launchToken(tuple(string,string,string,string,tuple(string,string,string,string,string),' +
  'address,uint16,bool,bytes32,bytes32),uint256,address,address[])';

const params = (salt) => [
  'Nvidia',
  'NVDA',
  'ipfs://logo',
  '',
  ['', '', '', '', ''],
  DEV,
  0,
  false,
  ZERO32,
  salt,
];

const base = {
  chainId: 4663,
  nonce: 5,
  gasLimit: 3_000_000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  type: 2,
};

test('the salt comes back out of a signed launchToken', async () => {
  const data = new Interface(FACTORY_V2_ABI).encodeFunctionData(LAUNCH_SIG, [params(SALT), 0, PAIR, []]);
  const raw = await Wallet.createRandom().signTransaction({ ...base, to: FACTORY, data, value: 1000n });
  assert.equal(saltFromLaunchTx(raw), SALT);
});

test('the salt comes back out of a signed forwarder launchAndBuy', async () => {
  const data = new Interface(FORWARDER_V2_ABI).encodeFunctionData('launchAndBuy', [
    params(SALT),
    0,
    PAIR,
    5_000_000n,
    0n,
    DEV,
    [],
  ]);
  const raw = await Wallet.createRandom().signTransaction({ ...base, to: FORWARDER, data, value: 1000n });
  assert.equal(saltFromLaunchTx(raw), SALT);
});

test('a different salt reads back as different — the check can actually fail', async () => {
  const other = '0x' + 'cd'.repeat(32);
  const data = new Interface(FACTORY_V2_ABI).encodeFunctionData(LAUNCH_SIG, [params(other), 0, PAIR, []]);
  const raw = Transaction.from({ ...base, to: FACTORY, data, value: 1000n }).unsignedSerialized;
  assert.equal(saltFromLaunchTx(raw), other);
  assert.notEqual(saltFromLaunchTx(raw), SALT);
});

test('a transaction that is not a v2 launch throws rather than answering', async () => {
  const raw = await Wallet.createRandom().signTransaction({ ...base, to: FACTORY, data: '0xdeadbeef' });
  assert.throws(() => saltFromLaunchTx(raw), /not a pons v2 launchToken or launchAndBuy call/);
});

test('bytes that are not a transaction at all throw', () => {
  assert.throws(() => saltFromLaunchTx('LAUNCH'));
  assert.throws(() => saltFromLaunchTx('0x'));
});
