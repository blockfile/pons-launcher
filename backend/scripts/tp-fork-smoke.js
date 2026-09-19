#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LIVE VERIFICATION of the take-profit dApp on a LOCAL ANVIL FORK of Robinhood
// Chain (4663). Nothing here touches the real chain: every transaction is signed
// by a throwaway wallet created at run time, funded with anvil_setBalance, and
// sent to the fork on 127.0.0.1:8546 (memory: local-fork-smoke-test).
//
//   cd frontend && npm run build        # the server serves frontend/dist/dapp
//   cd backend  && node scripts/tp-fork-smoke.js [--size-only] [--hold] [--require-graduated]
//                                                [--pair] [--attach] [--keep]
//
// What it proves, through the REAL backend and the REAL browser modules:
//   0. the built page runs under the production CSP, its first load (without the
//      lazy three.js chunk) passes frontend/scripts/dapp-size.mjs (250 KB gzipped),
//      and the JS + CSS first load is printed at gzip -6 and -9 — --size-only stops here;
//   1. the host gate — on the dApp host only the dApp page, its own assets and
//      /api/tp/* answer (the console's routes, its key backup AND the console page's
//      bundle are 404), the page carries the CSP itself; the console host is unchanged;
//   2. /api/tp/token, /wallets, /fees, /quote, /quote/pair, /broadcast and the SSE
//      stream (snapshot, receipts scoped to the broadcast's sid, trades, candles);
//   3. arm — the approvals planned by frontend/src/dapp/chain/plan.js and signed by
//      frontend/src/dapp/keys/walletStore.js land, and the allowances cover the balances;
//   4. sells of 25 %, 50 % and 100 % from 3 wallets land, sell EXACTLY the planned
//      amount and pay at least minOut — read from the chain, not the API;
//   5. with --pair, a token-quoted curve (a stock token or USDG as the pair) on 3 wallets
//      of its own: the sells pay the pair token and the pair -> ETH leg (planPairLeg +
//      /quote/pair) turns exactly that into ETH in the same wallet. Opt-in: its setup
//      reads many fresh storage slots (the pair's pools), and the public RPC this forks
//      from stops serving the fork block's state within minutes, so it runs FIRST and a
//      failed SETUP skips it with a note;
//   6. /broadcast refuses what is not a sell (a plain transfer, a foreign chain id, a
//      stranger spender, more than 100 transactions) and none of it reaches the chain;
//   7. the dApp account (spec Addendum v2 A) on the real server: sign-in with a
//      throwaway wallet, the encrypted-list round trip, a racing save answered 409,
//      the host gate, and the DELETE that signs every session out. Its state lives in
//      the scratch dir (TP_ACCOUNTS_DIR), never in backend/data, and the sign-in
//      message names this page's own origin (TP_SIWE_ORIGIN), so a --hold browser run
//      can sign in on it as well;
//   8. v2 token header (spec Addendum D, plan Part 02), on every venue: GET /token's
//      `info` and `figures` hold their contract, the stream's snapshot carries
//      `stats` and a `stats` event follows the sells, and GET /api/tp/logo/:ca
//      answers an image or a 404 — with nosniff, CSP default-src 'none' and CORP
//      same-origin either way, immutable only for a raw CID (the backend asks the
//      public IPFS gateways for the CID, or the token's https host through its
//      SSRF-safe fetch: public data, no key, no address);
//   9. v2 account (Addendum A + C): scripts/lib/tpSmokeAccount.mjs signs a
//      throwaway owner in on two "devices" through the page's OWN api.js, account,
//      vaultSync and positions modules — 3 signatures, then 2 — and device 2 gets
//      every wallet AND every recorded starting size back; no request body, no
//      file under TP_ACCOUNTS_DIR and no backend log line holds a bundle key or a
//      bundle address; a write from a foreign Origin is refused (403).
// Venues: a live pons v2 ETH-quoted curve token, and a graduated (Uniswap v4) one
// when the scan finds one — SKIPPED otherwise; --require-graduated fails instead.
//
// --hold (implies --require-graduated) keeps the fork and the server up for the
// Playwright UI run: it re-buys BOTH ETH-quoted tokens for the 3 wallets, writes the
// 3 THROWAWAY keys to ui-keys.txt in its scratch dir (outside the repo; the browser
// reads it through a file input, so no key ever passes through a transcript) and
// waits. Create the STOP file it names to finish: it then checks on-chain that, on
// each venue, the UI sent one sell per click and the 25 %, 50 % and 100 % clicks sold
// exactly those shares of what each wallet held, that every sell paid ETH into its
// wallet, and that the page sent nothing but approvals and sells; then it stops both
// processes and removes the scratch dir, key file included.
//
// v2 in the UI run: the page also connects a browser wallet. That wallet is a
// throwaway owner key living in THIS process behind a local signer URL (HOLD
// signer ...); Playwright's Node side bridges the page's EIP-1193 calls to it
// (page.exposeFunction), and the page's own CSP keeps the page itself from
// reaching it. At STOP the script also checks the wallet was asked for exactly
// UI_SIGNATURES signatures, and reads the account's copy back as that owner: the
// 3 wallets, and on both tokens each wallet's saved starting size (the %-left
// bar's 100 %), ended after the 100 % click.
//
// --attach uses an anvil already listening on 127.0.0.1:8546 (and leaves it running);
// --keep keeps the scratch dir (logs) — its key file is removed either way.
//
// Output is booleans, amounts and (public) token addresses. It never prints a key, a
// wallet address or the fork's upstream RPC URL.
//
// Env (all optional):
//   TP_SMOKE_FORK_URL           upstream to fork (default: the public RPC)
//   TP_SMOKE_CURVE_TOKEN        use this pons v2 ETH-quoted curve token, skip the scan
//   TP_SMOKE_GRADUATED_TOKEN    use this graduated ETH-quoted pons v2 token
//   TP_SMOKE_PAIR_CURVE_TOKEN   use this token-quoted pons v2 curve token
//   TP_SMOKE_SCAN_WINDOWS       how many 10k-block windows to scan back (default 30)
//   TP_SMOKE_ANVIL              path to anvil (default ~/.foundry/bin/anvil[.exe])
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(REPO, 'backend');
const FRONTEND = path.join(REPO, 'frontend');
const DIST = path.join(FRONTEND, 'dist');
const DAPP_HTML = path.join(DIST, 'dapp', 'index.html');
const CONSOLE_HTML = path.join(DIST, 'index.html');

// Scratch FIRST, and move into it before anything can load dotenv: config.js calls
// require('dotenv').config(), which reads .env from the CURRENT directory. From
// here that is an empty scratch dir, so backend/.env (real RPC URL, passphrase,
// API key, a possible TP_SEQUENCER_URL) can never leak into this run or into the
// server it starts.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-fork-smoke-'));
const KEYS_FILE = path.join(SCRATCH, 'ui-keys.txt');
const STOP_FILE = path.join(SCRATCH, 'STOP');
const slash = (p) => p.split(path.sep).join('/');
process.chdir(SCRATCH);
// And point this process's own copy of config at the fork before anything
// requires it. evm/provider.js registers a keep-alive HTTPS agent for EVERY ethers
// request when config.rpcUrl is https — with the default URL that breaks the plain
// http:// fork provider below ("Protocol http: not supported").
process.env.RPC_URL = 'http://127.0.0.1:8546';
process.env.CHAIN_ID = '4663';

const {
  Contract,
  Interface,
  JsonRpcProvider,
  Transaction,
  Wallet,
  ZeroAddress,
  formatEther,
  formatUnits,
  getAddress,
  getBytes,
  solidityPacked,
  zeroPadValue,
} = require('ethers');
// Pure ABI strings — this file requires nothing (evm/v2/abi.js).
const { FACTORY_V2_ABI, CURVE_V2_ABI } = require('../src/evm/v2/abi');
const {
  pctAmount,
  clickAmounts,
  receivedWei,
  withinPpm,
  newestFirstWindows,
  landedInOrder,
  soldPerTx,
  createSseParser,
  cspProblems,
  firstLoadFiles,
  isUpstreamHiccup,
  withRetry,
  pollReceipt,
  createCookieJar,
  countHexIn,
  imageKind,
  logoProblems,
  tokenInfoProblems,
  figuresProblems,
  statsProblems,
  NonceFloor,
} = require('./lib/tpSmoke');

const ARGS = new Set(process.argv.slice(2));
const SIZE_ONLY = ARGS.has('--size-only');
const HOLD = ARGS.has('--hold');
// The UI run sells on BOTH venues, so a hold run needs a graduated token.
const REQUIRE_GRADUATED = ARGS.has('--require-graduated') || HOLD;
const KEEP = ARGS.has('--keep');
const ATTACH = ARGS.has('--attach');
const PAIR = ARGS.has('--pair');

const CHAIN_ID = 4663;
const ANVIL_PORT = 8546;
const APP_PORT = 3199;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const UPSTREAM = process.env.TP_SMOKE_FORK_URL || 'https://rpc.mainnet.chain.robinhood.com';
const ANVIL_BIN =
  process.env.TP_SMOKE_ANVIL ||
  path.join(os.homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
// This script's own per-IP buckets on the server (clientIp trusts X-Real-IP from a
// loopback peer), so its API run never spends what the browser run needs next.
// 198.51.100.0/24 is TEST-NET-2.
const SCRIPT_IP = '198.51.100.7';

// Addresses, lower-case. Sources: backend/src/config.js (pons v2 factory, v3Route
// SwapRouter02 / QuoterV2 / WETH / USDG), backend/src/evm/v3/poolswap.js V4_ADDRESSES
// (PoolManager, UniversalRouter, Permit2).
const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const SWAP_ROUTER02 = '0xcaf681a66d020601342297493863e78c959e5cb2';
const QUOTER_V2 = '0x5dedb1f91f5f56177bb4d193ad281b33e4f13098';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH_USDG_FEE = 100;
const PAIR_FEE_TIERS = [3000, 500, 100, 10000];

// The page's CSP (backend/src/tp/hostGate.js DAPP_CSP = deploy/nginx-rhbond.conf).
const PROD_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
// Permit2 AllowanceTransfer.allowance(owner, token, spender).
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];
// v4-core PoolManager.Initialize — the event a graduation emits when it creates the pool.
const POOL_MANAGER_ABI = [
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
];
// SETUP ONLY (buying a pair token for the token-quoted curve): SwapRouter02's
// exactInput without a deadline and QuoterV2 (evm/v3/swaproute.js:32-40).
const ROUTER_ABI = [
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
];
const QUOTER_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
];

const BUY_WEI = 10n ** 16n; // 0.01 ETH per wallet per venue
const FUND_WEI = 10n ** 18n; // 1 ETH of fork money per wallet
const SLIPPAGE_BPS = 1500; // the dApp's default 15 %
const LOG_WINDOW = 10_000; // the most blocks one getLogs may span on this chain
const SCAN_WINDOWS = Number(process.env.TP_SMOKE_SCAN_WINDOWS) || 30;
const MIN_AGE_BLOCKS = 600; // skip launches younger than ~1 min (snipe tax lasts 3 s)
const CANDIDATE_CAP = 40;
const UI_PCTS = [25, 50, 100]; // the UI run's clicks, in this order, on each venue
// The UI run's wallet signatures: sign-in + unlock + unlock again on the first
// visit, none on a reload (the session cookie and the cached key), one unlock
// after Lock. Any other count means the page asked the wallet for something else.
const UI_SIGNATURES = 4;
// Part 07's one first-load size measurement (250 KB gzipped budget).
const SIZE_SCRIPT = path.join(FRONTEND, 'scripts', 'dapp-size.mjs');

const erc20Iface = new Interface(ERC20_ABI);
const TRANSFER_TOPIC = erc20Iface.getEvent('Transfer').topicHash;

let anvil = null;
let server = null;
let signer = null; // the UI run's throwaway owner wallet (startSigner)
let provider = null;
let interrupted = false;
let passed = 0;
const logFds = [];
const labels = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lc = (a) => String(a).toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
const label = (address) => labels.get(lc(address)) || 'w?';
const newSid = () => crypto.randomBytes(16).toString('hex');

function check(cond, what) {
  if (!cond) throw new Error(what);
  passed++;
  console.log(`ok   ${what}`);
}

// ── processes ────────────────────────────────────────────────────────────────

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

function tail(name, lines) {
  try {
    const LF = String.fromCharCode(10);
    return fs.readFileSync(path.join(SCRATCH, name), 'utf8').split(LF).slice(-lines).join(LF);
  } catch (_err) {
    return '(no log)';
  }
}

function startAnvil() {
  const log = openLog('anvil.log');
  return spawn(
    ANVIL_BIN,
    [
      '--fork-url', UPSTREAM,
      '--chain-id', String(CHAIN_ID),
      '--port', String(ANVIL_PORT),
      '--host', '127.0.0.1',
      // The real chain's eth_maxPriorityFeePerGas is 0; the dApp sends tip 0.
      '--disable-min-priority-fee',
      '--retries', '10',
      '--fork-retry-backoff', '1000',
      '--timeout', '45000',
    ],
    { stdio: ['ignore', log, log], windowsHide: true }
  );
}

async function waitForAnvil() {
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (anvil && anvil.exitCode !== null) throw new Error('anvil exited during start-up (rerun with --keep and read anvil.log)');
    try {
      const res = await fetch(FORK_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const body = await res.json();
      if (body.result === '0x1237') return; // 4663
    } catch (_err) {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error('anvil did not answer eth_chainId = 4663 within 90 s');
}

// Only the variables the OS needs to run node, kept in their original casing.
// Everything the backend reads is set explicitly below, so nothing from this
// shell (or from a backend/.env loaded elsewhere) reaches the server.
function osEnvOnly() {
  const keep = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG',
  ]);
  const out = {};
  for (const key of Object.keys(process.env)) if (keep.has(key.toUpperCase())) out[key] = process.env[key];
  return out;
}

function startServer() {
  const log = openLog('server.log');
  const env = {
    ...osEnvOnly(),
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    DRY_RUN: 'false',
    RPC_URL: FORK_RPC,
    CHAIN_ID: String(CHAIN_ID),
    KEYSTORE_PATH: path.join(SCRATCH, 'wallets.keystore.json'),
    HISTORY_PATH: path.join(SCRATCH, 'launches.json'),
    USERS_PATH: path.join(SCRATCH, 'users.json'),
    // DRY_RUN=false refuses to boot without these. Random, used by nothing here.
    KEYSTORE_PASSPHRASE: crypto.randomBytes(24).toString('hex'),
    API_KEY: crypto.randomBytes(24).toString('hex'),
    // The dApp host gate answers for this Host — so http://127.0.0.1:3199 IS the dApp,
    // and http://localhost:3199 is the console.
    DAPP_HOST: '127.0.0.1',
    // Never a second broadcast endpoint from a fork run: it would be the real chain.
    TP_SEQUENCER_URL: '',
    // Every tp RPC handle on the fork (no WSS probe of a real endpoint either).
    TP_READ_RPC_URL: FORK_RPC,
    TP_CHART_RPC_URL: FORK_RPC,
    TP_CHART_WSS_URL: '',
    TP_MAX_TOKENS: '8',
    // The dApp account: its encrypted lists, session secret and revocations go in the
    // scratch dir (removed with it), never in backend/data; and the sign-in message
    // names this page's own origin. Chromium takes the __Host- Secure cookie over plain
    // http on 127.0.0.1, so a --hold browser run signs in here too.
    TP_ACCOUNTS_DIR: path.join(SCRATCH, 'tp-accounts'),
    TP_SIWE_ORIGIN: APP,
    RELAY_API_KEY: '',
    ADMIN_USERS: '',
  };
  // cwd = the scratch dir, so the server's dotenv finds no .env either.
  return spawn(process.execPath, [path.join(BACKEND, 'server.js')], {
    cwd: SCRATCH,
    env,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
}

async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    if (server.exitCode !== null) throw new Error('the backend exited during start-up');
    try {
      const res = await fetch(`${APP}/api/tp/fees`, { headers: { 'x-real-ip': SCRIPT_IP } });
      if (res.status === 200) return;
    } catch (_err) {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error('the backend did not answer /api/tp/fees within 120 s');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, sleep(5000)]);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function api(method, route, body) {
  const headers = { 'x-real-ip': SCRIPT_IP };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(APP + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_err) {
    json = null;
  }
  return { status: res.status, json, text };
}

async function apiOk(method, route, body) {
  const r = await api(method, route, body);
  if (r.status !== 200) {
    const why = r.json ? `${r.json.code || ''} ${r.json.error || ''}`.trim() : r.text.slice(0, 120);
    throw new Error(`${method} ${route.split('?')[0]} answered ${r.status}: ${why}`);
  }
  return r.json;
}

// A request with an explicit Host header, for the host-gate checks.
function rawRequest(method, route, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: route, method, headers: { host, 'x-real-ip': SCRIPT_IP } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// One SSE reader. With `sid` it is the page's stream: the receipts of broadcasts
// that carry that sid reach it. Without, the server names a fresh sid — a
// stranger watching the same token, who must see none of them.
function openStream(token, sid) {
  const controller = new AbortController();
  const events = [];
  const done = (async () => {
    const q = `token=${token}&interval=1${sid ? `&sid=${sid}` : ''}`;
    const res = await fetch(`${APP}/api/tp/stream?${q}`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream', 'x-real-ip': SCRIPT_IP },
    });
    if (res.status !== 200) throw new Error(`the stream answered ${res.status}`);
    const parser = createSseParser();
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) events.push(ev);
    }
  })().catch((err) => {
    if (err.name !== 'AbortError') events.push({ event: '__error', data: err.message });
  });
  async function waitFor(pred, ms, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred(events)) {
        check(true, `${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        return;
      }
      const broken = events.find((e) => e.event === '__error');
      if (broken) throw new Error(`${what} — the stream failed: ${broken.data}`);
      await sleep(100);
    }
    // The indexer's own words, when it has any (status {state, detail}).
    const st = [...events].reverse().find((e) => e.event === 'status');
    const why = st && st.data ? ` (the stream's last status: ${st.data.state}${st.data.detail ? ' — ' + st.data.detail : ''})` : '';
    throw new Error(`${what} — not within ${ms / 1000} s${why}`);
  }
  return {
    events,
    waitFor,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

const receiptsIn = (hashes) => (events) => {
  const landed = new Set(
    events.filter((e) => e.event === 'receipt' && e.data && e.data.status === 'landed').map((e) => lc(e.data.hash))
  );
  return hashes.every((h) => landed.has(lc(h)));
};

const tradesIn = (hashes) => (events) => {
  const seen = new Set();
  for (const e of events) {
    const list = e.event === 'trades' ? e.data : e.event === 'snapshot' ? e.data.trades : [];
    for (const t of list || []) seen.add(lc(t.tx));
  }
  return hashes.every((h) => seen.has(lc(h)));
};

const barsSeen = (events) =>
  events.some((e) => (e.event === 'snapshot' && e.data.bars && e.data.bars.length > 0) || e.event === 'bar');

// ── chain helpers ────────────────────────────────────────────────────────────

async function balances(token, addresses, pairToken = null) {
  const t = new Contract(token, ERC20_ABI, provider);
  const p = pairToken ? new Contract(pairToken, ERC20_ABI, provider) : null;
  const out = new Map();
  for (const a of addresses) {
    out.set(lc(a), {
      token: await t.balanceOf(a),
      eth: await provider.getBalance(a),
      pair: p ? await p.balanceOf(a) : 0n,
    });
  }
  return out;
}

// Receipts by polling (lib/tpSmoke.js pollReceipt), never ethers' wait: it reads the
// head, then the receipt, and a tx mined between the two waits for a NEXT block that an
// idle automining fork never mines (measured: a pair leg mined in 1 s, the wait hit 60 s).
const receiptOf = (hash) => pollReceipt((h) => provider.getTransactionReceipt(h), hash, { timeoutMs: 60_000, pollMs: 200 });

async function landed(hashes, what) {
  const receipts = await Promise.all(hashes.map((h) => receiptOf(h)));
  check(
    receipts.every((r) => r && r.status === 1),
    `${what}: all ${hashes.length} tx landed (status 1)`
  );
  return receipts;
}

// A fork forwards getLogs over pre-fork blocks to the public RPC, which answers an
// occasional 429 or "internal server error". The scans retry a window before giving up.
function getLogsRetry(filter) {
  return withRetry(() => provider.getLogs(filter), { attempts: 4, baseMs: 1000, retryable: () => true });
}

// Every state read the fork has not made yet goes to the public RPC, which throttles
// bursts: anvil then fails the call ("failed to get storage ... HTTP error 429"), and
// ethers reports it as a data-less revert. Setup reads retry THOSE, with backoff; a
// contract's own revert is not retried (isUpstreamHiccup tells them apart).
const upstream = (fn) => withRetry(fn);

// The factory's TokenLaunched logs, newest first, scanned ONCE per run: the
// token-quoted pick and the ETH-quoted pick read the same windows, and each 10k-block
// window is a heavy getLogs on the throttled public RPC.
let launchScan = null;
function launchLogs() {
  if (!launchScan) {
    launchScan = (async () => {
      const factory = new Contract(PONS_V2_FACTORY, FACTORY_V2_ABI, provider);
      const topic = factory.interface.getEvent('TokenLaunched').topicHash;
      const head = await provider.getBlockNumber();
      const out = [];
      for (const w of newestFirstWindows(head - MIN_AGE_BLOCKS, LOG_WINDOW, SCAN_WINDOWS)) {
        const logs = await getLogsRetry({ address: PONS_V2_FACTORY, topics: [topic], fromBlock: w.from, toBlock: w.to });
        for (const log of logs.reverse()) {
          const ev = factory.interface.parseLog(log);
          out.push({ token: getAddress(ev.args.token), pairToken: getAddress(ev.args.pairToken) });
        }
        const native = out.filter((l) => l.pairToken === ZeroAddress).length;
        const stock = out.filter((l) => l.pairToken !== ZeroAddress && lc(l.pairToken) !== USDG).length;
        if (native >= CANDIDATE_CAP && (!PAIR || stock >= CANDIDATE_CAP)) break;
      }
      return out;
    })();
    launchScan.catch(() => {
      launchScan = null; // a failed scan is not cached
    });
  }
  return launchScan;
}

async function buyCurve(ctx, curveAddress, what) {
  let last = 0;
  for (const w of ctx.wallets) {
    const c = new Contract(curveAddress, CURVE_V2_ABI, w);
    const sim = await upstream(() => c.buy.staticCall(BUY_WEI, 0n, w.address, { value: BUY_WEI }));
    const tx = await upstream(() => c.buy(BUY_WEI, (sim * 90n) / 100n, w.address, { value: BUY_WEI }));
    const r = await receiptOf(tx.hash);
    check(r.status === 1, `${what} ${label(w.address)}: bought the curve token with ${formatEther(BUY_WEI)} ETH`);
    last = Math.max(last, r.blockNumber);
  }
  return last;
}

async function pickCurveToken(ctx) {
  const factory = new Contract(PONS_V2_FACTORY, FACTORY_V2_ABI, provider);
  const candidates = [];
  if (process.env.TP_SMOKE_CURVE_TOKEN) {
    candidates.push(getAddress(lc(process.env.TP_SMOKE_CURVE_TOKEN)));
  } else {
    for (const l of await launchLogs()) if (l.pairToken === ZeroAddress) candidates.push(l.token);
  }
  const probe = ctx.wallets[0];
  for (const token of candidates.slice(0, CANDIDATE_CAP)) {
    const rec = await upstream(() => factory.getLaunchedToken(token));
    if (!rec.exists || Number(rec.phase) !== 0 || rec.pairToken !== ZeroAddress) continue;
    const curve = new Contract(rec.curve, CURVE_V2_ABI, provider);
    const [native, ready, graduated, sellable] = await upstream(() =>
      Promise.all([curve.isNativeQuote(), curve.readyToGraduate(), curve.graduated(), curve.sellableTokens()])
    );
    if (!native || ready || graduated || sellable === 0n) continue;
    // All the buys of the run (API run + UI run) together must stay far from
    // graduation, or the curve could bond mid-run and the test would be about
    // something else.
    let out = 0n;
    try {
      out = await upstream(() =>
        curve.buy.staticCall(BUY_WEI * 6n, 0n, probe.address, { value: BUY_WEI * 6n, from: probe.address })
      );
    } catch (err) {
      if (isUpstreamHiccup(err)) throw err;
      continue; // the curve itself refuses the buys
    }
    if (out === 0n || out * 2n >= sellable) continue;
    return { token, curve: getAddress(rec.curve) };
  }
  return null;
}

async function pickGraduatedToken() {
  const factory = new Contract(PONS_V2_FACTORY, FACTORY_V2_ABI, provider);
  const candidates = [];
  if (process.env.TP_SMOKE_GRADUATED_TOKEN) {
    candidates.push(getAddress(lc(process.env.TP_SMOKE_GRADUATED_TOKEN)));
  } else {
    // A graduation initialises a V4 pool whose hook is the pons meme hook and whose
    // currency0 is the native sentinel for an ETH-quoted launch.
    const hook = lc(await upstream(() => factory.memeHook()));
    const pm = new Interface(POOL_MANAGER_ABI);
    const topic = pm.getEvent('Initialize').topicHash;
    const nativeTopic = zeroPadValue(ZeroAddress, 32);
    const head = await provider.getBlockNumber();
    for (const w of newestFirstWindows(head, LOG_WINDOW, SCAN_WINDOWS)) {
      const logs = await getLogsRetry({
        address: POOL_MANAGER,
        topics: [topic, null, nativeTopic],
        fromBlock: w.from,
        toBlock: w.to,
      });
      for (const log of logs.reverse()) {
        const ev = pm.parseLog(log);
        if (lc(ev.args.hooks) === hook) candidates.push(getAddress(ev.args.currency1));
      }
      if (candidates.length >= 10) break;
    }
  }
  for (const token of candidates.slice(0, 10)) {
    const rec = await upstream(() => factory.getLaunchedToken(token));
    if (rec.exists && Number(rec.phase) === 2 && rec.pairToken === ZeroAddress) return token;
  }
  return null;
}

async function buyGraduated(ctx, token, what) {
  // SETUP ONLY: the verified V4 buy encoder (evm/v3/poolswap.js) gets tokens into
  // the wallets. What is under test is the dApp's SELL path, built in the browser
  // modules. Required here, after process.chdir, so its config loads no .env.
  const poolswap = require('../src/evm/v3/poolswap');
  let last = 0;
  for (const w of ctx.wallets) {
    const built = await upstream(() =>
      poolswap.resolveAndBuildBuy(
        { token, amountIn: BUY_WEI, slippageBps: 2000, recipient: w.address, deadline: nowSec() + 600, liquidate: true },
        { provider }
      )
    );
    check(
      built.pool.isNativeQuote && BigInt(built.value) === BUY_WEI,
      `${what} ${label(w.address)}: V4 buy built against the verified ETH-quoted pool`
    );
    const tx = await w.sendTransaction({ to: built.to, data: built.data, value: built.value, gasLimit: 500_000n });
    const r = await receiptOf(tx.hash);
    check(r.status === 1, `${what} ${label(w.address)}: bought the graduated token with ${formatEther(BUY_WEI)} ETH`);
    last = Math.max(last, r.blockNumber);
  }
  return last;
}

// ── the token-quoted curve (setup) ───────────────────────────────────────────

/** WETH -> USDG [-> pair]: the ETH -> pair route, USDG itself one hop. */
function buyPath(pair, fee) {
  if (lc(pair) === USDG) return solidityPacked(['address', 'uint24', 'address'], [WETH, WETH_USDG_FEE, USDG]);
  return solidityPacked(['address', 'uint24', 'address', 'uint24', 'address'], [WETH, WETH_USDG_FEE, USDG, fee, pair]);
}

/** The ETH -> pair route that pays the most for `ethIn`, or null. */
async function pairRoute(pair, ethIn) {
  const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
  const fees = lc(pair) === USDG ? [0] : PAIR_FEE_TIERS;
  let best = null;
  for (const fee of fees) {
    try {
      const out = BigInt((await upstream(() => quoter.quoteExactInput.staticCall(buyPath(pair, fee), ethIn)))[0]);
      if (out > 0n && (!best || out > best.out)) best = { fee, out, path: buyPath(pair, fee) };
    } catch (err) {
      if (isUpstreamHiccup(err)) throw err;
      // no pool at this tier
    }
  }
  return best;
}

// A token-quoted launch whose curve is live and far from graduation, and whose pair
// token has an ETH route (stock tokens first — the AMZN-type case the dApp's pair
// leg exists for — then USDG, whose leg is one hop).
async function pickPairCurveToken() {
  const factory = new Contract(PONS_V2_FACTORY, FACTORY_V2_ABI, provider);
  const candidates = [];
  if (process.env.TP_SMOKE_PAIR_CURVE_TOKEN) {
    candidates.push(getAddress(lc(process.env.TP_SMOKE_PAIR_CURVE_TOKEN)));
  } else {
    const stock = [];
    const usdg = [];
    for (const l of await launchLogs()) {
      if (l.pairToken === ZeroAddress) continue;
      (lc(l.pairToken) === USDG ? usdg : stock).push(l.token);
    }
    candidates.push(...stock.slice(0, CANDIDATE_CAP), ...usdg.slice(0, 10));
  }
  const routes = new Map();
  for (const token of candidates) {
    const rec = await upstream(() => factory.getLaunchedToken(token));
    if (!rec.exists || Number(rec.phase) !== 0 || rec.pairToken === ZeroAddress) continue;
    const curve = new Contract(rec.curve, CURVE_V2_ABI, provider);
    const [native, ready, graduated, sellable] = await upstream(() =>
      Promise.all([curve.isNativeQuote(), curve.readyToGraduate(), curve.graduated(), curve.sellableTokens()])
    );
    if (native || ready || graduated || sellable === 0n) continue;
    const pair = getAddress(rec.pairToken);
    if (!routes.has(lc(pair))) routes.set(lc(pair), await pairRoute(pair, BUY_WEI));
    const route = routes.get(lc(pair));
    if (!route) continue;
    return { token, curve: getAddress(rec.curve), pair, route };
  }
  return null;
}

async function buyPairCurve(ctx, pc, what) {
  const router = new Contract(SWAP_ROUTER02, ROUTER_ABI, provider);
  const pairToken = new Contract(pc.pair, ERC20_ABI, provider);
  let last = 0;
  for (const w of ctx.wallets) {
    const quoted = (await pairRoute(pc.pair, BUY_WEI)).out;
    const swap = await router
      .connect(w)
      .exactInput([pc.route.path, w.address, BUY_WEI, (quoted * 90n) / 100n], { value: BUY_WEI, gasLimit: 600_000n });
    check((await receiptOf(swap.hash)).status === 1, `${what} ${label(w.address)}: swapped ${formatEther(BUY_WEI)} ETH into ${pc.pairSymbol}`);
    const held = await pairToken.balanceOf(w.address);
    const approve = await pairToken.connect(w).approve(pc.curve, held);
    await receiptOf(approve.hash);
    const c = new Contract(pc.curve, CURVE_V2_ABI, w);
    const sim = await c.buy.staticCall(held, 0n, w.address);
    const tx = await c.buy(held, (sim * 90n) / 100n, w.address, { gasLimit: 600_000n });
    const r = await receiptOf(tx.hash);
    check(
      r.status === 1 && (await pairToken.balanceOf(w.address)) === 0n,
      `${what} ${label(w.address)}: bought the token-quoted curve with all its ${formatUnits(held, pc.pairDecimals)} ${pc.pairSymbol}`
    );
    last = Math.max(last, r.blockNumber);
  }
  const curve = new Contract(pc.curve, CURVE_V2_ABI, provider);
  check(!(await curve.readyToGraduate()) && !(await curve.graduated()), `${what}: the curve is still live after the buys`);
  return last;
}

// ── the dApp flow ────────────────────────────────────────────────────────────

async function walletStates(ctx, token) {
  const { wallets } = await apiOk('POST', '/api/tp/wallets', { token, addresses: ctx.addresses });
  if (!Array.isArray(wallets) || wallets.length !== ctx.addresses.length) {
    throw new Error(`/api/tp/wallets returned ${Array.isArray(wallets) ? wallets.length : 'no'} wallets for ${ctx.addresses.length} addresses`);
  }
  return wallets;
}

// The mark the planner prices against must include the last TRADE (a setup buy or
// the previous click's sells). Approvals do not move it, so they are not waited on.
async function freshMark(token, minBlock) {
  const t0 = Date.now();
  for (;;) {
    const { mark } = await apiOk('GET', `/api/tp/token/${token}`);
    if (mark && Number(mark.block) >= minBlock) return mark;
    if (Date.now() - t0 > 15_000) {
      throw new Error(`/token answered a mark at block ${mark ? mark.block : 'null'}, below ${minBlock}, for 15 s`);
    }
    await sleep(500);
  }
}

// Every /wallets read a step signs on goes through the run's NonceFloor: a read
// taken before this run's last landing (a fork still answering `pending` from a
// moment ago, or ethers' 250 ms cache of an identical earlier read) would seed the
// step's fresh NonceBook at a nonce the chain has already used, and the node would
// refuse every transaction of the step with "nonce has already been used".
async function statesAfter(ctx, token, floor) {
  return floor.waitFor(() => walletStates(ctx, token));
}

// Tell the floor where each wallet's nonce now stands on-chain. Called before the
// first read of a venue and after every landing, so no read is ever unjudged.
async function recordLanded(ctx, floor) {
  for (const a of ctx.addresses) floor.record(a, await provider.getTransactionCount(a, 'latest'));
}

async function signAll(ctx, entries) {
  const raws = [];
  for (const { address, tx } of entries) raws.push(await ctx.dapp.signTx(address, tx));
  return raws;
}

async function broadcast(token, raws, what, sid) {
  const { results } = await apiOk('POST', '/api/tp/broadcast', { token, txs: raws, sid });
  const errors = (results || []).filter((r) => !r.ok).map((r) => r.error);
  check(
    Array.isArray(results) && results.length === raws.length && errors.length === 0,
    `${what}: /broadcast accepted all ${raws.length}${errors.length ? ' — ' + errors.join('; ') : ''}`
  );
  const local = new Set(raws.map((raw) => lc(Transaction.from(raw).hash)));
  check(results.every((r) => local.has(lc(r.hash))), `${what}: /broadcast returned the hashes of the txs signed here`);
  return raws.map((raw) => lc(Transaction.from(raw).hash));
}

async function arm(ctx, venue, stream, floor) {
  const what = `${venue.label} arm`;
  if (venue.kind === 'curve') {
    check(lc(venue.spenders.approve) === lc(venue.curve), `${what}: the spender to approve is the curve`);
  } else {
    check(
      lc(venue.spenders.approve) === PERMIT2 && lc(venue.spenders.permit2Router) === UNIVERSAL_ROUTER,
      `${what}: token -> Permit2, Permit2 -> the UniversalRouter`
    );
  }
  const states = await statesAfter(ctx, venue.token, floor);
  const fees = await apiOk('GET', '/api/tp/fees');
  const nonces = new ctx.dapp.NonceBook();
  for (const s of states) nonces.seed(s.address, Number(s.nonce));
  const plan = ctx.dapp.planArm({ venue, wallets: states, fees, nonces, now: Number(fees.timestamp) || nowSec() });
  const perWallet = venue.kind === 'graduated' ? 2 : 1;
  const needing = plan.filter((p) => p.txs && p.txs.length);
  check(
    needing.length === 3 && needing.every((p) => p.txs.length === perWallet),
    `${what}: planArm gives each of the 3 wallets ${perWallet} approval tx(s)`
  );
  const raws = await signAll(ctx, needing.flatMap((p) => p.txs.map((tx) => ({ address: p.address, tx }))));
  const hashes = await broadcast(venue.token, raws, what, stream.sid);
  await landed(hashes, what);
  await stream.waitFor(receiptsIn(hashes), 10_000, `${what}: the stream pushed a landed receipt for every approval`);
  // The first sell's /wallets read must include these approvals.
  await recordLanded(ctx, floor);

  const armed = await statesAfter(ctx, venue.token, floor);
  const token = new Contract(venue.token, ERC20_ABI, provider);
  const permit2 = new Contract(PERMIT2, PERMIT2_ABI, provider);
  for (const s of armed) {
    const onchain = await token.allowance(s.address, venue.spenders.approve);
    check(onchain >= BigInt(s.tokenBalance), `${what} ${label(s.address)}: on-chain allowance covers the balance`);
    check(BigInt(s.allowance) === onchain, `${what} ${label(s.address)}: /wallets reports that same allowance`);
    if (venue.kind === 'graduated') {
      const p2 = await permit2.allowance(s.address, venue.token, venue.spenders.permit2Router);
      check(
        p2.amount >= BigInt(s.tokenBalance) && Number(p2.expiration) > nowSec(),
        `${what} ${label(s.address)}: Permit2 lets the router pull the balance, unexpired`
      );
      check(
        s.permit2 && BigInt(s.permit2.amount) === p2.amount,
        `${what} ${label(s.address)}: /wallets reports that same Permit2 amount`
      );
    }
  }
}

// A token-quoted sell paid the pair token: turn exactly that into ETH, the way the
// page's pair leg does (POST /quote/pair, planPairLeg, one /broadcast of approve +
// swap at consecutive nonces).
async function pairLeg(ctx, venue, stream, got, what, floor) {
  const fees = await apiOk('GET', '/api/tp/fees');
  const states = await statesAfter(ctx, venue.token, floor);
  const nonces = new ctx.dapp.NonceBook();
  for (const s of states) nonces.seed(s.address, Number(s.nonce));
  const legs = [];
  for (const [address, amountIn] of got) {
    const route = await apiOk('POST', '/api/tp/quote/pair', { pairToken: venue.pairToken, amount: amountIn.toString() });
    check(route.ok === true && BigInt(route.amountOut) > 0n, `${what} ${label(address)}: /quote/pair prices the ${venue.pairSymbol} -> ETH leg (impact ${route.impactBps} bps)`);
    const leg = ctx.dapp.planPairLeg({
      venue,
      address,
      amountIn,
      route,
      slippageBps: SLIPPAGE_BPS,
      fees,
      nonces,
      now: Number(fees.timestamp) || nowSec(),
    });
    check(leg.reason === null && leg.txs.length === 2, `${what} ${label(address)}: planPairLeg builds approve + swap${leg.reason ? ' — ' + leg.reason : ''}`);
    legs.push({ address, amountIn, leg });
  }
  const before = await balances(venue.token, ctx.addresses, venue.pairToken);
  const raws = await signAll(ctx, legs.flatMap((l) => l.leg.txs.map((tx) => ({ address: l.address, tx }))));
  const hashes = await broadcast(venue.token, raws, what, stream.sid);
  const receipts = await landed(hashes, what);
  await stream.waitFor(receiptsIn(hashes), 10_000, `${what}: the stream pushed a landed receipt for every leg tx`);
  const after = await balances(venue.token, ctx.addresses, venue.pairToken);
  const gasBy = new Map();
  receipts.forEach((r) => gasBy.set(lc(r.from), (gasBy.get(lc(r.from)) || 0n) + r.fee));
  for (const { address, amountIn, leg } of legs) {
    const a = lc(address);
    check(before.get(a).pair - after.get(a).pair === amountIn, `${what} ${label(a)}: the leg spent exactly the ${venue.pairSymbol} the sell paid`);
    const eth = receivedWei({ ethBefore: before.get(a).eth, ethAfter: after.get(a).eth, gasCosts: [gasBy.get(a) || 0n] });
    check(eth >= leg.minOut && eth > 0n, `${what} ${label(a)}: received ${formatEther(eth)} ETH >= leg minOut ${formatEther(leg.minOut)}`);
  }
}

async function sellStep(ctx, venue, stream, pct, afterBlock, floor) {
  const what = `${venue.label} ${pct}%`;
  const mark = await freshMark(venue.token, afterBlock);
  const states = await statesAfter(ctx, venue.token, floor);
  const fees = await apiOk('GET', '/api/tp/fees');
  const want = new Map(states.map((s) => [lc(s.address), pctAmount(s.tokenBalance, pct)]));

  // Pools are priced by the server's quoter, exactly as the page does it: the
  // /quote body comes from plan.sellRequests and the answer is joined back with
  // plan.attachQuotes (planSell uses a quote only for the amount it was asked for).
  let quotes = new Map();
  if (venue.kind !== 'curve') {
    const sells = ctx.dapp.sellRequests({ wallets: states, pct });
    check(
      sells.length === 3 && sells.every((r) => BigInt(r.amount) === want.get(lc(r.address))),
      `${what}: sellRequests asks /quote for floor(balance x ${pct} / 100) per wallet`
    );
    const answer = await apiOk('POST', '/api/tp/quote', { token: venue.token, sells });
    check(
      Array.isArray(answer.quotes) && answer.quotes.length === 3 && answer.quotes.every((q) => q.ok && BigInt(q.amountOut) > 0n),
      `${what}: /quote prices every wallet's sell`
    );
    quotes = ctx.dapp.attachQuotes(sells, answer.quotes);
  }

  const before = await balances(venue.token, ctx.addresses, venue.nativeQuote ? null : venue.pairToken);
  const nonces = new ctx.dapp.NonceBook();
  for (const s of states) nonces.seed(s.address, Number(s.nonce));
  const plan = ctx.dapp.planSell({
    venue,
    mark,
    wallets: states,
    pct,
    slippageBps: SLIPPAGE_BPS,
    quotes,
    fees,
    nonces,
    now: Number(fees.timestamp) || nowSec(),
  });
  const sells = plan.filter((p) => p.tx);
  const skipped = plan.filter((p) => !p.tx);
  check(
    sells.length === 3 && skipped.length === 0,
    `${what}: planSell plans all 3 wallets${skipped.length ? ' (skipped: ' + skipped.map((p) => p.reason).join('; ') + ')' : ''}`
  );
  for (const p of sells) {
    check(BigInt(p.amount) === want.get(lc(p.address)), `${what} ${label(p.address)}: amount = floor(balance x ${pct} / 100)`);
    check(BigInt(p.minOut) > 0n && BigInt(p.minOut) <= BigInt(p.expectedOut), `${what} ${label(p.address)}: 0 < minOut <= expectedOut`);
  }

  const raws = await signAll(ctx, sells.map((p) => ({ address: p.address, tx: p.tx })));
  const t0 = Date.now();
  const hashes = await broadcast(venue.token, raws, what, stream.sid);
  const receipts = await landed(hashes, what);
  await stream.waitFor(receiptsIn(hashes), 10_000, `${what}: the stream pushed a landed receipt for every sell`);
  console.log(`info ${what}: broadcast -> every receipt on the stream in ${Date.now() - t0} ms`);
  const after = await balances(venue.token, ctx.addresses, venue.nativeQuote ? null : venue.pairToken);

  let sumExpected = 0n;
  let sumReceived = 0n;
  const got = [];
  for (let i = 0; i < sells.length; i++) {
    const p = sells[i];
    const a = lc(p.address);
    const sold = before.get(a).token - after.get(a).token;
    const received = venue.nativeQuote
      ? receivedWei({ ethBefore: before.get(a).eth, ethAfter: after.get(a).eth, gasCosts: [receipts[i].fee] })
      : after.get(a).pair - before.get(a).pair;
    got.push(received);
    check(sold === BigInt(p.amount), `${what} ${label(a)}: sold exactly the planned amount on-chain (${formatUnits(sold, venue.decimals)})`);
    check(
      received > 0n && received >= BigInt(p.minOut),
      `${what} ${label(a)}: received ${formatUnits(received, venue.pairDecimals)} ${venue.pairSymbol} >= minOut ${formatUnits(BigInt(p.minOut), venue.pairDecimals)}`
    );
    sumExpected += BigInt(p.expectedOut);
    sumReceived += received;
  }

  if (venue.kind === 'curve') {
    const order = receipts.map((r) => ({ hash: r.hash, blockNumber: r.blockNumber, index: r.index }));
    if (landedInOrder(hashes, order)) {
      // The HEAD of the click is priced off the live reserves alone, so it must
      // match the chain: exactly, or 1 wei over (the curve floors its fee and the
      // creator tax separately; the page's maths may floor their sum).
      const diff = got[0] - BigInt(sells[0].expectedOut);
      check(diff >= 0n && diff <= 1n, `${what} ${label(sells[0].address)}: the first sell matches the curve maths (off by ${diff} wei)`);
      sells.slice(1).forEach((p, i) =>
        console.log(`info ${what} ${label(p.address)}: received - planned = ${got[i + 1] - BigInt(p.expectedOut)} wei`)
      );
    } else {
      console.log(`note ${what}: the sells landed out of plan order; the per-wallet to-the-wei check does not apply`);
    }
    check(
      withinPpm(sumReceived, sumExpected, 1000, 3n),
      `${what}: total received ${formatUnits(sumReceived, venue.pairDecimals)} is within 0.1% of the planned ${formatUnits(sumExpected, venue.pairDecimals)}`
    );
  } else {
    console.log(`info ${what}: received ${formatEther(sumReceived)} ETH against quoted ${formatEther(sumExpected)}`);
  }

  // The chart's indexer reads its first hour back to back before it polls live; on a
  // fork every one of those windows is forwarded to the public RPC, which can be slow
  // or flaky. Generous, and the timeout names the indexer's status.
  await stream.waitFor(tradesIn(hashes), 180_000, `${what}: the indexer reported every sell as a trade on the stream`);

  // The pair leg signs on its own /wallets read: the sells it follows land first.
  await recordLanded(ctx, floor);
  if (!venue.nativeQuote) {
    await pairLeg(ctx, venue, stream, new Map(sells.map((p, i) => [p.address, got[i]])), `${what} pair leg`, floor);
  }
  // The next click's /wallets read must include everything this one sent.
  await recordLanded(ctx, floor);
  return Math.max(...receipts.map((r) => r.blockNumber));
}

async function runVenue(ctx, token, kind, extra) {
  const tag = extra.label || kind;
  let { venue, mark, info, figures } = await apiOk('GET', `/api/tp/token/${token}`);
  // GET /token waits for the mark alone (the sell click's fallback): a first answer
  // may come before the info read has; the page re-reads, and so does this.
  for (let i = 0; i < 5 && info === null; i += 1) {
    await sleep(2000);
    ({ venue, mark, info, figures } = await apiOk('GET', `/api/tp/token/${token}`));
  }
  venue.label = tag;
  const infoWrong = tokenInfoProblems(info, token);
  check(infoWrong.length === 0, `${tag}: /token's info holds its contract${infoWrong.length ? ' — ' + infoWrong.join('; ') : ''}`);
  const figWrong = figuresProblems(figures, kind);
  check(figWrong.length === 0, `${tag}: /token's figures hold for a ${kind}${figWrong.length ? ' — ' + figWrong.join('; ') : ''}`);
  await logoCheck(tag, token, info);
  check(venue.kind === kind, `${tag}: /token resolves the venue as '${kind}'`);
  check(lc(venue.token) === lc(token), `${tag}: venue.token is the pasted CA`);
  check(venue.nativeQuote === !extra.pair, `${tag}: the venue is ${extra.pair ? 'token' : 'ETH'}-quoted`);
  if (extra.pair) check(lc(venue.pairToken) === lc(extra.pair), `${tag}: venue.pairToken is the launch's pair token`);
  check(mark && typeof mark.price === 'number' && mark.price > 0, `${tag}: the mark price is a positive number`);
  if (kind === 'curve') check(lc(venue.curve) === lc(extra.curve), `${tag}: venue.curve is the factory's curve`);

  const sid = newSid();
  const stream = openStream(token, sid);
  stream.sid = sid;
  const stranger = openStream(token, null);
  try {
    await stream.waitFor((evs) => evs.some((e) => e.event === 'snapshot'), 30_000, `${tag}: the stream opened with a snapshot`);
    const snap = stream.events.find((e) => e.event === 'snapshot').data;
    check(stream.events[0].event === 'snapshot', `${tag}: the snapshot is the first event`);
    check(snap.sid === sid, `${tag}: the snapshot carries the page's own sid back`);
    check(Array.isArray(snap.bars) && Array.isArray(snap.trades), `${tag}: the snapshot carries bars and trades`);
    check('stats' in snap, `${tag}: the snapshot carries stats (null until the indexer has any)`);
    await stranger.waitFor((evs) => evs.some((e) => e.event === 'snapshot'), 30_000, `${tag}: a second viewer's stream opened`);
    const strangerSid = stranger.events.find((e) => e.event === 'snapshot').data.sid;
    check(/^[0-9a-f]{32}$/.test(strangerSid) && strangerSid !== sid, `${tag}: the second viewer got a sid of its own`);

    // The setup buys landed before this venue's first read: the floor starts at
    // where the chain has each wallet now, and every landing below raises it.
    const floor = new NonceFloor();
    await recordLanded(ctx, floor);

    const states = await statesAfter(ctx, token, floor);
    const t = new Contract(token, ERC20_ABI, provider);
    for (const s of states) {
      check(s.tokenBalance === (await t.balanceOf(s.address)).toString(), `${tag} ${label(s.address)}: /wallets tokenBalance equals balanceOf on-chain`);
    }

    await arm(ctx, venue, stream, floor);
    let lastTrade = extra.lastTradeBlock;
    for (const pct of [25, 50, 100]) lastTrade = await sellStep(ctx, venue, stream, pct, lastTrade, floor);

    const left = await balances(token, ctx.addresses, extra.pair || null);
    check([...left.values()].every((b) => b.token === 0n), `${tag}: after 100% every wallet holds 0 tokens`);
    if (extra.pair) check([...left.values()].every((b) => b.pair === 0n), `${tag}: and 0 ${venue.pairSymbol} — every sell's proceeds went on to ETH`);
    await stream.waitFor(barsSeen, 60_000, `${tag}: the stream delivered candles`);
    await stream.waitFor(
      (evs) => evs.some((e) => e.event === 'stats' && statsProblems(e.data).length === 0),
      30_000,
      `${tag}: a stats event followed the sells, in its contract`
    );
    check(
      !stranger.events.some((e) => e.event === 'receipt'),
      `${tag}: the second viewer's stream saw none of the page's receipts (${stranger.events.filter((e) => e.event === 'trades').length} trades batches, 0 receipts)`
    );
  } finally {
    await stream.close();
    await stranger.close();
  }
}

async function refusals(ctx, token, curve) {
  const what = 'guard';
  const notPons = await api('GET', `/api/tp/token/${WETH}`);
  check(notPons.status === 400 && notPons.json && notPons.json.code === 'not_pons', `${what}: /token refuses a contract that is not a pons launch (400 not_pons)`);

  const w0 = ctx.wallets[0];
  const fees = await apiOk('GET', '/api/tp/fees');
  const nonce = await provider.getTransactionCount(w0.address, 'pending');
  const stranger = Wallet.createRandom().address;
  const base = { nonce, maxFeePerGas: BigInt(fees.maxFeePerGas), maxPriorityFeePerGas: 0n, type: 2 };
  // Signed with ethers directly, not walletStore: none of these is something the
  // dApp would ever build, and each is refused for a different reason.
  const transfer = await w0.signTransaction({ ...base, to: stranger, value: 1n, data: '0x', gasLimit: 21_000n, chainId: CHAIN_ID });
  const foreign = await w0.signTransaction({
    ...base,
    to: token,
    value: 0n,
    data: erc20Iface.encodeFunctionData('approve', [curve, 1n]),
    gasLimit: 80_000n,
    chainId: 1,
  });
  const strangerApprove = await w0.signTransaction({
    ...base,
    to: token,
    value: 0n,
    data: erc20Iface.encodeFunctionData('approve', [stranger, 1n]),
    gasLimit: 80_000n,
    chainId: CHAIN_ID,
  });
  for (const [what2, txs, code] of [
    ['a plain ETH transfer', [transfer], 'bad_tx'],
    ['an approve signed for chain 1', [foreign], 'bad_tx'],
    ["an approve to a spender that is not this venue's", [strangerApprove], 'bad_tx'],
    ['101 transactions in one request', Array(101).fill(transfer), 'too_many'],
  ]) {
    const r = await api('POST', '/api/tp/broadcast', { token, txs });
    check(
      r.status === 400 && r.json && r.json.code === code,
      `${what}: /broadcast refuses ${what2} (400 ${code}${r.json && r.json.code !== code ? ', got ' + r.status + ' ' + r.json.code : ''})`
    );
  }
  await sleep(1500);
  check((await provider.getTransactionCount(w0.address, 'latest')) === nonce, `${what}: nothing refused reached the chain (nonce unchanged)`);
  check((await provider.getBalance(stranger)) === 0n, `${what}: the transfer's recipient received nothing`);
  const t = new Contract(token, ERC20_ABI, provider);
  check((await t.allowance(w0.address, stranger)) === 0n, `${what}: the stranger holds no allowance`);
}

async function gate() {
  const dappHtml = fs.readFileSync(DAPP_HTML, 'utf8');
  const consoleHtml = fs.existsSync(CONSOLE_HTML) ? fs.readFileSync(CONSOLE_HTML, 'utf8') : null;
  const dappHost = `127.0.0.1:${APP_PORT}`;
  const consoleHost = `localhost:${APP_PORT}`;

  const root = await rawRequest('GET', '/', dappHost);
  check(root.status === 200 && root.body === dappHtml, 'gate: the dApp host serves frontend/dist/dapp/index.html at /');
  check(root.headers['content-security-policy'] === PROD_CSP, 'gate: the page carries the production CSP header itself');
  check(root.headers['x-frame-options'] === 'DENY', 'gate: the page carries X-Frame-Options DENY');
  const deep = await rawRequest('GET', '/some/deep/link', dappHost);
  check(deep.status === 200 && deep.body === dappHtml, 'gate: any other page path on the dApp host is the dApp page');
  for (const [method, route] of [
    ['GET', '/api/health'],
    ['GET', '/api/wallets'],
    ['GET', '/API/wallets'],
    ['POST', '/api/wallets/export'],
    ['GET', '/api/v4/wallets/backup'],
    ['POST', '/api/v4/wallets/backup'],
    ['POST', '/api/v3/wallets/backup'],
  ]) {
    const r = await rawRequest(method, route, dappHost);
    check(r.status === 404, `gate: ${method} ${route} is 404 on the dApp host`);
  }
  // The console PAGE: its HTML is never what the dApp host answers, and the bundle
  // it loads (its own JS and CSS) is not served there either.
  if (consoleHtml) {
    const idx = await rawRequest('GET', '/index.html', dappHost);
    check(idx.body !== consoleHtml, 'gate: /index.html on the dApp host is not the console page');
    const consoleFiles = [...consoleHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    check(consoleFiles.length > 0, `gate: the console page loads ${consoleFiles.length} bundle file(s)`);
    for (const f of consoleFiles) {
      const r = await rawRequest('GET', f, dappHost);
      check(r.status === 404, `gate: the console's ${path.posix.basename(f)} is 404 on the dApp host (got ${r.status})`);
    }
  }
  const dappFiles = [...dappHtml.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  for (const f of dappFiles) {
    const r = await rawRequest('GET', f, dappHost);
    check(r.status === 200, `gate: the dApp's own ${path.posix.basename(f)} is served on the dApp host`);
  }
  const fees = await rawRequest('GET', '/api/tp/fees', dappHost);
  check(fees.status === 200, 'gate: /api/tp/fees answers on the dApp host');

  const health = await rawRequest('GET', '/api/health', consoleHost);
  check(health.status === 200, 'gate: the console host still answers /api/health');
  if (consoleHtml) {
    const consoleRoot = await rawRequest('GET', '/', consoleHost);
    check(consoleRoot.status === 200 && consoleRoot.body === consoleHtml, 'gate: the console host still serves the console at /');
  }
  const dappOnConsole = await rawRequest('GET', '/dapp/', consoleHost);
  check(dappOnConsole.status === 404, 'gate: the dApp page is 404 on the console host');
}

// The dApp account (spec Addendum v2 A) over the REAL server. A throwaway owner
// wallet made here signs in on the server-built message, saves a list (random bytes
// stand in for the ciphertext: the server never looks inside one), reads it back,
// loses a racing save with 409, and deletes it, which signs every session out. The
// account API is 404 on the console host. Prints booleans only: never the wallet,
// the signature or the cookie.
function accountRequest(method, route, { body, cookie, host = `127.0.0.1:${APP_PORT}` } = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = { host, 'x-real-ip': SCRIPT_IP, 'sec-fetch-site': 'same-origin' };
  if (method !== 'GET') {
    headers.origin = APP;
    headers['content-type'] = 'application/json';
  }
  if (cookie) headers.cookie = cookie;
  if (text !== undefined) headers['content-length'] = Buffer.byteLength(text);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: APP_PORT, path: route, method, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        out += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = out ? JSON.parse(out) : null;
        } catch (_err) {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

async function account() {
  const owner = Wallet.createRandom();
  const challenge = await accountRequest('POST', '/api/tp/account/nonce', { body: { address: owner.address } });
  check(challenge.status === 200, 'account: POST /api/tp/account/nonce answers on the dApp host');
  const lines = String(challenge.json.message).split(String.fromCharCode(10));
  check(
    lines[0] === `127.0.0.1:${APP_PORT} wants you to sign in with your Ethereum account:` &&
      lines.includes(`URI: ${APP}`) &&
      lines.includes('Chain ID: 4663'),
    'account: the sign-in message names this page (TP_SIWE_ORIGIN) and chain 4663'
  );
  const login = await accountRequest('POST', '/api/tp/account/login', {
    body: { nonce: challenge.json.nonce, signature: await owner.signMessage(challenge.json.message) },
  });
  const setCookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('__Host-tp_session='));
  check(login.status === 200 && Boolean(setCookie), 'account: login with the throwaway wallet sets the session cookie');
  check(
    ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'].every((a) => setCookie.includes(a)),
    'account: the cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/'
  );
  const cookie = setCookie.split(';')[0];
  const session = await accountRequest('GET', '/api/tp/account/me', { cookie });
  check(
    session.status === 200 && session.json.address === owner.address && session.json.vault === null,
    'account: GET /me knows the signed-in wallet, which has no saved list yet'
  );

  const b64 = (n) => crypto.randomBytes(n).toString('base64');
  const keyId = `0x${crypto.randomBytes(16).toString('hex')}`;
  const envelope = (baseRev) => ({ baseRev, kv: 1, keyId, iv: b64(12), ct: b64(512) });
  const first = envelope(0);
  const created = await accountRequest('PUT', '/api/tp/account/vault', { body: first, cookie });
  check(created.status === 200 && created.json.rev === 1, 'account: the first save creates the list (rev 1)');
  const read = await accountRequest('GET', '/api/tp/account/vault', { cookie });
  check(read.status === 200 && read.json.vault.ct === first.ct && read.json.vault.keyId === keyId, 'account: the list reads back byte for byte');
  const file = path.join(SCRATCH, 'tp-accounts', 'vaults', `${lc(owner.address)}.json`);
  check(fs.existsSync(file), 'account: the list is stored under TP_ACCOUNTS_DIR, in the scratch dir');
  const racing = await Promise.all([1, 1].map((rev) => accountRequest('PUT', '/api/tp/account/vault', { body: envelope(rev), cookie })));
  check(racing.map((r) => r.status).sort().join(',') === '200,409', 'account: two saves racing on one rev: one lands, the other is 409 conflict');
  const consoleSide = await accountRequest('GET', '/api/tp/account/me', { cookie, host: `localhost:${APP_PORT}` });
  check(consoleSide.status === 404, 'account: the account API is 404 on the console host');
  const del = await accountRequest('DELETE', '/api/tp/account/vault', { body: { baseRev: 2 }, cookie });
  check(del.status === 200 && del.json.deleted === true && !fs.existsSync(file), 'account: DELETE removes the list');
  const after = await accountRequest('GET', '/api/tp/account/me', { cookie });
  check(after.status === 401 && after.json.code === 'no_session', 'account: after the DELETE that session is signed out');
}

// Spec, Testing: the dApp's first load, without the lazy three.js chunk, stays
// under 250 KB gzipped. The gate is Part 07's frontend/scripts/dapp-size.mjs
// (first-load JS, gzip level 6 = nginx's gzip_comp_level). This adds the JS + CSS
// total at gzip -6 and -9, and that the scene is a lazy chunk kept out of it.
function sizeBudget() {
  const html = fs.readFileSync(DAPP_HTML, 'utf8');
  const read = (urlPath) => fs.readFileSync(path.join(DIST, urlPath.replace(/^\//, '')), 'utf8');
  const files = firstLoadFiles(html, read);
  const scene = files.lazy.filter((f) => /\/EmptyScene-[^/]+\.js$/.test(f));
  check(scene.length === 1, 'first load: the three.js scene is a lazy chunk (EmptyScene-*.js, reached only by import())');
  check(!files.js.some((f) => /EmptyScene-/.test(f)), 'first load: the scene chunk is not among the first-load files');
  const sum = (list, level) =>
    list.reduce((n, f) => n + zlib.gzipSync(fs.readFileSync(path.join(DIST, f.replace(/^\//, ''))), { level }).length, 0);
  const raw = [...files.js, ...files.css].reduce((n, f) => n + fs.statSync(path.join(DIST, f.replace(/^\//, ''))).size, 0);
  const js6 = sum(files.js, 6);
  const all6 = js6 + sum(files.css, 6);
  const all9 = sum(files.js, 9) + sum(files.css, 9);
  console.log(
    `info size first load = ${files.js.length} JS + ${files.css.length} CSS file(s): raw ${raw} B, gzip -6 ${all6} B (JS alone ${js6} B), gzip -9 ${all9} B; budget 250 KB = ${250 * 1024} B`
  );
  check(fs.existsSync(SIZE_SCRIPT), 'first load: frontend/scripts/dapp-size.mjs exists');
  const run = spawnSync(process.execPath, [SIZE_SCRIPT, DIST], { cwd: FRONTEND, encoding: 'utf8', windowsHide: true });
  const LF = String.fromCharCode(10);
  for (const line of `${run.stdout || ''}${run.stderr || ''}`.split(LF)) if (line.trim()) console.log(`info size ${line.trimEnd()}`);
  check(run.status === 0, 'first load: dapp-size.mjs passes — JS + CSS under 250 KB gzipped, no three.js in the first load');
}

// Every transaction the 3 wallets sent after `fromBlock`, with its receipt, oldest
// first. The fork mines only what this run and the page send (automine, no empty
// blocks), so this walks a few dozen blocks.
async function walletTxsSince(ctx, fromBlock) {
  const mine = new Set(ctx.addresses.map(lc));
  const head = await provider.getBlockNumber();
  const out = [];
  for (let n = fromBlock + 1; n <= head; n++) {
    const block = await provider.getBlock(n, true);
    const txs = block.prefetchedTransactions;
    for (const tx of txs) {
      if (!mine.has(lc(tx.from))) continue;
      const receipt = await provider.getTransactionReceipt(tx.hash);
      const ownInBlock = txs.filter((t) => lc(t.from) === lc(tx.from)).length;
      out.push({ tx, receipt, ownInBlock });
    }
  }
  return out;
}

// The UI's clicks on one venue, read back from the chain alone: per wallet, the
// token Transfer logs out of it (a reverted tx has none) folded per transaction.
async function verifyUiVenue(ctx, { kind, token, target, start, txs }) {
  const what = `ui ${kind}`;
  const end = await balances(token, ctx.addresses);
  for (const address of ctx.addresses) {
    const a = lc(address);
    const who = `${what} ${label(a)}`;
    const transfers = [];
    for (const { tx, receipt } of txs) {
      if (lc(tx.from) !== a || receipt.status !== 1) continue;
      for (const log of receipt.logs) {
        if (lc(log.address) !== lc(token) || log.topics[0] !== TRANSFER_TOPIC) continue;
        const ev = erc20Iface.parseLog(log);
        if (lc(ev.args.from) !== a) continue;
        transfers.push({ hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, amount: ev.args.value });
      }
    }
    const sold = soldPerTx(transfers);
    const want = clickAmounts(start.get(a).token, UI_PCTS);
    check(sold.length === UI_PCTS.length, `${who}: ${UI_PCTS.length} sell transactions on-chain, one per click (found ${sold.length})`);
    for (let i = 0; i < sold.length; i++) {
      const pct = UI_PCTS[i];
      const s = sold[i];
      check(
        s.amount === want[i],
        `${who}: the ${pct}% click sold exactly ${pct}% of what was left${s.amount === want[i] ? '' : ` (sold ${s.amount}, expected ${want[i]})`}`
      );
      const entry = txs.find((t) => lc(t.receipt.hash) === s.hash);
      check(lc(entry.tx.to) === lc(target), `${who}: the ${pct}% sell went to the ${kind === 'curve' ? 'curve' : 'UniversalRouter'}`);
      check(entry.ownInBlock === 1, `${who}: the ${pct}% sell is its wallet's only transaction in its block`);
      const received = receivedWei({
        ethBefore: await provider.getBalance(a, s.blockNumber - 1),
        ethAfter: await provider.getBalance(a, s.blockNumber),
        gasCosts: [entry.receipt.fee],
      });
      check(received > 0n, `${who}: the ${pct}% sell paid ${formatEther(received)} ETH into the wallet`);
    }
    check(end.get(a).token === 0n, `${who}: holds 0 tokens after the 100% click`);
  }
}

// ── v2: the logo route, the account, the UI run's wallet ────────────────────

// One request with an explicit Host, keeping the body as bytes (a logo).
function rawBytes(method, route, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: route, method, headers: { host, 'x-real-ip': SCRIPT_IP } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// GET /api/tp/logo/:ca on the dApp host (Part 02): an image, or a 404 the page
// turns into an identicon — never anything a browser could run. A 404 because
// every gateway (or the https host) was slow is a valid answer. `info` (GET
// /token's) sets the caching a served logo must carry (tpSmoke.logoProblems).
async function logoCheck(tag, token, info) {
  const r = await rawBytes('GET', `/api/tp/logo/${lc(token)}`, `127.0.0.1:${APP_PORT}`);
  const wrong = logoProblems(r, info);
  const what = r.status === 200 ? `a ${imageKind(r.bytes)}` : `${r.status}`;
  check(wrong.length === 0, `${tag}: /logo answered ${what}, within its contract${wrong.length ? ' — ' + wrong.join('; ') : ''}`);
}

// One browser's view of the dApp host, for the page's own api.js: a cookie jar of
// its own, the page's Origin on every request (a same-origin POST carries it) and
// this script's x-real-ip. A fetch-shaped function over node:http, which lets the
// script set Origin and Cookie itself, as the browser would.
function deviceTransport({ origin = APP } = {}) {
  const jar = createCookieJar();
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url, APP);
      const headers = { ...(init.headers || {}), host: u.host, origin, 'x-real-ip': SCRIPT_IP };
      const cookie = jar.header();
      if (cookie) headers.cookie = cookie;
      const req = http.request(
        { host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method || 'GET', headers },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => {
            jar.take(res.headers['set-cookie']);
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, json: async () => JSON.parse(text) });
          });
        }
      );
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}

const loadDapp = (rel) => import(pathToFileURL(path.join(FRONTEND, 'src', 'dapp', rel)).href);
const loadAccountLib = () => import(pathToFileURL(path.join(__dirname, 'lib', 'tpSmokeAccount.mjs')).href);
const plainWallets = (ctx) => ctx.wallets.map((w) => ({ address: w.address, privateKey: w.privateKey }));

// What reached the server's disk and log: ciphertext only. No bundle key and no
// bundle address, in any case, in any file under TP_ACCOUNTS_DIR; no key in the log.
function diskClean(what, wallets) {
  const root = path.join(SCRATCH, 'tp-accounts');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  const needles = wallets.flatMap((w) => [w.privateKey, w.address]);
  const found = files.reduce((n, f) => n + countHexIn(fs.readFileSync(f, 'latin1'), needles), 0);
  check(files.length > 0, `${what}: the account store wrote ${files.length} file(s) under TP_ACCOUNTS_DIR`);
  check(found === 0, `${what}: no file under TP_ACCOUNTS_DIR holds a bundle key or a bundle address`);
  const log = fs.readFileSync(path.join(SCRATCH, 'server.log'), 'latin1');
  check(countHexIn(log, wallets.map((w) => w.privateKey)) === 0, `${what}: the backend log holds no bundle key`);
}

// Spec Addendum A + C through the page's own modules, against this backend: a
// throwaway owner on two devices (scripts/lib/tpSmokeAccount.mjs), then a write
// from another site, then what reached the disk. Chain-free.
async function accountRun(ctx, token) {
  const lib = await loadAccountLib();
  const wallets = plainWallets(ctx);
  const r = await lib.accountRoundTrip({ load: loadDapp, transport: () => deviceTransport(), owner: Wallet.createRandom(), wallets, token, origin: APP });
  check(r.signedIn1 && r.unlocked1, `account: device 1 signed in and unlocked through the page's modules${r.error ? ' — ' + r.error : ''}`);
  check(r.signatures1 === 3, `account: a first visit asks the wallet for 3 signatures: sign-in, unlock, unlock again (${r.signatures1})`);
  check(r.saved, `account: device 1 saved the encrypted copy (rev ${r.rev})`);
  check(r.signedIn2 && r.unlocked2, `account: device 2 signed in and unlocked${r.error ? ' — ' + r.error : ''}`);
  check(r.signatures2 === 2, `account: device 2 needed 2 signatures: sign-in, one unlock (${r.signatures2})`);
  check(r.sameKey, 'account: both devices derived the same key id from the same wallet');
  check(r.walletsBack, 'account: device 2 got every wallet back, each key matching its address');
  check(r.positionsBack, "account: device 2 got every wallet's saved starting size back (the %-left bar's 100 %)");
  check(r.bodiesClean, `account: none of the ${r.requests} request bodies carries a bundle key or a bundle address`);
  const api = await loadDapp('api.js');
  let refused = '';
  try {
    await api.putVault(
      { baseRev: 0, kv: 1, keyId: '0x' + '0'.repeat(32), iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(24) },
      { fetch: deviceTransport({ origin: 'https://evil.example' }) }
    );
  } catch (e) {
    refused = String((e && e.cause && e.cause.status) || (e && e.message) || e);
  }
  check(refused === '403', `account: a write carrying another site's Origin is refused 403 (got ${refused || 'no refusal'})`);
  diskClean('account', wallets);
}

// The UI run's browser wallet: a throwaway owner key that lives in THIS process.
// It answers eth_requestAccounts / eth_accounts and personal_sign only, counts the
// signatures, and never sends a key anywhere. The page cannot reach it (its CSP
// allows connect-src 'self'): Playwright's Node side forwards the page's calls.
function startSigner(owner) {
  const counts = { signatures: 0, calls: 0 };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', async () => {
      const reply = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: { code: 4200, message: 'not found' } });
      counts.calls += 1;
      let msg = null;
      try {
        msg = JSON.parse(body);
      } catch (_err) {
        return reply(400, { error: { code: -32700, message: 'not JSON' } });
      }
      const method = msg && msg.method;
      const params = Array.isArray(msg && msg.params) ? msg.params : [];
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return reply(200, { result: [owner.address] });
      if (method === 'personal_sign') {
        if (lc(params[1]) !== lc(owner.address)) return reply(200, { error: { code: 4100, message: 'not this wallet' } });
        try {
          const signature = await owner.signMessage(getBytes(params[0]));
          counts.signatures += 1;
          return reply(200, { result: signature });
        } catch (_err) {
          return reply(200, { error: { code: -32602, message: 'not a hex message' } });
        }
      }
      return reply(200, { error: { code: 4200, message: 'unsupported method' } });
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, counts, url: `http://127.0.0.1:${srv.address().port}/rpc` }));
  });
}

async function stopSigner() {
  if (!signer) return;
  const s = signer;
  signer = null;
  if (typeof s.srv.closeAllConnections === 'function') s.srv.closeAllConnections();
  await new Promise((resolve) => s.srv.close(() => resolve()));
}

// The UI run's account, read back as the owner the page signed in with: the
// signature count, the 3 wallets, and on both tokens each wallet's saved starting
// size — the %-left bar's 100 % — ended (empty) after the 100 % click.
async function verifyUiAccount(ctx, { owner, curve, graduated, start }) {
  check(
    signer.counts.signatures === UI_SIGNATURES,
    `ui account: the page asked the wallet for ${UI_SIGNATURES} signatures (sign-in, unlock twice, one unlock after Lock; none on reloads) — got ${signer.counts.signatures}`
  );
  const lib = await loadAccountLib();
  const wallets = plainWallets(ctx);
  const copy = await lib.readAccountCopy({ load: loadDapp, transport: () => deviceTransport(), owner, origin: APP, expect: wallets });
  check(copy.error === '', `ui account: the owner reads the saved copy back${copy.error ? ' — ' + copy.error : ''}`);
  check(copy.sameWallets, 'ui account: the saved copy holds exactly the 3 imported wallets, each key matching');
  for (const [kind, token] of [
    ['curve', curve.token],
    ['graduated', graduated],
  ]) {
    const group = copy.positions[lc(token)] || {};
    for (const a of ctx.addresses.map(lc)) {
      const rec = group[a];
      const want = start[kind].get(a).token.toString();
      check(!!rec && rec.hwm === want, `ui account ${kind} ${label(a)}: the saved starting size is the balance the page first saw${rec ? '' : ' (no record)'}`);
      check(!!rec && rec.empty === true, `ui account ${kind} ${label(a)}: after the 100% click the saved position is ended (empty)`);
    }
  }
  diskClean('ui account', wallets);
}

async function hold(ctx, curve, graduated) {
  // Fresh positions for the page. The API run sold everything, and planArm
  // approves exactly the balance, which those sells used up — so the page has to
  // arm these wallets again on both venues.
  await buyCurve(ctx, curve.curve, 'ui setup');
  await buyGraduated(ctx, graduated, 'ui setup');
  const startBlock = await provider.getBlockNumber();
  const start = {
    curve: await balances(curve.token, ctx.addresses),
    graduated: await balances(graduated, ctx.addresses),
  };
  for (const [kind, held] of Object.entries(start)) {
    check([...held.values()].every((b) => b.token > 0n), `ui setup: all 3 wallets hold the ${kind} token again`);
  }
  fs.rmSync(STOP_FILE, { force: true });
  fs.writeFileSync(KEYS_FILE, ctx.wallets.map((w) => w.privateKey).join(os.EOL) + os.EOL, { mode: 0o600 });
  // The page's Connect wallet: a throwaway owner, never one of the bundle keys.
  const owner = Wallet.createRandom();
  signer = await startSigner(owner);
  console.log(`HOLD dApp ${APP}/`);
  console.log(`HOLD curve token ${curve.token}`);
  console.log(`HOLD graduated token ${graduated}`);
  console.log(`HOLD keys file (3 throwaway fork keys, removed on stop): ${slash(KEYS_FILE)}`);
  console.log(`HOLD signer (the page's Connect wallet, a throwaway owner key in this process): ${signer.url}`);
  console.log(`HOLD to finish, create: ${slash(STOP_FILE)}`);
  while (!fs.existsSync(STOP_FILE) && !interrupted) await sleep(1000);
  fs.rmSync(KEYS_FILE, { force: true });
  if (interrupted) throw new Error('interrupted before the STOP file was created: the UI run was not checked');

  const txs = await walletTxsSince(ctx, startBlock);
  console.log(`info ui: the page sent ${txs.length} transactions from the 3 wallets (expected 27: 3 + 6 approvals, 18 sells)`);
  const allowed = new Set([lc(curve.token), lc(curve.curve), lc(graduated), PERMIT2, UNIVERSAL_ROUTER]);
  check(txs.every((t) => allowed.has(lc(t.tx.to))), 'ui: every transaction the page sent went to a token (approve), the curve, Permit2 or the UniversalRouter');
  check(txs.every((t) => t.receipt.status === 1), 'ui: none of the transactions the page sent reverted');
  await verifyUiVenue(ctx, { kind: 'curve', token: curve.token, target: curve.curve, start: start.curve, txs });
  await verifyUiVenue(ctx, { kind: 'graduated', token: graduated, target: UNIVERSAL_ROUTER, start: start.graduated, txs });
  await verifyUiAccount(ctx, { owner, curve, graduated, start });
  await stopSigner();
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  check(fs.existsSync(DAPP_HTML), 'the dApp is built (frontend/dist/dapp/index.html) — else run: cd frontend && npm run build');
  const csp = cspProblems(fs.readFileSync(DAPP_HTML, 'utf8'));
  check(csp.length === 0, `the built dApp page can run under the production CSP${csp.length ? ' — ' + csp.join(', ') : ''}`);
  sizeBudget();
  if (SIZE_ONLY) {
    console.log(`PASS ${passed} checks — size budget only (no fork started)`);
    return;
  }
  check(!(await isListening(APP_PORT)), `port ${APP_PORT} is free`);
  if (ATTACH) {
    check(await isListening(ANVIL_PORT), `--attach: an anvil already listens on ${ANVIL_PORT}`);
  } else {
    check(fs.existsSync(ANVIL_BIN), 'anvil is installed');
    check(!(await isListening(ANVIL_PORT)), `port ${ANVIL_PORT} is free (else a previous run is still up; or pass --attach)`);
    anvil = startAnvil();
  }
  await waitForAnvil();
  // cacheTimeout -1: ethers otherwise answers an identical read made within 250 ms
  // from cache, and a balance read right after an instantly-mined fork tx comes
  // back as the balance from before it.
  provider = new JsonRpcProvider(FORK_RPC, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 200 });
  check(true, 'anvil forked chain 4663 on 127.0.0.1:8546');
  // Mine one block at once: every block's pre-execution touches the chain's system
  // contracts (the EIP-2935 block-hash store), and anvil panics when the upstream can
  // no longer serve their state ("historical state ... is not available") — measured
  // when a run's first block came a couple of minutes after the fork.
  if (!ATTACH) await provider.send('anvil_mine', ['0x1']);

  const wallets = [0, 1, 2].map(() => new Wallet(Wallet.createRandom().privateKey, provider));
  wallets.forEach((w, i) => labels.set(lc(w.address), `w${i + 1}`));
  for (const w of wallets) {
    await provider.send('anvil_setBalance', [w.address, '0x' + FUND_WEI.toString(16)]);
    check((await provider.getCode(w.address)) === '0x', `${label(w.address)}: a plain EOA on the fork (no 7702 code)`);
    check((await provider.getBalance(w.address)) === FUND_WEI, `${label(w.address)}: funded with ${formatEther(FUND_WEI)} fork ETH`);
  }

  // The browser's own modules, loaded as ES modules.
  const load = (rel) => import(pathToFileURL(path.join(FRONTEND, 'src', 'dapp', rel)).href);
  const [plan, noncesMod, store] = await Promise.all([load('chain/plan.js'), load('chain/nonces.js'), load('keys/walletStore.js')]);
  const dapp = {
    planArm: plan.planArm,
    planSell: plan.planSell,
    planPairLeg: plan.planPairLeg,
    sellRequests: plan.sellRequests,
    attachQuotes: plan.attachQuotes,
    NonceBook: noncesMod.NonceBook,
    signTx: store.signTx,
  };
  const { added } = store.addWallets(wallets.map((w) => ({ address: w.address, privateKey: w.privateKey })));
  check(added === 3, 'walletStore holds the 3 throwaway keys');
  const ctx = { wallets, addresses: wallets.map((w) => w.address), dapp };

  // The backend first, and every venue resolved the moment its token is picked. A
  // fork serves state it has not read yet from the upstream node, and the public RPC
  // keeps a block's state only for a few minutes (measured: "historical state ... is
  // not available" soon after the fork starts). What is read early stays cached by
  // anvil for the rest of the run, the UI run included.
  server = startServer();
  await waitForServer();
  check(true, `the backend is up on ${APP} with DAPP_HOST=127.0.0.1`);
  const warmVenue = async (token) => {
    const r = await api('GET', `/api/tp/token/${token}`);
    if (r.status !== 200) throw new Error(`GET /api/tp/token/${token} answered ${r.status}: ${r.json && r.json.code} ${r.json && r.json.error}`);
  };

  // --pair: the token-quoted venue, on 3 wallets of its own (a setup that fails
  // half-way cannot leave a stuck nonce in the main wallets), set up AND run first,
  // while the fork's upstream still serves the fork block's state.
  let pairCurve = null;
  if (PAIR) {
    const pw = [0, 1, 2].map(() => new Wallet(Wallet.createRandom().privateKey, provider));
    pw.forEach((w, i) => labels.set(lc(w.address), `p${i + 1}`));
    for (const w of pw) await provider.send('anvil_setBalance', [w.address, '0x' + FUND_WEI.toString(16)]);
    const added = store.addWallets(pw.map((w) => ({ address: w.address, privateKey: w.privateKey })));
    check(added.added === 3, 'walletStore holds 3 more throwaway keys for the token-quoted venue');
    const pairCtx = { wallets: pw, addresses: pw.map((w) => w.address), dapp };
    let pairBuyBlock = 0;
    try {
      pairCurve = await pickPairCurveToken();
      if (pairCurve) {
        await warmVenue(pairCurve.token);
        const pt = new Contract(pairCurve.pair, ERC20_ABI, provider);
        pairCurve.pairSymbol = await pt.symbol();
        pairCurve.pairDecimals = Number(await pt.decimals());
        console.log(`info token-quoted curve token ${pairCurve.token} (pair ${pairCurve.pairSymbol} ${pairCurve.pair})`);
        pairBuyBlock = await buyPairCurve(pairCtx, pairCurve, 'pair-curve setup');
      } else {
        console.log('note no token-quoted curve with an ETH route was found: that venue is SKIPPED');
      }
    } catch (err) {
      console.log(`note the token-quoted setup failed (${err.message}): that venue is SKIPPED`);
      pairCurve = null;
    }
    if (pairCurve) {
      await runVenue(pairCtx, pairCurve.token, 'curve', {
        label: `pair-curve(${pairCurve.pairSymbol})`,
        curve: pairCurve.curve,
        pair: pairCurve.pair,
        lastTradeBlock: pairBuyBlock,
      });
    }
  }

  const curve = await pickCurveToken(ctx);
  check(curve !== null, 'found a live ETH-quoted pons v2 curve token with room for the buys');
  console.log(`info curve token ${curve.token}`);
  await warmVenue(curve.token);
  const curveBuyBlock = await buyCurve(ctx, curve.curve, 'curve setup');

  let graduated = null;
  let graduatedBuyBlock = 0;
  try {
    graduated = await pickGraduatedToken();
  } catch (err) {
    console.log(`note the graduated scan failed: ${err.message}`);
  }
  if (graduated) {
    console.log(`info graduated token ${graduated}`);
    await warmVenue(graduated);
    graduatedBuyBlock = await buyGraduated(ctx, graduated, 'graduated setup');
  } else if (REQUIRE_GRADUATED) {
    throw new Error(`no ETH-quoted graduated pons token found${HOLD ? ' (--hold needs one for the UI run)' : ''} — set TP_SMOKE_GRADUATED_TOKEN=<CA>`);
  }

  await gate();
  await account();
  await accountRun(ctx, curve.token);
  await runVenue(ctx, curve.token, 'curve', { curve: curve.curve, lastTradeBlock: curveBuyBlock });
  await refusals(ctx, curve.token, curve.curve);
  if (graduated) await runVenue(ctx, graduated, 'graduated', { lastTradeBlock: graduatedBuyBlock });

  if (HOLD) await hold(ctx, curve, graduated);

  console.log(
    `PASS ${passed} checks — account: sign-in and the saved-list round trip; curve: 25/50/100% from 3 wallets; graduated: ${graduated ? 'PASS' : 'SKIPPED (none found)'}` +
      `; token-quoted: ${pairCurve ? `PASS (${pairCurve.pairSymbol})` : PAIR ? 'SKIPPED (setup)' : 'not run (--pair)'}` +
      '; account: 2 devices, wallets and positions back' +
      (HOLD ? '; ui: 25/50/100% on both venues (chips on the curve, row buttons on the pool) and the account, checked on-chain' : '')
  );
}

async function cleanup() {
  try {
    fs.rmSync(KEYS_FILE, { force: true });
    fs.rmSync(STOP_FILE, { force: true });
  } catch (_err) {
    // best effort; the cleanup step removes the folder too
  }
  await stopSigner();
  await stopChild(server);
  await stopChild(anvil);
  if (provider) provider.destroy();
  for (const fd of logFds) {
    try {
      fs.closeSync(fd);
    } catch (_err) {
      // already closed
    }
  }
  if (KEEP) {
    console.log(`kept scratch dir ${slash(SCRATCH)} (logs; delete it yourself)`);
  } else {
    process.chdir(os.tmpdir());
    fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(
    SIZE_ONLY
      ? 'cleaned up: scratch removed (no fork or server was started)'
      : `cleaned up: ${ATTACH ? 'server stopped (the attached anvil is left running)' : 'fork and server stopped'}, key file ${KEEP ? 'removed' : 'and scratch removed'}`
  );
}

process.on('SIGINT', () => {
  interrupted = true;
  if (!HOLD) process.exit(130);
});
process.on('exit', () => {
  try {
    fs.rmSync(KEYS_FILE, { force: true });
  } catch (_err) {
    // nothing to remove
  }
  for (const child of [server, anvil]) {
    try {
      if (child && child.exitCode === null) child.kill();
    } catch (_err) {
      // already gone
    }
  }
});

let exitCode = 0;
main()
  .catch((err) => {
    exitCode = 1;
    console.error(`FAIL ${err.message}`);
    // The backend never sees a key, so its log is safe to show; it goes with the
    // scratch dir otherwise (rerun with --keep to keep it).
    if (server) console.error(`last lines of the backend log:${String.fromCharCode(10)}${tail('server.log', 30)}`);
  })
  .then(cleanup)
  .catch((err) => {
    exitCode = 1;
    console.error(`FAIL during cleanup: ${err.message}`);
  })
  .then(() => process.exit(exitCode));
