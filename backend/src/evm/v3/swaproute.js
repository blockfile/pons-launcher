'use strict';

/**
 * V3's ERC-20-quote swap leg: route native ETH <-> a curve's pairToken (e.g. AMZN)
 * through USDG on the VERIFIED Uniswap SwapRouter02 + QuoterV2.
 *
 * WHY THIS EXISTS. A pons v2 curve can be quoted in native ETH (curve.buy takes msg.value,
 * curve.sell pays ETH) OR in another token (curve.buy takes that token via transferFrom,
 * curve.sell pays it). The relay chain funds buys and moves sell proceeds in NATIVE ETH, so
 * for a token-quoted curve V3 must convert ETH <-> pairToken around each curve trade. There is
 * no direct WETH/pairToken pool on this chain, so the swap is 2-hop: WETH -> USDG -> pairToken
 * (and the reverse). This module builds ONLY the swap calldata + quotes — v3/trade.js sequences
 * it with the curve legs and signs. READS AND BUILDS ONLY; it never signs.
 *
 * Every address and the route were verified live: QuoterV2.quoteExactInput of
 * WETH-0.01%-USDG-0.30%-AMZN reproduced a real on-chain buy to the wei. minOut on both legs is
 * always sized from a fresh quote (the USDG/pairToken pools are thin — see the caller's floors).
 */

const { Contract, getAddress, solidityPacked } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');

const SWAP_ROUTER = () => getAddress(config.v3Route.swapRouter);
const QUOTER = () => getAddress(config.v3Route.quoter);
const WETH = () => getAddress(config.v3Route.weth);
const USDG = () => getAddress(config.v3Route.usdg);
const WETH_USDG_FEE = () => Number(config.v3Route.wethUsdgFee);

// SwapRouter02 (no deadline): exactInput takes a packed multi-hop path. multicall + unwrapWETH9
// let a token->ETH swap pay the router in WETH then unwrap it to the seller in one tx.
const ROUTER_ABI = [
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
];
// QuoterV2.quoteExactInput is state-mutating (reverts to return the value) — call it with
// staticCall only, never as a tx.
const QUOTER_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
];
const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];

const routerIface = new Contract(SWAP_ROUTER(), ROUTER_ABI).interface;
const erc20Iface = new Contract(WETH(), ERC20_APPROVE_ABI).interface;

function quoterOf(deps) {
  return new Contract(QUOTER(), QUOTER_ABI, deps.provider || provider);
}

// USDG<->pairToken fee tiers to probe, richest-first for the funded pons pairs (AMZN's pool is
// the 0.30% tier). The best one for a given pair is discovered from the quoter, since thin pairs
// live at different tiers.
const PAIR_FEE_TIERS = [3000, 500, 100, 10000];

/** WETH -> USDG -> pairToken (a BUY: ETH in). */
function buyPath(pairToken, usdgFee) {
  return solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [WETH(), WETH_USDG_FEE(), USDG(), Number(usdgFee), getAddress(pairToken)]
  );
}

/** pairToken -> USDG -> WETH (a SELL: ETH out). */
function sellPath(pairToken, usdgFee) {
  return solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [getAddress(pairToken), Number(usdgFee), USDG(), WETH_USDG_FEE(), WETH()]
  );
}

/**
 * The USDG<->pairToken fee tier that quotes the best ETH->pairToken output for a small probe —
 * i.e. the tier with real liquidity. Throws if no tier can route (no funded USDG pool for the
 * pair), which is the "V3 cannot trade this token" case the route surfaces to the caller.
 */
async function discoverPairFee(pairToken, deps = {}) {
  const q = quoterOf(deps);
  const probe = 10n ** 15n; // 0.001 ETH
  let best = null;
  for (const fee of PAIR_FEE_TIERS) {
    try {
      const out = BigInt((await q.quoteExactInput.staticCall(buyPath(pairToken, fee), probe))[0]);
      if (out > 0n && (!best || out > best.out)) best = { fee, out };
    } catch {
      /* no pool / no liquidity at this tier — try the next */
    }
  }
  if (!best) {
    throw new Error(
      `no USDG<->${getAddress(pairToken)} pool with liquidity — V3 cannot route ETH to this pair token, ` +
        `so it cannot trade this curve`
    );
  }
  return best.fee;
}

// A tiny probe whose price impact on any funded pool is negligible — its rate is the "true"
// (near-spot) rate to compare a full trade against. 0.001 (of an 18-dec asset).
const IMPACT_PROBE = 10n ** 15n;

/**
 * PRICE-IMPACT detector. The QuoterV2 SATURATES on an oversized input (it returns ~the whole
 * pool, it does NOT revert), so a per-quote slippage floor is structurally blind to a trade that
 * drains a thin pool — the floor just "expects" the drained output and permits it. This compares
 * the full trade's effective rate to a tiny probe's near-spot rate and reports the impact in bps,
 * which the caller refuses on. Both quotes share one path/fee.
 *
 * @returns {Promise<{impactBps: number, fullOut: bigint}>}
 */
async function assessImpact({ path, amountIn, probeIn = IMPACT_PROBE }, deps = {}) {
  const q = quoterOf(deps);
  const amt = BigInt(amountIn);
  const probe = BigInt(probeIn);
  if (amt <= 0n || probe <= 0n) return { impactBps: 10_000, fullOut: 0n };
  const [probeOut, fullOut] = await Promise.all([
    q.quoteExactInput.staticCall(path, probe).then((r) => BigInt(r[0])),
    q.quoteExactInput.staticCall(path, amt).then((r) => BigInt(r[0])),
  ]);
  if (probeOut <= 0n) return { impactBps: 10_000, fullOut };
  // impactBps = 10000 * (1 - (fullOut/amt) / (probeOut/probe)) = 10000 * (1 - fullOut*probe / (probeOut*amt))
  const num = fullOut * probe * 10_000n;
  const den = probeOut * amt;
  const kept = den > 0n ? Number(num / den) : 0; // bps of value KEPT vs the spot rate
  return { impactBps: Math.max(0, Math.min(10_000, 10_000 - kept)), fullOut };
}

/** ETH->pairToken buy impact, at the routed fee. */
async function assessBuyImpact({ pairToken, amountInWei, usdgFee }, deps = {}) {
  const fee = usdgFee ?? (await discoverPairFee(pairToken, deps));
  const out = await assessImpact({ path: buyPath(pairToken, fee), amountIn: amountInWei }, deps);
  return { ...out, usdgFee: fee };
}

/** pairToken->ETH sell impact, at the routed fee. */
async function assessSellImpact({ pairToken, amountIn, usdgFee }, deps = {}) {
  const fee = usdgFee ?? (await discoverPairFee(pairToken, deps));
  const out = await assessImpact({ path: sellPath(pairToken, fee), amountIn }, deps);
  return { ...out, usdgFee: fee };
}

/** Quote ETH in -> pairToken out. Returns { amountOut, usdgFee } (the fee it routed through). */
async function quoteEthToPair({ pairToken, amountInWei, usdgFee }, deps = {}) {
  const fee = usdgFee ?? (await discoverPairFee(pairToken, deps));
  const out = BigInt((await quoterOf(deps).quoteExactInput.staticCall(buyPath(pairToken, fee), BigInt(amountInWei)))[0]);
  return { amountOut: out, usdgFee: fee };
}

/** Quote pairToken in -> ETH out. Returns { amountOut, usdgFee }. */
async function quotePairToEth({ pairToken, amountIn, usdgFee }, deps = {}) {
  const fee = usdgFee ?? (await discoverPairFee(pairToken, deps));
  const out = BigInt((await quoterOf(deps).quoteExactInput.staticCall(sellPath(pairToken, fee), BigInt(amountIn)))[0]);
  return { amountOut: out, usdgFee: fee };
}

/**
 * BUY leg: native ETH -> pairToken, delivered to `recipient`. One tx, ETH rides in as value.
 * @returns {{to, data, value}}
 */
function buildSwapEthToPair({ pairToken, amountInWei, minOut, recipient, usdgFee }) {
  const amount = BigInt(amountInWei);
  const data = routerIface.encodeFunctionData('exactInput', [
    [buyPath(pairToken, usdgFee), getAddress(recipient), amount, BigInt(minOut)],
  ]);
  return { to: SWAP_ROUTER(), data, value: amount };
}

/**
 * SELL leg: pairToken -> native ETH, delivered to `recipient`. The swap pays the ROUTER in WETH
 * (recipient = the router), then unwrapWETH9 forwards native ETH to the seller — both in one
 * multicall tx, so the ETH is measurable as a balance delta. Requires a prior approve of the
 * pairToken to the router (buildApproveToRouter).
 * @returns {{to, data, value}}
 */
function buildSwapPairToEth({ pairToken, amountIn, minOut, recipient, usdgFee }) {
  const swap = routerIface.encodeFunctionData('exactInput', [
    [sellPath(pairToken, usdgFee), SWAP_ROUTER(), BigInt(amountIn), BigInt(minOut)],
  ]);
  const unwrap = routerIface.encodeFunctionData('unwrapWETH9', [0n, getAddress(recipient)]);
  const data = routerIface.encodeFunctionData('multicall', [[swap, unwrap]]);
  return { to: SWAP_ROUTER(), data, value: 0n };
}

/** Bounded approve of the pairToken to the swap router (the router pulls it via transferFrom). */
function buildApproveToRouter({ pairToken, amount }) {
  return {
    to: getAddress(pairToken),
    data: erc20Iface.encodeFunctionData('approve', [SWAP_ROUTER(), BigInt(amount)]),
    value: 0n,
  };
}

module.exports = {
  SWAP_ROUTER,
  discoverPairFee,
  quoteEthToPair,
  quotePairToEth,
  assessImpact,
  assessBuyImpact,
  assessSellImpact,
  buildSwapEthToPair,
  buildSwapPairToEth,
  buildApproveToRouter,
  _private: { buyPath, sellPath, PAIR_FEE_TIERS, IMPACT_PROBE },
};
