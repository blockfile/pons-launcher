'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — the letscash.fun (CashCat) BUNDLE fan-out money path.
//
// This is letscash's actual bundler primitive. letscash has NO snipe-tax
// exemption list (unlike pons v2), so there is no way to make many wallets buy
// cheaply in the launch block. What IS free is a plain ERC-20 TRANSFER: the
// CashCat hook taxes SWAPS (pool interactions) on the quote side, but a
// wallet→wallet `transfer()` never touches the pool or the hook, so it is
// UNTAXED. So the edge is:
//
//   1. the launcher makes ONE big atomic firstBuyIn inside the launch (done in
//      v5/launch.js) — guaranteed first, unfront-runnable, and it lands the
//      whole intended position in the launcher wallet.
//   2. THIS module fans that position out to the N bundle wallets with untaxed
//      transfers, so the supply ends up spread across many wallets at the launch
//      price without any of them paying the anti-snipe premium.
//
// It mirrors v5/launch.js's discipline: prepareBundle SIGNS every transfer at
// preflight (against the launcher's sequential pending nonces) after checking the
// balance covers them and the launcher can pay the gas, and BROADCASTS NOTHING;
// fireBundle broadcasts the pre-signed transfers and reads each receipt back.
//
// LOWER RISK THAN THE LAUNCH: every transfer moves the operator's OWN token to
// the operator's OWN wallet. The worst realistic failure is a transfer that
// reverts (caught by the balance sum-check up front) or a mis-split — not a loss
// to a third party. The one external assumption is that the token's transfer() is
// untaxed; letscash tokens are standard ERC-20s whose tax lives in the hook, so
// they are, but prepareBundle records the assumption and the review path checks it.
// ─────────────────────────────────────────────────────────────────────────────

const { Interface, parseUnits, formatUnits, getAddress, isAddress } = require('ethers');
const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { keystoreFor } = require('../wallets/keystore');
const { ERC20_ABI, getDecimals, getSymbol, readTokenBalance } = require('../evm/erc20');
const v5roles = require('./roles');

const erc20Iface = new Interface(ERC20_ABI);

// Same +25% headroom the launcher uses, so a transfer is not the tx left behind
// when the base fee ticks up between preflight and broadcast.
const FEE_BUMP_PCT = 25;

/** Strip to the signable fields + pin nonce/gas/chainId/fees. Mirrors launch.js. */
function toSignable({ to, data }, { nonce, gasLimit, fees, chainId }) {
  return { to, data, value: 0n, nonce, gasLimit, chainId, ...fees };
}

/** BigInt fees → strings, so the plan survives JSON.stringify. */
function stringifyFees(fees) {
  return Object.fromEntries(
    Object.entries(fees).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
  );
}

/**
 * Work out how many token-wei each bundle wallet should receive.
 *
 *   mode 'equal' (default): split (balance − leaveInLauncher) EQUALLY across the
 *       wallets. Integer division leaves a dust remainder; it stays in the
 *       launcher (never silently added to one wallet), so the maths is exact and
 *       auditable.
 *   mode 'amounts': explicit per-wallet amounts, in whole TOKEN units (parsed
 *       with the token's decimals, never wei, so a caller cannot fat-finger 18
 *       zeros). TWO accepted shapes:
 *         • a POSITIONAL array of amounts, aligned to the bundle-wallet list by
 *           index — must have exactly one entry per wallet.
 *         • NAMED entries { walletId | address, amount } — each is matched to its
 *           bundle wallet BY NAME, never by position, and may address a subset.
 *           A name that is not one of this tab's bundle wallets, or a wallet named
 *           twice, is an error — never silently aligned to the wrong wallet.
 *       If ANY entry is a named object, the whole list is treated as named.
 *
 * @returns {{ perWallet: Array<{wallet, amountWei: bigint}>, totalWei: bigint, leaveWei: bigint }}
 */
function planAllocations({ wallets, balanceWei, decimals, mode, leaveInLauncher, amounts }) {
  if (!wallets.length) throw new Error('no v5bundle wallets to fan out to — generate some first');

  if (mode === 'amounts') {
    if (!Array.isArray(amounts) || !amounts.length) throw new Error('amounts[] is required in amounts mode');
    const parse = (raw, label) => {
      const amountWei = parseUnits(String(raw ?? '0'), decimals);
      if (amountWei < 0n) throw new Error(`a negative amount for ${label} makes no sense`);
      return amountWei;
    };

    const named = amounts.some((a) => a && typeof a === 'object' && (a.walletId != null || a.address != null));
    if (named) {
      // Match each entry to its wallet BY NAME. Ignore position entirely.
      const seen = new Set();
      const perWallet = amounts.map((entry) => {
        if (!entry || typeof entry !== 'object' || (entry.walletId == null && entry.address == null)) {
          throw new Error('every amounts entry must name its wallet ({ walletId | address, amount }) when any does');
        }
        const key = entry.walletId ?? entry.address;
        const wallet = wallets.find(
          (w) =>
            (entry.walletId != null && w.id === entry.walletId) ||
            (entry.address != null && getAddress(w.address) === getAddress(entry.address))
        );
        if (!wallet) throw new Error(`amounts names "${key}", which is not one of this tab's bundle wallets`);
        if (seen.has(wallet.id)) throw new Error(`amounts names wallet ${wallet.id} more than once`);
        seen.add(wallet.id);
        return { wallet, amountWei: parse(entry.amount, key) };
      });
      return { perWallet, totalWei: perWallet.reduce((s, p) => s + p.amountWei, 0n), leaveWei: 0n };
    }

    // Positional: one plain amount per wallet, aligned by index.
    if (amounts.length !== wallets.length) {
      throw new Error(`a positional amounts[] must have one entry per bundle wallet (${wallets.length})`);
    }
    const perWallet = wallets.map((wallet, i) => ({ wallet, amountWei: parse(amounts[i], wallet.address) }));
    return { perWallet, totalWei: perWallet.reduce((s, p) => s + p.amountWei, 0n), leaveWei: 0n };
  }

  // 'equal' (default).
  const leaveWei = leaveInLauncher ? parseUnits(String(leaveInLauncher), decimals) : 0n;
  if (leaveWei < 0n) throw new Error('leaveInLauncher cannot be negative');
  const distributable = balanceWei - leaveWei;
  if (distributable <= 0n) {
    throw new Error(
      `nothing to distribute: the launcher holds ${formatUnits(balanceWei, decimals)} but ` +
        `leaveInLauncher is ${formatUnits(leaveWei, decimals)}`
    );
  }
  const each = distributable / BigInt(wallets.length); // floor; remainder stays in launcher
  if (each <= 0n) throw new Error('the split rounds to zero per wallet — fewer wallets or more supply');
  const perWallet = wallets.map((wallet) => ({ wallet, amountWei: each }));
  return { perWallet, totalWei: each * BigInt(wallets.length), leaveWei };
}

/**
 * Build + sign the untaxed token fan-out WITHOUT broadcasting anything.
 *
 * @param {object} input
 * @param {string} input.token          the launched ERC-20 to fan out (from the launch result).
 * @param {'equal'|'amounts'} [input.mode='equal']
 * @param {string} [input.leaveInLauncher='0']  ('equal' mode) whole-token amount to keep in the launcher.
 * @param {Array} [input.amounts]        ('amounts' mode) one whole-token amount per bundle wallet.
 * @param {object} [deps]                injected for tests: { keystore, roles, provider, getFees, readTokenBalance, getDecimals, getSymbol }.
 * @returns {Promise<object>} a plan whose transfers[].raw are SIGNED. Broadcast NOTHING.
 */
async function prepareBundle(input, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const getFeesFn = deps.getFees || getFees;
  const readBal = deps.readTokenBalance || readTokenBalance;
  const decimalsOf = deps.getDecimals || getDecimals;
  const symbolOf = deps.getSymbol || getSymbol;

  const { token, mode = 'equal', leaveInLauncher = '0', amounts } = input || {};
  if (!token || !isAddress(String(token))) throw new Error('token must be the launched ERC-20 address');
  const tokenAddr = getAddress(token);

  const dev = roles.dev(ks);
  if (!dev) throw new Error('no v5dev launcher wallet — the launcher holds the supply to fan out');
  const wallets = roles.bundle(ks);
  if (!wallets.length) throw new Error('no v5bundle wallets to fan out to — generate some first');

  const [decimals, symbol, balanceWei] = await Promise.all([
    decimalsOf(tokenAddr),
    symbolOf(tokenAddr),
    readBal(tokenAddr, dev.address),
  ]);
  if (balanceWei <= 0n) {
    throw new Error(
      `the launcher holds 0 ${symbol} — launch (with a first buy) before fanning out, or check the token address`
    );
  }

  const { perWallet, totalWei, leaveWei } = planAllocations({
    wallets,
    balanceWei,
    decimals,
    mode,
    leaveInLauncher,
    amounts,
  });

  // THE fund-safety gate: the launcher must actually hold what we are about to
  // move. Signing transfers that over-allocate would broadcast a batch whose tail
  // reverts for insufficient balance — the fan-out must be all-or-nothing on paper
  // before a single tx is signed.
  if (totalWei > balanceWei) {
    throw new Error(
      `the allocations total ${formatUnits(totalWei, decimals)} ${symbol} but the launcher holds only ` +
        `${formatUnits(balanceWei, decimals)} — reduce the amounts`
    );
  }
  const transfersWithValue = perWallet.filter((p) => p.amountWei > 0n);
  if (!transfersWithValue.length) throw new Error('every allocation is zero — nothing to fan out');

  // Gas: one representative transfer, estimated live, with headroom, applied to
  // all. A transfer to a wallet that does not yet hold the token writes a fresh
  // balance slot (the dearer case), so estimating the first — a bundle wallet,
  // typically a fresh holder — sizes the whole batch safely.
  const first = transfersWithValue[0];
  let gasLimit;
  try {
    const est = await prov.estimateGas({
      to: tokenAddr,
      data: erc20Iface.encodeFunctionData('transfer', [first.wallet.address, first.amountWei]),
      from: getAddress(dev.address),
    });
    gasLimit = (est * 15n) / 10n; // +50% — transfers vary by whether the slot is fresh
  } catch (err) {
    throw new Error(`a token transfer would revert, so nothing was signed: ${err.message}`);
  }

  const fees = await getFeesFn(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);
  const gasEach = gasCost(fees, gasLimit);
  const gasTotal = gasEach * BigInt(transfersWithValue.length);
  const ethBalance = await prov.getBalance(dev.address);
  if (ethBalance < gasTotal) {
    throw new Error(
      `the launcher holds ${formatUnits(ethBalance, 18)} ETH but the ${transfersWithValue.length} ` +
        `transfers need ~${formatUnits(gasTotal, 18)} ETH of gas — fund the launcher with ETH first`
    );
  }

  // THE settled-balance gate: the launcher must have NO transaction in flight
  // before we split its balance. If it does (a launch still confirming, or a prior
  // bundle whose transfers have not mined), balanceOf('latest') does NOT reflect
  // those pending sends, so a split sized on it would OVER-COMMIT — and signing at
  // the pending nonce would also collide with the in-flight tx's nonce. Refuse
  // until the wallet is settled. This is the on-chain guard that composes across
  // the launch and bundle paths (both spend this one wallet); the in-memory route
  // locks are only the first line. (pending > latest ⇒ unmined txs exist.)
  const [pendingNonce, latestNonce] = await Promise.all([
    prov.getTransactionCount(dev.address, 'pending'),
    prov.getTransactionCount(dev.address, 'latest'),
  ]);
  if (pendingNonce > latestNonce) {
    throw new Error(
      `the launcher has ${pendingNonce - latestNonce} transaction(s) still in flight (a launch or a prior ` +
        'bundle) — wait for them to confirm before bundling, so the split is sized on a settled balance'
    );
  }

  // Sign each transfer at a sequential nonce from the launcher's (now settled)
  // nonce. Sequential (not all-same) so the node accepts them as an ordered run;
  // a gap would stall every later transfer behind a missing nonce.
  const startNonce = pendingNonce;
  const signer = ks.signer(dev.id, prov);

  const transfers = [];
  for (let i = 0; i < transfersWithValue.length; i++) {
    const { wallet, amountWei } = transfersWithValue[i];
    const nonce = startNonce + i;
    const data = erc20Iface.encodeFunctionData('transfer', [getAddress(wallet.address), amountWei]);
    const raw = await signer.signTransaction(toSignable({ to: tokenAddr, data }, { nonce, gasLimit, fees, chainId }));
    transfers.push({
      walletId: wallet.id,
      to: getAddress(wallet.address),
      amount: formatUnits(amountWei, decimals),
      amountWei: amountWei.toString(),
      nonce,
      raw, // SIGNED — the route strips this before the plan leaves the server
    });
  }

  return {
    protocol: 'v5',
    kind: 'bundle',
    mode,
    token: tokenAddr,
    symbol,
    decimals,
    from: { walletId: dev.id, address: dev.address },
    launcherBalance: formatUnits(balanceWei, decimals),
    leaveInLauncher: formatUnits(leaveWei, decimals),
    totalOut: formatUnits(totalWei, decimals),
    count: transfers.length,
    gas: gasLimit.toString(),
    fees: stringifyFees(fees),
    chainId: chainId.toString(),
    transfers,
    note:
      'letscash tax is charged by the hook on SWAPS only; these are plain wallet→wallet ERC-20 ' +
      'transfers, which never touch the pool or the hook, so the fan-out is untaxed.',
  };
}

/**
 * Broadcast the pre-signed fan-out transfers and read each receipt back.
 *
 * The transfers are independent (each moves its own slice), so a single reverted
 * transfer strands only its own slice — the others still land. They ARE ordered by
 * nonce, so they are broadcast in order and a stuck early nonce would hold up the
 * rest; on this chain (sub-second blocks) that clears quickly.
 *
 * @param {object} plan   from prepareBundle (its transfers[].raw are signed).
 * @param {object} [deps] injected for tests: { provider, waitForReceipt, warmPool, dryRun }.
 * @returns {Promise<object>} { token, symbol, sent, failed, transfers:[{to,amount,hash,status}] }
 */
async function fireBundle(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const warm = deps.warmPool || warmPool;

  if (!plan || plan.kind !== 'bundle' || !Array.isArray(plan.transfers)) {
    throw new Error('not a v5 bundle plan — re-run preflight');
  }

  if (dryRun) {
    return {
      simulated: true,
      protocol: 'v5',
      kind: 'bundle',
      token: plan.token,
      symbol: plan.symbol,
      sent: 0,
      failed: 0,
      transfers: plan.transfers.map((t) => ({ to: t.to, amount: t.amount, hash: null, status: 'simulated' })),
    };
  }

  if (plan.transfers.some((t) => !t.raw)) throw new Error('plan has unsigned transfers — re-run preflight');

  // Warm a socket before the burst so a cold TLS handshake is not in the critical
  // path of the first broadcast.
  await warm(Math.min(plan.transfers.length, 4), rpc);

  // Broadcast IN NONCE ORDER, and STOP at the first send failure. The transfers
  // are signed at consecutive nonces, so a send that throws leaves that nonce
  // UNUSED — and broadcasting the higher-nonce transfers anyway would queue them
  // behind that hole where they can NEVER mine until it is filled (a stranded,
  // stuck-pending fan-out). Stopping instead leaves a clean prefix: nonces up to
  // the failure are used, everything after is simply un-sent, so the pending nonce
  // sits exactly at the gap and a later re-run (once the sent ones settle) fills
  // from there with no collision. The remainder is reported 'not-sent' so the
  // operator knows to re-run for them.
  const results = [];
  let stopped = false;
  for (const t of plan.transfers) {
    if (stopped) {
      results.push({ walletId: t.walletId, to: t.to, amount: t.amount, hash: null, status: 'not-sent' });
      continue;
    }
    try {
      const resp = await rpc.broadcastTransaction(t.raw);
      results.push({ walletId: t.walletId, to: t.to, amount: t.amount, hash: resp.hash, status: 'broadcast' });
    } catch (err) {
      results.push({ walletId: t.walletId, to: t.to, amount: t.amount, hash: null, status: 'send-failed', error: err.message });
      // Do not lay later transfers on top of the now-unused nonce.
      stopped = true;
    }
  }

  // Await receipts for everything that broadcast. A receipt read that throws (a
  // provider/wiring fault) must NOT fail the whole handler AFTER the transfers are
  // already on chain — that would read as a total failure and tempt a re-run. Treat
  // an un-read receipt as 'pending', the same as a timeout.
  await Promise.all(
    results.map(async (r) => {
      if (!r.hash) return;
      let receipt = null;
      try {
        receipt = await awaitReceipt(rpc, r.hash);
      } catch (_err) {
        receipt = null;
      }
      r.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
      r.blockNumber = receipt?.blockNumber ?? null;
    })
  );

  const sent = results.filter((r) => r.status === 'confirmed').length;
  const failed = results.filter((r) => r.status === 'reverted' || r.status === 'send-failed').length;
  const notSent = results.filter((r) => r.status === 'not-sent').length;
  const out = {
    protocol: 'v5',
    kind: 'bundle',
    token: plan.token,
    symbol: plan.symbol,
    sent,
    failed,
    pending: results.filter((r) => r.status === 'pending').length,
    notSent,
    transfers: results,
  };
  if (notSent) {
    // A send failure stopped the run partway. Tell the operator the safe recovery:
    // the fan-out did NOT strand anything (no nonce gap was created), but the
    // remaining wallets were not funded — re-run once the sent transfers confirm.
    out.incomplete =
      `${notSent} transfer(s) were not sent after a broadcast failure. Nothing is stranded — the ` +
      'unfunded wallets simply were not sent to. Wait for the sent transfers to confirm, then re-run ' +
      'the bundle to fan out to the rest.';
  }
  return out;
}

module.exports = {
  prepareBundle,
  fireBundle,
  // exported for tests
  planAllocations,
  toSignable,
};
