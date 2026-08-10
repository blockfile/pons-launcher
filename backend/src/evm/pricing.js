'use strict';

// Pricing a launch: the opening-tick estimate the caps are checked against, and
// what a v1 pool would pay for a sell.
//
// THE ESTIMATE ITSELF LIVES IN shared/bundleShare.js, not here. The console
// runs it on every keystroke while the operator sizes a bundle and this module
// runs it again at preflight, and the two must be the same arithmetic — a live
// figure that disagrees with the warning that stops a launch is worse than no
// live figure. It is re-exported below so every existing caller is unchanged;
// the comment on the tick's sign, and the launch it is anchored to, went with
// the maths.
//
// What stays here is everything that needs the chain: reading the pool a launch
// created, and quoting a sell against it.

const { Contract, getAddress } = require('ethers');
const { provider } = require('./provider');
const { rateFromTick, estimateTokensOut, capCheck } = require('../../../shared/bundleShare');

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
