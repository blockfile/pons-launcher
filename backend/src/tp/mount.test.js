'use strict';

// server.js wiring: the host gate runs before static files and every router, and the
// public tp router is mounted before identify (the console's auth). Tested against the
// REAL app exported by server.js, in multi-user mode so identify visibly refuses a
// keyless request — which is what proves /api/tp never passes through it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// config.js and the stores compute their paths at first require: point every one of
// them at a temp dir BEFORE server.js is loaded (routes/v8.test.js does the same).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-mount-'));
process.env.KEYSTORE_PATH = path.join(tmp, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-tp-mount';
process.env.HISTORY_PATH = path.join(tmp, 'launches.json');
process.env.USERS_PATH = path.join(tmp, 'users.json');
process.env.V4_STORE_PATH = path.join(tmp, 'v4.json');
process.env.DAPP_HOST = 'dapp.mount.test';
process.env.TP_ACCOUNTS_DIR = path.join(tmp, 'tp-accounts');
fs.writeFileSync(
  process.env.USERS_PATH,
  JSON.stringify({
    version: 1,
    users: [
      {
        id: 'alice',
        name: 'alice',
        keyHash: crypto.createHash('sha256').update(crypto.randomBytes(32).toString('hex')).digest('hex'),
        createdAt: new Date().toISOString(),
      },
    ],
  })
);

const app = require('../../server');

const SERVER_JS = path.resolve(__dirname, '..', '..', 'server.js');
const DIST = path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');
const DAPP = 'dapp.mount.test';

let server;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function get(p, host) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server.js: the gate precedes static, and /api/tp precedes identify', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const gate = src.indexOf('app.use(dappHostGate(');
  const statics = src.indexOf('app.use(express.static(dist))');
  const tp = src.indexOf("app.use('/api/tp', tpRoutes)");
  const identify = src.indexOf("app.use('/api', identify)");
  for (const [name, at] of Object.entries({ gate, statics, tp, identify })) assert.ok(at > 0, `${name} found`);
  assert.ok(gate < statics, 'dappHostGate is mounted before express.static');
  assert.ok(tp < identify, "/api/tp is mounted before app.use('/api', identify)");
});

test('console host: identify is live (a keyless console request is refused) …', async () => {
  const r = await get('/api/v4/wallets/backup', '127.0.0.1');
  assert.equal(r.status, 401);
});

test('… but /api/tp never reaches it: a keyless /api/tp request is answered by the tp router', async () => {
  const r = await get('/api/tp/nope', '127.0.0.1');
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
});

test('dApp host: console routes answer 404 before identify or any router runs', async () => {
  for (const p of ['/api/v4/wallets/backup', '/api/wallets', '/api/health']) {
    const r = await get(p, DAPP);
    assert.equal(r.status, 404, p);
    assert.deepEqual(JSON.parse(r.body), { error: 'not found' }, p);
  }
});

test('the account API: 401 no_session on the dApp host, 404 on the console host (host gate)', async () => {
  const onDapp = await get('/api/tp/account/me', DAPP);
  assert.equal(onDapp.status, 401);
  assert.equal(JSON.parse(onDapp.body).code, 'no_session');
  const onConsole = await get('/api/tp/account/me', '127.0.0.1');
  assert.equal(onConsole.status, 404);
  assert.deepEqual(JSON.parse(onConsole.body), { error: 'not found' });
  assert.ok(!fs.existsSync(path.join(tmp, 'tp-accounts')), 'a request without a cookie never touches the disk');
});

test('console host: /dapp and /dapp/* answer 404 — the key-holding page never runs on the console origin', async () => {
  for (const p of ['/dapp', '/dapp/', '/dapp/index.html', '/DAPP/', '/%64app/index.html']) {
    const r = await get(p, '127.0.0.1');
    assert.equal(r.status, 404, p);
    assert.deepEqual(JSON.parse(r.body), { error: 'not found' }, p);
  }
});

test('dApp host: / is the dApp page (or a 404 naming the build), never the console', async () => {
  const r = await get('/', DAPP);
  const dappIndex = path.join(DIST, 'dapp', 'index.html');
  if (fs.existsSync(dappIndex)) {
    assert.equal(r.status, 200);
    assert.equal(r.body, fs.readFileSync(dappIndex, 'utf8'));
  } else {
    assert.equal(r.status, 404);
    assert.match(JSON.parse(r.body).error, /npm run build/);
  }
  const consoleIndex = path.join(DIST, 'index.html');
  if (fs.existsSync(consoleIndex)) assert.notEqual(r.body, fs.readFileSync(consoleIndex, 'utf8'));
});
