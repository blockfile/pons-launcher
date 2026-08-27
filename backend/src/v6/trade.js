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

const { getAddress, Interface } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { readTokenBalance } = require('../evm/erc20');
const swap = require('../evm/v5/swap');

// The V4 PoolManager Swap event — used to prove a token is SELLABLE from its on-chain
// history when the quoter cannot (the CashCat hook's quote-side tax reverts the quoter's
// sell simulation even though the real sell works). currency0 is the ETH side of an
// ETH-quoted pool, so a Swap whose amount0 is positive is ETH LEAVING the pool to the
// swapper — a sell that landed.
const POOL_SWAP_IFACE = new Interface([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);
const SELL_SCAN_WINDOW = 9000;
const SELL_SCAN_MAX_BLOCKS = 300_000;
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
 * THE DUSTING GUARD, and it is a PROVENANCE gate, not a "does a pool exist" check. v6 takes
 * the token from untrusted operator input, and a run signs token approvals — an approval to
 * a hostile ERC-20 is the dusting attack. A decoy token can be paired with a look-alike pool
 * that would satisfy a bare liveness check and then eat every buy (a honeypot).
 *
 * It mirrors V3's fast guard — one factory-authoritative READ, no getLogs (the old
 * findLaunch scan 504'd on a range-capped RPC). Two gates, run in PARALLEL:
 *   1. PROVENANCE — factory.verifyProvenanceByCode(token): eth_getCode(token) must be an
 *      EIP-1167 clone of a factory `tokenMaster`. A decoy ERC-20 has its own bytecode and is
 *      rejected before any pool is trusted or any approval signed.
 *   2. LIVENESS — resolvePoolKey PROBING only the factory's legit hooks: the pool must be
 *      initialised + liquid under a hook the factory's module sets name (not swap.js's loose
 *      candidate list, so a look-alike pool under an unrelated hook can't be selected).
 * findLaunch stays only as a strictly TIME-BOUNDED fallback, reached when provenance passes
 * but no pool exists under a known-legit hook (a future/vanity hook) — never on today's
 * chain. Any operator-supplied `hook` is IGNORED (accepted for call-site symmetry only).
 *
 * @returns {Promise<{token, quote, poolKey, poolId, hook, liquidity, creator}>}
 */
// token -> { impl, creator, hook } once resolved, or { impl, noPoolAt } for a clone with no
// live pool. The token's code is an immutable EIP-1167 proxy and its hook is per-token, so a
// resolved entry is kept forever (the pool is still re-verified live under that hook every
// call). Skipped whenever a caller injects factory/swap/rpc (the tests).
const _poolCache = new Map();
const FIND_LAUNCH_TIMEOUT_MS = 12_000; // cap on the (rare) launch-scan fallback
const READ_TIMEOUT_MS = 12_000; // cap on EVERY readPool RPC read — a hung endpoint can never push readPool past the 60s gateway
const NO_POOL_TTL_MS = 60_000; // how long "clone but no live pool" is remembered, so a forged proxy can't re-trigger the scan each request

async function readPool({ token, quote = 'eth' }, deps = {}) {
  const w = wire(deps);
  const addr = getAddress(token);
  const live = !deps.factory && !deps.swap && !deps.rpc;
  const rt = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const cap = deps.findLaunchTimeoutMs ?? FIND_LAUNCH_TIMEOUT_MS;

  const cached = live ? _poolCache.get(addr) : undefined;
  // Proven + resolved once: re-verify liveness under its KNOWN hook (one call) and never
  // re-enter the probe/fallback — which also removes the fallback as a repeatable DoS.
  if (cached && cached.hook) {
    const r = await withTimeout(w.swap.resolvePoolKey({ token: addr, quote, hook: cached.hook }, { provider: w.rpc }), rt, 'pool');
    return { token: addr, quote, poolKey: r.poolKey, poolId: r.poolId, hook: r.hook, liquidity: r.liquidity, creator: cached.creator };
  }
  // A clone with no live pool, seen recently: reject fast rather than rescan every request.
  if (cached && cached.noPoolAt && Date.now() - cached.noPoolAt < NO_POOL_TTL_MS) {
    throw new Error(`${addr} is a letscash clone but has no live pool for this quote — nothing to trade.`);
  }

  // The legit hook set (never blocks — seeded from config, refreshed in the background).
  const { hooks } = await w.factory.legitSets({ provider: w.rpc });

  // Provenance (eth_getCode) and liveness (probe under legit hooks) IN PARALLEL, each capped
  // so neither can hang readPool. With the live hook this is getCode + slot0 + liquidity.
  const [prov, resolved] = await Promise.all([
    cached ? { ok: true, impl: cached.impl } : withTimeout(w.factory.verifyProvenanceByCode(addr, { provider: w.rpc }), rt, 'provenance'),
    withTimeout(w.swap.resolvePoolKey({ token: addr, quote }, { provider: w.rpc, candidateHooks: [...hooks] }), rt, 'pool probe').then(
      (r) => ({ r }),
      (err) => ({ err })
    ),
  ]);

  // Provenance FIRST — a decoy is rejected before any pool is trusted, and must never reach
  // the findLaunch fallback.
  if (!prov.ok) {
    throw new Error(
      `${addr} is not a letscash launch — its code is not an EIP-1167 clone of a letscash tokenMaster ` +
        `(${prov.reason}), so v6 will not approve or trade it. A decoy ERC-20 with a look-alike pool is ` +
        `exactly the honeypot this refuses.`
    );
  }
  let entry = cached;
  if (live && !entry) {
    entry = { impl: prov.impl, creator: null };
    _poolCache.set(addr, entry);
  }
  let creator = entry ? entry.creator : null;

  let r = resolved.r;
  let hook = r ? r.hook : null;
  if (!r) {
    // Genuine clone, but no pool under any legit hook — a future/vanity hook, a USDG-only
    // launch, or a forged proxy with no pool. Discover it authoritatively ONCE via findLaunch
    // (outer-capped), then cache the outcome so it is never a repeatable scan.
    const launch = await withTimeout(w.factory.findLaunch(addr, { provider: w.rpc }), cap, 'findLaunch');
    if (!launch) {
      if (entry) entry.noPoolAt = Date.now(); // remember "no pool" briefly — DoS defense
      throw resolved.err || new Error(`${addr} has no letscash pool for this quote`);
    }
    r = await withTimeout(w.swap.resolvePoolKey({ token: addr, quote, hook: launch.hook }, { provider: w.rpc }), rt, 'pool (fallback)');
    creator = launch.creator;
    hook = r.hook;
    if (w.factory.refreshLegitSets) w.factory.refreshLegitSets({ provider: w.rpc }); // a new hook appeared — refresh in bg
  }
  if (entry) {
    entry.creator = creator;
    entry.hook = hook; // resolved — future calls skip the probe/fallback
    delete entry.noPoolAt;
  }

  return {
    token: addr,
    quote,
    poolKey: r.poolKey,
    poolId: r.poolId,
    hook: r.hook,
    liquidity: r.liquidity,
    creator,
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
 * Has a SELL ever landed on this pool? — the reliable sellability test when the quoter
 * cannot price a sell (the CashCat hook reverts the quoter's sell simulation with a
 * custom error even though the real UniversalRouter sell works). Scans the PoolManager's
 * Swap events for this pool, newest windows first, and returns true at the first swap
 * that moved ETH OUT to the swapper (amount0 > 0). A token with buys but never a single
 * sell is a real buy-only honeypot; one with sells is sellable. Reads only.
 */
// poolId -> { sold, at }. A sell is permanent (cache forever); a "no sell yet" is cached
// only briefly, so a fresh token that has not sold is re-checked soon but a honeypot the
// operator retries is not re-scanned from scratch each time.
const _soldCache = new Map();
const NO_SELL_TTL_MS = 60_000;

function anySell(logs) {
  return logs.some((log) => POOL_SWAP_IFACE.parseLog({ topics: [...log.topics], data: log.data }).args.amount0 > 0n);
}

async function hasRecentSell({ pool }, deps = {}) {
  const w = wire(deps);
  const rpc = w.rpc;
  const live = !deps.rpc && !deps.head;
  if (live) {
    const c = _soldCache.get(pool.poolId);
    if (c && (c.sold || Date.now() - c.at < NO_SELL_TTL_MS)) return c.sold;
  }

  const base = { address: getAddress(config.letscash.poolManager), topics: [POOL_SWAP_IFACE.getEvent('Swap').topicHash, pool.poolId] };
  const head = deps.head ?? (await rpc.getBlockNumber());
  const found = await scanForSell(rpc, base, head, deps);
  if (live) _soldCache.set(pool.poolId, { sold: found, at: Date.now() });
  return found;
}

// Bound any single RPC read so a slow/hung endpoint cannot push a request toward the 60s
// gateway timeout. On expiry the read rejects and the caller treats sellability as
// "could not verify" — never a 60s hang.
const SCAN_CALL_TIMEOUT_MS = 12_000;
function withTimeout(promise, ms, label) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

// Fast, BOUNDED sellability scan — at most two getLogs calls, each time-capped:
//   1. the RECENT window (an actively-traded token's sell is here — one quick call);
//   2. the WHOLE history in one call (settles a quiet/honeypot pool; few logs to return).
// Returns true (a sell landed) or false (the whole range was read and held none). If the
// node REFUSES the whole-range call or it times out, this THROWS "inconclusive" rather than
// grinding dozens of windows — the caller then allows the run with a warning instead of
// blocking a possibly-fine token or hanging until a 504.
async function scanForSell(rpc, base, head, deps) {
  const recentFrom = Math.max(0, head - SELL_SCAN_WINDOW + 1);
  try {
    if (anySell(await withTimeout(rpc.getLogs({ ...base, fromBlock: recentFrom, toBlock: head }), SCAN_CALL_TIMEOUT_MS, 'sell scan (recent)'))) {
      return true;
    }
  } catch {
    /* recent window unavailable — the whole-range call below is the real decider */
  }
  const floor = deps.floor ?? config.letscash.factoryDeployBlock ?? 0;
  // A throw here (range refused / timed out) propagates as "inconclusive" — deliberately
  // NOT caught, so we never fall into a many-window grind.
  return anySell(await withTimeout(rpc.getLogs({ ...base, fromBlock: floor, toBlock: head }), SCAN_CALL_TIMEOUT_MS, 'sell scan (full)'));
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
  hasRecentSell,
  tokenBalance,
  quoteSellOut,
  quoteBuyOut,
  poolFee,
  buy,
  sell,
  _private: { spentOn, statusOf },
};
