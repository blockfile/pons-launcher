'use strict';

// Builds a complete, fully-signed launch bundle BEFORE anything is broadcast.
//
// This is the whole trick. predictTokenAddress tells us the address the token
// WILL have, so every bundle buy can be signed while the pool still does not
// exist. Snipers cannot begin until they observe the pool-creation event; we
// are already signed and queued before that event can exist.

const { parseEther, formatEther, randomBytes, hexlify, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const factory = require('../evm/factory');
const { buildBuyTx } = require('../evm/router');
const { capCheck } = require('../evm/pricing');
const keystore = require('../wallets/keystore');
const { spendableFromBalance } = require('../wallets/funding');

// A launch deploys a token, opens a V3 pool, mints and locks the position and
// optionally swaps — far past a normal transaction. Estimated when possible.
const LAUNCH_GAS_FALLBACK = 6_000_000n;
// Bundle buys are bumped hard: being one block late is the entire failure mode.
const FEE_BUMP_PCT = 25;

function randomSalt() {
  return hexlify(randomBytes(32));
}

/** Strip fields signTransaction rejects, and pin chainId. */
function toSignable(tx, { nonce, gasLimit, fees, chainId }) {
  const { from, ...rest } = tx;
  return { ...rest, nonce, gasLimit, chainId, ...fees };
}

/**
 * Build and sign the whole bundle.
 *
 * @param {object} input
 * @param {object} input.params TokenParams (name, symbol, logo, description, socials, feeWallet)
 * @param {number} input.launchConfigId
 * @param {number} input.dexId
 * @param {string} [input.salt] bytes32; random when omitted
 * @param {string|number} input.devBuyEth native ETH the launch itself buys with (atomic, uncapped)
 * @param {Array<{walletId:string, mode:'fixed'|'all', amountEth?:string|number}>} input.wallets
 * @returns {Promise<object>} the signed plan, ready for fire()
 */
async function prepare(input, { keystore: ks = keystore } = {}) {
  const {
    params,
    launchConfigId,
    dexId,
    salt = randomSalt(),
    devBuyEth = 0,
    wallets = [],
  } = input;

  if (!params || !params.name || !params.symbol) throw new Error('name and symbol are required');
  // A logo that is empty at launch is baked into the CREATE2 preimage forever —
  // reject here rather than trust the form's own disabled-button check.
  if (!params.logo) throw new Error('logo is required');

  const dev = ks.devWallet();

  // Resolve every referenced bundle wallet through the caller's own keystore
  // before any chain work starts. This is what makes a foreign wallet id (one
  // that belongs to another user) fail as "no wallet" rather than being
  // silently signed with, or reached only after wasted RPC calls. The buy loop
  // below reads from this same Map rather than re-resolving against ks.list()
  // — one source of truth, so the two can't drift apart.
  const knownWallets = new Map(ks.list().map((k) => [k.id, k]));
  for (const w of wallets) {
    if (!knownWallets.has(w.walletId)) throw new Error(`no wallet ${w.walletId}`);
  }

  const { launchFee, launchConfigs, dexConfigs } = await factory.getConfigs();

  const launchConfig = launchConfigs.find((c) => c.id === Number(launchConfigId));
  const dexConfig = dexConfigs.find((d) => d.id === Number(dexId));
  if (!launchConfig) throw new Error(`no launch config ${launchConfigId}`);
  if (!dexConfig) throw new Error(`no dex config ${dexId}`);
  if (!launchConfig.enabled) throw new Error(`launch config ${launchConfigId} is disabled`);
  if (!dexConfig.enabled) throw new Error(`dex config ${dexId} is disabled`);

  // The address this launch will produce — known in advance, which is what
  // lets the buys below be signed before the pool exists.
  const token = await factory.predictTokenAddress({
    params,
    launchConfigId,
    dexId,
    salt,
    deployer: dev.address,
  });

  const fees = await getFees(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);
  const warnings = [];

  // ── the launch transaction ────────────────────────────────────────────────
  const devBuyWei = parseEther(String(devBuyEth || 0));
  const launchValue = BigInt(launchFee) + devBuyWei;
  const launchTx = await factory.buildLaunchTx({ params, launchConfigId, dexId, salt, value: launchValue });

  let launchGas = LAUNCH_GAS_FALLBACK;
  try {
    launchGas = (await provider.estimateGas({ ...launchTx, from: dev.address })) * 12n / 10n;
  } catch (_err) {
    warnings.push(`could not estimate launch gas — using fallback ${LAUNCH_GAS_FALLBACK}`);
  }

  const devBalance = await provider.getBalance(dev.address);
  const devNeeded = launchValue + gasCost(fees, launchGas);
  if (devBalance < devNeeded) {
    throw new Error(
      `dev wallet ${dev.address} has ${formatEther(devBalance)} ETH but the launch needs ` +
        `${formatEther(devNeeded)} (fee ${formatEther(launchFee)} + buy ${formatEther(devBuyWei)} + gas)`
    );
  }

  const devSigner = ks.signer(dev.id, provider);
  const devNonce = await provider.getTransactionCount(dev.address, 'pending');
  const signedLaunch = {
    walletId: dev.id,
    address: dev.address,
    valueEth: formatEther(launchValue),
    devBuyEth: formatEther(devBuyWei),
    nonce: devNonce,
    raw: await devSigner.signTransaction(
      toSignable(launchTx, { nonce: devNonce, gasLimit: launchGas, fees, chainId })
    ),
  };

  // ── the bundle buys ───────────────────────────────────────────────────────
  const buyGas = BigInt(config.buyGasLimit);
  const buyCost = gasCost(fees, buyGas);
  const buffer = parseEther(String(config.gasBufferEth));
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const signedBuys = [];
  for (const w of wallets) {
    const known = knownWallets.get(w.walletId);
    if (!known) throw new Error(`no wallet ${w.walletId}`);

    const balance = await provider.getBalance(known.address);
    let amountIn;
    if (w.mode === 'all') {
      amountIn = spendableFromBalance(balance, buyCost, buyGas, buffer);
      if (amountIn === 0n) {
        warnings.push(`${known.address}: balance ${formatEther(balance)} ETH does not cover gas + buffer — skipped`);
        continue;
      }
    } else {
      amountIn = parseEther(String(w.amountEth || 0));
      if (amountIn <= 0n) {
        warnings.push(`${known.address}: buy amount is zero — skipped`);
        continue;
      }
      if (balance < amountIn + buyCost) {
        warnings.push(
          `${known.address}: has ${formatEther(balance)} ETH, needs ${formatEther(amountIn + buyCost)} ` +
            '(buy + gas) — skipped'
        );
        continue;
      }
    }

    // Every bundle buy lands inside the restriction window — the window is set
    // by EVM block.number, which advances roughly every 16s on this chain, so
    // no amount of speed escapes it. A buy over the cap does not clamp, it
    // REVERTS: gas spent, nothing bought. Warn while the operator can still
    // resize, rather than after the launch.
    const cap = capCheck({ amountInWei: amountIn, launchConfig, token });
    if (cap.exceedsWallet || cap.exceedsTx) {
      const which = cap.exceedsWallet ? `max wallet ${launchConfig.maxWalletBps / 100}%` : `max buy ${launchConfig.maxTxBps / 100}%`;
      warnings.push(
        `${known.address}: ${formatEther(amountIn)} ETH is about ${(cap.estBps / 100).toFixed(2)}% of supply, ` +
          `over ${which} — this buy will REVERT inside the restriction window. Estimated at the pool's ` +
          'initial price and ignoring the rest of the bundle, so treat it as a ceiling.'
      );
    }

    const buyTx = await buildBuyTx({
      dexConfig,
      launchConfig,
      token,
      recipient: getAddress(known.address),
      amountIn,
      deadline,
    });
    const signer = ks.signer(known.id, provider);
    const nonce = await provider.getTransactionCount(known.address, 'pending');
    signedBuys.push({
      walletId: known.id,
      address: known.address,
      amountEth: formatEther(amountIn),
      estShareBps: Math.round(cap.estBps),
      capExceeded: cap.exceedsWallet || cap.exceedsTx,
      nonce,
      raw: await signer.signTransaction(
        toSignable(buyTx, { nonce, gasLimit: buyGas, fees, chainId })
      ),
    });
  }

  return {
    token,
    salt,
    launchConfigId: Number(launchConfigId),
    dexId: Number(dexId),
    launchFeeEth: formatEther(launchFee),
    params,
    dryRun: config.dryRun,
    restrictionBlocks: launchConfig.restrictionBlocks,
    maxWalletBps: launchConfig.maxWalletBps,
    maxTxBps: launchConfig.maxTxBps,
    router: config.swapRouterOverride || dexConfig.swapRouter,
    launch: signedLaunch,
    buys: signedBuys,
    totalBuyEth: formatEther(signedBuys.reduce((s, b) => s + parseEther(b.amountEth), 0n)),
    warnings,
  };
}

module.exports = { prepare, randomSalt, toSignable, LAUNCH_GAS_FALLBACK };
