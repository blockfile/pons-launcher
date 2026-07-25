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
const keystore = require('./keystore');

const TRANSFER_GAS = 21000n;
const TOKEN_TRANSFER_GAS = 120000n;

async function balances() {
  const wallets = keystore.list();
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
async function disperse(targets) {
  const dev = keystore.devWallet();
  const signer = keystore.signer(dev.id, provider);
  const fees = await getFees(10);

  const planned = targets.map((t) => ({
    walletId: t.walletId,
    address: keystore.list().find((w) => w.id === t.walletId)?.address,
    value: parseEther(String(t.amountEth)),
  }));

  const missing = planned.find((p) => !p.address);
  if (missing) throw new Error(`no wallet ${missing.walletId}`);

  const total = planned.reduce((sum, p) => sum + p.value, 0n);
  const cost = gasCost(fees, TRANSFER_GAS) * BigInt(planned.length);
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

  let nonce = await provider.getTransactionCount(dev.address, 'pending');
  const sent = await Promise.all(
    planned.map(async (p) => {
      try {
        const tx = await signer.sendTransaction({
          to: p.address,
          value: p.value,
          nonce: nonce++,
          gasLimit: TRANSFER_GAS,
          ...fees,
        });
        return { walletId: p.walletId, address: p.address, amountEth: formatEther(p.value), hash: tx.hash };
      } catch (err) {
        return { walletId: p.walletId, address: p.address, error: err.shortMessage || err.message };
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
async function sweep({ includeTokens = false, tokenAddress = null } = {}) {
  const dev = keystore.devWallet();
  const wallets = keystore.bundleWallets();
  const fees = await getFees(0);
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
            const signer = keystore.signer(w.id, provider);
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
      const reserve = gasCost(fees, TRANSFER_GAS);
      const value = balance - reserve;
      if (value <= 0n) {
        entry.skipped = `balance ${formatEther(balance)} ETH does not cover the sweep's own gas`;
        results.push(entry);
        continue;
      }
      if (config.dryRun) {
        entry.eth = { amountEth: formatEther(value), hash: null, simulated: true };
      } else {
        const signer = keystore.signer(w.id, provider);
        const tx = await signer.sendTransaction({
          to: dev.address,
          value,
          gasLimit: TRANSFER_GAS,
          ...fees,
        });
        entry.eth = { amountEth: formatEther(value), hash: tx.hash };
      }
    } catch (err) {
      entry.error = err.shortMessage || err.message;
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
