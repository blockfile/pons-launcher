'use strict';

// The pons v2 launch factory.
//
// Rebuilt against the LIVE deployment (0x7eD598Bc…), which differs from the one
// the docs list in the two ways that decide how a bundle works:
//
//   1. Addresses are predictable. TokenParams carries a `salt`, and
//      PonsV2LaunchDeployer.predictLaunchAddresses returns the token and curve
//      that salt will produce. Every bundle buy can therefore be signed before
//      the launch is sent, exactly as on v1 — no helper contract, no waiting on
//      a receipt to learn where to buy.
//   2. Bundling is a declared parameter. launchToken takes up to 32 addresses
//      exempt from the opening snipe tax, applied atomically inside the launch.
//
// Prediction is cross-checked against a static call of the real launch before
// anything is signed. Two independent derivations of the curve address have to
// agree, because the cost of being wrong is every bundle wallet buying at an
// address with no contract — which on the EVM SUCCEEDS and silently keeps the
// money.

const { Contract, Interface, getAddress, ZeroAddress, hexlify, randomBytes } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { rpcMessage } = require('../errors');
const {
  FACTORY_V2_ABI,
  DEPLOYER_V2_ABI,
  FORWARDER_V2_ABI,
  MEME_HOOK_V2_ABI,
  V2_ERROR_ABI,
  MAX_SNIPE_TAX_EXEMPTIONS,
  MAX_EXEMPTIONS_VIA_FORWARDER,
} = require('./abi');
const { resolvePairTokens } = require('./pairTokens');

// One interface holding every v2 custom error, so a revert selector coming back
// from a failed launch is named rather than shown as raw bytes. The function
// ABIs carry no error definitions, so this is the only place the names live.
const V2_ERRORS = new Interface(V2_ERROR_ABI);

/**
 * Turn a reverted call/estimate into the contract's own words. The revert data
 * hides in a different place depending on the node and the ethers path, so this
 * digs it out of every known slot before decoding it against the v2 errors.
 * Falls back to the plain RPC message when there is no custom error to name.
 * @param {unknown} err
 * @returns {string}
 */
function explainRevert(err) {
  const data =
    err?.data ||
    err?.info?.error?.data ||
    err?.error?.data ||
    err?.revert?.data ||
    (typeof err?.value === 'string' && err.value.startsWith('0x') ? err.value : null);

  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = V2_ERRORS.parseError(data);
      if (parsed) {
        const args = parsed.args.length ? ` (${parsed.args.map(String).join(', ')})` : '';
        return `${parsed.name}${args}`;
      }
    } catch (_err) {
      // Not one of the v2 errors; fall through to the plain message.
    }
  }
  return rpcMessage(err);
}

function factory(runner = provider) {
  if (!config.v2FactoryAddress) throw new Error('PONS_V2_FACTORY is not set');
  return new Contract(config.v2FactoryAddress, FACTORY_V2_ABI, runner);
}

/** A fresh salt. Any value works; it only has to be one nobody has used. */
function newSalt() {
  return hexlify(randomBytes(32));
}

/**
 * A pair token's economics as the factory enforces them: the phantom quote
 * reserve and graduation threshold in the token's OWN decimals, and those
 * decimals. Native ETH has no entry here — it uses the LaunchConfig's values —
 * so this is only ever called for a non-native pair.
 *
 * The decimals returned are the authoritative ones: the launch reverts
 * PairTokenDecimalsMismatch if the token disagrees with them, so this is the
 * number every launch-sizing and share calculation must use, not the token's
 * own decimals() read.
 */
async function pairEconomics(pairToken) {
  const e = await factory().pairTokenEconomics(getAddress(pairToken));
  return {
    phantomQuote: e.phantomQuote,
    graduationThreshold: e.graduationThreshold,
    decimals: Number(e.decimals),
  };
}

/**
 * The pair tokens the factory currently accepts, native first. Thin wrapper over
 * the cached resolver so callers have one import point on the factory module.
 */
function getPairTokens(opts = {}) {
  return resolvePairTokens(opts);
}

/** Everything the console needs to render the v2 launch form. */
async function getConfigs() {
  const f = factory();
  const [count, launchFee, launchEnabled, maxCreatorTaxBps, snipeTaxStartBps, snipeTaxSeconds] =
    await Promise.all([
      f.launchConfigCount(),
      f.launchFee(),
      f.launchEnabled(),
      f.maxCreatorTaxBps(),
      f.snipeTaxStartBps(),
      f.snipeTaxSeconds(),
    ]);

  const launchConfigs = [];
  for (let id = 0; id < Number(count); id++) {
    const c = await f.getLaunchConfig(id);
    launchConfigs.push({
      id,
      supply: c.supply.toString(),
      curveFeeBps: Number(c.curveFeeBps),
      phantomQuote: c.phantomQuote.toString(),
      graduationThreshold: c.graduationThreshold.toString(),
      poolFee: Number(c.poolFee),
      tickSpacing: Number(c.tickSpacing),
      enabled: c.enabled,
    });
  }

  return {
    factory: config.v2FactoryAddress,
    launchFee: launchFee.toString(),
    launchEnabled,
    maxCreatorTaxBps: Number(maxCreatorTaxBps),
    snipeTaxStartBps: Number(snipeTaxStartBps),
    snipeTaxSeconds: Number(snipeTaxSeconds),
    // Both, because they differ and the console shows one to the operator.
    // launchAndBuy appends its own buy recipient, so a bundle sent with a dev
    // buy gets one fewer than the factory's limit — reporting only 32 would
    // have the console invite a launch that reverts.
    maxExemptions: MAX_SNIPE_TAX_EXEMPTIONS,
    maxExemptionsWithDevBuy: MAX_EXEMPTIONS_VIA_FORWARDER,
    launchConfigs,
  };
}

/**
 * Why a launch would be refused, before spending the fee on finding out.
 *
 * canLaunch() is the gate the factory itself uses. Reading whitelistedLaunchers
 * instead reports "false" for a wallet that can launch perfectly well — that
 * mapping is only one input to canLaunch, and taking it for the answer is what
 * made this project believe v2 was closed while thousands of launches went
 * through it.
 */
async function preflightGate({ launcher, pairToken = ZeroAddress }) {
  const f = factory();
  const problems = [];
  const pair = getAddress(pairToken);

  const [canLaunch, enabled, approved] = await Promise.all([
    f.canLaunch(getAddress(launcher)),
    f.launchEnabled(),
    pair === ZeroAddress ? Promise.resolve(true) : f.approvedPairTokens(pair),
  ]);

  if (!canLaunch) {
    problems.push(`the factory will not let ${launcher} launch — canLaunch() is false`);
  }
  // Native ETH is never checked against approvedPairTokens: the factory skips
  // that branch entirely for address(0).
  if (!approved) {
    problems.push(`pair token ${pair} is not approved by the factory`);
  }
  return { canLaunch, enabled, approved, problems };
}

/** Contracts the launch path depends on, all read from the factory itself. */
async function wiring() {
  const f = factory();
  const [deployer, forwarder, feeEscrow, buybackVault, memeHook] = await Promise.all([
    f.launchDeployer(),
    f.launchForwarder(),
    f.feeEscrow(),
    f.buybackVault(),
    f.memeHook(),
  ]);
  return {
    deployer: getAddress(deployer),
    forwarder: getAddress(forwarder),
    feeEscrow: getAddress(feeEscrow),
    buybackVault: getAddress(buybackVault),
    memeHook: getAddress(memeHook),
  };
}

/**
 * Rebuild the LaunchDeployment struct the factory would construct, and ask the
 * deployer what addresses it produces.
 *
 * This mirrors _launchToken() field for field. Anything that drifts from the
 * factory's own construction changes the predicted address, so the caller must
 * treat the answer as a claim to be checked — see verifyPrediction below.
 */
async function predictAddresses({ params, launchConfigId, pairToken = ZeroAddress, deployer: launcher }) {
  const f = factory();
  const w = await wiring();
  const pair = getAddress(pairToken);

  const [config_, policy] = await Promise.all([
    f.getLaunchConfig(launchConfigId),
    new Contract(w.memeHook, MEME_HOOK_V2_ABI, provider).currentFeePolicy(),
  ]);

  // A custom quote asset supplies its own phantom reserve and threshold in its
  // own decimals; native inherits the config's wei-denominated pair.
  const [phantomQuote, graduationThreshold] =
    pair === ZeroAddress
      ? [config_.phantomQuote, config_.graduationThreshold]
      : await f.pairTokenEconomics(pair).then((e) => [e.phantomQuote, e.graduationThreshold]);

  // The factory substitutes the launcher when the creator fee recipient is left
  // at zero, and the substituted value is what reaches the deployer.
  const creatorFeeRecipient =
    params.creatorFeeRecipient === ZeroAddress || !params.creatorFeeRecipient
      ? getAddress(launcher)
      : getAddress(params.creatorFeeRecipient);

  const deployment = {
    pairToken: pair,
    creatorFeeRecipient,
    originalDeployer: getAddress(launcher),
    feePolicy: w.memeHook,
    policy: [
      policy.protocolFeeRecipient,
      policy.protocolFeeShareBps,
      policy.buybackBurnBps,
      policy.hookFeeBps,
      policy.maxInternalPriceImpactBps,
    ],
    feeEscrow: w.feeEscrow,
    buybackVault: w.buybackVault,
    phantomQuote,
    curveFeeBps: config_.curveFeeBps,
    creatorTaxBps: params.creatorTaxBps,
    buybackEnabled: params.buybackEnabled,
    graduationThreshold,
    supply: config_.supply,
    salt: params.salt,
    name: params.name,
    symbol: params.symbol,
    logo: params.logo,
    description: params.description,
    socials: [
      params.socials.twitter,
      params.socials.telegram,
      params.socials.discord,
      params.socials.website,
      params.socials.farcaster,
    ],
  };

  const d = new Contract(w.deployer, DEPLOYER_V2_ABI, provider);
  const [token, curve] = await d.predictLaunchAddresses(deployment);
  return { token: getAddress(token), curve: getAddress(curve), wiring: w };
}

/**
 * Run the real launch as a static call and return the addresses it WOULD
 * produce. Costs nothing, touches nothing, and is derived by the factory rather
 * than by our reconstruction of it — so agreeing with predictAddresses is
 * meaningful evidence rather than the same guess made twice.
 */
async function simulateLaunch({ from, params, launchConfigId, pairToken = ZeroAddress, exemptions = [], value }) {
  const f = factory();
  const tx = await f.launchToken.populateTransaction(
    params,
    launchConfigId,
    getAddress(pairToken),
    exemptions.map((a) => getAddress(a)),
    { value }
  );
  const raw = await provider.call({ ...tx, from: getAddress(from) });
  const [token, curve] = f.interface.decodeFunctionResult(
    'launchToken(tuple(string,string,string,string,tuple(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])',
    raw
  );
  return { token: getAddress(token), curve: getAddress(curve) };
}

/**
 * Unsigned launch, with the bundle wallets declared exempt from the snipe tax.
 * `value` is the launch fee exactly — the factory reverts LaunchFeeNotPaid on
 * anything else, so the dev's own buy cannot ride along here. Use
 * buildLaunchAndBuyTx for that.
 */
async function buildLaunchTx({ params, launchConfigId, pairToken = ZeroAddress, exemptions = [], value }) {
  assertExemptions(exemptions);
  return factory().launchToken.populateTransaction(
    params,
    launchConfigId,
    getAddress(pairToken),
    exemptions.map((a) => getAddress(a)),
    { value }
  );
}

/**
 * Unsigned atomic launch + opening buy through the forwarder — the v2 shape of
 * v1's uncapped dev buy. The dev's tokens are bought inside the launch
 * transaction, so nothing can be in front of them, and the exemption list is
 * applied in the same call.
 *
 * `value` must be launchFee + quoteIn.
 */
async function buildLaunchAndBuyTx({
  params,
  launchConfigId,
  pairToken = ZeroAddress,
  quoteIn,
  minTokensOut = 0n,
  recipient,
  exemptions = [],
  value,
  forwarderAddress,
}) {
  assertExemptions(exemptions, true);
  const address = forwarderAddress || (await wiring()).forwarder;
  const fwd = new Contract(address, FORWARDER_V2_ABI, provider);
  return fwd.launchAndBuy.populateTransaction(
    params,
    launchConfigId,
    getAddress(pairToken),
    quoteIn,
    minTokensOut,
    getAddress(recipient),
    exemptions.map((a) => getAddress(a)),
    { value }
  );
}

/**
 * @param {boolean} viaForwarder launchAndBuy appends the buy recipient itself,
 *   so the caller's share of the list is one shorter than the factory's limit.
 */
function assertExemptions(exemptions, viaForwarder = false) {
  const limit = viaForwarder ? MAX_EXEMPTIONS_VIA_FORWARDER : MAX_SNIPE_TAX_EXEMPTIONS;
  if (exemptions.length > limit) {
    throw new Error(
      `${exemptions.length} exemptions requested but ${
        viaForwarder ? 'launchAndBuy allows' : 'the factory allows'
      } ${limit}${
        viaForwarder
          ? ' — it appends the buy recipient itself, so its limit is one below the factory limit'
          : ''
      } — the launch would revert ExemptionListTooLong`
    );
  }
}

/**
 * Pull the token and curve out of a mined launch. Still used, but now only to
 * confirm the prediction the bundle was already signed against.
 * @returns {{token: string, curve: string, pairToken: string}|null}
 */
function parseLaunch(receipt) {
  const iface = factory().interface;
  for (const log of receipt.logs || []) {
    if (log.address.toLowerCase() !== config.v2FactoryAddress.toLowerCase()) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch (_err) {
      continue; // some other event from the same contract
    }
    if (parsed && parsed.name === 'TokenLaunched') {
      return {
        token: getAddress(parsed.args.token),
        curve: getAddress(parsed.args.curve),
        pairToken: getAddress(parsed.args.pairToken),
        launchConfigId: Number(parsed.args.launchConfigId),
        graduationThreshold: parsed.args.graduationThreshold.toString(),
      };
    }
  }
  return null;
}

module.exports = {
  factory,
  newSalt,
  getConfigs,
  preflightGate,
  wiring,
  predictAddresses,
  pairEconomics,
  getPairTokens,
  simulateLaunch,
  buildLaunchTx,
  buildLaunchAndBuyTx,
  parseLaunch,
  explainRevert,
  MAX_SNIPE_TAX_EXEMPTIONS,
};
