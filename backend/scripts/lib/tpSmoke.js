'use strict';

// Pure helpers for scripts/tp-fork-smoke.js, split out so they can be tested
// offline (scripts/lib/tpSmoke.test.js). No ethers, no network, no fs, no keys.
// No escape sequences (memory: write-tool-escapes): control characters are built
// with String.fromCharCode.

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/**
 * The amount one % click sells from one wallet: floor(balance x pct / 100), and
 * EXACTLY the balance at 100 % — the rule the spec gives chain/plan.js. The smoke
 * run clicks whole percentages only.
 */
function pctAmount(balance, pct) {
  const b = BigInt(balance);
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
    throw new Error(`pct must be a whole number in 1..100, got ${pct}`);
  }
  if (b < 0n) throw new Error('a balance cannot be negative');
  return pct === 100 ? b : (b * BigInt(pct)) / 100n;
}

/**
 * What a run of % clicks sells from one wallet, click by click: each click takes
 * pctAmount of what the clicks before it left. [25, 50, 100] on 1000 sells 250,
 * then 375, then 375 — the UI checklist's three clicks.
 */
function clickAmounts(balance, pcts) {
  let left = BigInt(balance);
  const out = [];
  for (const pct of pcts) {
    const amount = pctAmount(left, pct);
    out.push(amount);
    left -= amount;
  }
  return out;
}

/** What a sell paid out: the wallet's ETH change plus the gas it spent in the same span. */
function receivedWei({ ethBefore, ethAfter, gasCosts = [] }) {
  let spent = 0n;
  for (const g of gasCosts) spent += BigInt(g);
  return BigInt(ethAfter) - BigInt(ethBefore) + spent;
}

/** |actual - expected| <= expected x ppm / 1e6, or <= floorWei when that is larger. */
function withinPpm(actual, expected, ppm, floorWei = 0n) {
  const a = BigInt(actual);
  const e = BigInt(expected);
  const diff = a > e ? a - e : e - a;
  let tolerance = (e * BigInt(ppm)) / 1000000n;
  if (tolerance < BigInt(floorWei)) tolerance = BigInt(floorWei);
  return diff <= tolerance;
}

/**
 * getLogs ranges of `size` blocks, newest first, ending at `head`, at most `count`
 * of them, never below block 0. Sequential windows because this chain's nodes
 * refuse spans over 10k blocks and degrade under concurrent getLogs
 * (evm/v2/holdings.js LOG_WINDOW).
 */
function newestFirstWindows(head, size, count) {
  const out = [];
  let to = Number(head);
  for (let i = 0; i < count && to >= 0; i++) {
    const from = Math.max(0, to - size + 1);
    out.push({ from, to });
    to = from - 1;
  }
  return out;
}

/**
 * Did the transactions land in the order they were planned? Only then can a curve
 * sell be compared to its planned expectedOut to the wei, because the planner
 * walks the reserves forward in plan order.
 * @param {string[]} plannedHashes
 * @param {{hash:string, blockNumber:number, index:number}[]} receipts
 */
function landedInOrder(plannedHashes, receipts) {
  const pos = new Map();
  for (const r of receipts) pos.set(String(r.hash).toLowerCase(), [Number(r.blockNumber), Number(r.index)]);
  let prev = null;
  for (const h of plannedHashes) {
    const p = pos.get(String(h).toLowerCase());
    if (!p) return false;
    if (prev && (p[0] < prev[0] || (p[0] === prev[0] && p[1] <= prev[1]))) return false;
    prev = p;
  }
  return true;
}

/**
 * One wallet's outgoing token Transfer logs folded into one entry per
 * transaction (a token that splits a transfer still counts once per tx), oldest
 * first by block, then position in the block.
 * @param {{hash:string, blockNumber:number, txIndex:number, amount:bigint|string}[]} transfers
 * @returns {{hash:string, blockNumber:number, txIndex:number, amount:bigint}[]} hash lower-cased
 */
function soldPerTx(transfers) {
  const byHash = new Map();
  for (const t of transfers) {
    const hash = String(t.hash).toLowerCase();
    const seen = byHash.get(hash);
    if (seen) seen.amount += BigInt(t.amount);
    else byHash.set(hash, { hash, blockNumber: Number(t.blockNumber), txIndex: Number(t.txIndex), amount: BigInt(t.amount) });
  }
  return [...byHash.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex);
}

/**
 * An incremental text/event-stream parser: push(text) returns the events the text
 * completed, as {event, data}, with data JSON-decoded when it parses. Handles
 * chunks split anywhere, CRLF, comment lines and multi-line data.
 */
function createSseParser() {
  let buffer = '';
  let event = 'message';
  let data = [];
  let out = [];

  function onLine(rawLine) {
    const line = rawLine.endsWith(CR) ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      if (data.length) {
        const text = data.join(LF);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (_err) {
          parsed = text;
        }
        out.push({ event, data: parsed });
      }
      event = 'message';
      data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return {
    push(text) {
      out = [];
      buffer += String(text);
      let at = buffer.indexOf(LF);
      while (at !== -1) {
        onLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf(LF);
      }
      return out;
    },
  };
}

/**
 * Would this built HTML page run under the production CSP (script-src 'self';
 * style-src 'self' 'unsafe-inline')? Returns what would be blocked: inline
 * scripts, inline event handlers, and script/style/icon URLs off this origin.
 */
function cspProblems(html) {
  const problems = [];
  const lower = String(html).toLowerCase();
  let at = lower.indexOf('<script');
  while (at !== -1) {
    const end = lower.indexOf('>', at);
    const tag = lower.slice(at, end === -1 ? lower.length : end + 1);
    if (!tag.includes(' src=')) problems.push('inline <script>');
    at = lower.indexOf('<script', end === -1 ? lower.length : end + 1);
  }
  for (const attr of ['onload=', 'onerror=', 'onclick=']) {
    if (lower.includes(` ${attr}`)) problems.push(`inline handler ${attr}`);
  }
  for (const prefix of ['src="http', "src='http", 'href="http', "href='http", 'src="//', 'href="//']) {
    if (lower.includes(prefix)) problems.push(`off-origin URL (${prefix})`);
  }
  return problems;
}

/**
 * The files a built page loads FIRST, as root-relative URL paths: the module
 * script, its modulepreloads and stylesheets (from the HTML), plus every chunk
 * those import STATICALLY, transitively (`read(urlPath)` returns a chunk's code).
 * A dynamic import() — the lazy three.js scene — is not followed; its chunks are
 * returned separately as `lazy`. Mirrors frontend/scripts/dapp-size.mjs's crawl,
 * but keeps the CSS so the smoke run can report JS + CSS.
 * @returns {{js: string[], css: string[], lazy: string[]}}
 */
function firstLoadFiles(html, read) {
  const attr = (tag, name) => {
    const m = new RegExp(`${name}="([^"]+)"`).exec(tag);
    return m ? m[1] : null;
  };
  const tags = (name) => String(html).match(new RegExp(`<${name}[^>]*>`, 'g')) || [];
  const scripts = tags('script').filter((t) => /type="module"/.test(t)).map((t) => attr(t, 'src')).filter(Boolean);
  const links = tags('link');
  const preloads = links.filter((t) => /rel="modulepreload"/.test(t)).map((t) => attr(t, 'href')).filter(Boolean);
  const css = links.filter((t) => /rel="stylesheet"/.test(t)).map((t) => attr(t, 'href')).filter(Boolean);
  const resolve = (from, rel) => {
    const parts = from.split('/').slice(0, -1);
    for (const seg of rel.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  };
  const staticRe = /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]+?from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g;
  const dynamicRe = /import\(\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]\s*\)/g;
  const js = [];
  const lazy = new Set();
  const queue = [...scripts, ...preloads];
  while (queue.length) {
    const file = queue.shift();
    if (js.includes(file)) continue;
    js.push(file);
    const code = String(read(file));
    for (const m of code.matchAll(staticRe)) queue.push(resolve(file, m[1]));
    for (const m of code.matchAll(dynamicRe)) lazy.add(resolve(file, m[1]));
  }
  return { js, css, lazy: [...lazy].filter((f) => !js.includes(f)) };
}

// What a fork says when it could not serve a read from its upstream for a while: the
// public RPC throttled it (anvil: "failed to get storage ... HTTP error 429") or
// dropped the connection. Never a contract's own revert.
const UPSTREAM_HICCUP =
  /\b429\b|too many requests|failed to get (storage|account|block|code)|rate.?limit|timed? ?out|econnreset|econnrefused|socket hang up|fetch failed/i;
// ... except pruned history: once the public RPC stops serving the fork block's state
// it never serves it again, so retrying only burns the backoff. That fails at once.
const UPSTREAM_GONE = /historical state .* is not available|missing trie node|state (is )?not available/i;

/**
 * Did this read fail because the fork's upstream could not serve it, rather than
 * because the contract reverted? ethers v6 turns anvil's internal error on an
 * eth_call into a CALL_EXCEPTION whose message is the generic "missing revert
 * data" — the same words as a genuine data-less revert — and keeps anvil's text in
 * `info.error.message`, so every layer is read.
 */
function isUpstreamHiccup(err) {
  if (!err) return false;
  const parts = [err.message, err.shortMessage, err.code];
  if (err.info && err.info.error) parts.push(err.info.error.message, err.info.error.code);
  if (err.error) parts.push(err.error.message, err.error.code);
  if (err.cause) parts.push(err.cause.message, err.cause.code);
  const text = parts.filter((p) => p !== undefined && p !== null).join(' | ');
  return !UPSTREAM_GONE.test(text) && UPSTREAM_HICCUP.test(text);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn(attempt)` until it resolves, retrying only errors `retryable` accepts
 * (default: isUpstreamHiccup), waiting baseMs x 1, 2, 4, ... between attempts. The
 * last error surfaces once `attempts` are spent; a non-retryable one at once.
 */
async function withRetry(fn, { attempts = 6, baseMs = 2000, sleep = pause, retryable = isUpstreamHiccup } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !retryable(err)) throw err;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

/**
 * Wait for a transaction's receipt by reading it every `pollMs` until the node has
 * one (landed or reverted), or `timeoutMs` passes. NOT ethers' waitForTransaction:
 * that reads the head N, then the receipt, and a tx mined in N+1 between the two
 * has "0 confirmations" and sleeps until a NEXT block — which an automining fork
 * that goes idle after its last tx never mines. A failed read counts as "not yet".
 */
async function pollReceipt(getReceipt, hash, { timeoutMs = 60_000, pollMs = 200, sleep = pause, now = Date.now } = {}) {
  const t0 = now();
  for (;;) {
    let receipt = null;
    try {
      receipt = await getReceipt(hash);
    } catch (_err) {
      receipt = null;
    }
    if (receipt) return receipt;
    if (now() - t0 >= timeoutMs) {
      throw new Error(`no receipt for ${hash} within ${Math.round(timeoutMs / 1000)} s`);
    }
    await sleep(pollMs);
  }
}

// ── v2: the account's cookie, the logo route, the token header's facts ────────

/**
 * A one-origin cookie jar for the smoke's account requests (Node's fetch keeps
 * none). take() reads Set-Cookie lines: name=value before the first ';'; an
 * empty value, Max-Age of 0 or less, or an Expires in the past removes the
 * cookie. header() writes the Cookie request header. Path, Secure, HttpOnly and
 * SameSite are not enforced: the smoke talks to one origin, over plain http on
 * 127.0.0.1, exactly as the page does in Chromium there.
 */
function createCookieJar() {
  const jar = new Map();
  return {
    take(setCookie) {
      const lines = setCookie === undefined || setCookie === null ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
      for (const line of lines) {
        const parts = String(line).split(';');
        const eq = parts[0].indexOf('=');
        if (eq <= 0) continue;
        const name = parts[0].slice(0, eq).trim();
        const value = parts[0].slice(eq + 1).trim();
        const attrs = parts.slice(1).map((p) => p.trim());
        const gone =
          value === '' ||
          attrs.some((a) => {
            const lower = a.toLowerCase();
            if (lower.startsWith('max-age=')) return !(Number(a.slice(8)) > 0);
            if (lower.startsWith('expires=')) return Date.parse(a.slice(8)) <= Date.now();
            return false;
          });
        if (gone) jar.delete(name);
        else jar.set(name, value);
      }
    },
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    has(name) {
      return jar.has(name);
    },
    names() {
      return [...jar.keys()];
    },
  };
}

/** How many of `needles` (hex strings, with or without 0x) occur in `text`, ignoring case. */
function countHexIn(text, needles) {
  const hay = String(text).toLowerCase();
  return needles.filter((n) => {
    const hex = String(n).toLowerCase();
    return hay.includes(hex.startsWith('0x') ? hex.slice(2) : hex);
  }).length;
}

const IMAGE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** 'png' | 'jpeg' | 'gif' | 'webp' by magic bytes, else null (an SVG is null). */
function imageKind(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  const at = (i, list) => list.every((x, j) => b[i + j] === x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return null;
}

/**
 * GET /api/tp/logo/:ca's answer against the route's contract, as a list of what
 * it breaks (empty = fine). Every answer: nosniff, CSP default-src 'none', CORP
 * same-origin. A 200: a PNG/JPEG/GIF/WebP body whose Content-Type matches its
 * magic bytes. A 404 is a valid answer (no usable logo, or the gateways failed):
 * the page draws its identicon.
 *
 * `info` (GET /token's info, optional) sets the caching a served logo must carry:
 * a raw CID (bafkrei..., the file's own sha-256) is verified and cached immutable;
 * a dag-pb CID or a logo on an https host is only a gateway's or a host's word,
 * cached for exactly a day (tp/logo.js UNVERIFIED_TTL_MS). Without info either of
 * the two is accepted.
 * @param {{status: number, headers: object, bytes: Uint8Array|null}} res  headers with lower-case names
 */
function logoProblems({ status, headers, bytes }, info) {
  const out = [];
  const h = (k) => String((headers && headers[k]) || '');
  if (status !== 200 && status !== 404) out.push(`status ${status}`);
  if (h('x-content-type-options').toLowerCase() !== 'nosniff') out.push('no X-Content-Type-Options: nosniff');
  if (!h('content-security-policy').includes("default-src 'none'")) out.push("CSP is not default-src 'none'");
  if (h('cross-origin-resource-policy') !== 'same-origin') out.push('CORP is not same-origin');
  if (status === 200) {
    const kind = imageKind(bytes);
    if (!kind) out.push('the body is not a PNG, JPEG, GIF or WebP');
    else if (h('content-type') !== IMAGE_TYPES[kind]) out.push(`content-type ${h('content-type')} for a ${kind}`);
    const cc = h('cache-control');
    const logo = info && info.logo ? info.logo : null;
    const raw = Boolean(logo && typeof logo.cid === 'string' && logo.cid.startsWith('bafkrei'));
    const day = cc === 'public, max-age=86400';
    if (logo && raw && !cc.includes('immutable')) out.push('a raw-CID logo is not cached immutable');
    else if (logo && !raw && !day) out.push('an unverified logo is not cached for exactly a day');
    else if (!logo && !cc.includes('immutable') && !day) out.push('a logo is cached neither immutable nor for a day');
  }
  return out;
}

const INFO_KEYS = [
  'token',
  'version',
  'name',
  'symbol',
  'description',
  'socials',
  'logo',
  'creator',
  'creatorFeeRecipient',
  'launchedAt',
  'launchedBefore',
  'graduationThreshold',
  'phantomQuote',
  'launchSupply',
];
const SOCIAL_KEYS = ['x', 'telegram', 'discord', 'website', 'farcaster'];
const DECIMAL = /^[0-9]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What GET /api/tp/token/:ca's `info` breaks of Part 02's TokenInfo, as a list (empty = fine). */
function tokenInfoProblems(info, token) {
  if (!info || typeof info !== 'object') return ['info is missing'];
  const ca = String(token).toLowerCase();
  const out = [];
  for (const k of INFO_KEYS) if (!(k in info)) out.push(`info.${k} is missing`);
  if (info.token !== ca) out.push('info.token is not the CA');
  if (info.version !== 'v2' && info.version !== 'v1') out.push('info.version is not v2 or v1');
  for (const k of ['name', 'symbol', 'description']) if (typeof info[k] !== 'string') out.push(`info.${k} is not text`);
  if (typeof info.description === 'string' && info.description.length > 1000) out.push('info.description is over 1000 characters');
  const socials = info.socials && typeof info.socials === 'object' ? info.socials : {};
  for (const k of SOCIAL_KEYS) {
    const v = socials[k];
    if (v !== null && !(typeof v === 'string' && v.startsWith('https://'))) out.push(`info.socials.${k} is not an https URL or null`);
  }
  // An IPFS logo is {cid, path}; one on an https host is {path} alone (its URL never
  // leaves the server). Nothing else, and never a URL the page could load.
  const logoKeys = info.logo && typeof info.logo === 'object' ? Object.keys(info.logo).sort().join(',') : '';
  const logoOk =
    info.logo === null ||
    (info.logo.path === `/api/tp/logo/${ca}` && (logoKeys === 'path' || (logoKeys === 'cid,path' && typeof info.logo.cid === 'string')));
  if (!logoOk) out.push('info.logo is not {cid?, path: /api/tp/logo/<ca>} or null');
  if (info.creator !== null && !ADDRESS.test(String(info.creator))) out.push('info.creator is not an address or null');
  if (info.version === 'v2') {
    if (!Number.isSafeInteger(info.launchedAt) || info.launchedAt <= 0) out.push('info.launchedAt is not a unix time (v2)');
    for (const k of ['graduationThreshold', 'phantomQuote', 'launchSupply']) {
      if (!DECIMAL.test(String(info[k]))) out.push(`info.${k} is not a decimal string (v2)`);
    }
  }
  return out;
}

/** What `figures` breaks for this venue kind ('curve' | 'graduated'), as a list (empty = fine). */
function figuresProblems(figures, kind) {
  if (!figures || typeof figures !== 'object') return ['figures are missing'];
  const out = [];
  if (kind === 'curve') {
    if (!(typeof figures.progress === 'number' && figures.progress >= 0 && figures.progress <= 1)) out.push('curve progress is not 0..1');
    if (!DECIMAL.test(String(figures.raised))) out.push('curve raised is not a decimal string');
  } else {
    if (figures.progress !== 1) out.push('a graduated token is not at progress 1');
    const q = figures.liquidity && figures.liquidity.quote;
    if (!DECIMAL.test(String(q)) || BigInt(q) <= 0n) out.push('pool liquidity (quote side) is not above 0');
  }
  return out;
}

const WINDOWS = ['m5', 'h1', 'h24'];

/** What a stream `stats` payload breaks of Part 02's Stats, as a list (empty = fine). */
function statsProblems(stats) {
  if (!stats || typeof stats !== 'object') return ['stats are missing'];
  const out = [];
  if (!Number.isSafeInteger(stats.at)) out.push('stats.at is not a unix time');
  for (const group of ['change', 'volume', 'complete']) {
    const g = stats[group];
    if (!g || typeof g !== 'object') {
      out.push(`stats.${group} is missing`);
      continue;
    }
    for (const k of WINDOWS) if (!(k in g)) out.push(`stats.${group}.${k} is missing`);
  }
  const change = stats.change && typeof stats.change === 'object' ? stats.change : {};
  for (const k of WINDOWS) {
    if (k in change && change[k] !== null && !Number.isFinite(change[k])) out.push(`stats.change.${k} is not a number or null`);
  }
  if (!stats.figures || typeof stats.figures !== 'object') out.push('stats.figures is missing');
  return out;
}

/**
 * The nonce each wallet's next `/wallets` read has to reach before that read may
 * be built on.
 *
 * The page keeps ONE NonceBook for a session, and `seed()` never moves a counter
 * backwards, so a stale wallet read cannot hand the page a nonce it has already
 * spent. The smoke seeds a FRESH NonceBook for every step from the read it just
 * took, so it has no such protection: a `/wallets` answer taken before the step
 * before it landed (a fork still answering `pending` from a moment ago, or
 * ethers' 250 ms cache of an identical earlier read) makes the whole step sign at
 * nonces the chain has already used, and every transaction is refused with
 * "nonce has already been used".
 *
 * So every landing this run causes — an arm's approvals as much as a click's
 * sells — raises its wallet's floor, and a read is taken through `waitFor`.
 * A wallet the floor was never told about is refused outright rather than
 * trusted: that silence is what let the hole exist (the floor used to start empty
 * at each venue's first sell, and an empty floor clears anything).
 *
 * Counts only, never an address: this file's output is quoted in the smoke's log.
 */
class NonceFloor {
  constructor() {
    this.floor_ = new Map();
  }

  /** Raise `address`'s floor. Never lowers it. */
  record(address, nonce) {
    const k = String(address).toLowerCase();
    const v = Number(nonce);
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('nonce must be a non-negative integer');
    const cur = this.floor_.get(k);
    if (cur === undefined || v > cur) this.floor_.set(k, v);
  }

  /** The floor known for a wallet, or undefined. */
  get(address) {
    return this.floor_.get(String(address).toLowerCase());
  }

  /** How a `/wallets` read measures up: how many wallets are unknown, how many behind. */
  measure(states) {
    const list = Array.isArray(states) ? states : [];
    let unknown = 0;
    let behind = 0;
    for (const s of list) {
      const floor = this.get(s && s.address);
      if (floor === undefined) unknown += 1;
      else if (Number(s.nonce) < floor) behind += 1;
    }
    return { unknown, behind, total: list.length };
  }

  /**
   * Read until every wallet's nonce shows what this run landed, then answer that
   * read. An unknown wallet throws at once: the caller did not record what it
   * landed, so no read of that wallet can be judged.
   */
  async waitFor(read, { timeoutMs = 15_000, pauseMs = 300, sleep = pause } = {}) {
    const t0 = Date.now();
    for (;;) {
      const states = await read();
      const { unknown, behind, total } = this.measure(states);
      if (unknown > 0) {
        throw new Error(
          `no landing recorded for ${unknown} of ${total} wallet(s) — record the chain's nonce before reading`
        );
      }
      if (behind === 0) return states;
      if (Date.now() - t0 >= timeoutMs) {
        throw new Error(
          `/wallets kept answering nonces from before this run's last landing for ${Math.round(
            timeoutMs / 1000
          )} s (${behind} of ${total} wallets)`
        );
      }
      await sleep(pauseMs);
    }
  }
}

module.exports = {
  isUpstreamHiccup,
  NonceFloor,
  withRetry,
  pollReceipt,
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
  createCookieJar,
  countHexIn,
  imageKind,
  logoProblems,
  tokenInfoProblems,
  figuresProblems,
  statsProblems,
};
