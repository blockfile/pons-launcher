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
 * NO SLIPPAGE FLOOR ON EITHER SIDE. minTokensOut and minQuoteOut are both 0.
 * The engine's guarantee is that every wallet ends up having bought, and a
 * floor turns that into a maybe — the same decision, for the same reason, that
 * prepareSell's header records. What protects the run instead is that sizing.js
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

const { Contract, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { CURVE_V2_ABI } = require('../evm/v2/abi');

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

// Same headroom the rest of the codebase uses on a fee ceiling. Quoting the
// base fee exactly gets a transaction rejected the moment it ticks up between
// the quote and the broadcast — and here that would strand an approval with a
// sell queued behind it at the next nonce.
const FEE_BUMP_PCT = 25;

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

  return {
    address: getAddress(curveAddress),
    token: getAddress(token),
    isNativeQuote: Boolean(isNativeQuote),
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
async function buy({ wallet, curveAddress, amountWei }, deps = {}) {
  const w = wire(deps);
  const amount = BigInt(amountWei);
  if (amount <= 0n) throw new Error('a buy needs a positive amount');

  const c = w.curve(curveAddress, w.rpc);
  const token = getAddress(deps.token || (await c.token()));
  const tx = await c.buy.populateTransaction(amount, 0n, getAddress(wallet.address), {
    value: amount,
  });

  if (w.dryRun) {
    return { simulated: true, hash: null, status: 'simulated', blockNumber: null, tokensOut: 0n };
  }

  const fees = await feesFor(w);
  const before = await tokenBalance(token, wallet.address, deps);
  const nonce = await w.rpc.getTransactionCount(getAddress(wallet.address), 'pending');

  let hash;
  try {
    const sent = await w.ks
      .signer(wallet.id, w.rpc)
      .sendTransaction({ ...tx, nonce, gasLimit: BigInt(config.buyGasLimit), ...fees });
    hash = sent.hash;
  } catch (err) {
    throw new Error(`buy from ${wallet.address} failed to broadcast: ${rpcMessage(err)}`);
  }

  const receipt = await w.await(w.rpc, hash);
  const status = statusOf(receipt);
  const after = status === 'confirmed' ? await tokenBalance(token, wallet.address, deps) : before;

  return {
    hash,
    status,
    blockNumber: receipt?.blockNumber ?? null,
    tokensOut: after > before ? after - before : 0n,
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
async function sell({ wallet, curveAddress, token, tokensIn }, deps = {}) {
  const w = wire(deps);
  const amount = BigInt(tokensIn);
  if (amount <= 0n) throw new Error('a sell needs a positive token amount');

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
  const sellTx = await c.sell.populateTransaction(amount, 0n, address);

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
    const after = BigInt(await w.rpc.getBalance(address));
    const delta = after - before + spentOn(approveReceipt) + spentOn(sellReceipt);
    ethReceived = delta > 0n ? delta : 0n;
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

module.exports = {
  APPROVE_GAS,
  SELL_GAS,
  FEE_BUMP_PCT,
  readCurve,
  snipeTax,
  tokenBalance,
  buy,
  sell,
  _private: { spentOn, statusOf, curveContract, erc20Contract },
};
