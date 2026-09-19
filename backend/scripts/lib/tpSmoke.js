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

// What a fork says when it could not serve a read from its upstream: the public RPC
// throttled it (anvil: "failed to get storage ... HTTP error 429"), pruned the fork
// block's state, or dropped the connection. Never a contract's own revert.
const UPSTREAM_HICCUP =
  /\b429\b|too many requests|failed to get (storage|account|block|code)|historical state|rate.?limit|timed? ?out|econnreset|econnrefused|socket hang up|fetch failed/i;

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
  return UPSTREAM_HICCUP.test(parts.filter((p) => p !== undefined && p !== null).join(' | '));
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

module.exports = {
  isUpstreamHiccup,
  withRetry,
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
};
