'use strict';

// Prints the factory's approved quote assets, in the format SEED_CANDIDATES wants.
//
// WHY THIS EXISTS. The factory has no enumeration function, so the full list is
// discovered from PairTokenApprovalUpdated logs with a WHOLE-CHAIN getLogs. That
// works on a node limited by matched count (the default Robinhood RPC) and fails
// on one limited by RANGE — QuickNode refuses any span over 10k blocks. When the
// launcher moved to QuickNode, discovery returned nothing and the picker offered
// the 7 seeded pairs out of 56, with AMD approved, priced and simply invisible.
//
// So the seed is now the primary source rather than the floor, and a seed has to
// be maintained. This is the maintenance tool: run it against an endpoint that
// still allows the whole-chain query, paste the output into SEED_CANDIDATES.
//
//   npm run pairs                          # against RPC_URL
//   RPC_URL=https://rpc.mainnet.chain.robinhood.com npm run pairs
//   npm run pairs -- --check               # exit 1 if the chain has pairs the seed lacks,
//                                          # exit 2 if THIS endpoint cannot tell
//
// --check is the one to put in front of a launch: it answers "is my picker
// showing everything the factory would accept" without changing anything.
//
// Read-only. It sends no transaction and signs nothing.

const { getAddress, Interface } = require('ethers');
const config = require('../src/config');
const { provider } = require('../src/evm/provider');
const { FACTORY_V2_ABI } = require('../src/evm/v2/abi');
const { resolvePairTokens, SEED_CANDIDATES } = require('../src/evm/v2/pairTokens');

const factoryIface = new Interface(FACTORY_V2_ABI);

const CHECK = process.argv.includes('--check');

(async () => {
  console.log('');
  console.log(`pons-launcher — approved pair tokens, read from ${config.rpcUrl}`);
  console.log('');

  const list = await resolvePairTokens({ refresh: true });
  const pairs = list.filter((t) => !t.native).sort((a, b) => a.symbol.localeCompare(b.symbol));

  const seeded = new Set(SEED_CANDIDATES.map((a) => getAddress(a).toLowerCase()));
  const missing = pairs.filter((t) => !seeded.has(getAddress(t.address).toLowerCase()));

  // CAN THIS ENDPOINT DISCOVER AT ALL? Asked directly, not inferred from the
  // count, and that distinction is the whole value of this script now.
  //
  // The seed carries all 56, so a range-limited node RESOLVES all 56 -- by
  // confirming the seed, not by finding anything. The comparison below would
  // then agree with itself and print OK forever, including on the day a 57th
  // pair is approved. Counting is no help either: a complete seed produces a
  // complete-looking answer. The only honest question is whether the
  // whole-chain getLogs works HERE, so it is run.
  let discovers = false;
  let logsError = '';
  try {
    const topics = factoryIface.encodeFilterTopics('PairTokenApprovalUpdated', []);
    const logs = await provider.getLogs({
      address: config.v2FactoryAddress,
      topics,
      fromBlock: 0,
      toBlock: 'latest',
    });
    discovers = logs.length > 0;
    if (!discovers) logsError = 'the query succeeded but returned no approval events';
  } catch (err) {
    logsError = err.shortMessage || err.message;
  }

  if (CHECK) {
    console.log(`  chain: ${pairs.length} approved · seed: ${SEED_CANDIDATES.length} entries`);
    console.log(
      discovers
        ? '  discovery: WORKS here — this endpoint can find pairs the seed does not carry.'
        : `  discovery: BLIND here — ${logsError}.`
    );

    if (!discovers) {
      // Refusing to answer is the point. A green tick from an endpoint that
      // cannot look is worse than no tick: it is the seed agreeing with itself,
      // and it is exactly what hid AMD.
      console.log('');
      console.log('  CANNOT VERIFY FROM THIS ENDPOINT. Everything below the seed is invisible to');
      console.log('  it, so "every approved pair is in the seed" would only mean "the seed');
      console.log('  matches the seed". Re-run against a matched-count-limited node:');
      console.log('    RPC_URL=https://rpc.mainnet.chain.robinhood.com npm run pairs -- --check');
      console.log('');
      process.exit(2);
    }

    if (!missing.length) {
      console.log('  OK — every approved pair is in the seed.');
      process.exit(0);
    }
    console.log(`  ${missing.length} approved pair(s) are NOT in the seed:`);
    for (const t of missing) console.log(`    ${t.symbol.padEnd(6)} ${t.address}`);
    console.log('');
    console.log('  A range-limited node will not show these in the picker. Add them to');
    console.log('  SEED_CANDIDATES in src/evm/v2/pairTokens.js — run without --check for the');
    console.log('  paste-ready list.');
    process.exit(1);
  }

  for (const t of pairs) {
    const dec = Number(t.decimals) === 18 ? '' : `  (${t.decimals} decimals)`;
    console.log(`  '${getAddress(t.address)}', // ${t.symbol}${dec}`);
  }
  console.log('');
  console.log(`  ${pairs.length} approved · ${missing.length} not yet in SEED_CANDIDATES`);
  console.log('');
  process.exit(0);
})().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
