'use strict';

/**
 * Two ways to pull a V3 position back to one place after a run, sitting beside
 * the exit and the sweep as end-of-run utilities. Neither is part of the engine,
 * the run, or any existing flow — they are only ever reached by their own two
 * routes, and they read the chain and move the exact balance they find, the same
 * discipline exit.js and sweep.js hold to.
 *
 * ── returnToMain — move ONE token from every bundle wallet to v3main ──────────
 *
 * A DIRECT ERC-20 transfer, and the on-chain linkage that creates is ACCEPTED BY
 * DESIGN. Every bundle wallet sending the same token to one address draws exactly
 * the buyer→collector link the Relay hop is used to avoid on the ETH sweep. This
 * function is the deliberate exception: sometimes the operator wants the whole
 * position consolidated in the main wallet — to sell it there in one go, or to
 * move it onward — and is willing to pay that linkage for it. The UI warns about
 * it in as many words; the backend does not second-guess a confirmed request.
 *
 * A PLAIN transfer, NOT an approve, so it is safe against an arbitrary token: no
 * allowance is granted to anything, so the dusting attack the ownership gate
 * exists to stop (an approval to a hostile ERC-20) is simply not reachable here.
 * That is why returnToMain does NO factory/ownership check — there is nothing for
 * one to protect against.
 *
 * ── sellMain — sell v3main's own balance of a token, back to ETH ──────────────
 *
 * The mirror of the exit for a single wallet. It KEEPS the exit's two locks,
 * because it takes the exit's two risks:
 *
 *   · confirm===true — it is irreversible and has no slippage floor (liquidate).
 *   · THE OWNERSHIP GATE — selling approves the curve, and an approval to a
 *     hostile ERC-20 is the whole dusting attack. So the token must have been
 *     launched by a wallet this account holds or has held, the same gate
 *     resolveRun and the /v3/exit handler enforce.
 *
 * Both share the exit's per-wallet properties where they apply: read the actual
 * balance first, move/sell the EXACT balance, reserve gas and skip cleanly when
 * short, and report every wallet — never a half-done state left unsaid.
 */

const { formatEther, formatUnits, getAddress } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { erc20: defaultErc20 } = require('../evm/erc20');
const { waitForReceipt } = require('../evm/receipt');
const holdings = require('../evm/v2/holdings');
const v3roles = require('./roles');
const defaultTrade = require('./trade');

// A plain ERC-20 transfer is one SSTORE plus whatever the token does around it —
// but a launchpad token can carry a transfer hook or a fee-on-transfer, which a
// 65k bare-transfer limit runs out of gas on (a revert that moves nothing). This
// margin covers a hooked/taxed transfer; unused gas is refunded, so over-reserving
// costs nothing. It is BOTH the gas-reserve skip threshold AND the limit the
// transfer is sent with, so a wallet that passed the skip check can always pay.
const TRANSFER_GAS = 120_000n;

// Same headroom the rest of V3 puts on a fee ceiling — see trade.js. A base fee
// that ticks up between the read and the broadcast must not strand the transfer.
const FEE_BUMP_PCT = defaultTrade.FEE_BUMP_PCT;

function wire(deps = {}) {
  return {
    ks: (deps.keystoreForFn || keystoreFor),
    activity: (deps.activityForFn || activityFor),
    rpc: deps.rpc || provider,
    trade: deps.trade || defaultTrade,
    getFeesFn: deps.getFeesFn || getFees,
    erc20: deps.erc20 || defaultErc20,
    await: deps.waitForReceiptFn || waitForReceipt,
    describeToken: deps.describeToken || ((t) => holdings.describeToken(t)),
    ownerSet: deps.ownerSet || holdings.ownerSet,
    decimals: deps.decimals ?? 18,
  };
}

function statusOf(receipt) {
  if (!receipt) return 'pending';
  return Number(receipt.status) === 1 ? 'confirmed' : 'reverted';
}

/**
 * Move a SPECIFIC token from every V3 bundle wallet into the V3 main wallet, one
 * direct ERC-20 transfer each. Never from main — main is the destination.
 *
 * @param {string} input.token the token to consolidate.
 * @returns {Promise<{action, token, main, moved, results, skipped, totals}>}
 *   `results` is one row per attempted wallet {walletId, address, role, status,
 *   hash, amount, amountRaw}; `skipped` names the wallets that held none or could
 *   not cover a transfer's gas; `moved` is the total tokens actually moved.
 */
async function returnToMain(userId, { token }, deps = {}) {
  const w = wire(deps);
  const tokenAddr = getAddress(token);
  const ks = w.ks(userId);
  const main = v3roles.main(ks); // throws naming v3main if it does not exist
  const mainAddr = getAddress(main.address);
  const bundle = v3roles.bundle(ks);

  // One fee read for the whole run, so every wallet is measured against the same
  // reserve — exactly what the exit does.
  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const reserve = gasCost(fees, TRANSFER_GAS);

  const results = [];
  const skipped = [];

  for (const wallet of bundle) {
    // Never move FROM main: it is the destination, and a wallet sending to itself
    // is a fee for nothing. bundle() cannot contain main (a different role), but
    // assert the property rather than trust it.
    if (getAddress(wallet.address) === mainAddr) continue;

    const balance = BigInt(await w.trade.tokenBalance(tokenAddr, wallet.address, deps));
    if (balance <= 0n) {
      skipped.push({
        walletId: wallet.id,
        address: wallet.address,
        role: wallet.role,
        reason: 'holds none of this token',
      });
      continue;
    }

    const native = BigInt(await w.rpc.getBalance(wallet.address));
    if (native < reserve) {
      skipped.push({
        walletId: wallet.id,
        address: wallet.address,
        role: wallet.role,
        reason:
          `native balance ${formatEther(native)} ETH does not cover one ERC-20 transfer's gas ` +
          `(${formatEther(reserve)} ETH)`,
      });
      continue;
    }

    const entry = {
      walletId: wallet.id,
      address: wallet.address,
      role: wallet.role,
      amount: formatUnits(balance, w.decimals),
      amountRaw: balance.toString(),
    };
    try {
      const signer = ks.signer(wallet.id, w.rpc);
      // A plain transfer of exactly the balance. gasLimit fixed so ethers never
      // estimates (which would fail on a token that reverts on a zero read), and
      // so the send matches the reserve the skip check used.
      const sent = await w
        .erc20(tokenAddr, signer)
        .transfer(mainAddr, balance, { gasLimit: TRANSFER_GAS, ...fees });
      const receipt = await w.await(w.rpc, sent.hash);
      results.push({ ...entry, status: statusOf(receipt), hash: sent.hash });
    } catch (err) {
      // One wallet's failure is not the run's — the same rule the exit and the
      // sweep follow: these wallets are independent, nothing downstream depends
      // on this one, so stopping would strand the rest for no gain.
      results.push({
        ...entry,
        status: 'failed',
        hash: null,
        error: err?.shortMessage || err?.message || String(err),
      });
    }
  }

  const confirmed = results.filter((r) => r.status === 'confirmed');
  const movedRaw = confirmed.reduce((sum, r) => sum + BigInt(r.amountRaw), 0n);
  const totals = {
    wallets: results.length,
    transferred: confirmed.length,
    failed: results.length - confirmed.length,
    tokens: formatUnits(movedRaw, w.decimals),
    tokensRaw: movedRaw.toString(),
  };

  w.activity(userId).record(
    'v3',
    `[v3] returned ${tokenAddr} to main from ${confirmed.length}/${results.length} bundle wallet(s)` +
      (totals.failed ? `, ${totals.failed} failed` : '') +
      ' — direct transfer, links these wallets to main on-chain',
    { token: tokenAddr, main: mainAddr, totals, wallets: results, skipped }
  );

  return {
    action: 'v3-return-to-main',
    token: tokenAddr,
    main: mainAddr,
    moved: formatUnits(movedRaw, w.decimals),
    results,
    skipped,
    totals,
  };
}

/**
 * Sell the V3 MAIN wallet's whole balance of a token back into its curve.
 *
 * @param {string} input.token the token to sell.
 * @param {string} [input.curve] optional explicit curve; otherwise resolved from
 *   the factory record.
 * @param {boolean} input.confirm required — irreversible, no slippage floor.
 * @returns {Promise<{action, token, curve, tokensIn, tokensInRaw, status,
 *   ethReceived, ethReceivedRaw, approveHash, sellHash}>}
 */
async function sellMain(userId, { token, curve, confirm }, deps = {}) {
  const w = wire(deps);

  if (confirm !== true) {
    throw new Error(
      "selling the main wallet's whole position is irreversible and has no slippage floor — " +
        'requires { confirm: true }'
    );
  }

  const tokenAddr = getAddress(token);
  const ks = w.ks(userId);
  const main = v3roles.main(ks); // throws naming v3main if it does not exist

  // ── is this a token we may touch ────────────────────────────────────────────
  // describeToken gives both the curve to sell into AND the deployer the
  // ownership gate checks. Refuse a token the factory has never heard of.
  const record = await w.describeToken(tokenAddr);
  if (!record || !record.exists) {
    throw new Error(`${tokenAddr} is not a pons v2 launch — the factory has no record of it`);
  }
  // The same ownership gate resolveRun and the /v3/exit handler take. Selling
  // approves the curve, and an approval to a hostile ERC-20 is the whole dusting
  // attack — so the token must have been launched by a wallet this account holds
  // or has held.
  const ours = w.ownerSet(ks.ownedAddresses());
  if (!ours.has(getAddress(record.deployer).toLowerCase())) {
    throw new Error(
      `${tokenAddr} was not launched by a wallet this account holds or has held — the factory says ` +
        `${record.deployer} launched it. Refusing to approve a contract we did not create.`
    );
  }

  // ── is the curve still a curve ──────────────────────────────────────────────
  const curveAddr = curve ? getAddress(curve) : getAddress(record.curve);
  const state = await w.trade.readCurve(curveAddr, deps);
  if (state.graduated) {
    throw new Error(
      `the curve at ${curveAddr} has graduated — a graduated token trades in a Uniswap v4 pool and ` +
        'cannot be sold here. Sell it manually, or on ponsfamily.com.'
    );
  }

  // ── what main holds, sold in full ───────────────────────────────────────────
  const balance = BigInt(await w.trade.tokenBalance(state.token, main.address, deps));
  if (balance <= 0n) {
    throw new Error('the main wallet holds none of this token');
  }

  // Passing `curve` makes trade.sell take the native OR the ETH<->pairToken route
  // path automatically; liquidate:true is the floor-free "get out" mode the exit
  // uses — it must always liquidate.
  const out = await w.trade.sell(
    {
      wallet: main,
      curveAddress: state.address,
      token: state.token,
      tokensIn: balance,
      curve: state,
      liquidate: true,
    },
    { ...deps, keystore: ks, rpc: w.rpc }
  );

  const ethReceived = BigInt(out.ethReceived ?? 0n);
  const summary = {
    action: 'v3-sell-main',
    token: tokenAddr,
    curve: getAddress(state.address),
    tokensIn: formatUnits(balance, w.decimals),
    tokensInRaw: balance.toString(),
    status: out.status,
    ethReceived: formatEther(ethReceived),
    ethReceivedRaw: ethReceived.toString(),
    approveHash: out.approveHash ?? null,
    sellHash: out.sellHash ?? null,
  };

  w.activity(userId).record(
    'v3',
    `[v3] sold main's position in ${tokenAddr} — ${summary.status}` +
      (ethReceived > 0n ? ` — ${formatEther(ethReceived)} ETH` : ''),
    { token: tokenAddr, curve: summary.curve, tokensIn: summary.tokensIn, ...summary }
  );

  return summary;
}

module.exports = { returnToMain, sellMain, TRANSFER_GAS, _private: { statusOf, wire } };
