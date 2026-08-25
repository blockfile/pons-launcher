'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — the letscash.fun (CashCat) SELL / exit money path.
//
// Unwinds every bundle wallet's position in a launched token back to ETH, one
// wallet at a time, through a V4 swap on the UniversalRouter. Same discipline as
// the pons sell (bundle/prepareSell.js), which this mirrors: prepareSell builds
// and SIGNS everything at preflight and fireSell only broadcasts, so key
// derivation is never in the critical path and a plan can be read before a wallet
// moves.
//
// THE V4 SELL IS THREE TRANSACTIONS PER WALLET, not two. letscash sells route the
// token IN through Permit2, so before the swap each seller needs:
//   1. token.approve(Permit2, MAX)            — the standard one-time ERC-20 grant
//   2. Permit2.approve(token, router, amount) — bounded to this sell's balance
//   3. router.execute(sell)                    — the V4 token → ETH swap
// They are signed at consecutive nonces (n, n+1, n+2). The sequencer runs a
// wallet's txs in nonce order, so the approvals do not need to confirm before the
// sell is sent — the same nonce-ordering trick the launch's first buy relies on.
//
// DECISIONS (mirrored from the pons sell, each load-bearing):
//   1. NO SLIPPAGE FLOOR by default (minOut 0). The point of the exit is that
//      nothing is left holding tokens — every wallet sells at whatever price it
//      gets. A caller may pass slippageBps for a floor, accepting that a floor
//      turns a guaranteed exit into a maybe-exit.
//   2. THE POOL IS RESOLVED AGAINST THE CHAIN, never the config hook — the same
//      per-pool-hook safety swap.js enforces everywhere. resolvePoolKey verifies
//      the pool is initialised and has liquidity before a single approval is signed.
//   3. THE TOKEN MUST BE ONE THIS ACCOUNT LAUNCHED — enforced at the route
//      (assertOwnLaunchedToken), because signing an approval to a contract we did
//      not create is the dusting attack. This module trusts that gate.
// ─────────────────────────────────────────────────────────────────────────────

const { formatEther, formatUnits, getAddress, isAddress } = require('ethers');
const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { keystoreFor } = require('../wallets/keystore');
const { getDecimals, getSymbol, readTokenBalance } = require('../evm/erc20');
const swap = require('../evm/v5/swap');
const v5roles = require('./roles');

// The two approvals are cheap and well-behaved; 90k each is generous (unused gas
// is refunded). The SELL cannot be estimated — its approvals are not mined yet, so
// estimateGas would revert on the allowance check — so it takes a fixed limit,
// sized generously for a V4 execute() with a Permit2 pull, a settle and a take.
const ERC20_APPROVE_GAS = 90_000n;
const PERMIT2_APPROVE_GAS = 90_000n;
// The sell CANNOT be estimated — its two approvals are not mined yet, so
// estimateGas would revert on the allowance check — so it takes a FIXED, generous
// cap. A V4 execute() (Permit2 transferFrom pull + settle + take + the hook's tax
// skim) lands ~220-400k on this chain; 700k is ~1.75-3x headroom, and unused gas
// is refunded, so over-reserving costs only the up-front balance check. Sized
// above the pons sell's 600k because a hooked V4 swap is heavier than its v3 one.
const SELL_GAS = 700_000n;

// Signed at preflight, broadcast seconds later; the deadline only satisfies the
// router shape. An hour, matching the buy/launch window. NOT price protection.
const DEADLINE_SECONDS = 3600;

const FEE_BUMP_PCT = 25;

/** Strip to the signable fields + pin nonce/gas/chainId/fees. Mirrors launch/bundle. */
function toSignable({ to, data, value = 0n }, { nonce, gasLimit, fees, chainId }) {
  return { to, data, value: BigInt(value), nonce, gasLimit, chainId, ...fees };
}

function stringifyFees(fees) {
  return Object.fromEntries(
    Object.entries(fees).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
  );
}

/**
 * Build a signed V4 exit for every bundle wallet holding `token`.
 *
 * @param {object} input
 * @param {string} input.token          the token to exit.
 * @param {number} [input.slippageBps]  a floor (default 0 — no floor; guaranteed exit).
 * @param {object} [deps]               injectable for tests: { keystore, roles, provider, swap, getFees, readTokenBalance, getDecimals, getSymbol }.
 * @returns {Promise<object>} a plan in which every approval and sell is signed. Broadcast NOTHING.
 */
async function prepareSell(input, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const swapClient = deps.swap || swap;
  const getFeesFn = deps.getFees || getFees;
  const readBal = deps.readTokenBalance || readTokenBalance;
  const decimalsOf = deps.getDecimals || getDecimals;
  const symbolOf = deps.getSymbol || getSymbol;
  const dryRun = deps.dryRun ?? config.dryRun;

  const { token, slippageBps = 0, quote = 'eth', hook } = input || {};
  if (!token || !isAddress(String(token))) throw new Error('token must be the launched ERC-20 address');
  const tokenAddr = getAddress(token);

  // The exit quote — ETH or USDG (the two letscash quotes). A USDG-quoted token
  // sells token → USDG; proceeds are then denominated in USDG units, not ETH.
  const q = String(quote).toLowerCase();
  const usdgAddr = getAddress(config.letscash.usdg);
  const isNativeQuote = q === 'eth' || q === 'native' || q === '0x0000000000000000000000000000000000000000';
  const isUsdg = q === 'usdg' || (isAddress(q) && getAddress(q) === usdgAddr);
  if (!isNativeQuote && !isUsdg) {
    throw new Error('the v5 sell exits to ETH or USDG only — pass "eth" (default) or "usdg"');
  }
  const quoteDecimals = isNativeQuote ? 18 : Number(await decimalsOf(usdgAddr));
  const quoteSymbol = isNativeQuote ? 'ETH' : 'USDG';

  // THE decoy-pool guard. resolvePoolKey WITHOUT a hook probes candidate hooks and
  // takes the first live pool — and on the permissionless V4 PoolManager an
  // attacker can seed a decoy pool under the first candidate (config.hook) with
  // trivial liquidity. With minOut 0 the sell would drain into it for dust. So the
  // EXACT hook is REQUIRED here — the caller passes the launch receipt's recorded
  // hook (routes/v5.js looks it up), and resolvePoolKey pins THAT pool and verifies
  // it is initialised + liquid. No hook ⇒ no sell.
  if (!hook || !isAddress(String(hook))) {
    throw new Error(
      'a verified pool hook is required — the sell must target the exact pool from the launch receipt, ' +
        'never a probed one (a seeded decoy pool under the default hook would drain the exit at minOut 0)'
    );
  }
  const hookAddr = getAddress(hook);

  const wallets = roles.bundle(ks);
  if (!wallets.length) throw new Error('no v5bundle wallets to sell from — nothing to exit');

  // Resolve+VERIFY the pinned pool against the chain ONCE — the verified poolKey
  // every wallet's sell is built against. Passing the hook pins exactly one pool;
  // resolvePoolKey still checks it is initialised and liquid, and throws otherwise
  // (so we never sign an approval for a token whose pool we cannot find).
  const resolved = await swapClient.resolvePoolKey({ token: tokenAddr, quote, hook: hookAddr }, { provider: prov });

  const [decimals, symbol] = await Promise.all([decimalsOf(tokenAddr), symbolOf(tokenAddr)]);

  // Who holds any of it.
  const balances = await Promise.all(wallets.map((w) => readBal(tokenAddr, w.address)));
  const holders = [];
  const skipped = [];
  const warnings = [];
  wallets.forEach((w, i) => {
    const balance = balances[i];
    if (balance > 0n) holders.push({ wallet: w, balance });
    else skipped.push({ walletId: w.id, address: w.address, reason: `holds none of ${symbol}` });
  });
  if (!holders.length) throw new Error(`no bundle wallet holds any ${symbol} (${tokenAddr}) — nothing to sell`);

  const fees = deps.fees || (await getFeesFn(FEE_BUMP_PCT));
  const chainId = BigInt(deps.chainId ?? config.chainId);
  const reserve = gasCost(fees, ERC20_APPROVE_GAS + PERMIT2_APPROVE_GAS + SELL_GAS);
  const nowSec = deps.nowMs != null ? Math.floor(deps.nowMs / 1000) : Math.floor(Date.now() / 1000);
  const deadline = deps.deadline ?? nowSec + DEADLINE_SECONDS;

  const out = [];
  for (const { wallet, balance } of holders) {
    const native = await prov.getBalance(wallet.address);
    if (native < reserve) {
      // Signing an approval a wallet cannot pay for is worse than skipping it: a
      // broadcast approval that cannot mine strands the sell queued behind it.
      const why = `native ${formatEther(native)} ETH does not cover the two approvals + the sell (${formatEther(reserve)} ETH gas)`;
      skipped.push({ walletId: wallet.id, address: wallet.address, reason: why });
      warnings.push(`${wallet.address}: ${why} — skipped`);
      continue;
    }

    // Best-effort quote for the operator; gates nothing.
    let estEthOut = null;
    try {
      const q = await swapClient.quoteSell(
        { token: tokenAddr, quote, tokensInWei: balance, slippageBps, hook: resolved.hook },
        { provider: prov }
      );
      estEthOut = q.expectedOut;
    } catch (_err) {
      warnings.push(`${wallet.address}: could not quote the sell — proceeds unknown until it lands`);
    }

    // The floor. 0 unless a slippageBps was asked for. Applied to the quote if we
    // have one; without a quote a slippageBps cannot be honoured, so it stays 0
    // (and a warning already went out above).
    const minOut = slippageBps > 0 && estEthOut != null ? swapClient.applySlippage(estEthOut, slippageBps) : 0n;

    // The sell + its two Permit2 approvals, built against the VERIFIED pool.
    const built = swapClient.buildSellTx(
      {
        token: tokenAddr,
        quote,
        tokensInWei: balance,
        minOut,
        recipient: wallet.address,
        deadline,
        poolKey: resolved.poolKey,
      },
      { provider: prov }
    );
    const approvals = built.approvals || [];

    const startNonce = await prov.getTransactionCount(wallet.address, 'pending');
    const signer = ks.signer(wallet.id, prov);

    // Sign the approvals then the sell, at consecutive nonces.
    const signedApprovals = [];
    for (let i = 0; i < approvals.length; i++) {
      const a = approvals[i];
      const nonce = startNonce + i;
      signedApprovals.push({
        label: a.label,
        to: getAddress(a.to),
        nonce,
        raw: await signer.signTransaction(
          toSignable({ to: a.to, data: a.data, value: a.value || 0n }, { nonce, gasLimit: a.label && a.label.startsWith('erc20') ? ERC20_APPROVE_GAS : PERMIT2_APPROVE_GAS, fees, chainId })
        ),
      });
    }
    const sellNonce = startNonce + approvals.length;
    const sell = {
      nonce: sellNonce,
      minOut: minOut.toString(),
      raw: await signer.signTransaction(
        toSignable({ to: built.to, data: built.data, value: built.value || 0n }, { nonce: sellNonce, gasLimit: SELL_GAS, fees, chainId })
      ),
    };

    out.push({
      walletId: wallet.id,
      address: wallet.address,
      tokens: formatUnits(balance, decimals),
      tokensRaw: balance.toString(),
      // The estimate is in the QUOTE's units (ETH or USDG); estEthOut keeps its
      // name for back-compat but is denominated by quoteSymbol on the plan.
      estEthOut: estEthOut == null ? null : formatUnits(estEthOut, quoteDecimals),
      estEthOutRaw: estEthOut == null ? null : estEthOut.toString(),
      approvals: signedApprovals,
      sell,
    });
  }

  if (!out.length) {
    throw new Error(
      `every wallet holding ${symbol} is too short of ETH to pay for the exit — fund them with gas first`
    );
  }

  const totalTokens = out.reduce((s, w) => s + BigInt(w.tokensRaw), 0n);
  const estEthTotal = out.reduce((s, w) => s + (w.estEthOutRaw ? BigInt(w.estEthOutRaw) : 0n), 0n);

  warnings.push(
    'estEthOut is a per-wallet quote against the pool as it is now; these sells all land close ' +
      'together and move the price, so the real proceeds are lower and the tail fills worst. ' +
      (slippageBps > 0 ? `A ${slippageBps}bps floor is applied.` : 'There is NO slippage floor — every wallet exits at whatever price it gets.')
  );

  return {
    protocol: 'v5',
    kind: 'sell',
    token: tokenAddr,
    symbol,
    decimals,
    hook: resolved.hook,
    poolId: resolved.poolId,
    quote: isNativeQuote ? 'eth' : usdgAddr,
    quoteSymbol,
    quoteIsNative: isNativeQuote,
    minOutFloor: slippageBps > 0 ? `${slippageBps}bps` : '0 (no floor)',
    dryRun,
    wallets: out,
    skipped,
    walletCount: out.length,
    totalTokens: formatUnits(totalTokens, decimals),
    estEthOutTotal: estEthTotal > 0n ? formatUnits(estEthTotal, quoteDecimals) : null,
    fees: stringifyFees(fees),
    erc20ApproveGas: ERC20_APPROVE_GAS.toString(),
    permit2ApproveGas: PERMIT2_APPROVE_GAS.toString(),
    sellGas: SELL_GAS.toString(),
    chainId: chainId.toString(),
    warnings,
  };
}

/**
 * Broadcast every wallet's pre-signed approvals + sell, in nonce order, and read
 * the receipts back. A wallet's txs are broadcast in order (approvals then sell);
 * different wallets are independent, so one wallet's failed exit strands only its
 * own position.
 *
 * @param {object} plan   from prepareSell (every approval/sell raw is signed).
 * @param {object} [deps] injectable: { provider, waitForReceipt, warmPool, dryRun }.
 * @returns {Promise<object>} { token, symbol, sold, failed, pending, wallets:[{address, status, sellHash}] }
 */
async function fireSell(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const warm = deps.warmPool || warmPool;

  if (!plan || plan.kind !== 'sell' || !Array.isArray(plan.wallets)) {
    throw new Error('not a v5 sell plan — re-run preflight');
  }

  if (dryRun) {
    return {
      simulated: true,
      protocol: 'v5',
      kind: 'sell',
      token: plan.token,
      symbol: plan.symbol,
      sold: 0,
      failed: 0,
      pending: 0,
      wallets: plan.wallets.map((w) => ({ address: w.address, status: 'simulated', sellHash: null })),
    };
  }

  for (const w of plan.wallets) {
    if (!w.sell?.raw || (w.approvals || []).some((a) => !a.raw)) {
      throw new Error('plan has unsigned transactions — re-run preflight');
    }
  }

  await warm(Math.min(plan.wallets.length, 4), rpc);

  // Broadcast each wallet's txs in nonce order. Sequential within a wallet
  // (approvals must precede the sell); wallets processed in turn.
  const results = [];
  for (const w of plan.wallets) {
    const r = { walletId: w.walletId, address: w.address, tokens: w.tokens, sellHash: null, status: 'broadcast' };
    try {
      for (const a of w.approvals || []) {
        await rpc.broadcastTransaction(a.raw);
      }
      const resp = await rpc.broadcastTransaction(w.sell.raw);
      r.sellHash = resp.hash;
    } catch (err) {
      r.status = 'send-failed';
      r.error = err.message;
    }
    results.push(r);
  }

  // Await the SELL receipts (the approvals ride in front on lower nonces; if the
  // sell mined, they did too).
  await Promise.all(
    results.map(async (r) => {
      if (!r.sellHash) return;
      let receipt = null;
      try {
        receipt = await awaitReceipt(rpc, r.sellHash);
      } catch (_err) {
        receipt = null;
      }
      r.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
      r.blockNumber = receipt?.blockNumber ?? null;
    })
  );

  const sold = results.filter((r) => r.status === 'confirmed').length;
  const failed = results.filter((r) => r.status === 'reverted' || r.status === 'send-failed').length;
  const pending = results.filter((r) => r.status === 'pending').length;
  return {
    protocol: 'v5',
    kind: 'sell',
    token: plan.token,
    symbol: plan.symbol,
    sold,
    failed,
    pending,
    wallets: results,
  };
}

module.exports = {
  prepareSell,
  fireSell,
  toSignable,
  ERC20_APPROVE_GAS,
  PERMIT2_APPROVE_GAS,
  SELL_GAS,
  FEE_BUMP_PCT,
};
