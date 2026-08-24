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

const { parseEther, parseUnits, formatEther, formatUnits, getAddress, ZeroAddress, Contract } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const v2 = require('../evm/v2/factory');
const { buildBuyTx } = require('../evm/v2/curve');
const erc20mod = require('../evm/erc20');
const { bundleShare } = require('../../../shared/bundleShare');
const keystore = require('../wallets/keystore');
const { DEFAULT_VARIANT, devWalletFor } = require('../wallets/variants');
const { spendableFromBalance } = require('../wallets/funding');

const FEE_BUMP_PCT = 25;

// approve/allowance are not in evm/erc20.js — that module deliberately exposes
// only the read and transfer surface the funding path needs. Approving a pair
// token is a launch-path concern for ERC-20 quote assets, so the fragment lives
// here, exactly as it does on the sell path (bundle/prepareSell.js).
const APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];

// A single SSTORE plus whatever the token does around it; generous, and cheap to
// over-reserve since unused gas is refunded. Same figure the sell path uses. Only
// spent on the ERC-20 pair path — a native launch signs no approvals.
const APPROVE_GAS = 100_000n;

/** Strip fields signTransaction rejects, and pin chainId. */
function toSignable(tx, { nonce, gasLimit, fees, chainId }) {
  const { from, ...rest } = tx;
  return { ...rest, nonce, gasLimit, chainId, ...fees };
}

/**
 * FAIL-SAFE. Estimate the launch, or refuse the whole plan.
 *
 * A launch that will not estimate is a launch that reverts. The bundle buys are
 * signed by prepareV2 and broadcast the instant the launch is sent, so a
 * reverting launch that was allowed through used to fire every buy anyway —
 * each one paying into the curve address the launch never created. On the EVM a
 * call to a codeless address SUCCEEDS and keeps the ETH, and that ETH cannot be
 * recovered: the curve contract, if it is ever deployed there, never reads its
 * own balance. On 2026-08-13 this stranded 1.798 ETH.
 *
 * So there is no gas fallback. If the launch cannot simulate, this throws with
 * the contract's own revert reason and nothing downstream is signed.
 *
 * @param {object} launchTx populated launch transaction (may carry `from`)
 * @param {string} from the dev/launcher address
 * @param {{provider?: object, explain?: Function}} [deps] injectable for tests
 * @returns {Promise<bigint>} gas limit, estimate + 20%
 */
async function estimateLaunchGasOrThrow(
  launchTx,
  from,
  { provider: p = provider, explain = v2.explainRevert } = {}
) {
  try {
    return ((await p.estimateGas({ ...launchTx, from })) * 12n) / 10n;
  } catch (err) {
    throw new Error(
      `the launch would revert, so nothing was signed: ${explain(err)}. ` +
        'Fix this before arming — no bundle buys are broadcast when the launch cannot simulate.'
    );
  }
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
async function prepareV2(input, deps = {}) {
  // Dependencies are injectable so the sign-nothing guarantee can be exercised
  // end to end in tests without a chain. Defaults are the real modules, so
  // production behaviour is unchanged.
  const {
    keystore: ks = keystore,
    v2: v2mod = v2,
    getFees: getFeesFn = getFees,
    provider: prov = provider,
    // Pair-token reads, injectable so the ERC-20 path can be exercised without a
    // chain. Default to the real erc20 module.
    readTokenBalance: readTokenBalanceFn = (t, o) => erc20mod.readTokenBalance(t, o),
    getSymbol: getSymbolFn = (t) => erc20mod.getSymbol(t),
  } = deps;
  const {
    params,
    launchConfigId,
    pairToken = ZeroAddress,
    wallets = [],
    devBuyEth = 0,
    bundleFunding = 'pair',
  } = input;

  if (!params || !params.name || !params.symbol) throw new Error('name and symbol are required');
  if (!params.logo) throw new Error('logo is required');
  if (bundleFunding !== 'pair' && bundleFunding !== 'ethZap') {
    throw new Error(`unknown bundleFunding "${bundleFunding}" — expected 'pair' or 'ethZap'`);
  }

  const dev = devWalletFor(ks, deps.variant || DEFAULT_VARIANT);
  const warnings = [];
  const pair = getAddress(pairToken);
  // The one switch this whole feature turns on. EVERYTHING below that differs
  // from a native launch is gated on it; when it is false the code path is the
  // one that has always run, byte for byte.
  const nonNative = pair !== ZeroAddress;

  // ETH-zap bundle funding. A NON-native pair whose bundle wallets hold only ETH:
  // each buy routes ETH → pair → curve.buy through pons's swap-zap, fetched per
  // wallet AT FIRE TIME (the route calls the token's curve, which does not exist
  // until the launch confirms). It is meaningless for a native pair — the wallets
  // already hold ETH — so the flag is IGNORED there rather than rejected, exactly
  // as the spec requires: a native launch is byte-for-byte unchanged.
  const ethZap = nonNative && bundleFunding === 'ethZap';

  // Resolve every referenced wallet through the CALLER's keystore before any
  // chain work, so a foreign wallet id fails as "no wallet" rather than being
  // used. Same guarantee as v1.
  const known = new Map(ks.list().map((w) => [w.id, w]));
  const seenWallet = new Set();
  for (const w of wallets) {
    if (!known.has(w.walletId)) throw new Error(`no wallet ${w.walletId}`);
    // A duplicate id, or the dev wallet listed as a buyer, would sign two
    // transactions against the SAME pending nonce — one silently rejected at
    // fire time, or (for the dev) a buy colliding with the launch itself. Reject
    // it here rather than under-fill the bundle without saying so.
    if (seenWallet.has(w.walletId)) throw new Error(`wallet ${w.walletId} is listed twice`);
    if (known.get(w.walletId).address.toLowerCase() === dev.address.toLowerCase()) {
      throw new Error('the dev wallet cannot also be a bundle buyer — its buy would collide with the launch');
    }
    seenWallet.add(w.walletId);
  }

  const gate = await v2mod.preflightGate({ launcher: dev.address, pairToken: pair });
  for (const problem of gate.problems) warnings.push(problem);

  // An unapproved pair token would revert the launch (PairTokenNotApproved), and
  // it would do so as a raw selector out of simulateLaunch. Reject it here, up
  // front, with a message that names the token — but ONLY for a non-native pair.
  // Native ETH is address(0), which the factory never checks and preflightGate
  // always reports approved, so this branch never touches the native path.
  if (nonNative && !gate.approved) {
    throw new Error(
      `pons v2 has not approved ${pair} as a pair token — the factory would revert ` +
        'PairTokenNotApproved. Pick an approved quote asset (see /api/v2/configs pairTokens).'
    );
  }

  // The pair token's authoritative economics and label. Only read for a non-
  // native pair; native inherits the launch config's own phantomQuote/threshold
  // and is 18-decimal ETH, so nothing here runs for it.
  let pairDecimals = 18;
  let pairSymbol = 'ETH';
  let pairEconomics = null;
  if (nonNative) {
    pairEconomics = await v2mod.pairEconomics(pair);
    pairDecimals = pairEconomics.decimals;
    pairSymbol = await getSymbolFn(pair).catch(() => `${pair.slice(0, 6)}…${pair.slice(-4)}`);
  }

  const cfgs = await v2mod.getConfigs();
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
    salt: params.salt || v2mod.newSalt(),
  };

  const fees = await getFeesFn(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);
  const launchFee = BigInt(cfgs.launchFee);
  // The dev buy is denominated in the QUOTE asset: native wei for ETH, the pair
  // token's own units otherwise (a 6-decimal USDG dev buy of "5" is 5_000_000,
  // not 5e18). Parsing at the wrong scale would over- or under-buy by orders of
  // magnitude, so the decimals come from the factory's own economics.
  //
  // IN ETH-ZAP MODE THE ATOMIC DEV BUY IS ZERO. launchAndBuy takes the pair
  // token, which a zap-funded dev does not hold — so the launch is a plain
  // launchToken (no forwarder, no quoteIn), and a requested dev buy becomes a
  // post-launch zap buyer instead (sized further down). Forcing devBuy to 0n here
  // makes every "dev buy" branch below take its no-dev-buy path automatically:
  // exemption limit 32 not 31, launch value = fee only, no dev approve.
  const devBuy = ethZap
    ? 0n
    : nonNative
      ? parseUnits(String(devBuyEth || 0), pairDecimals)
      : parseEther(String(devBuyEth || 0));

  // ── who is exempt from the opening tax ────────────────────────────────────
  // The dev and the creator fee recipient are exempted by the factory itself.
  // Everyone else has to be declared here.
  //
  // THE CAP DEPENDS ON HOW THE LAUNCH IS SENT. launchAndBuy appends its own buy
  // recipient before handing the list to the factory, so its share is one below
  // the factory's 32 — checking 32 here would let a 32-wallet bundle pass
  // preflight and revert at fire time, after the fee is spent.
  const exemptions = wallets.map((w) => getAddress(known.get(w.walletId).address));
  const exemptionLimit =
    devBuy > 0n ? v2mod.MAX_EXEMPTIONS_VIA_FORWARDER : v2mod.MAX_SNIPE_TAX_EXEMPTIONS;
  if (exemptions.length > exemptionLimit) {
    throw new Error(
      `${exemptions.length} bundle wallets, but this launch path exempts at most ` +
        `${exemptionLimit} — the rest would pay the ${cfgs.snipeTaxStartBps / 100}% opening tax`
    );
  }

  // ── where the token will be ───────────────────────────────────────────────
  const predicted = await v2mod.predictAddresses({
    params: fullParams,
    launchConfigId,
    pairToken: pair,
    deployer: dev.address,
  });

  // The launch, run as a call. Free, and derived by the factory rather than by
  // our reconstruction of it — so agreement is real evidence, not the same
  // guess made twice. It also proves the launch would not revert.
  const simulated = await v2mod.simulateLaunch({
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
  //
  // THE NATIVE VALUE DIFFERS BY QUOTE ASSET. For a native launch the dev buy is
  // paid in ETH, so the forwarder call carries launchFee + devBuy. For an ERC-20
  // pair the dev buy is paid in the pair TOKEN, pulled by the forwarder via
  // transferFrom, so the call carries only the launch fee and the dev must have
  // approved the forwarder for the quoteIn first (built below).
  const launchValue = nonNative ? launchFee : launchFee + devBuy;
  const launchTx =
    devBuy > 0n
      ? await v2mod.buildLaunchAndBuyTx({
          params: fullParams,
          launchConfigId,
          pairToken: pair,
          quoteIn: devBuy,
          minTokensOut: 0n,
          recipient: dev.address,
          exemptions,
          value: launchValue,
          forwarderAddress: predicted.wiring.forwarder,
        })
      : await v2mod.buildLaunchTx({
          params: fullParams,
          launchConfigId,
          pairToken: pair,
          exemptions,
          value: launchFee,
        });

  // THE FAIL-SAFE, and the one place the ERC-20 path cannot reuse the native
  // one. estimateGas is a real revert check: if the launch would revert, nothing
  // downstream is signed (see estimateLaunchGasOrThrow). But an ERC-20
  // launchAndBuy cannot be estimated before the dev's approve is mined — the
  // transferFrom in it reverts on the missing allowance every time. So for that
  // ONE case the fail-safe estimates the PLAIN launch (launchToken, no buy),
  // which needs no allowance and proves the curve is created and the launch does
  // not revert; the atomic buy then rides on a gas limit widened by one buy's
  // worth of headroom. simulateLaunch above already cross-checked this same plain
  // launch against the predicted address. Native — and ERC-20 with no dev buy —
  // estimate the real launch tx exactly as before.
  const estimateErc20DevBuy = nonNative && devBuy > 0n;
  const estimateTx = estimateErc20DevBuy
    ? await v2mod.buildLaunchTx({
        params: fullParams,
        launchConfigId,
        pairToken: pair,
        exemptions,
        value: launchFee,
      })
    : launchTx;
  const estimatedGas = await estimateLaunchGasOrThrow(estimateTx, dev.address, { provider: prov });
  const launchGas = estimateErc20DevBuy ? estimatedGas + BigInt(config.buyGasLimit) : estimatedGas;

  // ── what the dev wallet must hold ─────────────────────────────────────────
  // Native and ERC-20 diverge here: an ERC-20 dev buy is paid in the pair token
  // and only the fee + gas (+ the approve's gas) is native, so the native and
  // token balances are checked separately.
  const devBalance = await prov.getBalance(dev.address);
  if (nonNative) {
    const approveGasCost = devBuy > 0n ? gasCost(fees, APPROVE_GAS) : 0n;
    const devNativeNeeded = launchFee + approveGasCost + gasCost(fees, launchGas);
    if (devBalance < devNativeNeeded) {
      throw new Error(
        `dev wallet ${dev.address} has ${formatEther(devBalance)} ETH but the launch needs ` +
          `${formatEther(devNativeNeeded)} native (fee ${formatEther(launchFee)} + gas` +
          (devBuy > 0n ? ' + approve gas' : '') +
          `) — the ${pairSymbol} dev buy is paid in the pair token`
      );
    }
    if (devBuy > 0n) {
      const devPairBalance = BigInt(await readTokenBalanceFn(pair, dev.address));
      if (devPairBalance < devBuy) {
        throw new Error(
          `dev wallet ${dev.address} holds ${formatUnits(devPairBalance, pairDecimals)} ${pairSymbol} ` +
            `but the dev buy needs ${formatUnits(devBuy, pairDecimals)} ${pairSymbol}`
        );
      }
    }
  } else {
    const devNeeded = launchFee + devBuy + gasCost(fees, launchGas);
    if (devBalance < devNeeded) {
      throw new Error(
        `dev wallet ${dev.address} has ${formatEther(devBalance)} ETH but the launch needs ` +
          `${formatEther(devNeeded)} (fee ${formatEther(launchFee)}` +
          (devBuy > 0n ? ` + dev buy ${formatEther(devBuy)}` : '') +
          ' + gas)'
      );
    }
  }

  const devSigner = ks.signer(dev.id, provider);
  const devNonce = await prov.getTransactionCount(dev.address, 'pending');

  // For an ERC-20 dev buy the forwarder pulls the pair token, so the dev signs
  // approve(forwarder, devBuy) at nonce n and the launch at n+1 — the same
  // consecutive-nonce, pre-signed shape the sell path uses. fireV2 broadcasts
  // the approve first; the sequencer runs a wallet's nonces in order, so the
  // allowance is always in place by the time the launch executes.
  let devApprove = null;
  let launchNonce = devNonce;
  if (nonNative && devBuy > 0n) {
    const forwarder = getAddress(predicted.wiring.forwarder);
    const approveTx = await new Contract(pair, APPROVE_ABI, prov).approve.populateTransaction(
      forwarder,
      devBuy
    );
    devApprove = {
      nonce: devNonce,
      spender: forwarder,
      raw: await devSigner.signTransaction(
        toSignable(approveTx, { nonce: devNonce, gasLimit: APPROVE_GAS, fees, chainId })
      ),
    };
    launchNonce = devNonce + 1;
  }

  const signedLaunch = {
    walletId: dev.id,
    address: dev.address,
    // The NATIVE value the launch tx carries — fee only for an ERC-20 launch.
    valueEth: formatEther(launchValue),
    // The dev buy in the quote asset's own units and label.
    devBuyEth: nonNative ? formatUnits(devBuy, pairDecimals) : formatEther(devBuy),
    nonce: launchNonce,
    atomic: devBuy > 0n,
    // Present only on the ERC-20 dev-buy path; its presence tells fireV2 to
    // broadcast it before the launch and to skip the fire-time re-estimate (which
    // would falsely revert on the not-yet-mined allowance).
    ...(devApprove ? { approve: devApprove, needsApprove: true } : {}),
    raw: await devSigner.signTransaction(
      toSignable(launchTx, { nonce: launchNonce, gasLimit: launchGas, fees, chainId })
    ),
  };

  // ── ETH-zap buys: sized here, NOT signed here ─────────────────────────────
  // This is the whole difference the mode makes, and it returns early so the
  // pre-signed native and pair paths below are reached ONLY when ethZap is false
  // — they are byte-for-byte what they always were.
  //
  // A zap buy cannot be pre-signed: the transaction that spends the ETH is the
  // pons swap-zap route, which bakes in the wallet as recipient and calls the
  // token's curve, and that route can only be fetched once the curve exists —
  // after the launch confirms. So prepareV2 sizes each wallet's ETH spend and
  // stops; fireV2 fetches the quote per wallet and signs it at fire time.
  if (ethZap) {
    const zapBuyGas = BigInt(config.zapBuyGasLimit);
    const zapBuyCost = gasCost(fees, zapBuyGas);
    const buffer = parseEther(String(config.gasBufferEth));
    const slippageBps = Number(input.slippageBps ?? config.zapSlippageBps);

    const buys = [];

    // A requested dev buy is NOT atomic in zap mode — it becomes another
    // post-launch zap buyer. The factory exempts the dev wallet itself, so its
    // taker=dev zap is untaxed without being declared in the exemption list. It
    // is sized from the dev's native balance AFTER the launch's own fee + gas.
    const devZapWei = parseEther(String(devBuyEth || 0));
    if (devZapWei > 0n) {
      const devNeededForZap =
        launchFee + gasCost(fees, launchGas) + devZapWei + zapBuyCost + buffer;
      if (devBalance >= devNeededForZap) {
        buys.push({
          walletId: dev.id,
          address: dev.address,
          amountEth: formatEther(devZapWei),
          amountIn: devZapWei.toString(),
          exempt: true,
          zap: true,
          isDev: true,
        });
      } else {
        warnings.push(
          `dev wallet ${dev.address}: ${formatEther(devBalance)} ETH does not cover the launch plus a ` +
            `${formatEther(devZapWei)} ETH post-launch dev zap (needs ${formatEther(devNeededForZap)} ETH) — dev zap skipped`
        );
      }
    }

    for (const w of wallets) {
      const wallet = known.get(w.walletId);
      const balance = await prov.getBalance(wallet.address);

      let amountIn;
      if (w.mode === 'all') {
        // Whole balance minus this buy's own gas and the buffer — the zap sends
        // ETH as value AND pays gas from the same balance, so both come out here.
        amountIn = spendableFromBalance(balance, zapBuyCost, zapBuyGas, buffer);
        if (amountIn === 0n) {
          warnings.push(
            `${wallet.address}: balance ${formatEther(balance)} ETH does not cover the zap gas + buffer — skipped`
          );
          continue;
        }
      } else {
        amountIn = parseEther(String(w.amountEth || 0));
        if (amountIn <= 0n) {
          warnings.push(`${wallet.address}: buy amount is zero — skipped`);
          continue;
        }
        // The requested buy plus this zap's own gas + buffer must fit the
        // balance. A zap buy reserves the heavy 900k-gas settle, so a fixed
        // amount sized before ETH-zap was chosen (against a plain buy's lighter
        // gas) can be a touch too large. Rather than drop the wallet from the
        // bundle, TRIM the buy to the most it can afford — the same clamp `all`
        // mode uses above — and only skip when nothing at all is affordable.
        const affordable = spendableFromBalance(balance, zapBuyCost, zapBuyGas, buffer);
        if (affordable === 0n) {
          warnings.push(
            `${wallet.address}: balance ${formatEther(balance)} ETH does not cover the zap gas + buffer — skipped`
          );
          continue;
        }
        if (amountIn > affordable) {
          warnings.push(
            `${wallet.address}: buy trimmed ${formatEther(amountIn)} → ${formatEther(affordable)} ETH ` +
              `to cover the zap gas + buffer`
          );
          amountIn = affordable;
        }
      }

      buys.push({
        walletId: wallet.id,
        address: wallet.address,
        amountEth: formatEther(amountIn),
        amountIn: amountIn.toString(),
        exempt: true,
        zap: true,
      });
    }

    // The honest health warnings the pre-signed path also raises.
    const funded = new Set(buys.filter((b) => !b.isDev).map((b) => b.address));
    const declaredButSkipped = exemptions.filter((a) => !funded.has(a));
    if (declaredButSkipped.length) {
      warnings.push(
        `${declaredButSkipped.length} wallet(s) are declared snipe-tax exempt but have no buy — harmless, but they will not be in the bundle`
      );
    }

    // The one thing the operator MUST understand about this mode, stated plainly:
    // zap buys are NOT atomic with the launch. They go out after the launch
    // confirms — a block or more later — so the "nothing gets in front of the
    // bundle" guarantee of the same-block pre-signed path does NOT hold. The
    // exemption still protects the PRICE (the bundle buys untaxed; a non-exempt
    // sniper in the gap pays the decaying opening tax), but it cannot stop a
    // sniper from buying ahead in that window.
    warnings.push(
      'ETH-zap mode: bundle buys are fetched and sent AFTER the launch confirms, not atomically inside ' +
        'it. The wallets buy untaxed (exemption preserved), but they are not guaranteed to be first — a ' +
        'non-exempt buyer in the gap between launch and buys pays the opening snipe tax, not you.'
    );

    const totalWei = buys.reduce((s, b) => s + BigInt(b.amountIn), 0n);

    return {
      variant: deps.variant || DEFAULT_VARIANT,
      protocol: 'v2',
      mode: 'ethZap',
      bundleFunding: 'ethZap',
      token,
      curve,
      predictedBy: 'salt',
      launchConfigId: Number(launchConfigId),
      pairToken: pair,
      pairSymbol,
      pairDecimals,
      launchFeeEth: formatEther(launchFee),
      params: fullParams,
      salt: fullParams.salt,
      dryRun: config.dryRun,
      canLaunch: gate.canLaunch,
      launchEnabled: gate.enabled,
      pairApproved: gate.approved,
      supply: launchConfig.supply,
      graduationThreshold:
        pairEconomics ? pairEconomics.graduationThreshold.toString() : launchConfig.graduationThreshold,
      curveFeeBps: launchConfig.curveFeeBps,
      creatorTaxBps: fullParams.creatorTaxBps,
      buybackEnabled: fullParams.buybackEnabled,
      snipeTax: {
        startBps: cfgs.snipeTaxStartBps,
        seconds: cfgs.snipeTaxSeconds,
        exemptions,
        max: exemptionLimit,
      },
      launch: signedLaunch,
      buys,
      // The buys are denominated in ETH — that is what the wallets spend. What
      // reaches the curve is in the pair token and is only known at fire time
      // from the zap rate, so the precise supply share is NOT precomputed. Left
      // null deliberately (a partial share object would be a lie, and the console
      // reads share.bundle.bps when share is present).
      share: null,
      slippageBps,
      // ETH the bundle spends in total (not what lands in the curve).
      totalBuyEth: formatEther(totalWei),
      dryRun: config.dryRun,
      fees: Object.fromEntries(
        Object.entries(fees).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
      ),
      // The zap buy's gas limit, baked so fireV2 signs each buy against the same
      // figure the sizing above reserved native ETH for.
      zapBuyGas: zapBuyGas.toString(),
      chainId: chainId.toString(),
      warnings,
    };
  }

  // ── the buys ──────────────────────────────────────────────────────────────
  // Signed here, against the predicted curve. Nothing is left to do at fire
  // time but broadcast.
  //
  // NATIVE vs ERC-20. A native buy is one transaction: curve.buy with the ETH
  // sent as value, sized from the wallet's native balance. An ERC-20 buy is two,
  // exactly like the sell path: approve(curve, amountIn) at nonce n and
  // curve.buy(amountIn,…) with value 0 at n+1, sized from the wallet's PAIR-TOKEN
  // balance — the pair token is not spent on gas, so its whole balance is
  // available, while native is only checked against the two transactions' gas.
  const buyGas = BigInt(config.buyGasLimit);
  const buyCost = gasCost(fees, buyGas);
  const approveCost = gasCost(fees, APPROVE_GAS);
  const buffer = parseEther(String(config.gasBufferEth));
  // Native ETH needed per wallet just to broadcast: one buy for native, an
  // approve plus a buy for ERC-20.
  const nativeGasNeeded = nonNative ? approveCost + buyCost : buyCost;

  const buys = [];
  for (const w of wallets) {
    const wallet = known.get(w.walletId);

    let amountIn;
    if (nonNative) {
      // The pair token pays for the buy; native only has to cover the two
      // transactions' gas. Both are checked, separately.
      const pairBalance = BigInt(await readTokenBalanceFn(pair, wallet.address));
      const nativeBalance = await prov.getBalance(wallet.address);
      if (nativeBalance < nativeGasNeeded + buffer) {
        warnings.push(
          `${wallet.address}: native balance ${formatEther(nativeBalance)} ETH does not cover the ` +
            `approve + buy gas (${formatEther(nativeGasNeeded)} ETH) + buffer — skipped`
        );
        continue;
      }
      if (w.mode === 'all') {
        amountIn = pairBalance; // no gas is taken out of the token balance
        if (amountIn <= 0n) {
          warnings.push(`${wallet.address}: holds no ${pairSymbol} to buy with — skipped`);
          continue;
        }
      } else {
        amountIn = parseUnits(String(w.amountEth || 0), pairDecimals);
        if (amountIn <= 0n) {
          warnings.push(`${wallet.address}: buy amount is zero — skipped`);
          continue;
        }
        if (pairBalance < amountIn) {
          warnings.push(
            `${wallet.address}: holds ${formatUnits(pairBalance, pairDecimals)} ${pairSymbol}, needs ` +
              `${formatUnits(amountIn, pairDecimals)} ${pairSymbol} — skipped`
          );
          continue;
        }
      }
    } else {
      const balance = await prov.getBalance(wallet.address);
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
    }

    const baseNonce = await prov.getTransactionCount(wallet.address, 'pending');
    const buyNonce = nonNative ? baseNonce + 1 : baseNonce;
    const buyTx = await buildBuyTx({
      curveAddress: curve,
      amountIn,
      minTokensOut: 0n,
      recipient: wallet.address,
      nativeQuote: pair === ZeroAddress,
    });
    const signer = ks.signer(wallet.id, provider);

    // The ERC-20 approve, signed at the base nonce, one below the buy. Native
    // wallets sign no approval — the buy carries its ETH as value.
    let approve = null;
    if (nonNative) {
      const approveTx = await new Contract(pair, APPROVE_ABI, prov).approve.populateTransaction(
        curve,
        amountIn
      );
      approve = {
        nonce: baseNonce,
        spender: curve,
        raw: await signer.signTransaction(
          toSignable(approveTx, { nonce: baseNonce, gasLimit: APPROVE_GAS, fees, chainId })
        ),
      };
    }

    buys.push({
      walletId: wallet.id,
      address: wallet.address,
      // In the quote asset's own units and label — pair token for ERC-20, ETH
      // for native.
      amountEth: nonNative ? formatUnits(amountIn, pairDecimals) : formatEther(amountIn),
      amountIn: amountIn.toString(),
      nonce: buyNonce,
      exempt: true,
      ...(approve ? { approve } : {}),
      raw: await signer.signTransaction(
        toSignable(buyTx, { nonce: buyNonce, gasLimit: buyGas, fees, chainId })
      ),
    });
  }

  // ── what this bundle actually takes ───────────────────────────────────────
  // The same module the console runs as the operator types, over the amounts
  // that were signed. On v2 this is not an estimate: the config fixes the
  // curve's phantom reserve and supply before the launch, so walking the buys
  // through it in order — dev buy first, since it is inside the launch
  // transaction — is what the curve will do.
  // For an ERC-20 pair the curve does NOT use the launch config's own
  // phantomQuote/graduationThreshold — those are the native ones. It uses the
  // pair token's economics, in the pair token's decimals, so the share must be
  // walked against those. Native is unchanged: it inherits the config's values.
  const shareLaunchConfig =
    nonNative && pairEconomics
      ? {
          ...launchConfig,
          phantomQuote: pairEconomics.phantomQuote.toString(),
          graduationThreshold: pairEconomics.graduationThreshold.toString(),
        }
      : launchConfig;
  const share = bundleShare({
    protocol: 'v2',
    launchConfig: shareLaunchConfig,
    creatorTaxBps: fullParams.creatorTaxBps,
    devBuyWei: devBuy,
    buys: buys.map((b) => ({ key: b.walletId, amountWei: b.amountIn })),
    pairDecimals,
    pairSymbol,
  });
  const legByWallet = new Map(share.buys.map((l) => [l.key, l]));
  for (const b of buys) {
    const leg = legByWallet.get(b.walletId);
    if (leg) {
      b.estTokens = leg.estTokens;
      b.estShareBps = Math.round(leg.estBps);
    }
  }

  // Graduating on the way IN is the one state a bundle cannot sell out of
  // through the curve, so it is a warning rather than a line in the plan.
  if (share.graduation && share.graduation.crosses) {
    warnings.push(
      `this bundle puts ${share.graduation.raisedEth} ${pairSymbol} into the curve, at or over the ` +
        `${share.graduation.thresholdEth} ${pairSymbol} graduation threshold — the curve graduates on the way ` +
        'in, and a graduated launch cannot be exited through the curve. Size down or expect to sell ' +
        'into the Uniswap v4 pool instead.'
    );
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
    // Which launcher built this — see the note in prepare.js.
    variant: deps.variant || DEFAULT_VARIANT,
    protocol: 'v2',
    mode: 'presigned',
    token,
    curve,
    predictedBy: 'salt',
    launchConfigId: Number(launchConfigId),
    pairToken: pair,
    // The quote asset descriptors, so the console can label amounts correctly.
    // Native leaves these at ETH/18 and the numbers below are byte-identical to
    // what a native launch has always produced.
    pairSymbol,
    pairDecimals,
    launchFeeEth: formatEther(launchFee),
    params: fullParams,
    salt: fullParams.salt,
    dryRun: config.dryRun,
    canLaunch: gate.canLaunch,
    launchEnabled: gate.enabled,
    pairApproved: gate.approved,
    supply: launchConfig.supply,
    // The threshold this launch actually graduates at, in the quote asset's
    // units: the pair token's economics for an ERC-20 pair, the config's own for
    // native ETH.
    graduationThreshold:
      nonNative && pairEconomics
        ? pairEconomics.graduationThreshold.toString()
        : launchConfig.graduationThreshold,
    curveFeeBps: launchConfig.curveFeeBps,
    creatorTaxBps: fullParams.creatorTaxBps,
    buybackEnabled: fullParams.buybackEnabled,
    snipeTax: {
      startBps: cfgs.snipeTaxStartBps,
      seconds: cfgs.snipeTaxSeconds,
      exemptions,
      // The cap that actually applies to THIS launch: the forwarder path (any
      // dev buy) allows one fewer than the factory, and reporting the factory's
      // 32 here would contradict the limit the plan was built against.
      max: exemptionLimit,
    },
    launch: signedLaunch,
    buys,
    // The bundle's total buy, in the quote asset's own units.
    totalBuyEth: (() => {
      const sum = buys.reduce((s, b) => s + BigInt(b.amountIn), 0n);
      return nonNative ? formatUnits(sum, pairDecimals) : formatEther(sum);
    })(),
    share,
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

module.exports = { prepareV2, toSignable, estimateLaunchGasOrThrow };
