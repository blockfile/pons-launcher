'use strict';

// Estimating how much of a token a bundle buy will receive, so a buy that would
// breach the launch-window caps can be caught BEFORE it is signed.
//
// During the restriction window every non-dev address is capped at
// maxWalletBps of supply, and a buy over it does not clamp — it REVERTS, and
// the pool's TransferHelper masks the reason as "TF". There is no pool to quote
// against at signing time, so the estimate comes from the initial tick the
// launch config pins.
//
// On the sign of initialTick: a Uniswap tick is quoted as token1-per-token0,
// so its sign follows the pool's address ordering rather than the economics.
// A launchpad always opens with the token cheap against the pair token — a
// billion-token supply against a fraction of an ETH — so the magnitude is the
// exchange rate whichever side the token lands on. An earlier version of this
// file derived the direction from address ordering and got it inverted, which
// reported 0.00% for a buy that was really 0.11% of supply.
//
// Anchored to a real launch: token 0x4aE28f7022F0db76F9B791ff3DEe6bE67B40137F,
// initialTick -204200, where 0.003 ETH bought 2,186,029 tokens.
//
// The estimate ignores the price impact of the bundle's own buys, so it reports
// slightly MORE tokens than a wallet will really get. That errs toward warning
// early, which is the safe direction.

const { Contract, getAddress } = require('ethers');
const { provider } = require('./provider');

const Q = 1.0001;

// Q96 squared. A Uniswap v3 pool stores sqrt(price) shifted left 96 bits, so
// price = (sqrtPriceX96 / 2**96)**2 and the shift comes out as 2**192.
const Q192 = 1n << 192n;
// Uniswap fee tiers are hundredths of a basis point: 10000 is 1%.
const FEE_DENOMINATOR = 1_000_000n;

const V3_FACTORY_ABI = ['function getPool(address, address, uint24) view returns (address)'];
const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
];

/**
 * Tokens received per whole pair token at the pool's opening price.
 */
function rateFromTick(initialTick) {
  const tick = Math.abs(Number(initialTick));
  if (!Number.isFinite(tick)) return 0;
  const rate = Math.pow(Q, tick);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/**
 * Tokens a buy of `amountInWei` native wei receives at the opening price.
 * @returns {number} whole tokens (not wei); 0 on unusable input
 */
function estimateTokensOut({ amountInWei, initialTick }) {
  const rate = rateFromTick(initialTick);
  if (!rate) return 0;

  const amountIn = Number(amountInWei) / 1e18;
  if (!Number.isFinite(amountIn) || amountIn <= 0) return 0;

  const out = amountIn * rate;
  return Number.isFinite(out) && out > 0 ? out : 0;
}

/**
 * Where a buy lands against the launch-window caps.
 * @returns {{estTokens:number, estBps:number, exceedsWallet:boolean, exceedsTx:boolean}}
 */
function capCheck({ amountInWei, launchConfig }) {
  const supply = Number(launchConfig.supply) / 1e18;
  const estTokens = estimateTokensOut({ amountInWei, initialTick: launchConfig.initialTick });

  if (!supply || !estTokens) {
    return { estTokens: 0, estBps: 0, exceedsWallet: false, exceedsTx: false };
  }

  const estBps = (estTokens / supply) * 10000;
  return {
    estTokens,
    estBps,
    exceedsWallet: estBps > Number(launchConfig.maxWalletBps),
    exceedsTx: estBps > Number(launchConfig.maxTxBps),
  };
}

/**
 * The v1 pool a launched token trades in, and its current price. Read from the
 * dex factory's own getPool rather than from the token's liquidityPool() getter,
 * for the same reason provenance is: a token's word about itself is not evidence.
 *
 * @returns {Promise<{pool: string, sqrtPriceX96: bigint, tokenIsToken0: boolean}>}
 */
async function readPoolPrice({ dexFactory, token, pairToken, poolFee }, deps = {}) {
  const rpc = deps.provider || provider;
  const address = await new Contract(getAddress(dexFactory), V3_FACTORY_ABI, rpc).getPool(
    getAddress(token),
    getAddress(pairToken),
    Number(poolFee)
  );
  const pool = getAddress(address);
  if (pool === '0x0000000000000000000000000000000000000000') {
    throw new Error(`no ${Number(poolFee) / 10000}% pool for ${token} — the dex factory has none`);
  }
  const p = new Contract(pool, V3_POOL_ABI, rpc);
  const [token0, slot0] = await Promise.all([p.token0(), p.slot0()]);
  return {
    pool,
    sqrtPriceX96: BigInt(slot0[0]),
    tokenIsToken0: getAddress(token0) === getAddress(token),
  };
}

/**
 * Pair-token base units a v1 sell of `tokensIn` would return AT THE POOL'S
 * CURRENT PRICE, with the pool fee taken off the output.
 *
 * THIS IS A CEILING, NOT A QUOTE. It is the spot price, so it ignores the price
 * impact of the sell itself and of the other wallets selling alongside it — the
 * real proceeds are lower, and further below this the bigger the position. Every
 * caller has to say so; it exists so an operator arming a floor-less sell sees
 * an order of magnitude rather than nothing at all.
 *
 * Checked against the live chain, not derived from docs: 72,915.416942227609
 * tokens of 0x86D26b51… at sqrtPriceX96 2146001890159706666683605869625172 in
 * the 1% pool returned 98383459876113 wei from a real eth_call of the sell, and
 * this returns 98390581041968 — 0.007% high, which is the impact it does not
 * model. That gap widens with the size of the position.
 *
 * @returns {bigint} base units of the pair token
 */
function quoteSellOutV1({ tokensIn, sqrtPriceX96, tokenIsToken0, poolFee = 0 }) {
  const amount = BigInt(tokensIn);
  const sqrtP = BigInt(sqrtPriceX96);
  if (amount <= 0n || sqrtP <= 0n) return 0n;

  // price = token1 per token0. Selling token0 multiplies by it; selling token1
  // divides by it. Integer throughout — a float here loses wei at these scales.
  const gross = tokenIsToken0
    ? (amount * sqrtP * sqrtP) / Q192
    : (amount * Q192) / (sqrtP * sqrtP);
  const out = gross - (gross * BigInt(poolFee)) / FEE_DENOMINATOR;
  return out > 0n ? out : 0n;
}

module.exports = { rateFromTick, estimateTokensOut, capCheck, readPoolPrice, quoteSellOutV1 };
