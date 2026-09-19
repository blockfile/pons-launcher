import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Transaction } from 'ethers';
import * as store from './walletStore.js';
import { addWallets, addresses, removeWallet, clearWallets, signTx, subscribe, _exportForVault } from './walletStore.js';

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
    'subscribe',
  ]);
});

test('subscribe reports imports, re-imports, removals and clears by address only, and only when one happened', () => {
  clearWallets();
  const events = [];
  const off = subscribe((e) => events.push(e));
  const [a, b] = fresh(2);
  addWallets([a, b]);
  addWallets([{ privateKey: a.privateKey }]); // already here: nothing added, reported as a re-import
  removeWallet(a.address.toLowerCase());
  removeWallet(a.address); // already gone: no event
  clearWallets();
  clearWallets(); // empty: no event
  off();
  addWallets([a]); // unsubscribed
  assert.deepEqual(events, [
    { type: 'add', addresses: [a.address, b.address] },
    { type: 'duplicate', addresses: [a.address] },
    { type: 'remove', addresses: [a.address] },
    { type: 'clear', addresses: [b.address] },
  ]);
  const text = JSON.stringify(events).toLowerCase();
  for (const w of [a, b]) assert.ok(!text.includes(w.privateKey.slice(2).toLowerCase()), 'no event carries a key');
  clearWallets();
});

test("a listener that throws neither blocks the change nor the other listeners", () => {
  clearWallets();
  const seen = [];
  const off1 = subscribe(() => {
    throw new Error('listener bug');
  });
  const off2 = subscribe((e) => seen.push(e.type));
  const [a] = fresh(1);
  assert.deepEqual(addWallets([a]), { added: 1, duplicates: 0 });
  assert.deepEqual(addresses(), [a.address]);
  assert.deepEqual(seen, ['add']);
  off1();
  off2();
  clearWallets();
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

// The store signs with a SigningKey + Transaction rather than an ethers Wallet (a
// Wallet pulls the JSON keystore, HD wallet and wordlist into the page's first load).
// ECDSA here is deterministic (RFC 6979), so the SAME bytes as Wallet.signTransaction
// prove the two are one signer.
test('signTx produces byte-for-byte what ethers Wallet.signTransaction produces', async () => {
  clearWallets();
  const [a] = fresh(1);
  addWallets([a]);
  const txs = [
    { to: '0x0000000000000000000000000000000000000001', data: '0x095ea7b3', value: 0n, nonce: 0, gasLimit: 100000n, maxFeePerGas: 20000000n, maxPriorityFeePerGas: 0n, chainId: 4663, type: 2 },
    { to: '0x8876789976decbfcbbbe364623c63652db8c0904', data: '0x3593564c' + '00'.repeat(96), value: 0n, nonce: 41, gasLimit: 500000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, chainId: 4663, type: 2 },
  ];
  for (const tx of txs) {
    assert.equal(await signTx(a.address, tx), await new Wallet(a.privateKey).signTransaction(tx));
  }
});

test('signTx refuses a request whose from is another wallet, and accepts its own', async () => {
  clearWallets();
  const [a, b] = fresh(2);
  addWallets([a]);
  const base = { to: '0x0000000000000000000000000000000000000001', data: '0x', value: 0n, nonce: 1, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, chainId: 4663, type: 2 };
  await assert.rejects(signTx(a.address, { ...base, from: b.address }), /cannot be signed by/);
  assert.equal(Transaction.from(await signTx(a.address, { ...base, from: a.address.toLowerCase() })).from, a.address);
});

test('a key without its 0x prefix derives the same wallet', () => {
  clearWallets();
  const [a] = fresh(1);
  assert.deepEqual(addWallets([{ address: a.address, privateKey: a.privateKey.slice(2) }]), { added: 1, duplicates: 0 });
  assert.deepEqual(_exportForVault(), [a]);
  clearWallets();
});
