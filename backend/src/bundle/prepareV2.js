'use strict';

// Builds a pons v2 launch. Deliberately does LESS than v1's prepare().
//
// v1 signed everything up front because predictTokenAddress told us the token's
// address before it existed. v2 has no such function: the token and curve come
// from plain CREATE, so their addresses depend on the deployer's nonce, which
// moves whenever anyone else launches. A buy signed against a predicted address
// would, if another launch slipped in first, spend real money buying a
// stranger's token. That failure is worse than being a few hundred milliseconds
// slow, so the buys are signed in fireV2() once the receipt names the curve.
//
// What this function still does: validate the gate, pin the economics, check
// balances, and sign the launch itself.

const { parseEther, formatEther, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const v2 = require('../evm/v2/factory');
const v2helper = require('../evm/v2/helper');
const keystore = require('../wallets/keystore');
const { spendableFromBalance } = require('../wallets/funding');

// A launch deploys a token and a curve and mints the whole supply. Estimated
// when possible; this is only the fallback.
const LAUNCH_GAS_FALLBACK = 6_000_000n;
const FEE_BUMP_PCT = 25;

/** Strip fields signTransaction rejects, and pin chainId. */
function toSignable(tx, { nonce, gasLimit, fees, chainId }) {
  const { from, ...rest } = tx;
  return { ...rest, nonce, gasLimit, chainId, ...fees };
}

/**
 * @param {object} input
 * @param {object} input.params v2 TokenParams minus expectedEconomics, which is
 *   fetched here: name, symbol, logo, description, socials, creatorFeeRecipient,
 *   creatorTaxBps, buybackEnabled
 * @param {number} input.launchConfigId
 * @param {string} input.pairToken the launch's currency; must be factory-approved
 * @param {Array<{walletId, mode, amountEth}>} input.wallets bundle buyers
 * @returns {Promise<object>} a plan whose launch is signed and whose buys are not
 */
async function prepareV2(input, { keystore: ks = keystore } = {}) {
  const { params, launchConfigId, pairToken, wallets = [] } = input;

  if (!params || !params.name || !params.symbol) throw new Error('name and symbol are required');
  if (!params.logo) throw new Error('logo is required');
  if (!pairToken) throw new Error('pairToken is required');

  const dev = ks.devWallet();
  const warnings = [];

  // Resolve every referenced wallet through the CALLER's keystore before any
  // chain work, so a foreign wallet id fails as "no wallet" rather than being
  // used. Same guarantee as v1.
  const known = new Map(ks.list().map((w) => [w.id, w]));
  for (const w of wallets) {
    if (!known.has(w.walletId)) throw new Error(`no wallet ${w.walletId}`);
  }

  // Cheap, free, and the difference between a clear message and a reverted
  // transaction: every launchToken call on chain reverts today.
  const gate = await v2.preflightGate({ launcher: dev.address, pairToken });
  for (const problem of gate.problems) warnings.push(problem);

  const cfgs = await v2.getConfigs();
  const launchConfig = cfgs.launchConfigs.find((c) => c.id === Number(launchConfigId));
  if (!launchConfig) throw new Error(`no launch config ${launchConfigId}`);
  if (!launchConfig.enabled) throw new Error(`launch config ${launchConfigId} is disabled`);

  if (Number(params.creatorTaxBps || 0) > cfgs.maxCreatorTaxBps) {
    throw new Error(
      `creatorTaxBps ${params.creatorTaxBps} exceeds the factory maximum of ${cfgs.maxCreatorTaxBps}`
    );
  }

  // Pins the config's economics into the transaction. If the config is updated
  // between building and mining, the launch reverts instead of quietly
  // launching on different terms.
  const expectedEconomics = await v2.previewEconomics({ launchConfigId, pairToken });

  const fullParams = {
    name: params.name.trim(),
    symbol: params.symbol.trim(),
    logo: params.logo.trim(),
    description: (params.description || '').trim(),
    socials: {
      twitter: (params.socials?.twitter || '').trim(),
      telegram: (params.socials?.telegram || '').trim(),
      discord: (params.socials?.discord || '').trim(),
      website: (params.socials?.website || '').trim(),
      farcaster: (params.socials?.farcaster || '').trim(),
    },
    creatorFeeRecipient: params.creatorFeeRecipient
      ? getAddress(params.creatorFeeRecipient)
      : getAddress(dev.address),
    creatorTaxBps: Number(params.creatorTaxBps || 0),
    buybackEnabled: Boolean(params.buybackEnabled),
    expectedEconomics,
  };

  const fees = await getFees(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);
  const launchFee = BigInt(cfgs.launchFee);

  // There is no dev buy in v2 — value is the fee and nothing more.
  //
  // With a helper deployed the launch goes through arm() instead, so the helper
  // records the curve the factory just created and the buys can reference it by
  // epoch rather than by a guessed address.
  const useHelper = Boolean(config.v2HelperAddress);
  const epoch = useHelper ? (await v2helper.nextEpoch()).toString() : null;
  const launchTx = useHelper
    ? await v2helper.buildArmTx({ params: fullParams, launchConfigId, pairToken, value: launchFee })
    : await v2.buildLaunchTx({ params: fullParams, launchConfigId, pairToken, value: launchFee });

  let launchGas = LAUNCH_GAS_FALLBACK;
  try {
    launchGas = ((await provider.estimateGas({ ...launchTx, from: dev.address })) * 12n) / 10n;
  } catch (_err) {
    warnings.push(`could not estimate launch gas — using fallback ${LAUNCH_GAS_FALLBACK}`);
  }

  const devBalance = await provider.getBalance(dev.address);
  const devNeeded = launchFee + gasCost(fees, launchGas);
  if (devBalance < devNeeded) {
    throw new Error(
      `dev wallet ${dev.address} has ${formatEther(devBalance)} ETH but the launch needs ` +
        `${formatEther(devNeeded)} (fee ${formatEther(launchFee)} + gas)`
    );
  }

  const devSigner = ks.signer(dev.id, provider);
  const devNonce = await provider.getTransactionCount(dev.address, 'pending');
  const signedLaunch = {
    walletId: dev.id,
    address: dev.address,
    valueEth: formatEther(launchFee),
    nonce: devNonce,
    raw: await devSigner.signTransaction(
      toSignable(launchTx, { nonce: devNonce, gasLimit: launchGas, fees, chainId })
    ),
  };

  // ── the buys ──────────────────────────────────────────────────────────────
  // Resolved and costed here, signed later. Each entry carries everything
  // fireV2 needs the moment the curve address is known.
  const buyGas = BigInt(config.buyGasLimit);
  const buyCost = gasCost(fees, buyGas);
  const buffer = parseEther(String(config.gasBufferEth));

  const buys = [];
  for (const w of wallets) {
    const wallet = known.get(w.walletId);
    const balance = await provider.getBalance(wallet.address);

    let amountIn;
    if (w.mode === 'all') {
      amountIn = spendableFromBalance(balance, buyCost, buyGas, buffer);
      if (amountIn === 0n) {
        warnings.push(`${wallet.address}: balance ${formatEther(balance)} ETH does not cover gas + buffer — skipped`);
        continue;
      }
    } else {
      amountIn = parseEther(String(w.amountEth || 0));
      if (amountIn <= 0n) {
        warnings.push(`${wallet.address}: buy amount is zero — skipped`);
        continue;
      }
      if (balance < amountIn + buyCost) {
        warnings.push(
          `${wallet.address}: has ${formatEther(balance)} ETH, needs ${formatEther(amountIn + buyCost)} (buy + gas) — skipped`
        );
        continue;
      }
    }

    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    const entry = {
      walletId: wallet.id,
      address: wallet.address,
      amountEth: formatEther(amountIn),
      amountIn: amountIn.toString(),
      nonce,
    };

    // Helper mode signs now; without it the curve address does not exist yet
    // and fireV2 has to wait for the receipt before it can sign anything.
    if (useHelper) {
      const buyTx = await v2helper.buildBuyTx({ epoch, amountIn, minTokensOut: 0n });
      const signer = ks.signer(wallet.id, provider);
      entry.raw = await signer.signTransaction(
        toSignable(buyTx, { nonce, gasLimit: buyGas, fees, chainId })
      );
    }
    buys.push(entry);
  }

  return {
    protocol: 'v2',
    // 'helper' buys are pre-signed and fire immediately; 'reactive' buys are
    // signed after the receipt names the curve.
    mode: useHelper ? 'helper' : 'reactive',
    helper: config.v2HelperAddress,
    epoch,
    // No predicted token address: v2 cannot tell us one before the launch runs.
    token: null,
    curve: null,
    launchConfigId: Number(launchConfigId),
    pairToken: getAddress(pairToken),
    launchFeeEth: formatEther(launchFee),
    params: fullParams,
    dryRun: config.dryRun,
    launchEnabled: gate.enabled,
    whitelisted: gate.whitelisted,
    pairApproved: gate.approved,
    supply: launchConfig.supply,
    graduationThreshold: launchConfig.graduationThreshold,
    curveFeeBps: launchConfig.curveFeeBps,
    creatorTaxBps: fullParams.creatorTaxBps,
    buybackEnabled: fullParams.buybackEnabled,
    launch: signedLaunch,
    buys,
    totalBuyEth: formatEther(buys.reduce((s, b) => s + BigInt(b.amountIn), 0n)),
    fees,
    buyGas: buyGas.toString(),
    chainId: chainId.toString(),
    warnings,
  };
}

module.exports = { prepareV2, toSignable, LAUNCH_GAS_FALLBACK };
