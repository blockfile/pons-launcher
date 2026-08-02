'use strict';

// Watches the pons v2 factory for the moment launching actually opens.
//
// Today every launchToken call reverts NotWhitelisted(): launchEnabled is
// false, no pair token is approved, and no audit has closed. Any of those can
// flip without an announcement — people are already burning failed transactions
// trying. This prints a line only when something CHANGES, so it can be left in
// a cron job or a pm2 process without producing noise.
//
//   node scripts/v2-watch.js              check once, print the state, exit
//   node scripts/v2-watch.js --loop 60    check every 60s, print only changes

const { Contract, formatEther, getAddress } = require('ethers');
const config = require('../src/config');
const { provider } = require('../src/evm/provider');
const { FACTORY_V2_ABI } = require('../src/evm/v2/abi');

const PAIR_CANDIDATES = {
  'native ETH': '0x0000000000000000000000000000000000000000',
  'v1 WETH': '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};

async function snapshot(devAddress) {
  const f = new Contract(config.v2FactoryAddress, FACTORY_V2_ABI, provider);
  const [enabled, fee, maxTax, configs] = await Promise.all([
    f.launchEnabled(),
    f.launchFee(),
    f.maxCreatorTaxBps(),
    f.launchConfigCount(),
  ]);

  const pairs = {};
  for (const [label, addr] of Object.entries(PAIR_CANDIDATES)) {
    pairs[label] = await f.approvedPairTokens(addr);
  }

  const whitelisted = devAddress ? await f.whitelistedLaunchers(getAddress(devAddress)) : null;

  return {
    launchEnabled: enabled,
    launchFeeEth: formatEther(fee),
    maxCreatorTaxBps: Number(maxTax),
    launchConfigCount: Number(configs),
    pairs,
    whitelisted,
    // The single question that matters: could we launch right now?
    open: (enabled || whitelisted === true) && Object.values(pairs).some(Boolean),
  };
}

function describe(s) {
  return [
    `launchEnabled=${s.launchEnabled}`,
    `whitelisted=${s.whitelisted}`,
    `pairs=${Object.entries(s.pairs).map(([k, v]) => `${k}:${v}`).join(' ')}`,
    `configs=${s.launchConfigCount}`,
    `fee=${s.launchFeeEth}`,
    `maxTax=${s.maxCreatorTaxBps}bps`,
  ].join('  ');
}

(async () => {
  const loopArg = process.argv.indexOf('--loop');
  const everyMs = loopArg > -1 ? Number(process.argv[loopArg + 1] || 60) * 1000 : 0;

  let dev = null;
  try {
    dev = require('../src/wallets/keystore').devWallet().address;
  } catch (_err) {
    // No keystore or no dev wallet — the whitelist check is simply skipped.
  }

  let previous = null;
  for (;;) {
    let now;
    try {
      now = await snapshot(dev);
    } catch (err) {
      console.error(`[v2-watch] ${new Date().toISOString()} read failed: ${err.shortMessage || err.message}`);
      if (!everyMs) process.exit(1);
      await new Promise((r) => setTimeout(r, everyMs));
      continue;
    }

    const line = describe(now);
    if (!previous) {
      console.log(`[v2-watch] ${new Date().toISOString()} ${line}`);
      if (now.open) console.log('[v2-watch] *** v2 IS OPEN — you can launch ***');
    } else if (line !== previous) {
      console.log(`[v2-watch] ${new Date().toISOString()} CHANGED`);
      console.log(`           was: ${previous}`);
      console.log(`           now: ${line}`);
      if (now.open) console.log('[v2-watch] *** v2 IS OPEN — you can launch ***');
    }
    previous = line;

    // "Closed" is a successful answer, not a failure — exiting non-zero for it
    // made npm report a working check as an error. Only a failed READ is an
    // error; grep the OPEN/CLOSED line to act on the result.
    if (!everyMs) {
      console.log(`[v2-watch] ${now.open ? 'OPEN' : 'CLOSED'}`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
})();
