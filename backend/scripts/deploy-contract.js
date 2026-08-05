'use strict';

// Deploy the contracts in contracts/.
//
// The console's disperser panel does the same job for Disperse; this stays for
// scripted setup and for the case where the API is down. Both go through
// src/evm/deploy.js, so there is one definition of what gets deployed and on
// what compiler settings.
//
// Nothing is broadcast without --broadcast. The default run compiles, prices
// the deployment and stops, because the failure mode of a deploy script that
// broadcasts by default is paying for contracts you did not mean to create.

const { Wallet, formatEther } = require('ethers');

const config = require('../src/config');
const { provider } = require('../src/evm/provider');
const { compile, estimate, deploy } = require('../src/evm/deploy');
const { rpcMessage } = require('../src/evm/errors');
const { dispersersFor } = require('../src/store/dispersers');
const keystore = require('../src/wallets/keystore');
const users = require('../src/users/users');

function usage() {
  console.log(`
usage:
  node scripts/deploy-contract.js <Name> [count] [--broadcast] [--user <name>]

  <Name>       contract file in contracts/, without .sol — e.g. Disperse
  [count]      how many copies to deploy (default 1)
  --broadcast  actually send. Without it, this compiles and prices only
  --key        deploy from this private key instead of the keystore dev wallet
  --user       pay from this user's dev wallet, if user:add has been run
  --args       constructor arguments, comma-separated

examples:
  node scripts/deploy-contract.js Disperse 3
  node scripts/deploy-contract.js Disperse 3 --broadcast
`);
}

/** Constructor arguments, from --args. */
function constructorArgs(name, abi, raw) {
  const inputs = abi.find((f) => f.type === 'constructor')?.inputs ?? [];
  if (!inputs.length) return [];

  if (raw) {
    const given = raw.split(',').map((a) => a.trim());
    if (given.length !== inputs.length) {
      throw new Error(`${name} takes ${inputs.length} constructor argument(s), got ${given.length}`);
    }
    return given;
  }

  throw new Error(
    `${name} needs ${inputs.length} constructor argument(s) — pass --args ${inputs.map((i) => i.name || i.type).join(',')}`
  );
}

/**
 * The dev wallet that pays for the deployment, decrypted with
 * KEYSTORE_PASSPHRASE.
 *
 * Without --user this is the 'default' keystore. On a deployment where
 * `user:add --adopt` has run, that file no longer exists — the wallets were
 * renamed under the user who adopted them — so say which user to pass rather
 * than reporting a missing dev wallet on a machine that plainly has one.
 */
function devSigner(userId) {
  const ks = userId ? keystore.keystoreFor(userId) : keystore;
  try {
    return ks.signer(ks.devWallet().id, provider);
  } catch (err) {
    // Only for a missing dev wallet. A wrong passphrase fails here too, and
    // "pass --user" would send you looking in entirely the wrong place.
    if (!/no dev wallet/.test(err.message)) throw err;

    const names = users.enabled() ? users.list().map((u) => u.id) : [];
    if (!userId && names.length) {
      throw new Error(`${err.message}\nthese wallets belong to a user — pass --user ${names.join(' | ')}`);
    }
    throw err;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!name) return usage();

  const count = Number(argv.find((a) => /^\d+$/.test(a)) || 1);
  const broadcast = argv.includes('--broadcast');
  const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const rawKey = flag('--key') ?? process.env.DEPLOYER_PRIVATE_KEY;
  const userId = flag('--user');

  if (!Number.isInteger(count) || count < 1) throw new Error(`count must be a positive integer, got ${count}`);

  const { abi, version, warnings } = compile(name);
  for (const w of warnings) console.warn(w);
  console.log(`${name}.sol compiled with ${version}, optimizer 200 runs`);

  const args = constructorArgs(name, abi, flag('--args'));
  if (args.length) console.log(`args      ${args.join(', ')}`);

  const signer = rawKey ? new Wallet(rawKey.trim(), provider) : devSigner(userId);
  const { from, balance, gas, each, total } = await estimate(name, count, signer, args);

  console.log(`\ndeployer  ${from}`);
  console.log(`balance   ${formatEther(balance)} ETH`);
  console.log(`gas       ${gas} each`);
  console.log(`cost      ${formatEther(each)} ETH each, ${formatEther(total)} ETH for ${count}`);

  if (!broadcast) {
    console.log(`\nnothing broadcast. Re-run with --broadcast to deploy ${count}.`);
    return;
  }

  const show = (d, i) => {
    console.log(`\n${i}/${count}  ${d.address}`);
    console.log(`       ${config.explorerUrl}/address/${d.address}`);
    console.log(`       gas used ${d.gasUsed}`);
  };

  let seen = 0;
  let deployed;
  try {
    deployed = await deploy(name, count, signer, { args, onDeployed: (d) => show(d, ++seen) });
  } catch (err) {
    if (err.deployed?.length) {
      console.error(`\n${err.deployed.length} of ${count} deployed before this failed.`);
      if (name === 'Disperse') recordDispersers(err.deployed, userId);
      console.error(`re-run with ${count - err.deployed.length} to deploy the rest.`);
    }
    throw err;
  }

  if (name === 'Disperse') {
    recordDispersers(deployed, userId);
    console.log('\nrecorded — funding runs use these on the next request, no restart needed.');
  }

  console.log(
    `to verify on the explorer: solc ${version}, optimizer enabled, 200 runs, ` +
      (args.length ? `constructor args ${args.join(', ')}` : 'no constructor args')
  );
}

/**
 * Dispersers go in the user's list, not .env — the same place the console
 * writes them, so the two do not drift apart.
 */
function recordDispersers(deployed, userId) {
  const store = dispersersFor(userId || 'default');
  const all = store.add(deployed);
  console.log(`\nnow funding through ${all.length}:`);
  for (const d of all) console.log(`  ${d.address}`);
}

main().catch((err) => {
  console.error(`\nfailed: ${rpcMessage(err)}`);
  process.exit(1);
});
