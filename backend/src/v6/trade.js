'use strict';

/**
 * V6's two trades: buy ETH into a letscash Uniswap-V4 pool, and sell part of a
 * position back out of it — ONE wallet, one trade at a time.
 *
 * SEPARATE FROM v5/buy.js and v5/sell.js by design. Those build a whole BUNDLE up
 * front, sign every tx at preflight, and broadcast nothing until fire time (a bundle
 * cannot afford key derivation in its critical path). V6 has no critical path — its
 * relay-chain cycles are seconds apart on purpose — so it signs and sends one trade
 * at a time and reads the chain between them, which is what lets a sell's ACTUAL
 * proceeds decide the size of the Relay transfer that follows it. This is the exact
 * shape of v3/trade.js, with the venue swapped from a bonding curve to a V4 pool.
 *
 * IT WRAPS THE letscash SWAP CLIENT (evm/v5/swap.js) for calldata + quotes — the
 * one place the exact V4 bytes are built and verified against the chain. What differs
 * from v3's curve trade:
 *   - venue: UniversalRouter execute() over the V4 PoolManager, per-pool HOOK pinned
 *     (not a curve address); the pool is resolved+verified once and reused per cycle.
 *   - the SELL is THREE txs (token→Permit2 approve, Permit2→router approve, execute)
 *     at consecutive nonces, broadcast in nonce order — not the curve's two.
 *   - the BUY carries a POSITIVE slippage floor (buildBuyTx refuses 0), quoted per
 *     buy; v3's zero-floor buy does not port to letscash. The SELL keeps the no-floor
 *     default (a guaranteed exit), same decision v3/v5's sells record.
 *   - sizing quotes via the V4 quoter (quoteSell/quoteBuy), never a reserve formula.
 *
 * A trade's proceeds are NOT in its receipt (a swap return value / a native transfer
 * do not appear in logs), so tokensOut / ethReceived are measured as BALANCE DELTAS,
 * with the gas the txs burned added back on the sell — the same technique v3/v5 use.
 */

const { getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { readTokenBalance } = require('../evm/erc20');
const swap = require('../evm/v5/swap');
const factory = require('../evm/v5/factory');

// The buy is a single V4 execute(); 500k is generous (unused gas refunded).
const BUY_GAS = BigInt(config.buyGasLimit || 500_000);
// The sell is 3 txs. The two approvals are cheap; the execute() cannot be estimated
// (its approvals are not mined yet) so it takes a fixed, generous cap — same sizes
// v5/sell.js settled on for the same hooked V4 swap.
const ERC20_APPROVE_GAS = 90_000n;
const PERMIT2_APPROVE_GAS = 90_000n;
const SELL_GAS = 700_000n;

const DEADLINE_SECONDS = 3600; // router shape only, NOT price protection
const FEE_BUMP_PCT = 25;

// Default BUY floor. letscash buys REQUIRE a positive floor, and a live pool the
// chain's snipers move fast, so the default absorbs self- + sniper-impact. The
// engine passes its own (operator-set) value; overridable per call.
const DEFAULT_BUY_SLIPPAGE_BPS = 3000;

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
    swap: deps.swap || swap,
    factory: deps.factory || factory,
    await: deps.waitForReceiptFn || waitForReceipt,
    readBal: deps.readTokenBalance || readTokenBalance,
    getFeesFn: deps.getFeesFn || getFees,
    fees: deps.fees || null,
    dryRun: deps.dryRun ?? config.dryRun,
    deadline: deps.deadline,
    nowMs: deps.nowMs,
  };
}

async function feesFor(w) {
  return w.fees || (await w.getFeesFn(FEE_BUMP_PCT));
}

function deadlineFor(w) {
  if (w.deadline != null) return w.deadline;
  return Math.floor((w.nowMs != null ? w.nowMs : Date.now()) / 1000) + DEADLINE_SECONDS;
}

/**
 * Resolve + VERIFY the pool for a token, ONCE (replaces v3's readCurve).
 *
 * THE DUSTING GUARD, and it is a PROVENANCE gate, not a "does a pool exist" check. v6
 * takes the token from untrusted operator input, and a run signs token approvals — an
 * approval to a hostile ERC-20 is the dusting attack. A decoy token can be paired with
 * an attacker's own hook to seed a real, initialised, liquid pool that would satisfy a
 * bare liveness check and then eat every buy (a honeypot). So the gate is:
 *   1. factory.findLaunch(token) — the token MUST have a genuine TokenLaunched event on
 *      the letscash factory. This rejects a decoy (no such event) AND yields the
 *      AUTHORITATIVE hook the factory assigned — including a per-token vanity hook.
 *   2. resolvePoolKey against THAT hook — confirm the pool is initialised and liquid.
 * Any operator-supplied `hook` is IGNORED: the only hook trusted is the one the factory
 * itself emitted. `hook` is accepted in the signature for call-site symmetry only.
 *
 * @returns {Promise<{token, quote, poolKey, poolId, hook, liquidity, creator}>}
 */
async function readPool({ token, quote = 'eth' }, deps = {}) {
  const w = wire(deps);
  const addr = getAddress(token);

  const launch = await w.factory.findLaunch(addr, { provider: w.rpc });
  if (!launch) {
    throw new Error(
      `${addr} is not a letscash launch — the factory has no TokenLaunched event for it, so v6 will not ` +
        `approve or trade it. v6 only trades genuine letscash launchpad tokens (a decoy ERC-20 with a ` +
        `look-alike pool is exactly the honeypot this refuses).`
    );
  }

  // Verify the pool is live under the hook the FACTORY named (trusted), for the quote
  // v6 trades. Throws if that pool is not initialised/liquid (e.g. the token launched
  // against USDG and has no ETH pool).
  const r = await w.swap.resolvePoolKey({ token: addr, quote, hook: launch.hook }, { provider: w.rpc });
  return {
    token: addr,
    quote,
    poolKey: r.poolKey,
    poolId: r.poolId,
    hook: r.hook,
    liquidity: r.liquidity,
    creator: launch.creator,
  };
}

/** A wallet's balance of one token. */
async function tokenBalance(token, owner, deps = {}) {
  const w = wire(deps);
  return BigInt(await w.readBal(getAddress(token), getAddress(owner)));
}

/** Quote ETH out for selling `tokensIn` (for slice sizing). V4 quoter, net of tax. */
async function quoteSellOut({ token, quote = 'eth', pool, tokensIn }, deps = {}) {
  const w = wire(deps);
  const q = await w.swap.quoteSell(
    { token: getAddress(token), quote, tokensInWei: BigInt(tokensIn), hook: pool.hook, poolKey: pool.poolKey },
    { provider: w.rpc }
  );
  return BigInt(q.expectedOut);
}

/** Quote tokens out for buying `amountWei` (reporting / feasibility). */
async function quoteBuyOut({ token, quote = 'eth', pool, amountWei }, deps = {}) {
  const w = wire(deps);
  const q = await w.swap.quoteBuy(
    { token: getAddress(token), quote, amountInWei: BigInt(amountWei), hook: pool.hook, poolKey: pool.poolKey },
    { provider: w.rpc }
  );
  return BigInt(q.expectedOut);
}

/** The live pool tax a normal wallet pays now (informational; replaces v3's snipeTax). */
async function poolFee({ token, quote = 'eth', pool }, deps = {}) {
  const w = wire(deps);
  return w.swap.poolFeeStatus({ token: getAddress(token), quote, hook: pool.hook }, { provider: w.rpc });
}

/**
 * Spend `amountWei` on the pool, tokens to the buyer. One tx (native ETH in). Quotes
 * to set a positive floor (buildBuyTx refuses 0), builds against the pinned pool,
 * signs, broadcasts, measures tokensOut as a balance delta.
 *
 * @returns {Promise<{hash, status, blockNumber, tokensOut, expectedOut, minOut}>}
 */
async function buy({ wallet, token, quote = 'eth', pool, amountWei, slippageBps = DEFAULT_BUY_SLIPPAGE_BPS }, deps = {}) {
  const w = wire(deps);
  const amount = BigInt(amountWei);
  if (amount <= 0n) throw new Error('a buy needs a positive amount');
  const tokenAddr = getAddress(token);

  // Quote to set minOut. A quote failure or a zero expected/floor is refused — never
  // sign a buy with no price protection (the decoy-pool guard the whole client keeps).
  const q = await w.swap.quoteBuy(
    { token: tokenAddr, quote, amountInWei: amount, slippageBps, hook: pool.hook, poolKey: pool.poolKey },
    { provider: w.rpc }
  );
  const expectedOut = BigInt(q.expectedOut);
  const minOut = BigInt(q.minOut);
  if (expectedOut <= 0n || minOut <= 0n) {
    throw new Error(`the buy quote returned no output — refusing a buy with no floor (pool ${pool.poolId})`);
  }

  const tx = w.swap.buildBuyTx(
    { token: tokenAddr, quote, amountInWei: amount, minOut, recipient: wallet.address, deadline: deadlineFor(w), poolKey: pool.poolKey },
    { provider: w.rpc }
  );

  if (w.dryRun) {
    return { simulated: true, hash: null, status: 'simulated', blockNumber: null, tokensOut: 0n, expectedOut, minOut };
  }

  const fees = await feesFor(w);
  const before = await tokenBalance(tokenAddr, wallet.address, deps);
  const nonce = await w.rpc.getTransactionCount(getAddress(wallet.address), 'pending');
  let hash;
  try {
    const sent = await w.ks
      .signer(wallet.id, w.rpc)
      .sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || 0n), nonce, gasLimit: BUY_GAS, ...fees });
    hash = sent.hash;
  } catch (err) {
    throw new Error(`buy from ${wallet.address} failed to broadcast: ${rpcMessage(err)}`);
  }

  const receipt = await w.await(w.rpc, hash);
  const status = statusOf(receipt);
  const after = status === 'confirmed' ? await tokenBalance(tokenAddr, wallet.address, deps) : before;
  return {
    hash,
    status,
    blockNumber: receipt?.blockNumber ?? null,
    tokensOut: after > before ? after - before : 0n,
    expectedOut,
    minOut,
  };
}

/**
 * Sell `tokensIn` back to ETH, proceeds to the seller. THREE txs at consecutive
 * nonces (token→Permit2 approve at n, Permit2→router approve at n+1, execute sell at
 * n+2), broadcast in nonce order without waiting — the sequencer runs a wallet's txs
 * in nonce order, so the approvals are in place by the time the sell runs. minOut
 * default 0 (a guaranteed exit; pass slippageBps for a floor). Proceeds measured as a
 * native balance delta with the gas all three txs burned added back.
 *
 * @returns {Promise<{approveHashes, sellHash, status, blockNumber, ethReceived, tokensIn}>}
 */
async function sell({ wallet, token, quote = 'eth', pool, tokensIn, slippageBps = 0 }, deps = {}) {
  const w = wire(deps);
  const amount = BigInt(tokensIn);
  if (amount <= 0n) throw new Error('a sell needs a positive token amount');
  const tokenAddr = getAddress(token);
  const address = getAddress(wallet.address);

  // Checked before anything is signed — an approval for more than the wallet holds is
  // harmless, but the sell queued behind it at n+2 reverts and the cycle has burned
  // three txs to learn something one eth_call knew.
  const held = await tokenBalance(tokenAddr, address, deps);
  if (held < amount) throw new Error(`${address} holds ${held} of ${tokenAddr} but the cycle needs to sell ${amount}`);

  // Optional floor (default 0 — guaranteed exit). Quote only if a floor is asked for.
  let minOut = 0n;
  if (slippageBps > 0) {
    try {
      const q = await w.swap.quoteSell(
        { token: tokenAddr, quote, tokensInWei: amount, slippageBps, hook: pool.hook, poolKey: pool.poolKey },
        { provider: w.rpc }
      );
      minOut = BigInt(q.minOut);
    } catch (_e) {
      minOut = 0n; // could not quote — fall back to no floor (guaranteed exit)
    }
  }

  const built = w.swap.buildSellTx(
    { token: tokenAddr, quote, tokensInWei: amount, minOut, recipient: address, deadline: deadlineFor(w), poolKey: pool.poolKey },
    { provider: w.rpc }
  );
  const approvals = built.approvals || [];

  if (w.dryRun) {
    return { simulated: true, approveHashes: [], sellHash: null, status: 'simulated', blockNumber: null, ethReceived: 0n, tokensIn: amount };
  }

  const fees = await feesFor(w);
  const before = BigInt(await w.rpc.getBalance(address));
  const startNonce = await w.rpc.getTransactionCount(address, 'pending');
  const signer = w.ks.signer(wallet.id, w.rpc);

  const approveHashes = [];
  let sellHash;
  try {
    for (let i = 0; i < approvals.length; i++) {
      const a = approvals[i];
      const g = a.label && String(a.label).startsWith('erc20') ? ERC20_APPROVE_GAS : PERMIT2_APPROVE_GAS;
      const sent = await signer.sendTransaction({
        to: getAddress(a.to), data: a.data, value: BigInt(a.value || 0n), nonce: startNonce + i, gasLimit: g, ...fees,
      });
      approveHashes.push(sent.hash);
    }
    const sent = await signer.sendTransaction({
      to: built.to, data: built.data, value: BigInt(built.value || 0n), nonce: startNonce + approvals.length, gasLimit: SELL_GAS, ...fees,
    });
    sellHash = sent.hash;
  } catch (err) {
    throw new Error(`sell from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }

  const sellReceipt = await w.await(w.rpc, sellHash);
  const status = statusOf(sellReceipt);
  let ethReceived = 0n;
  if (status === 'confirmed') {
    const after = BigInt(await w.rpc.getBalance(address));
    const approveReceipts = await Promise.all(approveHashes.map((h) => w.await(w.rpc, h).catch(() => null)));
    const gasBurned = spentOn(sellReceipt) + approveReceipts.reduce((s, r) => s + spentOn(r), 0n);
    const delta = after - before + gasBurned; // what the POOL paid, gross of gas
    ethReceived = delta > 0n ? delta : 0n;
  }
  return { approveHashes, sellHash, status, blockNumber: sellReceipt?.blockNumber ?? null, ethReceived, tokensIn: amount };
}

module.exports = {
  BUY_GAS,
  ERC20_APPROVE_GAS,
  PERMIT2_APPROVE_GAS,
  SELL_GAS,
  FEE_BUMP_PCT,
  DEFAULT_BUY_SLIPPAGE_BPS,
  readPool,
  tokenBalance,
  quoteSellOut,
  quoteBuyOut,
  poolFee,
  buy,
  sell,
  _private: { spentOn, statusOf },
};
