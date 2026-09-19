// The /api/tp/account contract, from the page's side. backend/src/tp/accountContract.json
// is the ONE copy both sides test: backend/src/tp/account.test.js walks its scenario
// through the real router; this file walks the same scenario through the page's
// fake server (fakeServer.js, which every account test here leans on) and checks
// that the real client (api.js) calls exactly the routes and fields it names.
// A route or a field renamed on one side only fails a test on the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import * as api from '../api.js';
import { checkChallenge } from './messages.js';
import { createFakeAccountServer } from './fakeServer.js';

// Test-only reach into the backend, as chain/constants.test.js does.
const require = createRequire(import.meta.url);
const CONTRACT = require('../../../../backend/src/tp/accountContract.json');

const ORIGIN = 'http://127.0.0.1:3199';
const b64 = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('base64');
const hex = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('hex');

async function bodyOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

test('the fake server answers the shared contract, step by step (accountContract.json)', async () => {
  const server = createFakeAccountServer({ origin: ORIGIN });
  const w = Wallet.createRandom();
  const keyId = `0x${hex(16)}`;
  let challenge = null;
  for (const [i, step] of CONTRACT.scenario.entries()) {
    const route = CONTRACT.routes[step.route];
    const where = `step ${i + 1}: ${route.method} ${route.path}`;
    let body;
    if (step.route === 'nonce') body = { address: w.address.toLowerCase() };
    else if (step.route === 'login') body = { nonce: challenge.nonce, signature: (await w.signMessage(challenge.message)).toLowerCase() };
    else if (step.route === 'vaultPut') body = { baseRev: step.baseRev, kv: 1, keyId, iv: b64(12), ct: b64(64) };
    else if (step.route === 'vaultDelete') body = { baseRev: step.baseRev };
    else if (route.body) body = {};
    if (body !== undefined) assert.deepEqual(Object.keys(body).sort(), route.body, `${where}: the body the contract names`);
    const res = await server.fetch(CONTRACT.base + route.path, { method: route.method, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await bodyOf(res);
    assert.equal(res.status, step.status, `${where}: ${JSON.stringify(j)}`);
    if (step.code) {
      assert.equal(j.code, step.code, where);
      assert.deepEqual(Object.keys(j).sort(), step.code === 'conflict' ? CONTRACT.conflictKeys : CONTRACT.refusalKeys, where);
      if (step.rev !== undefined) assert.equal(j.rev, step.rev, where);
      continue;
    }
    if (route.answer === null) {
      assert.equal(j, null, `${where}: no body`);
      continue;
    }
    assert.deepEqual(Object.keys(j).sort(), route.answer, `${where}: the answer's fields`);
    if (step.rev !== undefined) assert.equal(j.rev, step.rev, where);
    if (step.vault === null) assert.equal(j.vault, null, where);
    if (step.vault === 'meta') assert.deepEqual(Object.keys(j.vault).sort(), CONTRACT.vaultMeta, where);
    if (step.vault === 'record') assert.deepEqual(Object.keys(j.vault).sort(), CONTRACT.vaultRecord, where);
    if (step.route === 'nonce') challenge = j;
  }
});

test('api.js calls exactly the contract routes with exactly its fields, and reads its answers', async () => {
  const server = createFakeAccountServer({ origin: ORIGIN });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ method: init.method, path: url, body: init.body === undefined ? null : Object.keys(JSON.parse(init.body)).sort() });
    return server.fetch(url, init);
  };
  const o = { fetch };
  const w = Wallet.createRandom();
  assert.equal(await api.getAccountSession(o), null, 'no session yet: signed out, not an error');
  const ch = await api.postChallenge(w.address, o);
  assert.deepEqual(Object.keys(ch).sort(), CONTRACT.routes.nonce.answer);
  const message = checkChallenge(ch, { address: w.address, origin: ORIGIN });
  const signature = await w.signMessage(message);
  assert.equal((await api.postLogin({ nonce: ch.nonce, signature, message, address: w.address }, o)).address, w.address);
  assert.deepEqual(await api.getAccountSession(o), { address: w.address, expiresAt: server.session.expiresAt, vault: null });
  assert.equal(await api.getVault(o), null);
  const keyId = `0x${hex(16)}`;
  assert.equal((await api.putVault({ baseRev: 0, kv: 1, keyId, iv: b64(12), ct: b64(64) }, o)).rev, 1);
  assert.deepEqual(await api.deleteVault(1, o), { deleted: true });
  assert.equal(await api.getAccountSession(o), null, 'a delete ends the session (backend: every session of the address)');
  assert.deepEqual(await api.postLogout(o), {});
  const want = ['me', 'nonce', 'login', 'me', 'vaultGet', 'vaultPut', 'vaultDelete', 'me', 'logout'].map((name) => {
    const r = CONTRACT.routes[name];
    return { method: r.method, path: CONTRACT.base + r.path, body: r.body };
  });
  assert.deepEqual(calls, want);
});
