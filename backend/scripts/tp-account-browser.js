#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THE dAPP ACCOUNT, A REAL BROWSER AGAINST THE REAL BACKEND (spec Addendum v2 A).
//
//   cd frontend && npm run build       # the server serves frontend/dist/dapp
//   cd backend  && node scripts/tp-account-browser.js [--keep]
//
// No chain and no fork: the account API reads none, so every RPC setting points at
// a closed local port. The page is the BUILT dApp, served by the REAL backend
// (server.js: the host gate, the account router, the vault store) with
// DAPP_HOST=127.0.0.1, TP_SIWE_ORIGIN=http://127.0.0.1:3199 and TP_ACCOUNTS_DIR in
// this run's scratch dir. A real Chromium drives it through the Playwright MCP
// (plan Task 41, Steps 8-15): connect, sign in, unlock twice, import, reload,
// lock, reload, unlock, a second device, disconnect, and a wallet that signs
// differently each time.
//
// Between the browser and the backend sits a recording TAP on 127.0.0.1:3199,
// the page's origin. It forwards every byte both ways unchanged and keeps, in
// memory only, each /api request: its method and path, the headers the BROWSER
// set (Origin, Sec-Fetch-Site, Referer, Content-Type, Cookie), its body, and the
// server's status, Set-Cookie lines and (account routes) answer body.
//
// The page's wallet is a throwaway owner key living in THIS process behind the
// signer URL (HOLD signer). Playwright's Node side forwards the page's EIP-1193
// calls to it; the page cannot reach it (its CSP allows connect-src 'self'). It
// answers eth_requestAccounts, eth_accounts and personal_sign, and counts each
// signature as a sign-in, an unlock or other. POST /owner {"hedged": true} swaps
// in a second throwaway owner that signs the same message differently every time
// (a random ECDSA nonce, as an MPC or smart wallet would).
//
// Create the STOP file it names to finish. It then checks:
//   0. every page load carried the production CSP and Referrer-Policy: no-referrer
//      (the conditions the browser's Origin and cookie behaviour are judged under);
//   1. the wallets were asked for exactly the signatures the steps need
//      (owner 1: 2 sign-ins + 4 unlocks; owner 2: 1 sign-in + 2 unlocks), and
//      every sign-in message named this page (its domain and URI);
//   2. every account request as the browser sent it (scripts/lib/tpWireAudit.js):
//      Sec-Fetch-Site same-origin, no Referer, Origin == TP_SIWE_ORIGIN and JSON on
//      every write, the __Host- session cookie set right and sent back, the exact
//      bodies, and no status outside the contract;
//   3. no /api request body holds a bundle key or an unlock signature (hex, r, s,
//      r || s, base64), no account body names a bundle wallet, and the only
//      signatures on the wire are the 3 sign-in signatures, each once;
//   4. on the server's disk: owner 1's list and no list for owner 2; no file under
//      TP_ACCOUNTS_DIR and no backend log line holds a bundle key, a bundle address
//      or an unlock signature; the stored keyId is the one Node derives from owner
//      1's unlock signature with the page's own account/unlockKey.js; the stored
//      ciphertext opens (account/envelope.js) to exactly the 3 imported wallets; and
//      the file holds byte for byte the last save the browser sent.
// Then it stops everything and removes the scratch dir (--keep keeps the logs;
// the key file is removed either way).
//
// Output: booleans, counts, routes and status codes. Never a key, a signature, a
// cookie value or a wallet address.
//
// Env (optional): TP_BROWSER_PORT (the page, default 3199), TP_BROWSER_BACKEND_PORT
// (the backend behind the tap, default 3197).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(REPO, 'backend');
const FRONTEND = path.join(REPO, 'frontend');
const DAPP_HTML = path.join(FRONTEND, 'dist', 'dapp', 'index.html');

// Scratch FIRST, and move into it before anything can load dotenv (the backend's
// config.js reads .env from the current directory): backend/.env never reaches
// this run or the server it starts.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-account-browser-'));
const KEYS_FILE = path.join(SCRATCH, 'ui-keys.txt');
const STOP_FILE = path.join(SCRATCH, 'STOP');
const ACCOUNTS_DIR = path.join(SCRATCH, 'tp-accounts');
const slash = (p) => p.split(path.sep).join('/');
process.chdir(SCRATCH);

const { Wallet, getBytes, hashMessage, toUtf8String } = require('ethers');
// backend/package.json declares @noble/curves at the version ethers pins: the hedged
// owner needs its extraEntropy, and ethers' own SigningKey.sign is deterministic
// RFC6979, so it cannot stand in. Without the declaration a lockfile refresh onto
// curves 2.x would kill this script at require time with npm test still green.
const { secp256k1 } = require('@noble/curves/secp256k1');
const {
  isAccount,
  auditAccountWire,
  secretNeedles,
  addressNeedle,
  countNeedles,
  hexRuns,
  classifyMessage,
  loginNamesOrigin,
} = require('./lib/tpWireAudit');

const KEEP = process.argv.slice(2).includes('--keep');
const APP_PORT = Number(process.env.TP_BROWSER_PORT) || 3199;
const BACKEND_PORT = Number(process.env.TP_BROWSER_BACKEND_PORT) || 3197;
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
// Port 9 (discard): nothing listens there on a dev box. The account API reads no
// chain; anything that tries fails fast instead of reaching a real RPC.
const DEAD_RPC = 'http://127.0.0.1:9';
const BODY_CAP = 2 * 1024 * 1024;
const HOLD_LIMIT_MS = 60 * 60 * 1000;
// The page's CSP (backend/src/tp/hostGate.js DAPP_CSP = deploy/nginx-rhbond.conf).
const PROD_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// What the Playwright steps ask each owner's wallet for (plan Task 41):
//   owner 1: Step 9 sign-in + unlock twice (the first save), Step 11 one unlock
//            after Lock, Step 12 a second device: sign-in + one unlock. Reloads: none.
//   owner 2: Step 14 sign-in + unlock twice, refused (the two differ).
const EXPECT = [
  { login: 2, unlock: 4, other: 0 },
  { login: 1, unlock: 2, other: 0 },
];

let server = null;
let tap = null;
let signer = null;
let interrupted = false;
let passed = 0;
const logFds = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lc = (a) => String(a).toLowerCase();

function check(cond, what) {
  if (!cond) throw new Error(what);
  passed += 1;
  console.log(`ok   ${what}`);
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function openLog(name) {
  const fd = fs.openSync(path.join(SCRATCH, name), 'a');
  logFds.push(fd);
  return fd;
}

// Only what the OS needs to run node; everything the backend reads is set below.
function osEnvOnly() {
  const keep = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG']);
  const out = {};
  for (const key of Object.keys(process.env)) if (keep.has(key.toUpperCase())) out[key] = process.env[key];
  return out;
}

function startServer() {
  const log = openLog('server.log');
  const env = {
    ...osEnvOnly(),
    PORT: String(BACKEND_PORT),
    HOST: '127.0.0.1',
    DRY_RUN: 'true',
    RPC_URL: DEAD_RPC,
    CHAIN_ID: '4663',
    KEYSTORE_PATH: path.join(SCRATCH, 'wallets.keystore.json'),
    HISTORY_PATH: path.join(SCRATCH, 'launches.json'),
    USERS_PATH: path.join(SCRATCH, 'users.json'),
    KEYSTORE_PASSPHRASE: crypto.randomBytes(24).toString('hex'),
    API_KEY: crypto.randomBytes(24).toString('hex'),
    // http://127.0.0.1:<APP_PORT> IS the dApp (the host gate drops the port).
    DAPP_HOST: '127.0.0.1',
    // The account (Part 01): its files in this scratch dir, never in backend/data,
    // and the sign-in message and the CSRF guard name this page's origin exactly.
    TP_ACCOUNTS_DIR: ACCOUNTS_DIR,
    TP_SIWE_ORIGIN: ORIGIN,
    TP_SEQUENCER_URL: '',
    TP_READ_RPC_URL: DEAD_RPC,
    TP_CHART_RPC_URL: DEAD_RPC,
    TP_CHART_WSS_URL: '',
    RELAY_API_KEY: '',
    ADMIN_USERS: '',
  };
  return spawn(process.execPath, [path.join(BACKEND, 'server.js')], { cwd: SCRATCH, env, stdio: ['ignore', log, log], windowsHide: true });
}

// Up = the account router answers "no session" (GET /me) on the dApp host.
async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if (server.exitCode !== null) throw new Error('the backend exited during start-up (rerun with --keep and read server.log)');
    try {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/tp/account/me`);
      if (res.status === 401) return;
    } catch (_err) {
      // not listening yet
    }
    await sleep(300);
  }
  throw new Error('the backend did not answer GET /api/tp/account/me with 401 within 60 s');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([done, sleep(5000)]);
}

// ── the tap ──────────────────────────────────────────────────────────────────

const PICK = ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'referer', 'content-type', 'cookie'];

function startTap() {
  const entries = [];
  const pages = []; // the page's own document loads: {status, csp, referrerPolicy}
  const srv = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_CAP) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let entry = null;
      if (req.url.startsWith('/api/')) {
        const headers = {};
        for (const name of PICK) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
        entry = { seq: entries.length + 1, method: req.method, path: req.url, headers, body: body.toString('utf8'), status: 0, setCookies: [], responseBody: '' };
        entries.push(entry);
      }
      const isPage = req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/dapp/assets/');
      const up = http.request({ host: '127.0.0.1', port: BACKEND_PORT, method: req.method, path: req.url, headers: req.headers }, (answer) => {
        // A reload revalidates the page: 304, with the headers and no body.
        if (isPage && (answer.statusCode === 304 || /^text[/]html/i.test(String(answer.headers['content-type'] || '')))) {
          pages.push({ status: answer.statusCode, csp: answer.headers['content-security-policy'], referrerPolicy: answer.headers['referrer-policy'] });
        }
        if (entry) {
          entry.status = answer.statusCode;
          const sc = answer.headers['set-cookie'];
          entry.setCookies = Array.isArray(sc) ? sc.slice() : sc ? [sc] : [];
          if (isAccount(entry)) {
            const got = [];
            answer.on('data', (chunk) => got.push(chunk));
            answer.on('end', () => {
              entry.responseBody = Buffer.concat(got).toString('utf8');
            });
          }
        }
        res.writeHead(answer.statusCode, answer.rawHeaders);
        answer.pipe(res);
      });
      up.on('error', () => {
        if (entry) entry.status = 502;
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end();
      });
      up.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(APP_PORT, '127.0.0.1', () => resolve({ srv, entries, pages }));
  });
}

const savesSeen = () =>
  tap ? tap.entries.filter((e) => e.method === 'PUT' && e.path.split('?')[0] === '/api/tp/account/vault' && e.status === 200).length : 0;

// ── the page's wallet ────────────────────────────────────────────────────────

function newOwner(hedged) {
  return { wallet: Wallet.createRandom(), hedged, counts: { login: 0, unlock: 0, other: 0 }, loginSigs: [], unlockSigs: [], foreignLogins: 0 };
}

// A valid signature over the EIP-191 digest with a RANDOM nonce: every call differs.
function hedgedSign(owner, bytes) {
  const sig = secp256k1.sign(getBytes(hashMessage(bytes)), getBytes(owner.wallet.privateKey), { lowS: true, extraEntropy: true });
  const hex = (n) => n.toString(16).padStart(64, '0');
  return `0x${hex(sig.r)}${hex(sig.s)}${(27 + sig.recovery).toString(16)}`;
}

function startSigner() {
  const owners = [newOwner(false)];
  const current = () => owners[owners.length - 1];
  const reply = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  async function rpc(msg) {
    const method = msg && msg.method;
    const params = Array.isArray(msg && msg.params) ? msg.params : [];
    const owner = current();
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return { result: [owner.wallet.address] };
    if (method === 'eth_chainId') return { result: '0x1237' };
    if (method !== 'personal_sign') return { error: { code: 4200, message: 'unsupported method' } };
    if (lc(params[1]) !== lc(owner.wallet.address)) return { error: { code: 4100, message: 'not this wallet' } };
    let bytes;
    let text;
    try {
      bytes = getBytes(params[0]);
      text = toUtf8String(bytes);
    } catch (_err) {
      return { error: { code: -32602, message: 'personal_sign wants a hex-encoded UTF-8 message' } };
    }
    const kind = classifyMessage(text);
    const signature = owner.hedged ? hedgedSign(owner, bytes) : await owner.wallet.signMessage(bytes);
    owner.counts[kind] += 1;
    if (kind === 'login') {
      owner.loginSigs.push(signature);
      if (!loginNamesOrigin(text, ORIGIN)) owner.foreignLogins += 1;
    }
    if (kind === 'unlock') owner.unlockSigs.push(signature);
    return { result: signature };
  }
  const srv = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/status') {
        const c = current().counts;
        return reply(res, 200, { owners: owners.length, hedged: current().hedged, login: c.login, unlock: c.unlock, other: c.other, saves: savesSeen() });
      }
      let msg = null;
      try {
        msg = body ? JSON.parse(body) : {};
      } catch (_err) {
        return reply(res, 400, { error: { code: -32700, message: 'not JSON' } });
      }
      if (req.method === 'POST' && req.url === '/owner') {
        owners.push(newOwner(msg.hedged === true));
        return reply(res, 200, { owners: owners.length, hedged: current().hedged });
      }
      if (req.method === 'POST' && req.url === '/rpc') return reply(res, 200, await rpc(msg));
      return reply(res, 404, { error: { code: 4200, message: 'not found' } });
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, owners, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function closeServer(s) {
  if (!s) return;
  if (typeof s.srv.closeAllConnections === 'function') s.srv.closeAllConnections();
  await new Promise((resolve) => s.srv.close(() => resolve()));
}

// ── the checks ───────────────────────────────────────────────────────────────

function filesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const loadDapp = (rel) => import(pathToFileURL(path.join(FRONTEND, 'src', 'dapp', rel)).href);

async function verify(bundle) {
  const owners = signer.owners;
  // The wire first: its route table is what explains a failure further down.
  const { problems, stats } = auditAccountWire(tap.entries, { origin: ORIGIN });
  for (const [route, n] of Object.entries(stats.byRoute).sort()) console.log(`info wire ${route} x${n}`);
  for (const p of problems) console.log(`bad  ${p}`);
  const fresh = tap.pages.filter((pg) => pg.status === 200).length;
  check(
    fresh >= 3 && tap.pages.length >= 6 && tap.pages.every((pg) => pg.csp === PROD_CSP && pg.referrerPolicy === 'no-referrer'),
    `page: all ${tap.pages.length} page loads (${fresh} fresh, the rest reloads; at least 3 + 3) carried the production CSP and Referrer-Policy: no-referrer`
  );
  check(owners.length === EXPECT.length, `the run used ${EXPECT.length} throwaway owners: the deterministic one, then the hedged one (got ${owners.length})`);
  owners.forEach((o, i) => {
    const want = EXPECT[i];
    check(
      o.counts.login === want.login && o.counts.unlock === want.unlock && o.counts.other === want.other,
      `owner ${i + 1}: the page asked the wallet for ${want.login} sign-in(s) and ${want.unlock} unlock(s), nothing else ` +
        `(got ${o.counts.login} + ${o.counts.unlock} + ${o.counts.other} other)`
    );
    check(o.foreignLogins === 0, `owner ${i + 1}: every sign-in message named this page (domain ${new URL(ORIGIN).host}, URI ${ORIGIN})`);
  });

  check(
    problems.length === 0,
    `wire: all ${stats.account} account requests as the browser sent them — Sec-Fetch-Site same-origin, no Referer, ` +
      `Origin ${ORIGIN} and JSON on every write, the __Host- cookie set right and sent back, exact bodies, statuses in the contract` +
      (problems.length ? ` — ${problems.length} problem(s) above` : '')
  );
  check(stats.logins === 3, `wire: 3 sign-ins answered 200 (owner 1 on two devices, owner 2) (got ${stats.logins})`);
  check(stats.logouts === 1, `wire: 1 sign-out, the Disconnect (got ${stats.logouts})`);
  check(stats.puts >= 2, `wire: the browser saved the list at least twice, first empty then with the import (got ${stats.puts})`);
  check(stats.probes >= 2, `wire: fresh browsers asked GET /me and got 401 without a cookie (${stats.probes} time(s))`);
  if (stats.conflicts) console.log(`info wire: ${stats.conflicts} save(s) raced another device and were merged (409 conflict)`);

  const texts = tap.entries.map((e) => e.body);
  const accountTexts = tap.entries.filter(isAccount).map((e) => e.body);
  const keyNeedles = bundle.flatMap((w) => secretNeedles(w.privateKey));
  const unlockNeedles = owners.flatMap((o) => o.unlockSigs.flatMap((s) => secretNeedles(s)));
  const addrNeedles = bundle.map((w) => addressNeedle(w.address));
  check(owners.every((o) => o.unlockSigs.length > 0) && keyNeedles.length > 0, 'the scan has every bundle key and every unlock signature to look for');
  check(countNeedles(texts, keyNeedles) === 0, `bodies: none of the ${texts.length} /api request bodies holds a bundle key (hex, any case, or base64)`);
  check(countNeedles(texts, unlockNeedles) === 0, 'bodies: none holds an unlock signature, its r, its s or r || s (hex or base64)');
  check(countNeedles(accountTexts, addrNeedles) === 0, `bodies: none of the ${accountTexts.length} account bodies names a bundle wallet address`);
  const onWire = texts.flatMap((t) => hexRuns(t, 130)).map(lc);
  const logins = owners.flatMap((o) => o.loginSigs).map(lc);
  check(
    onWire.length === logins.length && logins.every((s) => onWire.filter((w) => w === s).length === 1),
    `bodies: the only signatures on the wire are the ${logins.length} sign-in signatures, each sent once (found ${onWire.length})`
  );

  const vaults = path.join(ACCOUNTS_DIR, 'vaults');
  const file1 = path.join(vaults, `${lc(owners[0].wallet.address)}.json`);
  const file2 = path.join(vaults, `${lc(owners[1].wallet.address)}.json`);
  check(fs.existsSync(file1), "disk: owner 1's encrypted list is in TP_ACCOUNTS_DIR/vaults");
  check(!fs.existsSync(file2) && !fs.existsSync(`${file2}.prev`), 'disk: nothing was saved for the hedged owner (its wallet cannot hold a stable key)');
  const files = filesUnder(ACCOUNTS_DIR);
  const onDisk = files.map((f) => fs.readFileSync(f, 'latin1'));
  check(
    countNeedles(onDisk, [...keyNeedles, ...unlockNeedles, ...addrNeedles]) === 0,
    `disk: none of the ${files.length} file(s) under TP_ACCOUNTS_DIR holds a bundle key, a bundle address or an unlock signature`
  );
  const log = fs.readFileSync(path.join(SCRATCH, 'server.log'), 'latin1');
  check(countNeedles([log], [...keyNeedles, ...unlockNeedles, ...owners.flatMap((o) => o.loginSigs.flatMap((s) => secretNeedles(s)))]) === 0, 'log: the backend log holds no bundle key and no signature');

  const record = JSON.parse(fs.readFileSync(file1, 'utf8'));
  const unlockKey = await loadDapp('account/unlockKey.js');
  const envelope = await loadDapp('account/envelope.js');
  const owner1 = owners[0].wallet.address;
  const derived = await unlockKey.deriveVaultKey({ signature: owners[0].unlockSigs[0], address: owner1 });
  check(derived.keyId === record.keyId, "key: the stored keyId is the one Node derives from owner 1's unlock signature with the page's own unlockKey.js (Chromium's WebCrypto agrees)");
  let plain = null;
  try {
    plain = await envelope.open({ key: derived.key, owner: lc(owner1), envelope: record });
  } catch (err) {
    check(false, `key: the stored ciphertext opens with that key (${(err && err.message) || err})`);
  }
  const want = new Map(bundle.map((w) => [lc(w.address), w.privateKey]));
  const got = Array.isArray(plain.wallets) ? plain.wallets : [];
  check(
    got.length === want.size && got.every((w) => want.get(lc(w.address)) === w.privateKey),
    `key: the stored ciphertext opens to exactly the ${want.size} imported wallets, each key matching its address`
  );
  const lastSave = [...tap.entries].reverse().find((e) => e.method === 'PUT' && e.path.split('?')[0] === '/api/tp/account/vault' && e.status === 200);
  const sent = JSON.parse(lastSave.body);
  check(sent.iv === record.iv && sent.ct === record.ct && sent.keyId === record.keyId, 'disk: the file holds byte for byte the ciphertext of the last save the browser sent');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  check(fs.existsSync(DAPP_HTML), 'the dApp is built (frontend/dist/dapp/index.html) — else run: cd frontend && npm run build');
  check(!(await isListening(APP_PORT)), `port ${APP_PORT} is free (the page's origin; the fork smoke uses it too)`);
  check(!(await isListening(BACKEND_PORT)), `port ${BACKEND_PORT} is free (the backend behind the tap)`);

  server = startServer();
  await waitForServer();
  check(true, `the real backend is up behind the tap: DAPP_HOST=127.0.0.1, TP_SIWE_ORIGIN=${ORIGIN}, TP_ACCOUNTS_DIR in the scratch dir, no chain`);
  tap = await startTap();
  signer = await startSigner();

  const bundle = [0, 1, 2].map(() => Wallet.createRandom());
  fs.rmSync(STOP_FILE, { force: true });
  fs.writeFileSync(KEYS_FILE, bundle.map((w) => w.privateKey).join(os.EOL) + os.EOL, { mode: 0o600 });
  console.log(`HOLD page ${ORIGIN}/`);
  console.log(`HOLD signer ${signer.url} (POST /rpc, POST /owner, GET /status; a throwaway owner key in this process)`);
  console.log(`HOLD keys file (3 throwaway keys, never funded, removed on stop): ${slash(KEYS_FILE)}`);
  console.log(`HOLD to finish, create: ${slash(STOP_FILE)}`);
  const t0 = Date.now();
  while (!fs.existsSync(STOP_FILE) && !interrupted && Date.now() - t0 < HOLD_LIMIT_MS) await sleep(500);
  fs.rmSync(KEYS_FILE, { force: true });
  if (interrupted) throw new Error('interrupted before the STOP file was created: nothing was checked');
  if (!fs.existsSync(STOP_FILE)) throw new Error('no STOP file within 60 minutes: nothing was checked');
  // Let a save that was debouncing when STOP appeared reach the disk and the tap.
  await sleep(3000);
  await verify(bundle.map((w) => ({ address: w.address, privateKey: w.privateKey })));
  console.log(`PASS ${passed} checks — the built page, a real browser and the real account API agree on the wire, on disk and in the ciphertext`);
}

async function cleanup() {
  try {
    fs.rmSync(KEYS_FILE, { force: true });
    fs.rmSync(STOP_FILE, { force: true });
  } catch (_err) {
    // best effort; the scratch dir goes below
  }
  await closeServer(signer);
  await closeServer(tap);
  await stopChild(server);
  for (const fd of logFds) {
    try {
      fs.closeSync(fd);
    } catch (_err) {
      // already closed
    }
  }
  if (KEEP) {
    console.log(`kept scratch dir ${slash(SCRATCH)} (server.log; tp-accounts holds only ciphertext)`);
  } else {
    process.chdir(os.tmpdir());
    fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`cleaned up: backend, tap and signer stopped, key file ${KEEP ? 'removed' : 'and scratch removed'}`);
}

process.on('SIGINT', () => {
  interrupted = true;
});
process.on('exit', () => {
  try {
    fs.rmSync(KEYS_FILE, { force: true });
  } catch (_err) {
    // nothing to remove
  }
  try {
    if (server && server.exitCode === null) server.kill();
  } catch (_err) {
    // already gone
  }
});

let exitCode = 0;
main()
  .catch((err) => {
    exitCode = 1;
    console.error(`FAIL ${err.message}`);
    if (server) {
      const LF = String.fromCharCode(10);
      let lines = '(no log)';
      try {
        lines = fs.readFileSync(path.join(SCRATCH, 'server.log'), 'utf8').split(LF).slice(-30).join(LF);
      } catch (_err) {
        // no log yet
      }
      console.error(`last lines of the backend log:${LF}${lines}`);
    }
  })
  .then(cleanup)
  .catch((err) => {
    exitCode = 1;
    console.error(`FAIL during cleanup: ${err.message}`);
  })
  .then(() => process.exit(exitCode));
