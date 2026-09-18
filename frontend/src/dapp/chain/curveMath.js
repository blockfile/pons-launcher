// Exact pons v2 bonding-curve sell maths, in the browser.
//
// A BigInt port of backend/src/tp/quote.js curveSellOut (Task 4), which was
// checked to the wei against a LIVE CurveSell on chain 4663 (curve
// 0xEBfCaFE39ED532cfBaB07FC53c8A26AFC77f0C76, block 66473033, tx 0xce7c9da9...a8f6).
// curveMath.test.js replays that sell and 200 seeded cases against the CommonJS
// function, so the two cannot drift.
//
// What the live sell proved, and what this file therefore does:
//   gross = floor(quoteReserve * tokensIn / (tokenReserve + tokensIn))
//   out   = gross - floor(gross * curveFeeBps / 10000) - floor(gross * creatorTaxBps / 10000)
//   the curve's quote reserve falls by the GROSS (fee and tax leave the curve too)
//   and its token reserve rises by tokensIn.
// The fee and the tax are floored SEPARATELY. backend/src/evm/v2/holdings.js:447
// floors their sum and comes out 1 wei low (467695541613799670 against the
// chain's ...671); bundle/prepareSell.js:313 walks the reserve by the NET and
// prices every later wallet too high. Neither is copied here.

const BPS = 10000n;

function bps(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new RangeError(`${what} must be an integer 0..10000`);
  return BigInt(n);
}

/**
 * What the curve gives up for `tokensIn`, before fee and tax.
 * @param {{quoteReserve: bigint|string, tokenReserve: bigint|string}} reserves
 * @param {bigint|string} tokensIn
 * @returns {bigint}
 */
export function curveSellGross({ quoteReserve, tokenReserve }, tokensIn) {
  const amount = BigInt(tokensIn);
  if (amount <= 0n) return 0n;
  const q = BigInt(quoteReserve);
  const t = BigInt(tokenReserve);
  if (q <= 0n || t + amount <= 0n) return 0n;
  return (q * amount) / (t + amount);
}

/**
 * Exact sell quote: quote base units the seller receives, net of the curve fee
 * and the creator tax, each floored on its own as the contract does.
 * Both fee fields are REQUIRED: a caller still passing the old summed `feeBps`
 * must fail loudly, not be priced fee-free.
 * @param {{quoteReserve, tokenReserve, curveFeeBps: number, creatorTaxBps: number}} reserves
 * @param {bigint|string} tokensIn token base units sold
 * @returns {bigint}
 */
export function quoteCurveSell({ quoteReserve, tokenReserve, curveFeeBps, creatorTaxBps }, tokensIn) {
  if (curveFeeBps == null || creatorTaxBps == null) {
    throw new TypeError('quoteCurveSell needs curveFeeBps and creatorTaxBps separately (the curve floors each on its own)');
  }
  const fee = bps(curveFeeBps, 'curveFeeBps');
  const tax = bps(creatorTaxBps, 'creatorTaxBps');
  if (fee + tax > BPS) throw new RangeError('curve fee plus creator tax exceed 100%');
  const gross = curveSellGross({ quoteReserve, tokenReserve }, tokensIn);
  const out = gross - (gross * fee) / BPS - (gross * tax) / BPS;
  return out > 0n ? out : 0n;
}

/**
 * The reserves after one sell has landed: the curve gives up the GROSS and keeps
 * the tokens. Every other field (the fees) is carried over.
 */
export function applyCurveSell(reserves, tokensIn) {
  const amount = BigInt(tokensIn);
  const q = BigInt(reserves.quoteReserve);
  const t = BigInt(reserves.tokenReserve);
  if (amount <= 0n) return { ...reserves, quoteReserve: q, tokenReserve: t };
  const gross = curveSellGross({ quoteReserve: q, tokenReserve: t }, amount);
  return { ...reserves, quoteReserve: q - gross, tokenReserve: t + amount };
}

/**
 * The reserves after sells totalling `totalIn` have landed, in ANY order and any
 * split: the token reserve exactly, the quote reserve as the LOWEST it can be.
 *
 * One sell leaves q' = q - floor(q*a/(t+a)) = ceil(q*t/(t+a)), so q*t never
 * falls; whatever the order, q >= ceil(q0*t0 / (t0 + totalIn)). This is the
 * order-free stand-in for "walk every other sell of the click first".
 */
export function curveReservesAfterAny(reserves, totalIn) {
  const total = BigInt(totalIn);
  const q = BigInt(reserves.quoteReserve);
  const t = BigInt(reserves.tokenReserve);
  if (total <= 0n) return { ...reserves, quoteReserve: q, tokenReserve: t };
  const T = t + total;
  return { ...reserves, quoteReserve: (q * t + T - 1n) / T, tokenReserve: T };
}

/**
 * The least `tokensIn` can receive when it lands AFTER sells totalling `othersIn`
 * from these reserves, in any order — or after only some of them, or none, which
 * pays more. 1 wei is taken off because `out` is not monotone in the gross by up
 * to 1 wei (fee and tax can each step up by one as the gross rises by one).
 */
export function curveSellWorst(reserves, tokensIn, othersIn) {
  const out = quoteCurveSell(curveReservesAfterAny(reserves, othersIn), tokensIn);
  return out > 1n ? out - 1n : 0n;
}
