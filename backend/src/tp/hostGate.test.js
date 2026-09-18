'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { dappHostGate, normaliseHost, isDappPath, DEFAULT_DAPP_HOST } = require('./hostGate');

const DAPP = 'dapp.test.invalid';
const CONSOLE = 'console.test.invalid';

// A fake frontend build, laid out as `npm run build` lays it out: the console's index
// and its hashed bundle in dist/assets/, the dApp's index and its OWN bundle in
// dist/dapp/assets/ (vite.dapp.config.js assetsDir).
function makeDist({ withDapp = true } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-gate-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>CONSOLE</html>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("asset")');
  if (withDapp) {
    fs.mkdirSync(path.join(dist, 'dapp', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'dapp', 'index.html'), '<html>DAPP</html>');
    fs.writeFileSync(path.join(dist, 'dapp', 'assets', 'dapp-def456.js'), 'console.log("dapp asset")');
  }
  return dist;
}

// The same shape as server.js: gate → static → a public /api/tp → an "auth-gated" /api
// router standing in for the console → the SPA fallback.
function makeApp(dist) {
  const app = express();
  app.use(dappHostGate({ host: DAPP, dist }));
  app.use(express.static(dist));
  app.get('/api/tp/x', (req, res) => res.json({ tp: true }));
  app.get('/api/v4/wallets/backup', (req, res) => res.json({ keys: 'CONSOLE-SECRET' }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    return res.sendFile(path.join(dist, 'index.html'));
  });
  return app;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// http.request, not fetch: fetch treats Host as a forbidden header.
function request(server, { method = 'GET', path: p, host, headers = {} }) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { host, ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let server;
let dist;

test.before(async () => {
  dist = makeDist();
  server = await listen(makeApp(dist));
});

test.after(() => {
  server.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

test('the default dApp host is dapp.rhbond.xyz', () => {
  assert.equal(DEFAULT_DAPP_HOST, 'dapp.rhbond.xyz');
});

test('dApp host + a console key route → 404, the console handler never runs', async () => {
  const r = await request(server, { path: '/api/v4/wallets/backup', host: DAPP });
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
  assert.doesNotMatch(r.body, /CONSOLE-SECRET/);
});

test('dApp host + /api/health and a case-shifted /API path → 404', async () => {
  assert.equal((await request(server, { path: '/api/health', host: DAPP })).status, 404);
  const upper = await request(server, { path: '/API/v4/wallets/backup', host: DAPP });
  assert.equal(upper.status, 404);
  assert.doesNotMatch(upper.body, /CONSOLE-SECRET/);
});

test('dApp host + /api/tp/* → passes through to the tp router', async () => {
  const r = await request(server, { path: '/api/tp/x', host: DAPP });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { tp: true });
});

test('dApp host + a traversal or encoded path → 404', async () => {
  for (const p of ['/api/tp/../v4/wallets/backup', '/api/tp/%2e%2e/v4/wallets/backup', '/assets/..%2fdapp/index.html']) {
    const r = await request(server, { path: p, host: DAPP });
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /CONSOLE-SECRET/, p);
  }
});

test('dApp host + / and any page path → dist/dapp/index.html, never the console', async () => {
  for (const p of ['/', '/token/0xabc', '/index.html']) {
    const r = await request(server, { path: p, host: DAPP });
    assert.equal(r.status, 200, p);
    assert.equal(r.body, '<html>DAPP</html>', p);
    assert.equal(r.headers['cache-control'], 'no-cache', p);
  }
});

test("dApp host + /dapp/assets/* → the dApp's own static file; a missing one → 404 JSON", async () => {
  const ok = await request(server, { path: '/dapp/assets/dapp-def456.js', host: DAPP });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'console.log("dapp asset")');
  const missing = await request(server, { path: '/dapp/assets/nope.js', host: DAPP });
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'not found' });
});

// The console PAGE is its HTML and the bundle that HTML loads from dist/assets/. On
// the public, password-less dApp host neither may be served: the console's code sits
// behind basic auth on its own host.
test('dApp host + /assets/* (the console page bundle) → 404 JSON, never the console code', async () => {
  for (const p of ['/assets/app-abc123.js', '/assets/nope.js', '/ASSETS/app-abc123.js', '/assets/']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await request(server, { method, path: p, host: DAPP });
      assert.equal(r.status, 404, `${method} ${p}`);
      assert.doesNotMatch(r.body, /asset|CONSOLE|DAPP/, `${method} ${p}`);
    }
  }
});

test('dApp host + a /dapp path that is not an asset → the dApp page (it is a page path), never a file listing', async () => {
  for (const p of ['/dapp/', '/dapp/index.html', '/dapp/assets/']) {
    const r = await request(server, { path: p, host: DAPP });
    if (p === '/dapp/assets/') {
      assert.equal(r.status, 404, p);
    } else {
      assert.equal(r.status, 200, p);
      assert.equal(r.body, '<html>DAPP</html>', p);
    }
  }
});

test('dApp host + a non-GET page request → 404', async () => {
  const r = await request(server, { method: 'POST', path: '/', host: DAPP });
  assert.equal(r.status, 404);
});

test('the host match ignores port, case and a trailing dot', async () => {
  for (const host of [`${DAPP}:443`, DAPP.toUpperCase(), `${DAPP}.`]) {
    const r = await request(server, { path: '/api/v4/wallets/backup', host });
    assert.equal(r.status, 404, host);
  }
  assert.equal(normaliseHost('[::1]:3100'), '[::1]');
  assert.equal(normaliseHost('Dapp.RHBond.xyz.'), 'dapp.rhbond.xyz');
});

test('X-Forwarded-Host cannot walk around the gate', async () => {
  const r = await request(server, {
    path: '/api/v4/wallets/backup',
    host: DAPP,
    headers: { 'x-forwarded-host': CONSOLE },
  });
  assert.equal(r.status, 404);
});

test('any other host is untouched — the console is unchanged', async () => {
  const keys = await request(server, { path: '/api/v4/wallets/backup', host: CONSOLE });
  assert.equal(keys.status, 200);
  assert.match(keys.body, /CONSOLE-SECRET/);
  const home = await request(server, { path: '/', host: CONSOLE });
  assert.equal(home.body, '<html>CONSOLE</html>');
  const health = await request(server, { path: '/api/health', host: CONSOLE });
  assert.equal(health.status, 200);
  const asset = await request(server, { path: '/assets/app-abc123.js', host: CONSOLE });
  assert.equal(asset.body, 'console.log("asset")');
  // and the dApp's bundle is not on the console origin either (it is under /dapp)
  const dappAsset = await request(server, { path: '/dapp/assets/dapp-def456.js', host: CONSOLE });
  assert.equal(dappAsset.status, 404);
});

// Without the gate, express.static serves dist/dapp/index.html for every one of these
// on the console host — the key-holding page on the console's origin.
const DAPP_SPELLINGS = [
  '/dapp',
  '/dapp/',
  '/dapp/index.html',
  '/dapp/index.html?x=1',
  '/DAPP/index.html',
  '/%64app/index.html',
  '/dapp%2Findex.html',
  '//dapp/index.html',
  '/./dapp/index.html',
  '/assets/../dapp/index.html',
  '/dapp./index.html',
];

test('console host + /dapp or /dapp/* → 404 JSON in every spelling: the dApp page never runs on the console origin', async () => {
  for (const p of DAPP_SPELLINGS) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const r = await request(server, { method, path: p, host: CONSOLE });
      assert.equal(r.status, 404, `${method} ${p}`);
      if (method !== 'HEAD') assert.deepEqual(JSON.parse(r.body), { error: 'not found' }, `${method} ${p}`);
      assert.doesNotMatch(r.body, /DAPP/, `${method} ${p}`);
    }
  }
});

test('console host + a path that merely starts with "dapp" is the console as before', async () => {
  for (const p of ['/dappled', '/dapp-notes', '/x/dapp/index.html']) {
    const r = await request(server, { path: p, host: CONSOLE });
    assert.equal(r.status, 200, p);
    assert.equal(r.body, '<html>CONSOLE</html>', p);
  }
});

test('isDappPath: what reaches dist/dapp, and what does not', () => {
  for (const p of DAPP_SPELLINGS) assert.equal(isDappPath(p.split('?')[0]), true, p);
  assert.equal(isDappPath('/dapp::$INDEX_ALLOCATION/index.html'), true);
  assert.equal(isDappPath('/dapp%zz'), true, 'undecodable, judged raw');
  for (const p of ['/', '', '/dappled', '/dapp-notes', '/api/tp/x', '/assets/dapp-abc.js', '/x/dapp/']) {
    assert.equal(isDappPath(p), false, p);
  }
});

test('dApp host with no dApp build → 404 JSON naming the build step', async () => {
  const bare = makeDist({ withDapp: false });
  const s = await listen(makeApp(bare));
  try {
    const r = await request(s, { path: '/', host: DAPP });
    assert.equal(r.status, 404);
    assert.match(JSON.parse(r.body).error, /npm run build/);
  } finally {
    s.close();
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('dappHostGate needs a dist directory', () => {
  assert.throws(() => dappHostGate({ host: DAPP }), /dist/);
});

// nginx sets these at server level, but a later add_header inside a location silently
// drops that whole set. The gate's copy survives it; duplicate identical headers are
// harmless (two CSPs intersect).
test('the dApp page and its assets carry the CSP and anti-framing headers themselves', async () => {
  const { DAPP_CSP } = require('./hostGate');
  assert.match(DAPP_CSP, /script-src 'self'/);
  assert.match(DAPP_CSP, /frame-ancestors 'none'/);
  for (const p of ['/', '/token/0xabc', '/dapp/assets/dapp-def456.js']) {
    const r = await request(server, { path: p, host: DAPP });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-security-policy'], DAPP_CSP, p);
    assert.equal(r.headers['x-frame-options'], 'DENY', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
  }
  // the console host is untouched
  const c = await request(server, { path: '/', host: CONSOLE });
  assert.equal(c.headers['content-security-policy'], undefined);
});
