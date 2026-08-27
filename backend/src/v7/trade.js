'use strict';

/**
 * V7's two trades: buy native ETH into a flap BONDING CURVE, and sell part of a
 * position back out of it — ONE wallet, one trade at a time.
 *
 * SEPARATE from v5/v6 by design, and the exact shape of v6/trade.js with the venue
 * swapped from a letscash Uniswap-V4 pool to a flap curve. It WRAPS the flap curve
 * client (evm/v7/curve.js) for calldata + quotes — the one place the exact launcher
 * bytes are built and verified. What differs from v6's V4-pool trade:
 *
 *   - venue: the FIXED flap launcher's swapExactInput (config.flap.launcher), not a
 *     per-token pool/hook. There is no pool to resolve — readCurve verifies provenance,
 *     the native binding, and the curve state, and reads the curve params. No getLogs.
 *   - the SELL is TWO txs (a plain approve(launcher, amount) at n, swapExactInput at
 *     n+1) — not the V4 pool's three (no Permit2 leg).
 *   - the BUY carries native in as msg.value and the SELL takes native out (the launcher
 *     wraps/unwraps WNATIVE internally), so every value hop is native — no wrap/unwrap.
 *   - the quoter PRICES SELLS, so there is no hasRecentSell / sellability getLogs scan;
 *     a genuine state-0 clone's sells are structurally guaranteed by the verified master.
 *   - one concern V6 never had: a GRADUATION gate. readCurve refuses a graduated token,
 *     and assertTradable lets the engine re-check state before each buy so a token that
 *     graduates mid-run halts-and-keeps-state rather than trading the wrong venue.
 *
 * A trade's proceeds are NOT in its receipt, so tokensOut / ethReceived are measured as
 * BALANCE DELTAS, with the gas the txs burned added back on the sell — the v3/v5/v6
 * technique. This is what lets a sell's ACTUAL proceeds size the Relay transfer that
 * follows it, net of the curve fee and any on-curve tax.
 */

const { getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { readTokenBalance } = require('../evm/erc20');
const curve = require('../evm/v7/curve');

// The buy is a single native-value swapExactInput; the launcher wraps internally, so it
// is heavier than a bare swap. Generous (unused gas refunded).
const BUY_GAS = BigInt(config.flap.buyGas || 550_000);
// The sell is TWO txs: a cheap approve, then swapExactInput (unwraps internally) which
// cannot be estimated before the approve is mined, so it takes a fixed generous cap.
const ERC20_APPROVE_GAS = 90_000n;
const SELL_GAS = BigInt(config.flap.sellGas || 650_000);

const FEE_BUMP_PCT = 25;

// Default BUY floor. The flap curve is a predictable constant-product with a 1% fee, so
// V7 CAN run a strictly-guaranteed buy (slippageBps 0) — but the default absorbs the fee,
// any on-curve tax, and others' impact. The engine passes its own operator-set value.
const DEFAULT_BUY_SLIPPAGE_BPS = 1500;

const READ_TIMEOUT_MS = 12_000; // cap on EVERY readCurve RPC read — a hung endpoint can never push readCurve past the 60s gateway

const LAUNCHER = () => getAddress(config.flap.launcher);

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

// Bound any single RPC read so a slow/hung endpoint cannot push a request toward the 60s
// gateway timeout — the same guard v6/trade.js keeps on readPool.
function withTimeout(promise, ms, label) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

function wire(deps = {}) {
  return {
    rpc: deps.rpc || provider,
    ks: deps.keystore,
    curve: deps.curve || curve,
    await: deps.waitForReceiptFn || waitForReceipt,
    readBal: deps.readTokenBalance || readTokenBalance,
    getFeesFn: deps.getFeesFn || getFees,
    fees: deps.fees || null,
    dryRun: deps.dryRun ?? config.dryRun,
  };
}

async function feesFor(w) {
  return w.fees || (await w.getFeesFn(FEE_BUMP_PCT));
}

/**
 * Resolve + VERIFY a flap curve for a token, ONCE (replaces v6's readPool).
 *
 * THE DUSTING GUARD, and a PROVENANCE gate, not a "does a curve exist" check. V7 takes the
 * token from untrusted operator input, and a run signs a token approval — an approval to a
 * hostile ERC-20 is the dusting attack, and a decoy could be a buy-only honeypot. Three
 * O(1) gates, no getLogs (the venue is fixed, so there is no pool/hook to probe):
 *   1. PROVENANCE — curve.verifyProvenanceByCode: one eth_getCode; the token must be an
 *      EIP-1167 clone of a flap tokenMaster. A decoy ERC-20 is rejected before any approve.
 *   2. NATIVE BINDING — quoteToken() must be WNATIVE, so proceeds are native and every Relay
 *      hop stays native. A token quoted in another ERC-20 is refused (the relay chain would
 *      break — Relay cannot move it).
 *   3. STATE GATE — state() must be BondingCurve(0). A graduated token trades on a different
 *      venue (the V2 pair) V7 does not touch, so it is refused.
 * Steps 1–2 are immutable for a genuine clone (code + quoteToken never change) and are cached;
 * step 3 and the curve params are re-read LIVE every call (state only advances, and the
 * graduation gate needs the current circulatingSupply).
 *
 * @returns {Promise<{token, quote, venue, state, circulatingSupply, dexSupplyThresh, headroomTokens}>}
 */
// token -> { impl } once provenance + native binding pass. A clone's code and its
// quoteToken are immutable, so the entry is kept forever; state/params are still re-read
// live every call. Skipped whenever a caller injects curve/rpc (the tests).
const _curveCache = new Map();

async function readCurve({ token, quote = 'eth' }, deps = {}) {
  const w = wire(deps);
  const addr = getAddress(token);
  const live = !deps.curve && !deps.rpc;
  const rt = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const cached = live ? _curveCache.get(addr) : undefined;

  if (!cached) {
    // 1. PROVENANCE — one eth_getCode; a decoy ERC-20 is rejected before any approve.
    const prov = await withTimeout(w.curve.verifyProvenanceByCode(addr, { provider: w.rpc }), rt, 'provenance');
    if (!prov.ok) {
      throw new Error(
        `${addr} is not a flap launch — ${prov.reason}, so V7 will not approve or trade it. ` +
          `A decoy ERC-20 is exactly the honeypot this refuses.`
      );
    }
    // 2. NATIVE BINDING — only WNATIVE-quoted curves keep every Relay hop native.
    const quoteTok = (await withTimeout(w.curve.quoteTokenOf(addr, { provider: w.rpc }), rt, 'quoteToken')).toLowerCase();
    if (quoteTok !== config.flap.wnative) {
      throw new Error(
        `${addr} is quoted in ${quoteTok}, not WNATIVE (${config.flap.wnative}) — V7 only trades native-quoted ` +
          `flap curves, because the relay chain must stay native (Relay cannot move an arbitrary ERC-20).`
      );
    }
    if (live) _curveCache.set(addr, { impl: prov.impl });
  }

  // 3. STATE GATE — curve-only. state≥1 means it graduated to the V2 pair (a different venue).
  const state = await withTimeout(w.curve.tokenState(addr, { provider: w.rpc }), rt, 'state');
  if (Number(state) !== config.flap.bondingState) {
    throw new Error(
      `${addr} is in state ${state}, not BondingCurve(${config.flap.bondingState}) — it has graduated to the V2 ` +
        `pair. V7 trades the state-0 flap curve only.`
    );
  }

  // 4. curve params for the graduation gate + a liveness probe.
  const { circulatingSupply, dexSupplyThresh } = await withTimeout(
    w.curve.tokenCurve(addr, { provider: w.rpc }),
    rt,
    'curve'
  );

  return {
    token: addr,
    quote: 'eth',
    venue: LAUNCHER(),
    state: Number(state),
    circulatingSupply,
    dexSupplyThresh,
    headroomTokens: dexSupplyThresh > circulatingSupply ? dexSupplyThresh - circulatingSupply : 0n,
  };
}

/**
 * Cheap mid-run graduation re-check: throws if the token is no longer on the state-0
 * curve. Called by the engine before the big buy and before each bundle buy, so a token
 * that graduated between cycles halts-and-keeps-state (nothing signed) rather than trading
 * the wrong venue.
 */
async function assertTradable(token, deps = {}) {
  const w = wire(deps);
  const state = await w.curve.tokenState(getAddress(token), { provider: w.rpc });
  if (Number(state) !== config.flap.bondingState) {
    throw new Error(
      `${getAddress(token)} is in state ${state}, not BondingCurve(${config.flap.bondingState}) — it graduated ` +
        `mid-run. V7 halts and keeps state rather than trade the wrong venue.`
    );
  }
  return Number(state);
}

/** A wallet's balance of one token. */
async function tokenBalance(token, owner, deps = {}) {
  const w = wire(deps);
  return BigInt(await w.readBal(getAddress(token), getAddress(owner)));
}

/** Quote ETH out for selling `tokensIn` (for slice sizing). `pool`/`quote` ignored (fixed venue). */
async function quoteSellOut({ token, quote = 'eth', pool, tokensIn }, deps = {}) {
  const w = wire(deps);
  return BigInt(await w.curve.quoteSell({ token: getAddress(token), tokensInWei: BigInt(tokensIn) }, { provider: w.rpc }));
}

/** Quote tokens out for buying `amountWei` (reporting / feasibility / graduation guard). */
async function quoteBuyOut({ token, quote = 'eth', pool, amountWei }, deps = {}) {
  const w = wire(deps);
  return BigInt(await w.curve.quoteBuy({ token: getAddress(token), amountInWei: BigInt(amountWei) }, { provider: w.rpc }));
}

/**
 * Spend `amountWei` native on the curve, tokens to the buyer. ONE tx (native in as
 * msg.value). Quotes to set the floor; near graduation the quote SATURATES (the curve
 * caps output at the remaining headroom) and the buy still lands. `pool` is accepted for
 * call-site symmetry with v6 and IGNORED — the venue is fixed.
 *
 * @returns {Promise<{hash, status, blockNumber, tokensOut, expectedOut, minOut}>}
 */
async function buy({ wallet, token, quote = 'eth', pool, amountWei, slippageBps = DEFAULT_BUY_SLIPPAGE_BPS }, deps = {}) {
  const w = wire(deps);
  const amount = BigInt(amountWei);
  if (amount <= 0n) throw new Error('a buy needs a positive amount');
  const tokenAddr = getAddress(token);

  const expectedOut = BigInt(await w.curve.quoteBuy({ token: tokenAddr, amountInWei: amount }, { provider: w.rpc }));
  if (expectedOut <= 0n) throw new Error(`the curve quote returned no output for ${tokenAddr} — refusing a buy that would get nothing`);
  // slippageBps 0 is a deliberate, strictly-guaranteed buy on the predictable curve.
  const minOut = slippageBps > 0 ? (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n : 0n;

  const tx = w.curve.buildBuyTx({ token: tokenAddr, amountInWei: amount, minOut }); // { to, data, value: amount }

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
      .sendTransaction({ to: tx.to, data: tx.data, value: amount, nonce, gasLimit: BUY_GAS, ...fees });
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
 * Sell `tokensIn` back to native, proceeds to the seller. TWO txs at consecutive nonces
 * (approve(launcher, amount) at n, swapExactInput at n+1), broadcast in nonce order
 * without waiting — the sequencer runs a wallet's txs in nonce order, so the approval is
 * in place by the time the sell runs. minOut default 0 (a guaranteed exit; pass slippageBps
 * for a floor). Proceeds measured as a native balance delta with BOTH txs' gas added back.
 *
 * @returns {Promise<{approveHashes, sellHash, status, blockNumber, ethReceived, tokensIn}>}
 */
async function sell({ wallet, token, quote = 'eth', pool, tokensIn, slippageBps = 0 }, deps = {}) {
  const w = wire(deps);
  const amount = BigInt(tokensIn);
  if (amount <= 0n) throw new Error('a sell needs a positive token amount');
  const tokenAddr = getAddress(token);
  const address = getAddress(wallet.address);

  // Checked before anything is signed — the sell queued behind a too-large approve would
  // revert and the cycle would burn two txs to learn what one eth_call knew.
  const held = await tokenBalance(tokenAddr, address, deps);
  if (held < amount) throw new Error(`${address} holds ${held} of ${tokenAddr} but the cycle needs to sell ${amount}`);

  // Optional floor (default 0 — guaranteed exit). The flap quoter DOES price sells.
  let minOut = 0n;
  if (slippageBps > 0) {
    try {
      const q = BigInt(await w.curve.quoteSell({ token: tokenAddr, tokensInWei: amount }, { provider: w.rpc }));
      minOut = (q * BigInt(10_000 - slippageBps)) / 10_000n;
    } catch (_e) {
      minOut = 0n; // could not quote — fall back to no floor (guaranteed exit)
    }
  }

  const approveTx = w.curve.buildApproveTx({ token: tokenAddr, amount });
  const sellTx = w.curve.buildSellTx({ token: tokenAddr, tokensInWei: amount, minOut });

  if (w.dryRun) {
    return { simulated: true, approveHashes: [], sellHash: null, status: 'simulated', blockNumber: null, ethReceived: 0n, tokensIn: amount };
  }

  const fees = await feesFor(w);
  const before = BigInt(await w.rpc.getBalance(address));
  const startNonce = await w.rpc.getTransactionCount(address, 'pending');
  const signer = w.ks.signer(wallet.id, w.rpc);

  let approveHash, sellHash;
  try {
    approveHash = (
      await signer.sendTransaction({ to: approveTx.to, data: approveTx.data, value: 0n, nonce: startNonce, gasLimit: ERC20_APPROVE_GAS, ...fees })
    ).hash;
    sellHash = (
      await signer.sendTransaction({ to: sellTx.to, data: sellTx.data, value: 0n, nonce: startNonce + 1, gasLimit: SELL_GAS, ...fees })
    ).hash;
  } catch (err) {
    throw new Error(`sell from ${address} failed to broadcast: ${rpcMessage(err)}`);
  }

  const sellReceipt = await w.await(w.rpc, sellHash);
  const status = statusOf(sellReceipt);
  let ethReceived = 0n;
  if (status === 'confirmed') {
    const after = BigInt(await w.rpc.getBalance(address));
    const approveReceipt = await w.await(w.rpc, approveHash).catch(() => null);
    const gasBurned = spentOn(sellReceipt) + spentOn(approveReceipt); // add back BOTH txs' gas
    const delta = after - before + gasBurned; // what the CURVE paid, gross of gas
    ethReceived = delta > 0n ? delta : 0n;
  }
  return { approveHashes: [approveHash], sellHash, status, blockNumber: sellReceipt?.blockNumber ?? null, ethReceived, tokensIn: amount };
}

module.exports = {
  BUY_GAS,
  ERC20_APPROVE_GAS,
  SELL_GAS,
  FEE_BUMP_PCT,
  DEFAULT_BUY_SLIPPAGE_BPS,
  readCurve,
  // Alias so engine.js / exit.js / routes cloned from v6 (which call trade.readPool) work
  // unchanged. One function, two names — never duplicate the guard.
  readPool: readCurve,
  assertTradable,
  tokenBalance,
  quoteSellOut,
  quoteBuyOut,
  buy,
  sell,
  _private: { spentOn, statusOf },
};
