'use strict';

// Moving native ETH between the dev wallet and the bundle wallets.
//
// Both directions assign nonces by hand and broadcast concurrently: 25
// sequential round-trips against a public RPC is slow enough to matter when
// you are funding minutes before a launch.

const { parseEther, formatEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { erc20, readTokenBalance } = require('../evm/erc20');
const { rpcMessage } = require('../evm/errors');
const { shouldBatch, splitAcross, buildDisperseTx } = require('../evm/disperse');
const keystore = require('./keystore');

// A plain transfer costs 21,195 gas on this chain, not the 21,000 every EVM
// tutorial assumes. Hardcoding the textbook number had the node reject every
// sweep with "intrinsic gas too low" — by 195 gas. So ask the chain, and keep
// this only as the floor for when estimation is unavailable.
const TRANSFER_GAS = 30000n;
const TOKEN_TRANSFER_GAS = 120000n;

/**
 * What a native transfer really costs here, with headroom. Never throws: a
 * failed estimate falls back to the floor above rather than stopping a sweep.
 */
async function transferGas(from, to) {
  try {
    const est = await provider.estimateGas({ from, to, value: 1n });
    const withHeadroom = (est * 12n) / 10n;
    return withHeadroom > TRANSFER_GAS ? withHeadroom : TRANSFER_GAS;
  } catch (_err) {
    return TRANSFER_GAS;
  }
}

// Fee headroom. Quoting the base fee exactly gets the transaction rejected the
// moment it ticks up between the quote and the broadcast — observed on a sweep
// where every transfer failed against a base fee 0.18% higher than quoted. The
// cost of the headroom is a fraction of a cent; the cost of a rejection is the
// whole operation.
const DISPERSE_FEE_BUMP_PCT = 25;
const SWEEP_FEE_BUMP_PCT = 25;

async function balances({ keystore: ks = keystore } = {}) {
  const wallets = ks.list();
  const out = [];
  for (const w of wallets) {
    const wei = await provider.getBalance(w.address);
    out.push({ ...w, balanceWei: wei.toString(), balanceEth: formatEther(wei) });
  }
  return out;
}

/**
 * Send native ETH from the dev wallet to bundle wallets.
 * @param {Array<{walletId:string, amountEth:string|number}>} targets
 */
async function disperse(targets, { keystore: ks = keystore } = {}) {
  const dev = ks.devWallet();
  const signer = ks.signer(dev.id, provider);
  const fees = await getFees(DISPERSE_FEE_BUMP_PCT);

  const planned = targets.map((t) => ({
    walletId: t.walletId,
    address: ks.list().find((w) => w.id === t.walletId)?.address,
    value: parseEther(String(t.amountEth)),
  }));

  if (!planned.length) throw new Error('targets[] is required');
  const missing = planned.find((p) => !p.address);
  if (missing) throw new Error(`no wallet ${missing.walletId}`);

  const total = planned.reduce((sum, p) => sum + p.value, 0n);
  // Every transfer in the batch is the same shape, so one estimate covers all.
  const perTransferGas = await transferGas(dev.address, planned[0].address);
  const cost = gasCost(fees, perTransferGas) * BigInt(planned.length);
  const balance = await provider.getBalance(dev.address);
  if (balance < total + cost) {
    throw new Error(
      `dev wallet has ${formatEther(balance)} ETH but needs ${formatEther(total + cost)} (transfers + gas)`
    );
  }

  if (config.dryRun) {
    return planned.map((p) => ({
      walletId: p.walletId,
      address: p.address,
      amountEth: formatEther(p.value),
      hash: null,
      simulated: true,
    }));
  }

  // Batched transfers beat N concurrent broadcasts once there are enough
  // recipients: cheaper, and they cannot be partially rate-limited. With
  // several dispersers configured the run is split across them, so one failing
  // batch costs only its own share.
  if (shouldBatch(planned.length)) {
    const chunks = splitAcross(planned.map((p) => ({ ...p, value: p.value })));
    let batchNonce = await provider.getTransactionCount(dev.address, 'pending');

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const nonce = batchNonce++;
        try {
          const tx = await buildDisperseTx(
            chunk.targets.map((t) => ({ address: t.address, value: t.value })),
            chunk.disperser
          );
          const sentTx = await signer.sendTransaction({ ...tx, nonce, ...fees });
          return chunk.targets.map((t) => ({
            walletId: t.walletId,
            address: t.address,
            amountEth: formatEther(t.value),
            hash: sentTx.hash,
            batched: true,
            disperser: chunk.disperser,
          }));
        } catch (err) {
          return chunk.targets.map((t) => ({
            walletId: t.walletId,
            address: t.address,
            amountEth: formatEther(t.value),
            error: rpcMessage(err),
            disperser: chunk.disperser,
          }));
        }
      })
    );

    const flat = results.flat();
    // Only fall back to individual transfers if EVERY batch failed. A partial
    // failure must not re-send the ones that already went out.
    if (flat.some((r) => r.hash)) return flat;
    console.warn('[pons-launcher] every disperse batch failed — falling back to individual transfers');
  }

  let nonce = await provider.getTransactionCount(dev.address, 'pending');
  const sent = await Promise.all(
    planned.map(async (p) => {
      try {
        const tx = await signer.sendTransaction({
          to: p.address,
          value: p.value,
          nonce: nonce++,
          gasLimit: perTransferGas,
          ...fees,
        });
        return { walletId: p.walletId, address: p.address, amountEth: formatEther(p.value), hash: tx.hash };
      } catch (err) {
        return { walletId: p.walletId, address: p.address, error: rpcMessage(err) };
      }
    })
  );
  return sent;
}

/**
 * Return funds from the bundle wallets to the dev wallet. Tokens go first —
 * a token transfer needs gas, so emptying the native balance first would strand
 * them.
 * @param {{includeTokens?:boolean, tokenAddress?:string}} opts
 */
async function sweep({ includeTokens = false, tokenAddress = null } = {}, { keystore: ks = keystore } = {}) {
  const dev = ks.devWallet();
  const wallets = ks.bundleWallets();
  const fees = await getFees(SWEEP_FEE_BUMP_PCT);
  const results = [];

  for (const w of wallets) {
    const entry = { walletId: w.id, address: w.address };
    try {
      if (includeTokens && tokenAddress) {
        const bal = await readTokenBalance(tokenAddress, w.address);
        if (bal > 0n) {
          if (config.dryRun) {
            entry.tokens = { amount: bal.toString(), hash: null, simulated: true };
          } else {
            const signer = ks.signer(w.id, provider);
            const tx = await erc20(tokenAddress, signer).transfer(dev.address, bal, {
              gasLimit: TOKEN_TRANSFER_GAS,
              ...fees,
            });
            await tx.wait();
            entry.tokens = { amount: bal.toString(), hash: tx.hash };
          }
        }
      }

      const balance = await provider.getBalance(w.address);
      const sweepGas = await transferGas(w.address, dev.address);
      const reserve = gasCost(fees, sweepGas);
      const value = balance - reserve;
      if (value <= 0n) {
        entry.skipped = `balance ${formatEther(balance)} ETH does not cover the sweep's own gas`;
        results.push(entry);
        continue;
      }
      if (config.dryRun) {
        entry.eth = { amountEth: formatEther(value), hash: null, simulated: true };
      } else {
        const signer = ks.signer(w.id, provider);
        const tx = await signer.sendTransaction({
          to: dev.address,
          value,
          gasLimit: sweepGas,
          ...fees,
        });
        entry.eth = { amountEth: formatEther(value), hash: tx.hash };
      }
    } catch (err) {
      entry.error = rpcMessage(err);
    }
    results.push(entry);
  }

  return { to: dev.address, results };
}

/**
 * What a wallet can spend on a buy when the mode is "entire balance": the whole
 * native balance minus the buy's own gas and the configured buffer.
 * Pure arithmetic, so the launch path can be tested without a chain.
 * @returns {bigint} 0n when the wallet cannot afford to buy at all
 */
function spendableFromBalance(balanceWei, feesOrCost, gasLimit, bufferWei) {
  const cost = typeof feesOrCost === 'bigint' ? feesOrCost : gasCost(feesOrCost, gasLimit);
  const spendable = balanceWei - cost - bufferWei;
  return spendable > 0n ? spendable : 0n;
}

module.exports = { balances, disperse, sweep, spendableFromBalance, TRANSFER_GAS };
