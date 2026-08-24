'use strict';

// Each bundle wallet swaps its OWN ETH → SPCX, through the deployed EthToSpcxSwap
// router, so it holds SPCX for a pre-signed pair buy at launch — WITHOUT the dev
// wallet ever transferring SPCX to it.
//
// Why per-wallet rather than distribute-from-dev. Distributing SPCX out of the
// dev wallet writes an on-chain link from the creator to every bundle buyer —
// dev → 20 wallets → they all buy the launch — which is exactly the coordination
// a bundle is trying not to advertise. Here each wallet acquires its SPCX
// independently; the dev wallet stays clean.
//
// The catch, and the safety gate. The SPCX pool's liquidity is intermittent
// (pons-managed; often zero). So EACH wallet's swap is SIMULATED first (eth_call
// with a zero floor). A simulation that reverts or returns dust means the pool is
// empty or the route is broken (e.g. the pool migrated) — that wallet is SKIPPED,
// never sent, so no ETH is dumped into a dead pool. Only when the simulation
// returns a real amount is the swap signed, with minOut = expected − slippage, so
// a price that moved between simulate and mine reverts (ETH kept) instead of
// filling badly.
//
// Preflight, not time-critical: wallets are swapped one at a time, each awaited to
// its receipt, so they don't compete on the thin pool or burst the RPC.

const { getAddress, parseUnits, formatUnits, formatEther, Interface } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { rpcMessage } = require('../evm/errors');
const { getSymbol, readTokenBalance } = require('../evm/erc20');
const { waitForReceipt } = require('../evm/receipt');
const v2mod = require('../evm/v2/factory');
const keystore = require('../wallets/keystore');
const { DEFAULT_VARIANT, bundleWalletsFor } = require('../wallets/variants');

const APPROVE_GAS = 100_000n; // same figure the pair buy reserves for its approve
const BPS = 10_000n;
// The bump prepareV2 applies to launch fees (its FEE_BUMP_PCT). The reserve kept
// back here must be sized at the SAME basis, or a wallet swaps to SPCX and then
// fails the launch's under-funded check at the higher fees, stranding the SPCX.
const FEE_BUMP_PCT = 25;

const SWAP_IFACE = new Interface([
  'function swapExactEthForSpcx(uint256 minSpcxOut, address recipient) payable returns (uint256)',
]);

function toSignable(tx, { nonce, gasLimit, fees, chainId }) {
  const { from, ...rest } = tx;
  return { ...rest, nonce, gasLimit, chainId, ...fees };
}

/**
 * @param {object} input
 * @param {string} [input.variant]     wallet variant (default v1)
 * @param {string[]} [input.walletIds] which bundle wallets to swap; default all
 * @param {string} input.pairToken     the launch's pair token — must be SPCX (the
 *   only token the router outputs); rejected otherwise
 * @param {number} [input.slippageBps] override the swap slippage floor
 * @param {boolean} [input.dryRun]     simulate every wallet, sign/send nothing
 * @param {object} [deps] injectable for tests
 */
async function swapBundleToPair(input, deps = {}) {
  const rpc = deps.provider || provider;
  const ks = deps.keystore || keystore;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const feesFn = deps.getFees || getFees;
  const pairEconomicsFn = deps.pairEconomics || v2mod.pairEconomics;
  const symbolFn = deps.getSymbol || getSymbol;
  const balanceFn = deps.readTokenBalance || readTokenBalance;

  const variant = input.variant || DEFAULT_VARIANT;
  const dryRun = Boolean(input.dryRun);
  const router = deps.router || config.ethToSpcxSwap;
  if (!router) {
    throw new Error(
      'ETH→SPCX router is not deployed — run `node scripts/deploy-contract.js EthToSpcxSwap --broadcast` ' +
        'and set ETH_TO_SPCX_SWAP_ADDRESS'
    );
  }
  const routerAddr = getAddress(router);

  if (!input.pairToken) throw new Error('swapBundleToPair: pairToken is required');
  const pair = getAddress(input.pairToken);
  if (pair.toLowerCase() !== config.spcxToken) {
    throw new Error(
      `this router only swaps to SPCX (${config.spcxToken}); the launch is paired against ${pair} — use ` +
        'the Distribute step for a non-SPCX pair'
    );
  }

  const { decimals } = await pairEconomicsFn(pair);
  const symbol = await symbolFn(pair);

  // Which wallets. Default every bundle wallet of the variant; an explicit list is
  // filtered to bundle wallets (never any other keystore wallet).
  const bundle = bundleWalletsFor(ks, variant);
  const byId = new Map(bundle.map((w) => [w.id, w]));
  let wallets;
  if (Array.isArray(input.walletIds) && input.walletIds.length) {
    wallets = input.walletIds.map((id) => {
      const w = byId.get(id);
      if (!w) throw new Error(`swapBundleToPair: ${id} is not a ${variant} bundle wallet`);
      return w;
    });
  } else {
    wallets = bundle;
  }
  if (wallets.length === 0) throw new Error('swapBundleToPair: no bundle wallets to swap');

  // Validate slippage up front: 10000 would zero the on-chain floor; >10000 or a
  // non-integer would make minOut negative/garbage.
  const bpsNum = Number(input.slippageBps ?? config.pairSwapSlippageBps);
  if (!Number.isInteger(bpsNum) || bpsNum < 0 || bpsNum >= 10_000) {
    throw new Error(`swapBundleToPair: slippageBps must be an integer in [0, 10000), got ${bpsNum}`);
  }
  const slippageBps = BigInt(bpsNum);

  // Fail fast on a router address with no code — a misconfigured
  // ETH_TO_SPCX_SWAP_ADDRESS would otherwise be handed value per wallet (the
  // simulate gate catches most, but this is clearer and cheaper).
  const routerCode = await rpc.getCode(routerAddr);
  if (!routerCode || routerCode === '0x') {
    throw new Error(`ETH→SPCX router ${routerAddr} has no contract code — check ETH_TO_SPCX_SWAP_ADDRESS`);
  }

  const chainId = BigInt(config.chainId);
  // Fees at the SAME bump the launch uses, so the ETH left behind is sized
  // against what the launch's approve+buy will actually cost.
  const fees = await feesFn(FEE_BUMP_PCT);
  const swapGas = BigInt(config.pairSwapGasLimit);
  const buyGas = BigInt(config.buyGasLimit);
  // ETH each wallet must keep back: the swap's own gas, then the launch's
  // approve + buy gas, plus a buffer. Everything above this is swapped to SPCX.
  const reserve = gasCost(fees, swapGas + APPROVE_GAS + buyGas) + parseBuffer();

  // Optional hard floor on the standing rate (0 = disabled); the relative
  // slippage floor above only guards price movement, not a bad standing price.
  const minSpcxPerEth = deps.minSpcxPerEth ?? config.pairSwapMinSpcxPerEth;
  const minRatePerEth = Number(minSpcxPerEth) > 0 ? parseUnits(String(minSpcxPerEth), decimals) : 0n;

  const results = [];
  for (const w of wallets) {
    const address = getAddress(w.address);
    const entry = { walletId: w.id, address };
    try {
      const balance = BigInt(await rpc.getBalance(address));
      const swapAmount = balance - reserve;
      if (swapAmount <= 0n) {
        entry.status = 'skipped';
        entry.reason = `balance ${formatEther(balance)} ETH does not cover the swap + approve + buy gas — fund it more`;
        results.push(entry);
        continue;
      }
      entry.swapEth = formatEther(swapAmount);

      // Simulate the swap with a zero floor: this proves the pool has liquidity
      // AND tells us the rate. A revert or dust means empty/broken — skip, spend
      // nothing.
      let expected;
      try {
        const data = SWAP_IFACE.encodeFunctionData('swapExactEthForSpcx', [0n, address]);
        const raw = await rpc.call({ from: address, to: routerAddr, value: swapAmount, data });
        [expected] = SWAP_IFACE.decodeFunctionResult('swapExactEthForSpcx', raw);
        expected = BigInt(expected);
      } catch (err) {
        entry.status = 'skipped';
        entry.reason = `pool has no route/liquidity right now (simulation failed: ${rpcMessage(err)}) — wait for a window`;
        results.push(entry);
        continue;
      }
      if (expected <= 0n) {
        entry.status = 'skipped';
        entry.reason = 'pool returned no SPCX (no liquidity right now) — wait for a window';
        results.push(entry);
        continue;
      }
      // Standing-rate floor (opt-in): refuse a thin/mispriced pool that would fill
      // this whole swap below the configured SPCX-per-ETH, rather than dump ETH.
      if (minRatePerEth > 0n) {
        const ratePerEth = (expected * 10n ** 18n) / swapAmount; // SPCX per 1 ETH, 18-dec
        if (ratePerEth < minRatePerEth) {
          entry.status = 'skipped';
          entry.reason = `rate ${formatUnits(ratePerEth, decimals)} ${symbol}/ETH is below the floor — thin/mispriced pool`;
          results.push(entry);
          continue;
        }
      }
      const minOut = (expected * (BPS - slippageBps)) / BPS;
      entry.expected = formatUnits(expected, decimals);
      entry.minOut = formatUnits(minOut, decimals);

      if (dryRun) {
        entry.status = 'planned';
        results.push(entry);
        continue;
      }

      const before = BigInt(await balanceFn(pair, address));
      const signer = ks.signer(w.id, rpc);
      const nonce = await rpc.getTransactionCount(address, 'pending');
      const data = SWAP_IFACE.encodeFunctionData('swapExactEthForSpcx', [minOut, address]);
      const signable = toSignable(
        { to: routerAddr, data, value: swapAmount },
        { nonce, gasLimit: swapGas, fees, chainId }
      );
      const rawTx = await signer.signTransaction(signable);
      const resp = await rpc.broadcastTransaction(rawTx);
      entry.hash = resp.hash;
      entry.nonce = nonce;
      const receipt = await awaitReceipt(rpc, resp.hash);
      entry.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
      entry.blockNumber = receipt?.blockNumber ?? null;
      if (entry.status === 'confirmed') {
        const after = BigInt(await balanceFn(pair, address));
        entry.received = formatUnits(after - before, decimals);
      }
    } catch (err) {
      entry.status = 'failed';
      entry.error = rpcMessage(err);
    }
    results.push(entry);
  }

  return {
    variant,
    pairToken: pair,
    pairSymbol: symbol,
    decimals,
    router: routerAddr,
    dryRun,
    count: wallets.length,
    swaps: results,
    confirmed: results.filter((r) => r.status === 'confirmed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed' || r.status === 'reverted').length,
  };
}

function parseBuffer() {
  try {
    const { parseEther } = require('ethers');
    return parseEther(String(config.gasBufferEth));
  } catch {
    return 0n;
  }
}

module.exports = { swapBundleToPair };
