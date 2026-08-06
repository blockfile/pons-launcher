'use strict';

// Selling 100% of a launched token out of every bundle wallet that holds it.
//
// Same shape as the launch bundle: preflight builds and SIGNS everything, fire
// only broadcasts. Nothing is signed at fire time, so key derivation is never
// in the critical path and a plan can be inspected before a single wallet moves.
//
// Three decisions here were made deliberately by the operator, with the risk
// stated. They are load-bearing, and each is asserted in prepareSell.test.js so
// that undoing one breaks a test rather than quietly changing behaviour:
//
//   1. THERE IS NO SLIPPAGE FLOOR. minQuoteOut is 0 for every wallet. The point
//      of this button is that nothing is left holding tokens — every wallet
//      exits at whatever price the curve gives it. The accepted risk is that a
//      sell into a drained curve, or one landing behind a front-runner, can
//      return near zero and still succeed. DO NOT ADD A FLOOR. A floor turns a
//      guaranteed exit into a maybe-exit, which is the opposite of the feature.
//
//   2. THE TOKEN MUST BE ONE THIS DEV WALLET LAUNCHED. Checked here again
//      against the factory's own record, not just at the picker. Preparing a
//      sell means signing an approval, and an approval to a hostile ERC-20 is
//      the whole dusting attack — see the header of evm/v2/holdings.js.
//
//   3. THE APPROVAL IS FOR EXACTLY THE BALANCE. No infinite allowance, so a
//      wallet reused for a later launch carries no lingering permission to a
//      contract it no longer trades with.
//
// The approval and the sell are signed at consecutive nonces (n, n+1) from the
// same wallet. The sequencer executes a wallet's transactions in nonce order,
// so the approval does not need to confirm before the sell is sent — the same
// trick the buy bundle uses to avoid a round trip.

const { Contract, formatEther, formatUnits, getAddress, ZeroAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const holdings = require('../evm/v2/holdings');
const { curve } = require('../evm/v2/curve');
const keystore = require('../wallets/keystore');
const { toSignable } = require('./prepareV2');

// Approve is a single SSTORE plus whatever the token does around it; 100k is
// generous for a well-behaved ERC-20 and cheap to over-reserve, since unused
// gas is refunded.
const APPROVE_GAS = 100_000n;
// The sell CANNOT be estimated: the approval it depends on has not been mined
// yet, so estimateGas would revert on the allowance check every time. A fixed
// limit is the only option, and it is sized for a curve sell plus a creator-fee
// transfer plus a native send to the recipient.
const SELL_GAS = 600_000n;

// Same headroom the funding path uses. Quoting the base fee exactly gets a
// transaction rejected the moment it ticks up between the quote and the
// broadcast, and here that would strand an approval with a sell queued behind
// it.
const FEE_BUMP_PCT = 25;

// approve/allowance are not in evm/erc20.js — that module deliberately exposes
// only the read and transfer surface the funding path needs. Approving is a
// sell-path concern, so the fragment lives with the sell.
const APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];

/**
 * Build a signed sell for every bundle wallet holding `token`.
 *
 * @param {object} input
 * @param {string} input.token the token to exit, entirely
 * @param {object} [deps] injectable for tests; nothing here touches the network
 *   when they are supplied
 * @returns {Promise<object>} a plan in which every approval and every sell is
 *   already signed
 */
async function prepareSell({ token }, deps = {}) {
  const ks = deps.keystore || keystore;
  const rpc = deps.provider || provider;
  const describe = deps.describeToken || ((t) => holdings.describeToken(t));
  const readCurve = deps.curveState || ((c) => holdings.curveState(c));
  const readPricing = deps.curvePricing || ((c) => holdings.curvePricing(c));
  const meta = deps.tokenMeta || ((t) => holdings.tokenMeta(t));
  const balanceOf = deps.balanceOf || null;
  const dryRun = deps.dryRun ?? config.dryRun;

  if (!token) throw new Error('token is required');
  const address = getAddress(token);
  const dev = ks.devWallet();
  const warnings = [];

  // ── may we sell this at all ───────────────────────────────────────────────
  // The factory's own record, not the picker's word for it. Everything after
  // this point signs an approval, so this is the gate that stops a dusted
  // contract from being approved by every funded wallet at once.
  const record = await describe(address);
  if (!record.exists) {
    throw new Error(`${address} is not a pons v2 launch — the factory has no record of it`);
  }
  if (getAddress(record.deployer) !== getAddress(dev.address)) {
    throw new Error(
      `${address} was not launched by this dev wallet — the factory says ${record.deployer} ` +
        'launched it. Refusing to approve a contract we did not create.'
    );
  }

  // ── which route ───────────────────────────────────────────────────────────
  // The curve's own state decides; the operator never picks.
  const state = await readCurve(record.curve);
  if (state.graduated) {
    // Deliberate refusal, not an oversight. A graduated token trades in a
    // Uniswap v4 pool, and a v4 swap is encoded through the UniversalRouter's
    // command/input scheme with a PoolKey that has to match the one the meme
    // hook created at graduation. Getting that encoding wrong does not revert
    // cleanly — it can route the sell into the wrong pool or leave tokens with
    // the router. That loses real money. An honest refusal does not.
    throw new Error(
      `${address} has graduated to a Uniswap v4 pool — selling a graduated token is not yet ` +
        'supported. Sell it manually, or on ponsfamily.com.'
    );
  }

  const { symbol, decimals } = await meta(address).catch(() => ({ symbol: '???', decimals: 18 }));
  const wallets = ks.bundleWallets();

  // ── who holds any ─────────────────────────────────────────────────────────
  const held = await holdings.tokenHoldings(
    address,
    wallets,
    balanceOf ? { balanceOf } : { provider: rpc }
  );
  const holders = held.filter((h) => h.balance > 0n);
  const skipped = held
    .filter((h) => h.balance === 0n)
    .map((h) => ({
      walletId: h.walletId,
      address: h.address,
      reason: `holds none of ${symbol}`,
    }));
  for (const s of skipped) warnings.push(`${s.address}: ${s.reason} — skipped`);

  if (!holders.length) {
    throw new Error(`no bundle wallet holds any ${symbol} (${address}) — nothing to sell`);
  }

  const fees = deps.fees || (await getFees(FEE_BUMP_PCT));
  const chainId = BigInt(deps.chainId ?? config.chainId);
  const reserve = gasCost(fees, APPROVE_GAS + SELL_GAS);

  // ── what the operator is about to accept ──────────────────────────────────
  // A floor-less, irreversible sell armed with nothing but a token count is not
  // something anyone can consent to. So the curve is quoted here. Best effort:
  // a curve that will not answer produces nulls and a warning, never a failure,
  // because the estimate is information — it gates nothing.
  let pricing = null;
  try {
    pricing = await readPricing(record.curve);
  } catch (err) {
    warnings.push(
      `could not quote the curve at ${record.curve} (${err.message}) — proceeds are unknown ` +
        'until the sells land'
    );
  }
  if (pricing && !pricing.isNativeQuote) {
    warnings.push(
      `this launch is priced in ${record.pairToken}, not native ETH — proceeds arrive as that ` +
        'token, and the estimates below are denominated in it'
    );
  }

  // Reserves are walked forward wallet by wallet, because that is what actually
  // happens: each sell moves the price for the next one. The TOTAL is what the
  // bundle gets out and is barely order-dependent; the PER-WALLET split is
  // entirely order-dependent, and the sequencer picks the order — hence the
  // warning rather than a promise.
  let quoteReserve = pricing ? BigInt(pricing.quoteReserve) : 0n;
  let tokenReserve = pricing ? BigInt(pricing.tokenReserve) : 0n;
  let estTotal = 0n;

  const out = [];
  for (const h of holders) {
    const native = await rpc.getBalance(h.address);
    if (native < reserve) {
      // Signing an approval a wallet cannot pay for is worse than skipping it:
      // if the approval is broadcast and cannot be mined, the sell at n+1 is
      // stuck behind it for good.
      const why =
        `native balance ${formatEther(native)} ETH does not cover the approval and the sell ` +
        `(${formatEther(reserve)} ETH of gas)`;
      skipped.push({ walletId: h.walletId, address: h.address, reason: why });
      warnings.push(`${h.address}: ${why} — skipped`);
      continue;
    }

    let estOut = null;
    if (pricing) {
      const q = holdings.quoteSellOut({
        tokensIn: h.balance,
        quoteReserve,
        tokenReserve,
        feeBps: pricing.feeBps,
        creatorTaxBps: pricing.creatorTaxBps,
      });
      estOut = q;
      estTotal += q;
      // The curve keeps the tokens and gives up the quote, fees included.
      quoteReserve -= q;
      tokenReserve += h.balance;
    }

    const nonce = await rpc.getTransactionCount(h.address, 'pending');
    const signer = ks.signer(h.walletId, rpc);

    const approveTx = await new Contract(address, APPROVE_ABI, rpc).approve.populateTransaction(
      record.curve,
      h.balance
    );
    // minQuoteOut 0. See decision 1 in the header. Do not change this.
    const sellTx = await curve(record.curve, rpc).sell.populateTransaction(
      h.balance,
      0n,
      h.address
    );

    out.push({
      walletId: h.walletId,
      address: h.address,
      tokens: formatUnits(h.balance, decimals),
      tokensRaw: h.balance.toString(),
      estEthOut: estOut === null ? null : formatEther(estOut),
      estEthOutRaw: estOut === null ? null : estOut.toString(),
      approve: {
        nonce,
        spender: record.curve,
        raw: await signer.signTransaction(
          toSignable(approveTx, { nonce, gasLimit: APPROVE_GAS, fees, chainId })
        ),
      },
      sell: {
        nonce: nonce + 1,
        minQuoteOut: '0',
        raw: await signer.signTransaction(
          toSignable(sellTx, { nonce: nonce + 1, gasLimit: SELL_GAS, fees, chainId })
        ),
      },
    });
  }

  if (!out.length) {
    throw new Error(
      `every wallet holding ${symbol} is too short of native ETH to pay for the sell — ` +
        'fund them first'
    );
  }

  if (pricing) {
    warnings.push(
      'estEthOut is an estimate against the curve as it is right now, assuming the wallets land ' +
        'in the order listed. The sequencer decides the real order, so the per-wallet split will ' +
        'differ; the total is the reliable figure. There is no slippage floor — every wallet ' +
        'sells at whatever price it gets.'
    );
  }

  const totalTokens = out.reduce((s, w) => s + BigInt(w.tokensRaw), 0n);

  return {
    action: 'sell',
    protocol: 'v2',
    route: 'curve',
    token: address,
    symbol,
    decimals,
    curve: record.curve,
    pairToken: record.pairToken,
    isNativeQuote: pricing ? pricing.isNativeQuote : record.pairToken === ZeroAddress,
    graduated: false,
    readyToGraduate: state.readyToGraduate,
    // Stated on the plan itself so the console can show it and nobody has to
    // read this file to find out there is no protection.
    minQuoteOut: '0',
    dryRun,
    wallets: out,
    skipped,
    walletCount: out.length,
    totalTokens: formatUnits(totalTokens, decimals),
    totalTokensRaw: totalTokens.toString(),
    estEthOutTotal: pricing ? formatEther(estTotal) : null,
    estEthOutTotalRaw: pricing ? estTotal.toString() : null,
    // Strings, not the BigInts getFees returns — this object is JSON-encoded on
    // the way out and JSON.stringify throws on a BigInt rather than skipping it.
    fees: Object.fromEntries(
      Object.entries(fees).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
    ),
    approveGas: APPROVE_GAS.toString(),
    sellGas: SELL_GAS.toString(),
    chainId: chainId.toString(),
    warnings,
  };
}

module.exports = { prepareSell, APPROVE_GAS, SELL_GAS, FEE_BUMP_PCT };
