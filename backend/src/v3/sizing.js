'use strict';

/**
 * How many tokens to sell to raise a given amount of ETH.
 *
 * Pure arithmetic — no provider, no keystore, no network. That is deliberate:
 * this is the one piece of V3 whose correctness can be settled by a test rather
 * than by watching a chain, and keeping I/O out of it is what makes the
 * round-trip property below provable instead of merely observed.
 *
 * THE CURVE, FORWARD:
 *
 *   gross = quoteReserve · tokensIn / (tokenReserve + tokensIn)
 *   out   = gross − gross · (feeBps + creatorTaxBps) / BPS
 *
 * Constant product: the curve keeps the tokens and gives up quote, fees taken
 * off the top. This is the same shape v2's holdings.quoteSellOut computes, and
 * it is rewritten here rather than imported because V3 shares no module with
 * the launchers' money paths.
 *
 * THE CURVE, INVERTED — which is what this file is actually for:
 *
 * Given a target `T` we must RAISE, find the tokens to sell. Undo the fee to
 * get the gross needed, then solve the product for tokensIn:
 *
 *   gross    = T · BPS / (BPS − feeBps − creatorTaxBps)
 *   gross · (tokenReserve + tokensIn) = quoteReserve · tokensIn
 *   tokensIn = gross · tokenReserve / (quoteReserve − gross)
 *
 * `quoteReserve − gross` is why a target can be refused: the denominator goes
 * to zero as the target approaches the whole reserve, and past it turns
 * negative. A constant-product curve only ever approaches its reserve
 * asymptotically, so "sell enough to extract more than the curve holds" has no
 * answer at any size and must be an error rather than a very large number.
 *
 * EVERY DIVISION ROUNDS UP. Not tidiness — direction. Rounding down can leave
 * the sell a wei short of the target, and a cycle that raises less than it
 * needs cannot pay for the transfer it just sold tokens for, which stops the
 * run. Rounding up oversells by dust. The test asserts the round trip holds for
 * every shape, including reserves chosen so that every division has a
 * remainder to drop.
 *
 * HEADROOM IS STRUCTURAL, NOT CAUTION. minQuoteOut is 0 on every V3 sell, so
 * the number this file returns is a quote and not a promise: anything that
 * lands between the quote and the sell moves the price. The headroom is applied
 * to the target BEFORE solving, so the refusal above also accounts for it — a
 * target the curve can pay but the padded target cannot is refused, because the
 * padded one is what will actually be sold.
 */

const BPS = 10_000n;

// What the spec settled on, and what the engine passes when it does not say.
const SELL_HEADROOM_PCT = 10;

/** Ceiling division for positive BigInts. */
function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/**
 * What selling `tokensIn` raises, net of fee and creator tax.
 *
 * Rounds DOWN, the way the contract does, so it is never optimistic about what
 * a sell will return.
 *
 * @returns {bigint} wei
 */
function quoteSellOut({ tokensIn, quoteReserve, tokenReserve, feeBps = 0, creatorTaxBps = 0 }) {
  const amount = BigInt(tokensIn);
  if (amount <= 0n) return 0n;

  const t = BigInt(tokenReserve);
  const q = BigInt(quoteReserve);
  const denom = t + amount;
  if (denom <= 0n) return 0n;

  const gross = (q * amount) / denom;
  const taken = (gross * (BigInt(feeBps) + BigInt(creatorTaxBps))) / BPS;
  const out = gross - taken;
  return out > 0n ? out : 0n;
}

/**
 * How many tokens to sell so that at least `targetWei` arrives.
 *
 * @param {bigint} input.targetWei what must be raised, before headroom
 * @param {number} [input.headroomPct] defaults to SELL_HEADROOM_PCT
 * @returns {bigint} tokens, in the token's own base units
 * @throws when the curve cannot pay the padded target at any size
 */
function tokensToRaise({
  targetWei,
  quoteReserve,
  tokenReserve,
  feeBps = 0,
  creatorTaxBps = 0,
  headroomPct = SELL_HEADROOM_PCT,
}) {
  const target = BigInt(targetWei);
  if (target <= 0n) throw new Error('the sell target must be positive');

  const t = BigInt(tokenReserve);
  if (t <= 0n) throw new Error('the curve holds no tokens to sell into');

  const q = BigInt(quoteReserve);
  const takenBps = BigInt(feeBps) + BigInt(creatorTaxBps);
  if (takenBps >= BPS) {
    throw new Error(`fee + creator tax is ${takenBps} bps, which takes the whole sell — nothing can be raised`);
  }

  // Headroom first, so everything below — including the refusal — is about the
  // amount that will actually be sold.
  const padded = ceilDiv(target * BigInt(100 + headroomPct), 100n);

  // Undo the fee to reach the gross the curve must give up.
  const gross = ceilDiv(padded * BPS, BPS - takenBps);

  if (gross >= q) {
    throw new Error(
      `the curve cannot pay ${padded} wei at any size — it holds ${q} wei of quote reserve, and a ` +
        'constant-product curve only approaches its reserve, never reaches it'
    );
  }

  return ceilDiv(gross * t, q - gross);
}

module.exports = { BPS, SELL_HEADROOM_PCT, quoteSellOut, tokensToRaise, _private: { ceilDiv } };
