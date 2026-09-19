// Offline tests for scripts/lib/tpSmokeAccount.mjs: the fork smoke's account
// round trip, run here against the page's own fake account server
// (frontend/src/dapp/account/fakeServer.js). Every wallet is Wallet.createRandom(),
// made in the test; nothing prints a key, a signature or an address.
//
// Not in `npm test`'s glob (src/** only): run it by path,
//   cd backend && node --test scripts/lib/tpSmokeAccount.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { accountRoundTrip, readAccountCopy, walletProvider } from './tpSmokeAccount.mjs';

const DAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'src', 'dapp');
const load = (rel) => import(pathToFileURL(path.join(DAPP, rel)).href);
const ORIGIN = 'http://127.0.0.1:3199';
const TOKEN = '0x' + '7'.repeat(40);

function throwaway(n) {
  return Array.from({ length: n }, () => {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  });
}

test('walletProvider answers accounts and personal_sign for its own account only, counting signatures', async () => {
  const owner = Wallet.createRandom();
  const { provider, counts } = walletProvider(owner);
  assert.deepEqual(await provider.request({ method: 'eth_requestAccounts' }), [owner.address]);
  const hex = '0x' + Buffer.from('hello', 'utf8').toString('hex');
  const sig = await provider.request({ method: 'personal_sign', params: [hex, owner.address.toLowerCase()] });
  assert.equal(sig, await owner.signMessage('hello'));
  assert.equal(counts.signatures, 1);
  await assert.rejects(provider.request({ method: 'personal_sign', params: [hex, Wallet.createRandom().address] }), (e) => e.code === 4100);
  await assert.rejects(provider.request({ method: 'eth_sendTransaction', params: [] }), (e) => e.code === 4200);
  assert.equal(counts.signatures, 1);
});

test('the round trip passes against the page fake server: 3 then 2 signatures, every wallet and position back, nothing in the clear', async () => {
  const { createFakeAccountServer } = await load('account/fakeServer.js');
  const server = createFakeAccountServer({ origin: ORIGIN });
  const owner = Wallet.createRandom();
  const wallets = throwaway(3);
  const r = await accountRoundTrip({ load, transport: () => server.fetch, owner, wallets, token: TOKEN, origin: ORIGIN });
  assert.equal(r.error, '');
  assert.deepEqual(
    { ...r, rev: r.rev >= 1, requests: r.requests > 0 },
    {
      error: '',
      signedIn1: true,
      unlocked1: true,
      signatures1: 3,
      saved: true,
      rev: true,
      signedIn2: true,
      unlocked2: true,
      signatures2: 2,
      sameKey: true,
      walletsBack: true,
      positionsBack: true,
      bodiesClean: true,
      requests: true,
    }
  );
  const stored = JSON.stringify([...server.vaults.values()]);
  assert.equal(wallets.filter((w) => stored.toLowerCase().includes(w.privateKey.slice(2).toLowerCase())).length, 0, 'no key in the stored copy');
  assert.equal(wallets.filter((w) => stored.toLowerCase().includes(w.address.slice(2).toLowerCase())).length, 0, 'no address in the stored copy');

  // The owner reads the copy back on a third device: the same wallets, and the positions.
  const copy = await readAccountCopy({ load, transport: () => server.fetch, owner, origin: ORIGIN, expect: wallets });
  assert.equal(copy.error, '');
  assert.equal(copy.sameWallets, true);
  assert.deepEqual(Object.keys(copy.positions), [TOKEN]);
  assert.deepEqual(Object.keys(copy.positions[TOKEN]).sort(), wallets.map((w) => w.address.toLowerCase()).sort());
});

test('a server that loses the copy fails the round trip instead of passing it', async () => {
  const { createFakeAccountServer } = await load('account/fakeServer.js');
  const server = createFakeAccountServer({ origin: ORIGIN });
  const forgetful = () => async (url, init = {}) => {
    const res = await server.fetch(url, init);
    if (init.method === 'PUT') server.vaults.clear();
    return res;
  };
  const r = await accountRoundTrip({ load, transport: forgetful, owner: Wallet.createRandom(), wallets: throwaway(2), token: TOKEN, origin: ORIGIN });
  assert.equal(r.saved, true, 'the PUT itself was answered');
  assert.equal(r.walletsBack, false);
  assert.equal(r.positionsBack, false);
  assert.equal(r.signatures2, 3, 'the second device found no copy: a first unlock, signed twice');
});

test('a page origin the server does not name stops the round trip at sign-in, with the reason', async () => {
  const { createFakeAccountServer } = await load('account/fakeServer.js');
  const server = createFakeAccountServer({ origin: 'https://dapp.rhbond.xyz' });
  const r = await accountRoundTrip({ load, transport: () => server.fetch, owner: Wallet.createRandom(), wallets: throwaway(1), token: TOKEN, origin: ORIGIN });
  assert.equal(r.signedIn1, false);
  assert.equal(r.signatures1, 0, 'nothing was signed');
  assert.notEqual(r.error, '');
});
