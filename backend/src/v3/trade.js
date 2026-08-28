'use strict';

/**
 * V3's two trades: buy ETH into a v2 bonding curve, and sell part of a position
 * back out of it.
 *
 * SEPARATE FROM bundle/prepareSell.js AND bundle/prepareV2.js BY DESIGN, and
 * not only because V3 is not allowed to touch them. The shapes genuinely
 * differ: those two build a whole bundle up front, sign every transaction at
 * preflight, and broadcast nothing until fire time, because a launch bundle
 * cannot afford key derivation in its critical path. V3 has no critical path —
 * its cycles are seconds apart on purpose — so it signs and sends one trade at
 * a time, and can therefore read the chain between them, which is what lets a
 * sell's actual proceeds decide the size of the transfer that follows it.
 *
 * BUYS TAKE NO FLOOR (minTokensOut 0): the engine's guarantee is that every
 * wallet ends up having bought, and a buy floor turns that into a maybe — the
 * same decision prepareSell's header records. The EXIT's sells also take no
 * floor (it must always liquidate). But a CYCLE sell accepts an optional
 * minQuoteOut (default 0): the engine passes one so a sell that would fill far
 * below its quote — the curve having moved between the quote and the sell, or a
 * tax biting — REVERTS instead of dust-filling the slice. A reverted sell sold
 * nothing, so the cycle halts resume-safe (no double sell) and retries when the
 * price is stable. What protects the run when the floor is 0 is that sizing.js
 * oversells slightly and the transfer is sized against the ETH that actually
 * arrived, not against the estimate.
 *
 * THE APPROVAL IS FOR EXACTLY THE TOKENS BEING SOLD, EVERY CYCLE. Not one
 * approval for the whole position at the start of the run. It costs one extra
 * transaction per cycle, which on this chain is a rounding error, and it means
 * a run that stops halfway leaves no standing allowance to a contract behind
 * it.
 *
 * A CURVE SELL'S PROCEEDS ARE NOT IN ITS RECEIPT. quoteOut is a return value,
 * and return values do not appear in logs. So `ethReceived` is measured as a
 * native balance delta with the gas both transactions burned added back — the
 * same technique fireSell uses, arrived at for the same reason.
 */

const { Contract, formatEther, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { CURVE_V2_ABI } = require('../evm/v2/abi');
// The 2-hop swap leg for a TOKEN-quoted curve (e.g. AMZN), and the curve math to floor the
// curve leg. Only reached for a non-native curve; the native path never touches these.
const swaproute = require('./../evm/v3/swaproute');
const sizing = require('./sizing');

// approve/allowance are not in evm/erc20.js — that module exposes only the read
// and transfer surface the funding path needs. Approving is a sell concern, so
// the fragment lives with the sell, exactly as it does on the v2 path.
const ERC20_TRADE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

// A single SSTORE plus whatever the token does around it. Generous, and cheap
// to over-reserve since unused gas is refunded.
const APPROVE_GAS = 100_000n;

// The sell CANNOT be estimated: the approval it depends on has not been mined
// when the estimate would run, so estimateGas reverts on the allowance check
// every time. A fixed limit is the only option, sized for a curve sell plus a
// creator-fee transfer plus a native send to the recipient.
const SELL_GAS = 600_000n;

// Gas for a 2-hop Uniswap-V3 swap leg (ETH<->pairToken through USDG) on the route path.
// Generous; unused gas is refunded.
const SWAP_GAS = BigInt(config.v3RouteSwapGas || 450_000);
// Default slippage floor for BOTH the swap legs and the curve leg on a token-quoted route. The
// USDG/pairToken pools are thin, so this is wider than a native-curve buy; the engine may pass
// its own. minOut on every one of the four floors (2 swaps, 2 curve legs) is sized from a live
// quote — never 0 on the route, unlike the native sell-all exit.
const DEFAULT_ROUTE_SLIPPAGE_BPS = Number(process.env.V3_ROUTE_SLIPPAGE_BPS) || 300; // 3%
// The EXIT's pairToken->ETH swap floor. The exit must ALWAYS liquidate (its whole reason for
// being), so it skips the impact cap and accepts the thin pool's price — but never a FLOORLESS
// swap, which on a thin pool is a sandwich to zero. This wide floor lets a saturated fill through
// while still refusing an outright drain. Env-tunable.
const EXIT_ROUTE_SLIPPAGE_BPS = Number(process.env.V3_EXIT_ROUTE_SLIPPAGE_BPS) || 2000; // 20%

// Same headroom the rest of the codebase uses on a fee ceiling. Quoting the
// base fee exactly gets a transaction rejected the moment it ticks up between
// the quote and the broadcast — and here that would strand an approval with a
// sell queued behind it at the next nonce.
const FEE_BUMP_PCT = 25;

// After a CONFIRMED cycle sell (one that carried a minQuoteOut floor), the curve is guaranteed
// to have paid at least that floor. If the post-sell balance read shows less, the node that
// answered had not yet applied the sell's block — a STALE READ on a load-balanced RPC, which
// otherwise mis-reports a perfectly healthy sell as "filled at dust" and halts the cycle on a
// phantom shortfall. These bound a short re-read: each getBalance may land on a fresher node,
// and the largest delta wins. Env-tunable.
const STALE_READ_TRIES = Number(process.env.V3_STALE_READ_TRIES) || 6;
const STALE_READ_MS = Number(process.env.V3_STALE_READ_MS) || 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curveContract(address, runner = provider) {
  return new Contract(getAddress(address), CURVE_V2_ABI, runner);
}

function erc20Contract(address, runner = provider) {
  return new Contract(getAddress(address), ERC20_TRADE_ABI, runner);
}

/** What a receipt cost its sender, so it can be added back to a balance delta. */
function spentOn(receipt) {
  if (!receipt) return 0n;
  const price = receipt.effectiveGasPrice ?? receipt.gasPrice ?? 0n;
  return BigInt(receipt.gasUsed ?? 0n) * BigInt(price);
}

function statusOf(receipt) {
  if (!receipt) return 'pending';
  return Number(receipt.status) === 1 ? 'confirmed' : 'reverted';
}

function wire(deps = {}) {
  return {
    rpc: deps.rpc || provider,
    ks: deps.keystore,
    curve: deps.curve || curveContract,
    erc20: deps.erc20 || erc20Contract,
    await: deps.waitForReceiptFn || waitForReceipt,
    dryRun: deps.dryRun ?? config.dryRun,
    fees: deps.fees || null,
    getFeesFn: deps.getFeesFn || getFees,
    sleepFn: deps.sleepFn || sleep,
    swap: deps.swaproute || swaproute,
  };
}

async function feesFor(w) {
  return w.fees || (await w.getFeesFn(FEE_BUMP_PCT));
}

/** Everything the engine needs to size a sell and to decide whether to run at all. */
async function readCurve(curveAddress, deps = {}) {
  const w = wire(deps);
  const c = w.curve(curveAddress, w.rpc);
  const [token, isNativeQuote, reserves, feeBps, creatorTaxBps, graduated, readyToGraduate] =
    await Promise.all([
      c.token(),
      c.isNativeQuote(),
      c.getReserves(),
      c.feeBps(),
      c.creatorTaxBps(),
      c.graduated(),
      c.readyToGraduate(),
    ]);

  // The curve's quote asset. For a native-quote curve this is a native sentinel/WETH and is
  // ignored; for a token-quote curve (e.g. AMZN) it is what the route swaps ETH to and from.
  // Read defensively — a curve that predates the getter, or a test double without it, yields null.
  let pairToken = null;
  try {
    pairToken = getAddress(await c.pairToken());
  } catch (_e) {
    pairToken = null;
  }

  return {
    address: getAddress(curveAddress),
    token: getAddress(token),
    isNativeQuote: Boolean(isNativeQuote),
    pairToken,
    quoteReserve: BigInt(reserves[0]),
    tokenReserve: BigInt(reserves[1]),
    feeBps: Number(feeBps),
    creatorTaxBps: Number(creatorTaxBps),
    graduated: Boolean(graduated),
    readyToGraduate: Boolean(readyToGraduate),
  };
}

/**
 * What the opening tax would cost this recipient right now.
 *
 * V3 buys AFTER the launch, so unlike a launch bundle its wallets are not on
 * the exemption list the launch declared — they were not known when it went
 * out. If the opening window is still open, every buy this engine makes pays
 * this. It gates nothing; it is stated in the plan so the operator can wait.
 */
async function snipeTax(curveAddress, recipient, deps = {}) {
  const w = wire(deps);
  const c = w.curve(curveAddress, w.rpc);
  const [bps, windowSeconds] = await Promise.all([
    c.currentSnipeTaxBps(getAddress(recipient)).catch(() => 0n),
    c.snipeTaxSeconds().catch(() => 0n),
  ]);
  return { bps: Number(bps), windowSeconds: Number(windowSeconds) };
}

/** A wallet's balance of one token. */
async function tokenBalance(token, owner, deps = {}) {
  const w = wire(deps);
  return BigInt(await w.erc20(token, w.rpc).balanceOf(getAddress(owner)));
}

/**
 * Spend `amountWei` on the curve, tokens to the buyer itself.
 *
 * @returns {Promise<{hash, status, blockNumber, tokensOut}>} tokensOut measured
 *   as a balance delta, because the curve returns it rather than logging it.
 */
async function buy({ wallet, curveAddress, amountWei, curve }, deps = {}) {
  // A TOKEN-quoted curve (e.g. AMZN) cannot take ETH directly — route it: swap ETH->pairToken,
  // then curve.buy(pairToken). The native path below is unchanged for native-ETH curves.
  if (curve && curve.isNativeQuote === false) {
    return buyViaRoute({ wallet, curveAddress, curve, amountWei }, deps);
  }
  const w = wire(deps);
  let amount = BigInt(amountWei);
  if (amount <= 0n) throw new Error('a buy needs a positive amount');

  const c = w.curve(curveAddress, w.rpc);
  const token = getAddress(deps.token || (await c.token()));
  const address = getAddress(wallet.address);

  if (w.dryRun) {
    return { simulated: true, hash: null, status: 'simulated', blockNumber: null, tokensOut: 0n };
  }

  const fees = await feesFor(w);
  const gasLimit = BigInt(config.buyGasLimit);

  // TRIM THE BUY TO FIT ITS OWN GAS. The caller sizes `amount` against a fee read a moment
  // earlier (the engine's per-cycle gasFor); if the base fee ticked up since, amount + gas can
  // exceed the wallet's live balance and the broadcast fails outright ("insufficient funds for
  // intrinsic transaction cost"), stranding the cycle with the Relay-filled ETH sitting unused
  // in the buyer. Re-check against the fee THIS tx will actually pay and the live balance, and
  // spend a little less rather than fail. The big buy is well-funded (the route pre-checks main's
  // balance), so this only ever trims a razor-thin bundle buy — it never shrinks the big buy.
  const maxGasCost = gasLimit * BigInt(fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
  const ethBalance = BigInt(await w.rpc.getBalance(address));
  if (ethBalance <= maxGasCost) {
    throw new Error(
      `buy from ${address} cannot proceed: ${formatEther(ethBalance)} ETH does not cover the buy's own gas ` +
        `(${formatEther(maxGasCost)} ETH)`
    );
  }
  if (amount + maxGasCost > ethBalance) {
    amount = ethBalance - maxGasCost; // spend slightly less so value + gas always fits the balance
  }

  const tx = await c.buy.populateTransaction(amount, 0n, address, { value: amount });
  const before = await tokenBalance(token, address, deps);
  const nonce = await w.rpc.getTransactionCount(address, 'pending');

  let hash;
  try {
    const sent = await w.ks.signer(wallet.id, w.rpc).sendTransaction({ ...tx, nonce, gasLimit, ...fees });
    hash = sent.hash;
  } catch (err) {
    throw new Error(`buy from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }

  const receipt = await w.await(w.rpc, hash);
  const status = statusOf(receipt);
  const after = status === 'confirmed' ? await tokenBalance(token, wallet.address, deps) : before;

  return {
    hash,
    status,
    blockNumber: receipt?.blockNumber ?? null,
    tokensOut: after > before ? after - before : 0n,
    spent: amount, // what was actually spent, after any trim-to-fit — so callers report the truth
  };
}

/**
 * Sell `tokensIn` back into the curve, proceeds to the seller itself.
 *
 * approve at nonce n, sell at n+1, both broadcast without waiting for the
 * approval to confirm — the sequencer executes a wallet's transactions in nonce
 * order, so the allowance is always in place by the time the sell runs.
 *
 * @returns {Promise<{approveHash, sellHash, status, blockNumber, ethReceived}>}
 */
async function sell({ wallet, curveAddress, token, tokensIn, minQuoteOut = 0n, curve, liquidate = false }, deps = {}) {
  // A TOKEN-quoted curve pays its sell proceeds in the pair token (e.g. AMZN), not ETH — route
  // it: curve.sell()->pairToken, then swap pairToken->ETH. `liquidate` (the exit) makes the route
  // skip the impact cap and use a wide swap floor — it must always get out. The native path below
  // is unchanged.
  if (curve && curve.isNativeQuote === false) {
    return sellViaRoute({ wallet, curveAddress, curve, tokensIn, liquidate }, deps);
  }
  const w = wire(deps);
  const amount = BigInt(tokensIn);
  if (amount <= 0n) throw new Error('a sell needs a positive token amount');
  const floor = BigInt(minQuoteOut);

  const address = getAddress(wallet.address);
  const tokenAddress = getAddress(token);

  // Checked before anything is signed. An approval broadcast for more than the
  // wallet holds is not itself harmful, but the sell queued behind it at n+1
  // reverts and the cycle has burned two transactions to learn something one
  // eth_call knew.
  const held = await tokenBalance(tokenAddress, address, deps);
  if (held < amount) {
    throw new Error(
      `${address} holds ${held} of ${tokenAddress} but the cycle needs to sell ${amount}`
    );
  }

  const c = w.curve(curveAddress, w.rpc);
  const approveTx = await w
    .erc20(tokenAddress, w.rpc)
    .approve.populateTransaction(getAddress(curveAddress), amount);
  const sellTx = await c.sell.populateTransaction(amount, floor, address);

  if (w.dryRun) {
    return {
      simulated: true,
      approveHash: null,
      sellHash: null,
      status: 'simulated',
      blockNumber: null,
      ethReceived: 0n,
      tokensIn: amount,
    };
  }

  const fees = await feesFor(w);
  const before = BigInt(await w.rpc.getBalance(address));
  const nonce = await w.rpc.getTransactionCount(address, 'pending');
  const signer = w.ks.signer(wallet.id, w.rpc);

  let approveHash;
  let sellHash;
  try {
    const a = await signer.sendTransaction({ ...approveTx, nonce, gasLimit: APPROVE_GAS, ...fees });
    approveHash = a.hash;
    const s = await signer.sendTransaction({
      ...sellTx,
      nonce: nonce + 1,
      gasLimit: SELL_GAS,
      ...fees,
    });
    sellHash = s.hash;
  } catch (err) {
    throw new Error(`sell from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }

  const [approveReceipt, sellReceipt] = await Promise.all([
    w.await(w.rpc, approveHash),
    w.await(w.rpc, sellHash),
  ]);
  const status = statusOf(sellReceipt);

  // Gas added back, so what is reported is what the CURVE paid rather than what
  // survived the round trip. On a revert the delta is negative and the wallet
  // is simply poorer — never report that as income.
  let ethReceived = 0n;
  if (status === 'confirmed') {
    const gasBack = spentOn(approveReceipt) + spentOn(sellReceipt);
    let best = BigInt(await w.rpc.getBalance(address)) - before + gasBack;
    // A confirmed sell with a floor paid AT LEAST `floor` (the curve enforces minQuoteOut). A
    // measured delta below that means the balance came from a node lagging the sell's block —
    // re-read (each call may hit a fresher node) and keep the largest delta, so a healthy sell
    // is never halted as a phantom "dust fill". With no floor (the exit) the loop is skipped
    // and the single read stands.
    for (let i = 0; i < STALE_READ_TRIES && best < floor; i++) {
      await w.sleepFn(STALE_READ_MS);
      const d = BigInt(await w.rpc.getBalance(address)) - before + gasBack;
      if (d > best) best = d;
    }
    ethReceived = best > 0n ? best : 0n;
  }

  return {
    approveHash,
    sellHash,
    status,
    blockNumber: sellReceipt?.blockNumber ?? null,
    ethReceived,
    tokensIn: amount,
  };
}

/**
 * Read a token-balance delta guaranteed to be at least `floor` (a swap's amountOutMinimum, a
 * curve's minOut), re-reading through a stale RPC balance the same way the native sell's ETH
 * measurement does — so a healthy leg is never mis-measured as dust on a load-balanced node.
 */
async function readDeltaAtLeast(readBalance, before, floor, w) {
  let best = (await readBalance()) - before;
  for (let i = 0; i < STALE_READ_TRIES && best < floor; i++) {
    await w.sleepFn(STALE_READ_MS);
    const d = (await readBalance()) - before;
    if (d > best) best = d;
  }
  return best;
}

/**
 * BUY on a TOKEN-quoted curve (e.g. AMZN): swap ETH -> pairToken, then curve.buy(pairToken).
 * THREE txs across TWO confirmations. Review-hardened:
 *   - IMPACT GUARD: the quoter SATURATES (never reverts) on an oversized input, so a slippage
 *     floor is blind to a pool-draining buy — refuse if the swap's price impact exceeds the cap.
 *   - RESUME/RECOVER: pairToken already in the wallet is a prior attempt's swap output whose curve
 *     buy did not complete — buy with it instead of swapping again (the ETH is already spent), so
 *     a curve-leg failure never strands value and a resume never double-swaps.
 *   - GAS for all THREE legs, so a tight bundle wallet doesn't die at leg 2 with pairToken stranded.
 *   - STALE-READ guard on the pairToken and token deltas.
 */
async function buyViaRoute(
  { wallet, curveAddress, curve, amountWei, slippageBps = DEFAULT_ROUTE_SLIPPAGE_BPS },
  deps = {}
) {
  const w = wire(deps);
  const address = getAddress(wallet.address);
  const pairToken = curve.pairToken;
  if (!pairToken) throw new Error(`${curveAddress} is token-quoted but exposes no pairToken — V3 cannot route it`);
  let amount = BigInt(amountWei);
  if (amount <= 0n) throw new Error('a buy needs a positive amount');

  if (w.dryRun) {
    return { simulated: true, hash: null, status: 'simulated', blockNumber: null, tokensOut: 0n, spent: 0n };
  }

  const fees = await feesFor(w);
  const signer = w.ks.signer(wallet.id, w.rpc);
  const c = w.curve(curveAddress, w.rpc);
  const feePerGas = BigInt(fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
  const usdgFee = await w.swap.discoverPairFee(pairToken, { provider: w.rpc });

  // RECOVER vs DUST. pairToken already held CAN be a prior attempt's swap output whose curve buy
  // did not complete — buy with it, don't swap again. But a mere DUST balance (stray residue) is
  // NOT a prior attempt: swap the intended ETH anyway and let curve.buy consume the dust + the new
  // output together, so a stray dust never makes the buyer "buy with dust" and skip its real buy.
  let pairReceived = await tokenBalance(pairToken, address, deps);
  let spent = 0n;
  let recover = false;
  if (pairReceived > 0n) {
    const worth = (await w.swap.quotePairToEth({ pairToken, amountIn: pairReceived, usdgFee }, { provider: w.rpc })).amountOut;
    recover = worth >= SWAP_GAS * feePerGas; // worth more than a swap's gas ⇒ a real stranded amount
  }

  if (!recover) {
    // ── leg 1: swap ETH -> pairToken ──
    // Reserve gas for ALL three legs (swap + approve + curve.buy); only the swap sends value.
    const reserve = (SWAP_GAS + APPROVE_GAS + BigInt(config.buyGasLimit)) * feePerGas;
    const ethBalance = BigInt(await w.rpc.getBalance(address));
    if (ethBalance <= reserve) {
      throw new Error(`route buy from ${address}: ${formatEther(ethBalance)} ETH does not cover the route's three legs of gas (${formatEther(reserve)})`);
    }
    if (amount + reserve > ethBalance) amount = ethBalance - reserve;

    // IMPACT GUARD — the floor cannot see a pool-draining buy; this refuses it.
    const impact = await w.swap.assessBuyImpact({ pairToken, amountInWei: amount, usdgFee }, { provider: w.rpc });
    if (impact.impactBps > config.v3Route.maxImpactBps) {
      throw new Error(
        `this ${formatEther(amount)} ETH buy would move the ${pairToken} pool ${(impact.impactBps / 100).toFixed(1)}% ` +
          `(max ${config.v3Route.maxImpactBps / 100}%) — the pool is too thin for this size and most of the ETH would ` +
          `be lost to price impact. Reduce the big buy.`
      );
    }
    if (impact.fullOut <= 0n) throw new Error(`the route quote returned no ${pairToken} for ${formatEther(amount)} ETH`);
    const swapMinOut = (impact.fullOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const swapTx = w.swap.buildSwapEthToPair({ pairToken, amountInWei: amount, minOut: swapMinOut, recipient: address, usdgFee });

    let swapHash;
    try {
      const nonce = await w.rpc.getTransactionCount(address, 'pending');
      swapHash = (await signer.sendTransaction({ to: swapTx.to, data: swapTx.data, value: swapTx.value, nonce, gasLimit: SWAP_GAS, ...fees })).hash;
    } catch (err) {
      throw new Error(`route buy swap from ${address} failed to broadcast: ${rpcMessage(err)}`);
    }
    const swapReceipt = await w.await(w.rpc, swapHash);
    if (statusOf(swapReceipt) !== 'confirmed') throw new Error('the ETH->pairToken swap reverted (route buy)');
    pairReceived = await readDeltaAtLeast(() => tokenBalance(pairToken, address, deps), 0n, swapMinOut, w);
    if (pairReceived <= 0n) throw new Error('the swap confirmed but delivered no pair token');
    spent = amount;
  }

  // ── leg 2: approve pairToken -> curve, then curve.buy(pairReceived) with NO value ──
  let minTokensOut = 0n;
  try {
    const expTok = sizing.quoteBuyOut({
      quoteIn: pairReceived,
      quoteReserve: curve.quoteReserve,
      tokenReserve: curve.tokenReserve,
      feeBps: curve.feeBps,
      creatorTaxBps: curve.creatorTaxBps,
    });
    minTokensOut = (BigInt(expTok) * BigInt(10_000 - slippageBps)) / 10_000n;
  } catch (_e) {
    minTokensOut = 0n;
  }

  const tokenBefore = await tokenBalance(curve.token, address, deps);
  let buyHash;
  try {
    const nonce = await w.rpc.getTransactionCount(address, 'pending');
    const ap = await w.erc20(pairToken, w.rpc).approve.populateTransaction(getAddress(curveAddress), pairReceived);
    await signer.sendTransaction({ ...ap, nonce, gasLimit: APPROVE_GAS, ...fees });
    const bt = await c.buy.populateTransaction(pairReceived, minTokensOut, address, { value: 0n });
    buyHash = (await signer.sendTransaction({ ...bt, nonce: nonce + 1, gasLimit: BigInt(config.buyGasLimit), ...fees })).hash;
  } catch (err) {
    throw new Error(`route curve-buy from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }
  const buyReceipt = await w.await(w.rpc, buyHash);
  const status = statusOf(buyReceipt);
  let tokensOut = 0n;
  if (status === 'confirmed') {
    tokensOut = await readDeltaAtLeast(() => tokenBalance(curve.token, address, deps), tokenBefore, minTokensOut, w);
  }
  return { hash: buyHash, status, blockNumber: buyReceipt?.blockNumber ?? null, tokensOut: tokensOut > 0n ? tokensOut : 0n, spent };
}

/**
 * SELL on a TOKEN-quoted curve: curve.sell(token) -> pairToken, then swap ALL held pairToken ->
 * ETH. FOUR txs across TWO confirmations. Review-hardened (round 2):
 *   - RECOVER-FIRST + RESUME-SAFE: it swaps the wallet's WHOLE pairToken balance (this sell's
 *     output plus anything a prior attempt's failed swap left stranded), so a swap-leg revert
 *     never strands pairToken and a resume never re-sells the token that already became pairToken.
 *   - PRE-SELL IMPACT GUARD (cycle): the impact is checked on the EXPECTED total the swap will move,
 *     BEFORE curve.sell — so a slice too big for the thin pool HALTS with nothing sold (resume-safe,
 *     no fee bleed, no pile) instead of selling into pairToken it then cannot swap. The quoter
 *     saturates instead of reverting, so this is the only thing that sees a pool-draining sell.
 *   - liquidate (the EXIT): skips the cap — it must always get out — and swaps at a WIDE floor,
 *     accepting the thin pool's price. Still never a floorless swap (a sandwich to zero).
 *   - STALE-READ guard on the pairToken and ETH deltas.
 */
async function sellViaRoute(
  { wallet, curveAddress, curve, tokensIn, slippageBps = DEFAULT_ROUTE_SLIPPAGE_BPS, liquidate = false },
  deps = {}
) {
  const w = wire(deps);
  const address = getAddress(wallet.address);
  const pairToken = curve.pairToken;
  if (!pairToken) throw new Error(`${curveAddress} is token-quoted but exposes no pairToken — V3 cannot route it`);
  const amount = BigInt(tokensIn);
  if (amount <= 0n) throw new Error('a sell needs a positive token amount');

  const held = await tokenBalance(curve.token, address, deps);
  if (held < amount) throw new Error(`${address} holds ${held} of ${curve.token} but the cycle needs to sell ${amount}`);

  if (w.dryRun) {
    return { approveHash: null, sellHash: null, status: 'simulated', blockNumber: null, ethReceived: 0n, tokensIn: amount };
  }

  const fees = await feesFor(w);
  const signer = w.ks.signer(wallet.id, w.rpc);
  const c = w.curve(curveAddress, w.rpc);
  const usdgFee = await w.swap.discoverPairFee(pairToken, { provider: w.rpc });

  // Any pairToken already in the wallet is stranded from a prior attempt whose swap failed — the
  // sell below adds to it and the swap moves the WHOLE balance, so it is recovered, not lost.
  const pairBefore = await tokenBalance(pairToken, address, deps);

  // The expected pair proceeds of this sell (a quote, not the floored min) — used both for the
  // stale-read floor below and for the PRE-SELL impact check on the whole balance the swap moves.
  let expPair = 0n;
  try {
    expPair = BigInt(
      sizing.quoteSellOut({
        tokensIn: amount,
        quoteReserve: curve.quoteReserve,
        tokenReserve: curve.tokenReserve,
        feeBps: curve.feeBps,
        creatorTaxBps: curve.creatorTaxBps,
      })
    );
  } catch (_e) {
    expPair = 0n;
  }
  // A cycle floors the curve leg at 3% (a curve that moved reverts atomically — nothing sold,
  // resume-safe). The EXIT is floor-free on the curve leg, like the native exit: it must ALWAYS
  // liquidate, so only its thin-pool swap leg keeps a (wide) floor, never the curve sell itself.
  const minPairOut = liquidate ? 0n : (expPair * BigInt(10_000 - slippageBps)) / 10_000n;

  // PRE-SELL IMPACT GUARD (cycle only) — refuse BEFORE selling if swapping the expected total
  // (stranded + this sell's output) would over-impact the pool. Nothing is sold, so the cycle halts
  // resume-safe with no fee bleed and no pair-token pile. The exit skips this: it MUST liquidate.
  if (!liquidate) {
    const expectTotal = pairBefore + expPair;
    if (expectTotal > 0n) {
      const pre = await w.swap.assessSellImpact({ pairToken, amountIn: expectTotal, usdgFee }, { provider: w.rpc });
      if (pre.impactBps > config.v3Route.maxImpactBps) {
        throw new Error(
          `selling this slice would move the ${pairToken} pool ${(pre.impactBps / 100).toFixed(1)}% ` +
            `(max ${config.v3Route.maxImpactBps / 100}%) — too thin for this size. NOTHING WAS SOLD; the position ` +
            `is intact. Sell a smaller slice, or run the Exit (which liquidates in full at the pool's price).`
        );
      }
    }
  }

  // ── leg 1: approve token -> curve, then curve.sell(tokensIn) -> pairToken to the wallet ──
  let curveSellHash;
  try {
    const nonce = await w.rpc.getTransactionCount(address, 'pending');
    const ap = await w.erc20(curve.token, w.rpc).approve.populateTransaction(getAddress(curveAddress), amount);
    await signer.sendTransaction({ ...ap, nonce, gasLimit: APPROVE_GAS, ...fees });
    const st = await c.sell.populateTransaction(amount, minPairOut, address);
    curveSellHash = (await signer.sendTransaction({ ...st, nonce: nonce + 1, gasLimit: SELL_GAS, ...fees })).hash;
  } catch (err) {
    throw new Error(`route curve-sell from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }
  const curveSellReceipt = await w.await(w.rpc, curveSellHash);
  if (statusOf(curveSellReceipt) !== 'confirmed') throw new Error('the curve sell reverted (route sell)');

  // The WHOLE pairToken balance now (this sell's output + anything a prior attempt stranded),
  // floored at pairBefore + minPairOut so a stale read cannot under-measure it.
  const pairTotal = await readDeltaAtLeast(() => tokenBalance(pairToken, address, deps), 0n, pairBefore + minPairOut, w);
  if (pairTotal <= 0n) throw new Error('the curve sell confirmed but the wallet holds no pair token to swap');

  // ── leg 2: approve pairToken -> router, then swap pairToken -> native ETH ──
  // Floor: a tight 3% for a cycle (already pre-sell impact-checked); a WIDE floor for the exit,
  // which accepts the thin pool's price to get out. Never floorless (a sandwich to zero).
  const swapSlippageBps = liquidate ? EXIT_ROUTE_SLIPPAGE_BPS : slippageBps;
  const q = await w.swap.quotePairToEth({ pairToken, amountIn: pairTotal, usdgFee }, { provider: w.rpc });
  const swapMinOut = q.amountOut > 0n ? (q.amountOut * BigInt(10_000 - swapSlippageBps)) / 10_000n : 0n;
  if (swapMinOut <= 0n) throw new Error('the pairToken->ETH quote returned nothing — refusing a floorless swap');
  const swapTx = w.swap.buildSwapPairToEth({ pairToken, amountIn: pairTotal, minOut: swapMinOut, recipient: address, usdgFee });
  const apRouter = w.swap.buildApproveToRouter({ pairToken, amount: pairTotal });

  // Snapshot AFTER the curve sell (that leg moved no ETH but gas), so the delta is purely the
  // swap's ETH out, gross of the swap legs' gas.
  const before = BigInt(await w.rpc.getBalance(address));
  let approveRouterHash, swapHash;
  try {
    const nonce = await w.rpc.getTransactionCount(address, 'pending');
    approveRouterHash = (await signer.sendTransaction({ to: apRouter.to, data: apRouter.data, value: 0n, nonce, gasLimit: APPROVE_GAS, ...fees })).hash;
    swapHash = (await signer.sendTransaction({ to: swapTx.to, data: swapTx.data, value: 0n, nonce: nonce + 1, gasLimit: SWAP_GAS, ...fees })).hash;
  } catch (err) {
    throw new Error(`route sell swap from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }
  const swapReceipt = await w.await(w.rpc, swapHash);
  if (statusOf(swapReceipt) !== 'confirmed') {
    // The curve leg ALREADY sold the token to pairToken; only the swap reverted. Say so accurately
    // (never "nothing was sold") — the pairToken is HELD in the wallet, not lost, and the next
    // attempt swaps it (recover-first) or the Exit recovers it. Throwing halts resume-safe
    // (sellDone stays false); the position is genuinely smaller now, so a resume re-sizes fresh.
    throw new Error(
      `the curve sold to ${pairToken}, but the ${pairToken}->ETH swap reverted — the ${pairToken} is HELD in ` +
        `${address} (NOT lost). The next attempt swaps it (recover-first), or run the Exit. Those tokens are ` +
        `already sold, so the position is smaller now.`
    );
  }
  const approveRouterReceipt = await w.await(w.rpc, approveRouterHash).catch(() => null);
  const gasBack = spentOn(swapReceipt) + spentOn(approveRouterReceipt);
  // The swap enforced amountOutMinimum = swapMinOut, so a confirmed swap paid AT LEAST that. A
  // measured delta below it means a stale balance read (a node lagging the swap's block) — the
  // same re-read guard the native sell uses.
  let best = BigInt(await w.rpc.getBalance(address)) - before + gasBack;
  for (let i = 0; i < STALE_READ_TRIES && best < swapMinOut; i++) {
    await w.sleepFn(STALE_READ_MS);
    const d = BigInt(await w.rpc.getBalance(address)) - before + gasBack;
    if (d > best) best = d;
  }
  const ethReceived = best > 0n ? best : 0n;
  return { approveHash: approveRouterHash, sellHash: swapHash, status: 'confirmed', blockNumber: swapReceipt?.blockNumber ?? null, ethReceived, tokensIn: amount };
}

/**
 * Swap a wallet's WHOLE pairToken balance to ETH — a SWAP-ONLY recovery, no curve leg. The EXIT
 * runs this on a token curve so a wallet holding pairToken that a prior failed swap stranded — and
 * which may hold NO launchpad token, so the normal sell skips it — is still emptied to ETH. Wide
 * exit floor, no impact cap (the exit must get out), never floorless. Returns 'skipped' when the
 * balance is below `minPairWei` (dust not worth a swap's gas).
 */
async function recoverPair({ wallet, curve, minPairWei = 0n }, deps = {}) {
  const w = wire(deps);
  const address = getAddress(wallet.address);
  const pairToken = curve.pairToken;
  if (!pairToken) return { status: 'skipped', ethReceived: 0n, pairIn: 0n };
  const pairTotal = await tokenBalance(pairToken, address, deps);
  if (pairTotal <= BigInt(minPairWei)) return { status: 'skipped', ethReceived: 0n, pairIn: pairTotal };

  if (w.dryRun) return { status: 'simulated', swapHash: null, approveHash: null, ethReceived: 0n, pairIn: pairTotal };

  const fees = await feesFor(w);
  const signer = w.ks.signer(wallet.id, w.rpc);
  const usdgFee = await w.swap.discoverPairFee(pairToken, { provider: w.rpc });
  const q = await w.swap.quotePairToEth({ pairToken, amountIn: pairTotal, usdgFee }, { provider: w.rpc });
  const swapMinOut = q.amountOut > 0n ? (q.amountOut * BigInt(10_000 - EXIT_ROUTE_SLIPPAGE_BPS)) / 10_000n : 0n;
  if (swapMinOut <= 0n) throw new Error('the pairToken->ETH quote returned nothing — refusing a floorless recovery swap');
  const swapTx = w.swap.buildSwapPairToEth({ pairToken, amountIn: pairTotal, minOut: swapMinOut, recipient: address, usdgFee });
  const apRouter = w.swap.buildApproveToRouter({ pairToken, amount: pairTotal });

  const before = BigInt(await w.rpc.getBalance(address));
  let approveHash, swapHash;
  try {
    const nonce = await w.rpc.getTransactionCount(address, 'pending');
    approveHash = (await signer.sendTransaction({ to: apRouter.to, data: apRouter.data, value: 0n, nonce, gasLimit: APPROVE_GAS, ...fees })).hash;
    swapHash = (await signer.sendTransaction({ to: swapTx.to, data: swapTx.data, value: 0n, nonce: nonce + 1, gasLimit: SWAP_GAS, ...fees })).hash;
  } catch (err) {
    throw new Error(`pair recovery swap from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }
  const swapReceipt = await w.await(w.rpc, swapHash);
  const status = statusOf(swapReceipt);
  let ethReceived = 0n;
  if (status === 'confirmed') {
    const apReceipt = await w.await(w.rpc, approveHash).catch(() => null);
    const gasBack = spentOn(swapReceipt) + spentOn(apReceipt);
    let best = BigInt(await w.rpc.getBalance(address)) - before + gasBack;
    for (let i = 0; i < STALE_READ_TRIES && best < swapMinOut; i++) {
      await w.sleepFn(STALE_READ_MS);
      const d = BigInt(await w.rpc.getBalance(address)) - before + gasBack;
      if (d > best) best = d;
    }
    ethReceived = best > 0n ? best : 0n;
  }
  return { status, swapHash, approveHash, ethReceived, pairIn: pairTotal };
}

module.exports = {
  APPROVE_GAS,
  SELL_GAS,
  SWAP_GAS,
  FEE_BUMP_PCT,
  readCurve,
  snipeTax,
  tokenBalance,
  buy,
  sell,
  recoverPair,
  _private: { spentOn, statusOf, curveContract, erc20Contract, buyViaRoute, sellViaRoute, readDeltaAtLeast },
};
