import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Transaction } from 'ethers';
import * as store from './walletStore.js';
import { addWallets, addresses, removeWallet, clearWallets, signTx, _exportForVault } from './walletStore.js';

function fresh(n) {
  return Array.from({ length: n }, () => {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  });
}

test('the module exports addresses and signing — nothing that hands out a Wallet', () => {
  assert.deepEqual(Object.keys(store).sort(), [
    '_exportForVault',
    '_importFromVault',
    'addWallets',
    'addresses',
    'clearWallets',
    'removeWallet',
    'signTx',
  ]);
});

test('addWallets stores in import order, counts duplicates, and addresses() returns only addresses', () => {
  clearWallets();
  const [a, b] = fresh(2);
  assert.deepEqual(addWallets([a, b, { privateKey: a.privateKey }]), { added: 2, duplicates: 1 });
  assert.deepEqual(addWallets([{ address: b.address.toLowerCase(), privateKey: b.privateKey }]), { added: 0, duplicates: 1 });
  assert.deepEqual(addresses(), [a.address, b.address]);
  for (const x of addresses()) assert.match(x, /^0x[0-9a-fA-F]{40}$/);
});

test('addWallets is all-or-nothing and its errors never carry the key', () => {
  clearWallets();
  const [a, b] = fresh(2);
  assert.throws(
    () => addWallets([a, { address: a.address, privateKey: b.privateKey }]),
    (err) => {
      assert.match(err.message, /^wallet 2: key does not match 0x/);
      assert.ok(!err.message.toLowerCase().includes(b.privateKey.slice(2).toLowerCase()));
      return true;
    }
  );
  assert.deepEqual(addresses(), [], 'nothing from the failed batch was stored');
  const outOfRange = `0x${'f'.repeat(64)}`;
  assert.throws(() => addWallets([{ privateKey: outOfRange }]), (err) => {
    assert.equal(err.message, 'wallet 1: not a valid private key');
    return true;
  });
});

test('signTx signs a type-2 transaction that recovers to the wallet', async () => {
  clearWallets();
  const [a] = fresh(1);
  addWallets([a]);
  const raw = await signTx(a.address.toLowerCase(), {
    to: '0x0000000000000000000000000000000000000001',
    data: '0x095ea7b3',
    value: 0n,
    nonce: 7,
    gasLimit: 60000n,
    maxFeePerGas: 1000000n,
    maxPriorityFeePerGas: 0n,
    chainId: 4663,
    type: 2,
  });
  const tx = Transaction.from(raw);
  assert.equal(tx.from, a.address);
  assert.equal(tx.chainId, 4663n);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.type, 2);
  assert.equal(tx.maxPriorityFeePerGas, 0n);
  assert.equal(tx.data, '0x095ea7b3');
});

test('signTx refuses an address it holds no key for', async () => {
  clearWallets();
  await assert.rejects(signTx('0x0000000000000000000000000000000000000002', { chainId: 4663 }), /no key loaded for 0x0{39}2/);
});

test('removeWallet and clearWallets', () => {
  clearWallets();
  const [a, b] = fresh(2);
  addWallets([a, b]);
  assert.equal(removeWallet(a.address.toUpperCase().replace('0X', '0x')), true);
  assert.equal(removeWallet(a.address), false);
  assert.deepEqual(addresses(), [b.address]);
  clearWallets();
  assert.deepEqual(addresses(), []);
});

test('_exportForVault round-trips through addWallets', () => {
  clearWallets();
  const list = fresh(3);
  addWallets(list);
  const out = _exportForVault();
  assert.deepEqual(out, list);
  clearWallets();
  assert.deepEqual(addWallets(out), { added: 3, duplicates: 0 });
});
