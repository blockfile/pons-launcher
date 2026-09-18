'use strict';

// Per-IP limits for the public /api/tp surface, with no new dependency.
//
//   reads      120 / min per IP     (TP_READS_PER_MIN)
//   broadcast  600 tx / min per IP  (TP_BROADCAST_TX_PER_MIN) — sells, swaps and anything
//                                    else that is not an approval; costed per raw tx
//   approvals  300 tx / min per IP  (TP_APPROVE_TX_PER_MIN) — ERC-20 approve and
//                                    Permit2 approve; a SEPARATE bucket
//   streams    5 open per IP         (TP_STREAMS_PER_IP)
//
// WHY TWO BROADCAST BUCKETS, AND WHY 600. One 100-wallet visitor arming a graduated
// token sends 200 approvals (token -> Permit2, Permit2 -> router); a token-quoted curve
// sends 100 curve approvals and, with its first sell, 100 pair-token approvals. In the
// spec's single 300 tx/min bucket that left room for ONE sell click, and the next click
// — the one a take-profit page exists for — was refused 429. So approvals draw from
// their own bucket and can never spend the sell budget, and the sell bucket holds three
// 100-wallet clicks a minute even with a pair leg each (100 sells + 100 pair swaps). A
// refused approval is recoverable (Retry-After, re-arm); a refused sell click is the
// worst failure this page can have. Both are env-tunable (backend/.env.example).
//
// nginx's limit_req is the first line; this is the copy that holds if nginx is
// mis-edited or bypassed on the box.
//
// THE CLIENT IP. server.js does not set `trust proxy` (and must not: it would make
// req.hostname honour a client-supplied X-Forwarded-Host and open the host gate), so
// behind nginx req.ip is 127.0.0.1 for EVERY visitor — one shared bucket. clientIp()
// takes X-Real-IP instead, but only when the TCP peer is loopback, i.e. the request
// came through our own nginx, which overwrites that header with $remote_addr.

const { decodeRlp } = require('ethers');
const { TpError } = require('./errors');

const posNum = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const LIMITS = Object.freeze({
  readsPerMin: posNum(process.env.TP_READS_PER_MIN, 120),
  broadcastTxPerMin: posNum(process.env.TP_BROADCAST_TX_PER_MIN, 600),
  approveTxPerMin: posNum(process.env.TP_APPROVE_TX_PER_MIN, 300),
  streamsPerIp: posNum(process.env.TP_STREAMS_PER_IP, 5),
});

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clientIp(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || req.ip || '');
  if (LOOPBACK.has(peer)) {
    const real = req.headers && req.headers['x-real-ip'];
    if (typeof real === 'string') {
      const ip = real.trim();
      if (ip && ip.length <= 64) return ip;
    }
  }
  return peer || 'unknown';
}

/**
 * Token buckets keyed by string, as GCRA (the "theoretical arrival time" form of a
 * token bucket): capacity `max`, refilled continuously at `max` per `windowMs`.
 * Integer maths whenever windowMs is a multiple of max, so tests are exact.
 *
 * take(key, cost) -> { ok: true, remaining } | { ok: false, retryAfterMs }
 * peek(key, cost) -> the same answer, without spending anything
 */
function tokenBuckets({ windowMs, max, now = Date.now, maxKeys = 20000 } = {}) {
  if (!(windowMs > 0) || !(max > 0)) throw new TypeError('tokenBuckets: windowMs and max must be positive');
  const interval = windowMs / max; // ms per token
  const tat = new Map(); // key -> theoretical arrival time (ms)

  function prune(t) {
    for (const [k, v] of tat) if (v <= t) tat.delete(k); // full again — forget it
    for (const k of tat.keys()) {
      if (tat.size <= maxKeys) break;
      tat.delete(k); // still over: drop the oldest keys
    }
  }

  function evaluate(key, cost) {
    const t = now();
    const n = Math.min(max, Math.max(1, Math.ceil(Number(cost) || 1)));
    const k = String(key);
    const base = Math.max(tat.get(k) || t, t);
    const next = base + n * interval;
    if (next - t > windowMs) return { ok: false, retryAfterMs: Math.ceil(next - t - windowMs), t, k, next };
    return { ok: true, remaining: Math.floor((windowMs - (next - t)) / interval), t, k, next };
  }

  function peek(key, cost = 1) {
    const r = evaluate(key, cost);
    return r.ok ? { ok: true, remaining: r.remaining } : { ok: false, retryAfterMs: r.retryAfterMs };
  }

  function take(key, cost = 1) {
    const r = evaluate(key, cost);
    if (!r.ok) return { ok: false, retryAfterMs: r.retryAfterMs };
    tat.set(r.k, r.next);
    if (tat.size > maxKeys) prune(r.t);
    return { ok: true, remaining: r.remaining };
  }

  return { take, peek, size: () => tat.size };
}

/**
 * Express middleware. Refuses with 429 TpError('rate_limited') and a Retry-After header.
 *
 * `max` is either a number (one bucket; `cost(req)` returns a number — a broadcast
 * costs one per tx) or named buckets `{ name: max }` (then `cost(req)` returns
 * `{ name: count }`; a name it leaves out or sets to 0 is not charged, and a request
 * that charges nothing is charged one token of the first bucket). A request is charged
 * all-or-nothing: if any of its buckets would refuse it, none is spent.
 */
function rateLimit({ windowMs, max, key = clientIp, cost = () => 1, now = Date.now } = {}) {
  const single = typeof max === 'number';
  const names = single ? ['default'] : Object.keys(max || {});
  if (names.length === 0) throw new TypeError('rateLimit: max must be a number or { bucket: number }');
  const buckets = {};
  for (const name of names) buckets[name] = tokenBuckets({ windowMs, max: single ? max : max[name], now });

  function charges(c) {
    if (single) return [['default', c]];
    const out = [];
    const given = c && typeof c === 'object' ? c : {};
    for (const name of names) {
      const n = Number(given[name]);
      if (Number.isFinite(n) && n > 0) out.push([name, n]);
    }
    return out.length ? out : [[names[0], 1]];
  }

  function tpRateLimit(req, res, next) {
    let k;
    let list;
    try {
      k = key(req);
      list = charges(cost(req));
    } catch (_err) {
      k = clientIp(req);
      list = [[names[0], 1]];
    }
    const refused = list.map(([name, n]) => buckets[name].peek(k, n)).filter((r) => !r.ok);
    if (refused.length === 0) {
      for (const [name, n] of list) buckets[name].take(k, n);
      return next();
    }
    const retryAfterMs = Math.max(...refused.map((r) => r.retryAfterMs));
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return next(new TpError('rate_limited', 'too many requests from this address — wait a moment and retry', 429));
  }
  tpRateLimit.buckets = buckets;
  return tpRateLimit;
}

// ── the broadcast cost: approvals vs everything else ─────────────────────────

// ERC-20 approve(address,uint256) and Permit2 approve(address,address,uint160,uint48):
// the only approvals the broadcast allowlist accepts (golden selectors pinned by
// constants.test.js). Any other selector, and anything that does not parse as a
// transaction, is charged to the sell bucket — a malformed raw can never be passed
// off as a cheap approval.
const APPROVE_SELECTORS = new Set(['0x095ea7b3', '0x87517c45']);
// The broadcast validator's per-request cap: a longer list is refused 'too_many', so it
// is charged by count and never parsed.
const MAX_CLASSIFIED = 100;
// A sell is < 2 KiB; nothing longer is worth decoding here.
const MAX_RAW_CHARS = 2 + 2 * 131072;
const TYPE2_PREFIX = /^0x02/i;

/**
 * The 4-byte selector (lower-case) of a signed raw EIP-1559 transaction, or null.
 * Type 2 only — the only type the dApp signs (contract: txRequest.type 2); any other
 * type is charged to the sell bucket. The RLP list is walked, not parsed into an
 * ethers Transaction: no hash, no signer recovery, ~15 µs a tx against ~70 µs, so
 * classifying a 100-tx sell click costs ~1.5 ms. Field 7 of the type-2 list
 * [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data,
 * accessList, yParity, r, s] is the calldata.
 */
function txSelector(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_CHARS || !TYPE2_PREFIX.test(raw)) return null;
  try {
    const fields = decodeRlp(`0x${raw.slice(4)}`);
    const data = Array.isArray(fields) && fields.length === 12 ? fields[7] : null;
    return typeof data === 'string' && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
  } catch (_err) {
    return null;
  }
}

/** cost() for the broadcast limiter: { send, approve } counts for one POST /broadcast body. */
function broadcastCost(req) {
  const txs = req && req.body && Array.isArray(req.body.txs) ? req.body.txs : null;
  if (!txs || txs.length === 0) return { send: 1 };
  if (txs.length > MAX_CLASSIFIED) return { send: txs.length };
  let approve = 0;
  for (const raw of txs) if (APPROVE_SELECTORS.has(txSelector(raw))) approve += 1;
  return { send: txs.length - approve, approve };
}

/** Open-stream slots per IP. acquire() false = over the limit; release() exactly once per true. */
function createStreamSlots({ perIp = LIMITS.streamsPerIp } = {}) {
  const open = new Map();
  return {
    acquire(ip) {
      const k = String(ip);
      const n = open.get(k) || 0;
      if (n >= perIp) return false;
      open.set(k, n + 1);
      return true;
    },
    release(ip) {
      const k = String(ip);
      const n = open.get(k) || 0;
      if (n <= 1) open.delete(k);
      else open.set(k, n - 1);
    },
    count(ip) {
      return open.get(String(ip)) || 0;
    },
  };
}

const streamSlots = createStreamSlots();

module.exports = {
  LIMITS,
  clientIp,
  tokenBuckets,
  rateLimit,
  broadcastCost,
  txSelector,
  APPROVE_SELECTORS,
  createStreamSlots,
  streamSlots,
};
