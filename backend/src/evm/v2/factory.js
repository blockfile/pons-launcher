'use strict';

// The pons v2 launch factory.
//
// Two things differ from v1 in ways that shape the whole bundle:
//
//   1. No dev buy. msg.value is the launch fee, full stop. The creator gets no
//      allocation, so the only way to hold your own token is to buy it off the
//      curve like anyone else.
//   2. No address prediction. v1's predictTokenAddress made the token address
//      knowable in advance, which is what let every buy be signed before the
//      launch existed. v2 deploys with plain CREATE, so the address depends on
//      the deployer's nonce — which moves whenever anyone else launches. Buys
//      therefore cannot be safely pre-signed: a stale prediction would point at
//      a stranger's curve and spend real money on their token.

const { Contract, getAddress } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { FACTORY_V2_ABI } = require('./abi');

function factory(runner = provider) {
  if (!config.v2FactoryAddress) throw new Error('PONS_V2_FACTORY is not set');
  return new Contract(config.v2FactoryAddress, FACTORY_V2_ABI, runner);
}

/** Everything the console needs to render the v2 launch form. */
async function getConfigs() {
  const f = factory();
  const [count, launchFee, launchEnabled, maxCreatorTaxBps] = await Promise.all([
    f.launchConfigCount(),
    f.launchFee(),
    f.launchEnabled(),
    f.maxCreatorTaxBps(),
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
    launchConfigs,
  };
}

/**
 * Why a launch would be refused, before spending the fee on finding out.
 *
 * Worth doing: at the time of writing every launchToken call on chain reverts,
 * and each attempt still costs the caller the 0.0005 fee in gas terms plus the
 * failed transaction. Reading three view functions is free.
 */
async function preflightGate({ launcher, pairToken }) {
  const f = factory();
  const problems = [];

  const [enabled, whitelisted, approved] = await Promise.all([
    f.launchEnabled(),
    f.whitelistedLaunchers(getAddress(launcher)),
    f.approvedPairTokens(getAddress(pairToken)),
  ]);

  if (!enabled && !whitelisted) {
    problems.push(
      `launching is disabled and ${launcher} is not whitelisted — the factory will revert NotWhitelisted`
    );
  }
  if (!approved) {
    problems.push(`pair token ${pairToken} is not approved by the factory`);
  }
  return { enabled, whitelisted, approved, problems };
}

/**
 * The economics commitment the factory demands in TokenParams. It pins the
 * config's numbers at the moment you build the transaction, so a config update
 * between building and mining reverts the launch instead of silently changing
 * the terms of it.
 */
async function previewEconomics({ launchConfigId, pairToken }) {
  return factory().previewLaunchEconomics(launchConfigId, getAddress(pairToken));
}

/** Unsigned launch transaction. `value` is the launch fee — there is no dev buy. */
async function buildLaunchTx({ params, launchConfigId, pairToken, value }) {
  return factory().launchToken.populateTransaction(
    params,
    launchConfigId,
    getAddress(pairToken),
    { value }
  );
}

/**
 * Pull the token and curve out of a mined launch. This is the only reliable way
 * to learn the curve address — hence the bundle being reactive rather than
 * pre-signed.
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
  getConfigs,
  preflightGate,
  previewEconomics,
  buildLaunchTx,
  parseLaunch,
};
