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

// How far a cycle's slice may stray from the running mean, and the ceiling on
// what an operator can ask for. ±30% is clearly irregular without any single
// buy standing out; past ±90% the small end rounds to dust.
const DEFAULT_VARIANCE_PCT = 30;
const MAX_VARIANCE_PCT = 90;

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

/**
 * What buying `quoteIn` receives. The curve, forward, on the other side.
 *
 * Used only to ESTIMATE, in the plan: it answers "after the big buy, how big is
 * the position, and so how big is an average slice". The engine never sizes a
 * real trade with this — it reads the main wallet's actual token balance.
 *
 * Fee comes off the input here rather than the output, which is the other side
 * of the same arrangement quoteSellOut models.
 *
 * @returns {bigint} tokens
 */
function quoteBuyOut({ quoteIn, quoteReserve, tokenReserve, feeBps = 0, creatorTaxBps = 0 }) {
  const amount = BigInt(quoteIn);
  if (amount <= 0n) return 0n;

  const takenBps = BigInt(feeBps) + BigInt(creatorTaxBps);
  if (takenBps >= BPS) return 0n;

  const net = (amount * (BPS - takenBps)) / BPS;
  const q = BigInt(quoteReserve);
  const t = BigInt(tokenReserve);
  const denom = q + net;
  if (denom <= 0n) return 0n;

  return (t * net) / denom;
}

/**
 * What this cycle should raise: the running mean, jittered.
 *
 * THE MEAN IS RECOMPUTED EVERY CYCLE, and that is the whole design.
 *
 * Dividing the position once at the start and selling that fixed amount N times
 * does not work, because every sell moves the price down: the position is worth
 * less after each cycle than the arithmetic assumed, and the run reaches the
 * last few wallets with nothing left to sell. Recomputing `remaining value ÷
 * remaining wallets` self-corrects. A cycle that sold into more impact than
 * expected lowers the value the next mean is drawn from, so the shortfall is
 * spread over the wallets that are left rather than landing entirely on the
 * last one.
 *
 * THE LAST WALLET TAKES WHATEVER IS LEFT, exactly — no jitter, no arithmetic.
 * That is what makes the position land on zero rather than near it, and it is
 * why the caller passes the whole remaining balance for that cycle instead of a
 * target.
 *
 * `roll` is a 0..1 uniform, injected rather than drawn here so the engine's
 * tests are deterministic.
 *
 * @returns {bigint} wei this cycle should raise
 */
function sliceFor({ valueWei, remainingWallets, variancePct = DEFAULT_VARIANCE_PCT, roll = 0.5 }) {
  const value = BigInt(valueWei);
  if (value <= 0n) throw new Error('there is nothing left of the position to slice');

  const left = Number(remainingWallets);
  if (!Number.isInteger(left) || left < 1) throw new Error('remainingWallets must be a positive integer');

  // One wallet left means it takes the remainder. The caller is expected to
  // sell the whole balance in that case; returning the full value keeps this
  // function honest about what it is saying.
  if (left === 1) return value;

  const mean = value / BigInt(left);
  const swing = Number(variancePct);
  if (!Number.isFinite(swing) || swing < 0 || swing > MAX_VARIANCE_PCT) {
    throw new Error(`variance must be between 0 and ${MAX_VARIANCE_PCT} percent`);
  }
  if (swing === 0) return mean;

  // ±swing%, uniform. Done in basis points so the whole calculation stays in
  // BigInt once the roll has been folded in.
  const factorBps = BigInt(Math.round(10_000 + swing * 100 * (roll * 2 - 1)));
  const slice = (mean * factorBps) / BPS;

  // Never more than is there, and never zero — a cycle that sells nothing
  // would transfer nothing and buy nothing, leaving a hole in the tape.
  if (slice >= value) return value;
  return slice > 0n ? slice : 1n;
}

/**
 * Replay the WHOLE chain against the curve before committing to it, to catch a
 * run that would collapse mid-way — the "slices too small" halt an operator
 * otherwise only discovers a wallet or two in.
 *
 * The plan's headline number, positionWei ÷ walletCount, is a naive average that
 * hides this: every sell moves the price down, so on a thin curve the value the
 * later cycles draw from can fall to almost nothing while the average still looks
 * healthy. This function does what the engine actually does each cycle — value
 * the remaining position, take a slice, find the tokens that raises, sell them
 * (advancing the reserves), and check the proceeds cover the main wallet's gas
 * AND leave enough to fund the next buy after the Relay fee — and reports the
 * first cycle that cannot.
 *
 * Pure arithmetic, like the rest of this file. Uses the MEAN slice (no jitter):
 * the expected case, and a run infeasible at the mean cannot be rescued by
 * variance. Reasons are short codes, not prose — the caller owns the wording and
 * the wei→ETH formatting, so this stays dependency-light.
 *
 * @returns {{ feasible: boolean, sustainedWallets: number, reason: string|null,
 *   atCycle: number|null }}
 */
function simulateChain({
  tokensBought,
  quoteReserve,
  tokenReserve,
  feeBps = 0,
  creatorTaxBps = 0,
  walletCount,
  mainGas,
  buyGas,
  buffer,
  relayFeePct = 3,
}) {
  let balance = BigInt(tokensBought);
  let q = BigInt(quoteReserve);
  let t = BigInt(tokenReserve);
  const mg = BigInt(mainGas);
  const bg = BigInt(buyGas);
  const bf = BigInt(buffer);
  const n = Number(walletCount);
  if (!Number.isInteger(n) || n < 1) throw new Error('walletCount must be a positive integer');

  const fail = (i, reason) => ({ feasible: false, sustainedWallets: i, reason, atCycle: i + 1 });

  for (let i = 0; i < n; i++) {
    const remainingWallets = n - i;
    if (balance <= 0n) return fail(i, 'exhausted');

    let tokensIn;
    if (remainingWallets <= 1) {
      tokensIn = balance; // the last wallet takes the remainder, as the engine does
    } else {
      const valueWei = quoteSellOut({ tokensIn: balance, quoteReserve: q, tokenReserve: t, feeBps, creatorTaxBps });
      if (valueWei <= 0n) return fail(i, 'worthless');
      let sliceWei;
      try {
        sliceWei = sliceFor({ valueWei, remainingWallets, variancePct: 0 });
      } catch {
        return fail(i, 'unsliceable');
      }
      try {
        tokensIn = tokensToRaise({ targetWei: sliceWei, quoteReserve: q, tokenReserve: t, feeBps, creatorTaxBps, headroomPct: 0 });
      } catch {
        return fail(i, 'curve-cannot-pay');
      }
      if (tokensIn > balance) tokensIn = balance;
    }

    // Sell: `raised` is net (what arrives), `gross` is what leaves the quote
    // reserve (raised plus the fee taken off the top).
    const denom = t + tokensIn;
    const gross = denom > 0n ? (q * tokensIn) / denom : 0n;
    const raised = quoteSellOut({ tokensIn, quoteReserve: q, tokenReserve: t, feeBps, creatorTaxBps });

    const spendable = raised - mg;
    if (spendable <= 0n) return fail(i, 'slice-below-gas');
    const transferWei = (spendable * BigInt(100 - relayFeePct)) / 100n;
    if (transferWei <= bg + bf) return fail(i, 'buy-underfunded');

    // Advance the curve and the position exactly as the sell would.
    q -= gross;
    t += tokensIn;
    balance -= tokensIn;
  }

  return { feasible: true, sustainedWallets: n, reason: null, atCycle: null };
}

module.exports = {
  BPS,
  SELL_HEADROOM_PCT,
  DEFAULT_VARIANCE_PCT,
  MAX_VARIANCE_PCT,
  quoteSellOut,
  quoteBuyOut,
  tokensToRaise,
  sliceFor,
  simulateChain,
  _private: { ceilDiv },
};
