'use strict';

// Builds a pons v2 launch, fully signed before anything is broadcast.
//
// This used to sign only the launch, because the curve address was unknowable
// until the launch was mined. The live factory changed that: TokenParams takes
// a `salt`, and PonsV2LaunchDeployer.predictLaunchAddresses returns the exact
// token and curve that salt produces. So v2 now prepares the way v1 does —
// every buy signed in advance, nothing left to compute at fire time.
//
// Two safeguards around the prediction, because a buy sent to an address with
// no contract SUCCEEDS on the EVM and silently keeps the money:
//
//   1. The prediction is cross-checked against a static call of the real
//      launch. Two independent derivations must agree before anything is
//      signed.
//   2. The bundle wallets are declared in `snipeTaxExemptions`, so they are the
//      only addresses that clear at the untaxed price during the opening
//      window. Undeclared buyers pay a tax starting at 99%.

const { parseEther, formatEther, getAddress, ZeroAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const v2 = require('../evm/v2/factory');
const { buildBuyTx } = require('../evm/v2/curve');
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
 * @param {object} input.params v2 TokenParams minus salt/expectedEconomics
 * @param {number} input.launchConfigId
 * @param {string} [input.pairToken] defaults to native ETH
 * @param {string|number} [input.devBuyEth] bought atomically inside the launch
 * @param {Array<{walletId, mode, amountEth}>} input.wallets bundle buyers
 * @returns {Promise<object>} a plan in which EVERYTHING is signed
 */
async function prepareV2(input, { keystore: ks = keystore } = {}) {
  const { params, launchConfigId, pairToken = ZeroAddress, wallets = [], devBuyEth = 0 } = input;

  if (!params || !params.name || !params.symbol) throw new Error('name and symbol are required');
  if (!params.logo) throw new Error('logo is required');

  const dev = ks.devWallet();
  const warnings = [];
  const pair = getAddress(pairToken);

  // Resolve every referenced wallet through the CALLER's keystore before any
  // chain work, so a foreign wallet id fails as "no wallet" rather than being
  // used. Same guarantee as v1.
  const known = new Map(ks.list().map((w) => [w.id, w]));
  for (const w of wallets) {
    if (!known.has(w.walletId)) throw new Error(`no wallet ${w.walletId}`);
  }

  const gate = await v2.preflightGate({ launcher: dev.address, pairToken: pair });
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
    // Left at zero deliberately. The factory only enforces this commitment when
    // it is non-zero, and pinning it turns an owner tweaking an unrelated fee
    // between preflight and launch into a reverted launch.
    expectedEconomics: `0x${'00'.repeat(32)}`,
    salt: params.salt || v2.newSalt(),
  };

  const fees = await getFees(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);
  const launchFee = BigInt(cfgs.launchFee);
  const devBuy = parseEther(String(devBuyEth || 0));

  // ── who is exempt from the opening tax ────────────────────────────────────
  // The dev and the creator fee recipient are exempted by the factory itself.
  // Everyone else has to be declared here, and the list is capped at 32.
  const exemptions = wallets.map((w) => getAddress(known.get(w.walletId).address));
  if (exemptions.length > v2.MAX_SNIPE_TAX_EXEMPTIONS) {
    throw new Error(
      `${exemptions.length} bundle wallets, but the factory exempts at most ` +
        `${v2.MAX_SNIPE_TAX_EXEMPTIONS} — the rest would pay the ${cfgs.snipeTaxStartBps / 100}% opening tax`
    );
  }

  // ── where the token will be ───────────────────────────────────────────────
  const predicted = await v2.predictAddresses({
    params: fullParams,
    launchConfigId,
    pairToken: pair,
    deployer: dev.address,
  });

  // The launch, run as a call. Free, and derived by the factory rather than by
  // our reconstruction of it — so agreement is real evidence, not the same
  // guess made twice. It also proves the launch would not revert.
  const simulated = await v2.simulateLaunch({
    from: dev.address,
    params: fullParams,
    launchConfigId,
    pairToken: pair,
    exemptions,
    value: launchFee,
  });

  if (simulated.curve !== predicted.curve || simulated.token !== predicted.token) {
    throw new Error(
      `address prediction disagrees with the factory — predicted curve ${predicted.curve}, ` +
        `the launch would create ${simulated.curve}. Refusing to pre-sign buys against either.`
    );
  }

  const token = predicted.token;
  const curve = predicted.curve;

  // ── the launch ────────────────────────────────────────────────────────────
  // With a dev buy it goes through the forwarder, which launches and buys in one
  // transaction — nothing can be in front of the dev. Without one, straight to
  // the factory, which rejects any msg.value that is not exactly the fee.
  const launchTx =
    devBuy > 0n
      ? await v2.buildLaunchAndBuyTx({
          params: fullParams,
          launchConfigId,
          pairToken: pair,
          quoteIn: devBuy,
          minTokensOut: 0n,
          recipient: dev.address,
          exemptions,
          value: launchFee + devBuy,
          forwarderAddress: predicted.wiring.forwarder,
        })
      : await v2.buildLaunchTx({
          params: fullParams,
          launchConfigId,
          pairToken: pair,
          exemptions,
          value: launchFee,
        });

  let launchGas = LAUNCH_GAS_FALLBACK;
  try {
    launchGas = ((await provider.estimateGas({ ...launchTx, from: dev.address })) * 12n) / 10n;
  } catch (_err) {
    warnings.push(`could not estimate launch gas — using fallback ${LAUNCH_GAS_FALLBACK}`);
  }

  const devBalance = await provider.getBalance(dev.address);
  const devNeeded = launchFee + devBuy + gasCost(fees, launchGas);
  if (devBalance < devNeeded) {
    throw new Error(
      `dev wallet ${dev.address} has ${formatEther(devBalance)} ETH but the launch needs ` +
        `${formatEther(devNeeded)} (fee ${formatEther(launchFee)}` +
        (devBuy > 0n ? ` + dev buy ${formatEther(devBuy)}` : '') +
        ' + gas)'
    );
  }

  const devSigner = ks.signer(dev.id, provider);
  const devNonce = await provider.getTransactionCount(dev.address, 'pending');
  const signedLaunch = {
    walletId: dev.id,
    address: dev.address,
    valueEth: formatEther(launchFee + devBuy),
    devBuyEth: formatEther(devBuy),
    nonce: devNonce,
    atomic: devBuy > 0n,
    raw: await devSigner.signTransaction(
      toSignable(launchTx, { nonce: devNonce, gasLimit: launchGas, fees, chainId })
    ),
  };

  // ── the buys ──────────────────────────────────────────────────────────────
  // Signed here, against the predicted curve. Nothing is left to do at fire
  // time but broadcast.
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
    const buyTx = await buildBuyTx({
      curveAddress: curve,
      amountIn,
      minTokensOut: 0n,
      recipient: wallet.address,
      nativeQuote: pair === ZeroAddress,
    });
    const signer = ks.signer(wallet.id, provider);

    buys.push({
      walletId: wallet.id,
      address: wallet.address,
      amountEth: formatEther(amountIn),
      amountIn: amountIn.toString(),
      nonce,
      exempt: true,
      raw: await signer.signTransaction(
        toSignable(buyTx, { nonce, gasLimit: buyGas, fees, chainId })
      ),
    });
  }

  // A wallet that was dropped for lack of funds is still on the exemption list,
  // which costs nothing but would mislead anyone reading the plan.
  const funded = new Set(buys.map((b) => b.address));
  const declaredButSkipped = exemptions.filter((a) => !funded.has(a));
  if (declaredButSkipped.length) {
    warnings.push(
      `${declaredButSkipped.length} wallet(s) are declared snipe-tax exempt but have no buy — harmless, but they will not be in the bundle`
    );
  }

  return {
    protocol: 'v2',
    mode: 'presigned',
    token,
    curve,
    predictedBy: 'salt',
    launchConfigId: Number(launchConfigId),
    pairToken: pair,
    launchFeeEth: formatEther(launchFee),
    params: fullParams,
    salt: fullParams.salt,
    dryRun: config.dryRun,
    canLaunch: gate.canLaunch,
    launchEnabled: gate.enabled,
    pairApproved: gate.approved,
    supply: launchConfig.supply,
    graduationThreshold: launchConfig.graduationThreshold,
    curveFeeBps: launchConfig.curveFeeBps,
    creatorTaxBps: fullParams.creatorTaxBps,
    buybackEnabled: fullParams.buybackEnabled,
    snipeTax: {
      startBps: cfgs.snipeTaxStartBps,
      seconds: cfgs.snipeTaxSeconds,
      exemptions,
      max: v2.MAX_SNIPE_TAX_EXEMPTIONS,
    },
    launch: signedLaunch,
    buys,
    totalBuyEth: formatEther(buys.reduce((s, b) => s + BigInt(b.amountIn), 0n)),
    // Strings, not the BigInts getFees returns. This object is JSON-encoded
    // twice — once as the preflight response, once into the launch history —
    // and JSON.stringify throws on a BigInt rather than skipping it, so a
    // successful plan came back as "Do not know how to serialize a BigInt".
    fees: Object.fromEntries(
      Object.entries(fees).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
    ),
    buyGas: buyGas.toString(),
    chainId: chainId.toString(),
    warnings,
  };
}

module.exports = { prepareV2, toSignable, LAUNCH_GAS_FALLBACK };
