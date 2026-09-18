'use strict';

// Pure log → Trade decoding for the take-profit chart. No I/O: the indexer fills
// `ts` from its block → timestamp cache (the public RPC returns blockTimestamp 0x0).
//
// One event source per venue kind (spec "Trade events, confirmed live"; re-probed
// on chain 4663 for this plan):
//
//   curve      CurveBuy / CurveSell, emitted BY THE CURVE (venue.curve; for a graduated
//              venue its dead venue.formerCurve, so pre-graduation history still
//              decodes). In no repo ABI — the topic hashes and word layout were read
//              off live logs:
//                CurveBuy  data [quoteIn, tokensOut, fee, tax]  topic1 caller, topic2 recipient
//                CurveSell data [tokensIn, quoteOut, fee, tax]  topic1 seller, topic2 recipient
//              (154 of 2,090 live logs had topic1 ≠ topic2: on buys topic1 was the
//              contract the tx called and topic2 the tx sender; on sells topic1 was
//              the tx sender.) Word 3 is NOT always 0 — 1,181 of those 2,090 logs
//              carried a tax there — so only words 0-1 are read.
//   graduated  Uniswap v4 PoolManager Swap(id, sender, amount0, amount1, sqrtPriceX96,
//              liquidity, tick, fee). The amounts are the SWAPPER's BalanceDelta:
//              negative = the swapper paid that currency in, positive = it was paid
//              out. Checked live on 0x07ebb29a…: a buy logged amount0 −0.0198 ETH,
//              amount1 +1717.14 tokens, and the tokens moved PoolManager → buyer.
//              `sender` is the router (or the pons meme hook's own fee swap).
//   v1         Uniswap v3 pool Swap(sender, recipient, amount0, amount1, sqrtPriceX96,
//              liquidity, tick). The amounts are the POOL's balance delta — the
//              opposite convention: positive = the pool received it.
//
// Price = quote per token in human units (execution price of that trade). A figure
// that cannot be computed (missing decimals, a zero side) makes the log decode to
// null — never a guessed number (memory: launcher-eth-pair-unit-bugs).

const { TOPICS, POOL_MANAGER, WETH } = require('./constants');

const ZERO = '0x0000000000000000000000000000000000000000';
const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

const lc = (s) => String(s || '').toLowerCase();

/** 32-byte word `i` of a hex data field, as an unsigned bigint, or null if short. */
function wordAt(data, i) {
  const hex = String(data || '');
  const start = 2 + i * 64;
  const w = hex.slice(start, start + 64);
  return w.length === 64 ? BigInt('0x' + w) : null;
}

/** Two's-complement read of a 256-bit word (int128/int256 are sign-extended by the ABI). */
function signed(u) {
  return u >= TWO_255 ? u - TWO_256 : u;
}

function topicAddress(topic) {
  const t = lc(topic);
  return t.length === 66 ? '0x' + t.slice(26) : null;
}

/** A number from an ethers number, a bigint, or a hex/decimal RPC string. */
function toInt(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v !== '') {
    try {
      return Number(BigInt(v));
    } catch {
      return NaN;
    }
  }
  return NaN;
}

/** Quote per token in human units, or null when it cannot be computed. */
function priceOf(quoteAmt, tokenAmt, quoteDecimals, tokenDecimals) {
  if (quoteAmt <= 0n || tokenAmt <= 0n) return null;
  const shift = Number(tokenDecimals) - Number(quoteDecimals);
  const p = (Number(quoteAmt) / Number(tokenAmt)) * 10 ** shift;
  return Number.isFinite(p) && p > 0 ? p : null;
}

const abs = (x) => (x < 0n ? -x : x);

function decodeCurve(log, topics) {
  const w0 = wordAt(log.data, 0);
  const w1 = wordAt(log.data, 1);
  if (w0 === null || w1 === null) return null;
  if (topics[0] === lc(TOPICS.CURVE_BUY)) {
    return { side: 'buy', quoteAmt: w0, tokenAmt: w1, trader: topicAddress(topics[2]) };
  }
  return { side: 'sell', tokenAmt: w0, quoteAmt: w1, trader: topicAddress(topics[1]) };
}

function decodeV4(log, topics, venue) {
  const key = venue.poolKey || {};
  const token = lc(venue.token);
  let tokenIs1;
  if (lc(key.currency1) === token) tokenIs1 = true;
  else if (lc(key.currency0) === token) tokenIs1 = false;
  else return null; // a pool key that does not hold the token is not this venue
  const a0 = wordAt(log.data, 0);
  const a1 = wordAt(log.data, 1);
  if (a0 === null || a1 === null) return null;
  const d0 = signed(a0);
  const d1 = signed(a1);
  const q = tokenIs1 ? d0 : d1;
  const k = tokenIs1 ? d1 : d0;
  // swapper's view: negative = paid in
  let side;
  if (q < 0n && k > 0n) side = 'buy';
  else if (q > 0n && k < 0n) side = 'sell';
  else return null;
  return { side, quoteAmt: abs(q), tokenAmt: abs(k), trader: topicAddress(topics[2]) };
}

function decodeV3(log, topics, venue) {
  const a0 = wordAt(log.data, 0);
  const a1 = wordAt(log.data, 1);
  if (a0 === null || a1 === null) return null;
  const token = lc(venue.token);
  const pair = venue.pairToken && lc(venue.pairToken) !== ZERO ? lc(venue.pairToken) : lc(WETH);
  // Uniswap v3 sorts token0 < token1; Task 2 reads it off token0() (evm/pricing.js:56).
  const tokenIs0 =
    typeof venue.tokenIsToken0 === 'boolean' ? venue.tokenIsToken0 : BigInt(token) < BigInt(pair);
  const d0 = signed(a0);
  const d1 = signed(a1);
  const k = tokenIs0 ? d0 : d1;
  const q = tokenIs0 ? d1 : d0;
  // pool's view: positive = the pool received it
  let side;
  if (k > 0n && q < 0n) side = 'sell';
  else if (k < 0n && q > 0n) side = 'buy';
  else return null;
  return { side, quoteAmt: abs(q), tokenAmt: abs(k), trader: topicAddress(topics[2]) };
}

/**
 * @param {object} log   an ethers Log or a raw eth_getLogs entry
 * @param {object} venue the token's Venue (venue.js)
 * @returns {null | {block, logIndex, tx, ts, side, tokenAmt, quoteAmt, price, trader}}
 */
function decodeLog(log, venue) {
  if (!log || !venue || log.removed) return null;
  const topics = Array.isArray(log.topics) ? log.topics.map(lc) : [];
  if (topics.length < 3) return null; // every source here has two indexed fields
  const address = lc(log.address);
  const t0 = topics[0];

  const curve = venue.curve || venue.formerCurve;
  let d = null;
  if ((t0 === lc(TOPICS.CURVE_BUY) || t0 === lc(TOPICS.CURVE_SELL)) && curve && address === lc(curve)) {
    d = decodeCurve(log, topics);
  } else if (
    t0 === lc(TOPICS.V4_SWAP) &&
    venue.poolId &&
    address === lc(POOL_MANAGER) &&
    topics[1] === lc(venue.poolId)
  ) {
    d = decodeV4(log, topics, venue);
  } else if (t0 === lc(TOPICS.V3_SWAP) && venue.pool && address === lc(venue.pool)) {
    d = decodeV3(log, topics, venue);
  }
  if (!d || !d.trader) return null;

  const price = priceOf(d.quoteAmt, d.tokenAmt, venue.pairDecimals, venue.decimals);
  if (price === null) return null;
  const block = toInt(log.blockNumber);
  const logIndex = toInt(log.index !== undefined ? log.index : log.logIndex);
  if (!Number.isSafeInteger(block) || !Number.isSafeInteger(logIndex)) return null;
  const ts = log.blockTimestamp !== undefined ? toInt(log.blockTimestamp) : 0;

  return {
    block,
    logIndex,
    tx: lc(log.transactionHash),
    ts: Number.isSafeInteger(ts) && ts > 0 ? ts : 0,
    side: d.side,
    tokenAmt: d.tokenAmt.toString(),
    quoteAmt: d.quoteAmt.toString(),
    price,
    trader: d.trader,
  };
}

module.exports = { decodeLog, priceOf };
