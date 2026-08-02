'use strict';

// Deploy the contracts in contracts/ — Disperse and PonsV2BundleHelper.
//
// A shell job rather than a route: deploying is a one-off, it spends the dev
// wallet's ETH, and nothing in the app should be able to trigger it over HTTP.
//
// Nothing is broadcast without --broadcast. The default run compiles, prices
// the deployment and stops, because the failure mode of a deploy script that
// broadcasts by default is paying for contracts you did not mean to create.

const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { Wallet, formatEther, ContractFactory } = require('ethers');

const config = require('../src/config');
const { provider } = require('../src/evm/provider');
const { getFees, gasCost } = require('../src/evm/fees');
const { waitForReceipt } = require('../src/evm/receipt');
const { rpcMessage } = require('../src/evm/errors');
const keystore = require('../src/wallets/keystore');

const CONTRACTS_DIR = path.join(__dirname, '..', '..', 'contracts');

// Pinned so the bytecode is reproducible: the explorer's verifier needs the
// exact same settings, and "optimizer was on with 200 runs" is the answer it
// will ask for.
const OPTIMIZER = { enabled: true, runs: 200 };

function usage() {
  console.log(`
usage:
  node scripts/deploy-contract.js <Name> [count] [--broadcast] [--key 0x…]

  <Name>       contract file in contracts/, without .sol — e.g. Disperse
  [count]      how many copies to deploy (default 1)
  --broadcast  actually send. Without it, this compiles and prices only
  --key        deploy from this private key instead of the keystore dev wallet
  --args       constructor arguments, comma-separated

examples:
  node scripts/deploy-contract.js Disperse 3
  node scripts/deploy-contract.js Disperse 3 --broadcast
  node scripts/deploy-contract.js PonsV2BundleHelper --broadcast
`);
}

function compile(name) {
  const file = `${name}.sol`;
  const source = fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf8');

  const input = {
    language: 'Solidity',
    sources: { [file]: { content: source } },
    settings: {
      optimizer: OPTIMIZER,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  for (const w of out.errors || []) console.warn(w.formattedMessage.trim());

  const artifact = out.contracts?.[file]?.[name];
  if (!artifact) throw new Error(`${file} compiled, but contains no contract named ${name}`);

  return {
    abi: artifact.abi,
    bytecode: '0x' + artifact.evm.bytecode.object,
    version: solc.version(),
  };
}

/**
 * Constructor arguments, from --args or from what the app already knows.
 *
 * PonsV2BundleHelper takes the v2 factory, and the config holds the verified
 * address the rest of the app talks to. Defaulting to it means the helper
 * cannot be deployed pointing at a different factory by accident — which would
 * arm launches the bundle then could not buy from.
 */
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

  if (name === 'PonsV2BundleHelper') return [config.v2FactoryAddress];
  throw new Error(
    `${name} needs ${inputs.length} constructor argument(s) — pass --args ${inputs.map((i) => i.name || i.type).join(',')}`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!name) return usage();

  const count = Number(argv.find((a) => /^\d+$/.test(a)) || 1);
  const broadcast = argv.includes('--broadcast');
  const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const rawKey = flag('--key') ?? process.env.DEPLOYER_PRIVATE_KEY;

  if (!Number.isInteger(count) || count < 1) throw new Error(`count must be a positive integer, got ${count}`);

  const { abi, bytecode, version } = compile(name);
  console.log(`${name}.sol compiled with ${version}, optimizer ${OPTIMIZER.runs} runs`);
  console.log(`bytecode ${(bytecode.length - 2) / 2} bytes`);

  const args = constructorArgs(name, abi, flag('--args'));
  if (args.length) console.log(`args      ${args.join(', ')}`);

  const deployer = rawKey
    ? new Wallet(rawKey.trim(), provider)
    : keystore.signer(keystore.devWallet().id, provider);
  const from = await deployer.getAddress();

  const factory = new ContractFactory(abi, bytecode, deployer);
  const deployTx = await factory.getDeployTransaction(...args);
  const gas = await provider.estimateGas({ from, data: deployTx.data });
  const fees = await getFees(25);
  const each = gasCost(fees, gas);

  console.log(`\ndeployer  ${from}`);
  console.log(`balance   ${formatEther(await provider.getBalance(from))} ETH`);
  console.log(`gas       ${gas} each`);
  console.log(`cost      ${formatEther(each)} ETH each, ${formatEther(each * BigInt(count))} ETH for ${count}`);

  if (!broadcast) {
    console.log(`\nnothing broadcast. Re-run with --broadcast to deploy ${count}.`);
    return;
  }

  const balance = await provider.getBalance(from);
  if (balance < each * BigInt(count)) {
    throw new Error(`deployer has ${formatEther(balance)} ETH but needs ${formatEther(each * BigInt(count))}`);
  }

  // Sequential, not concurrent. Each deployment's address depends on the
  // deployer's nonce, so a reordering would still be safe — but a failure
  // halfway through a concurrent batch leaves a nonce gap that stalls every
  // later transaction from this wallet until it is filled.
  const deployed = [];
  for (let i = 0; i < count; i++) {
    const tx = await deployer.sendTransaction({ ...deployTx, gasLimit: (gas * 12n) / 10n, ...fees });
    const receipt = await waitForReceipt(provider, tx.hash, { timeoutMs: 120_000 });

    if (!receipt || receipt.status !== 1) throw new Error(`deployment ${i + 1} reverted (${tx.hash})`);
    if (!receipt.contractAddress) throw new Error(`deployment ${i + 1} mined without a contract address`);

    // A receipt is not proof there is code at the address — confirm it, or a
    // silently empty deployment would be written straight into the config.
    const code = await provider.getCode(receipt.contractAddress);
    if (code === '0x') throw new Error(`nothing deployed at ${receipt.contractAddress}`);

    deployed.push(receipt.contractAddress);
    console.log(`\n${i + 1}/${count}  ${receipt.contractAddress}`);
    console.log(`       ${config.explorerUrl}/address/${receipt.contractAddress}`);
    console.log(`       gas used ${receipt.gasUsed}`);
  }

  const envVar = name === 'Disperse' ? 'DISPERSER_ADDRESSES' : 'PONS_V2_HELPER';
  console.log(`\nadd to backend/.env:\n\n${envVar}=${deployed.join(',')}\n`);
  console.log(
    `to verify on the explorer: solc ${version}, optimizer enabled, ${OPTIMIZER.runs} runs, ` +
      (args.length ? `constructor args ${args.join(', ')}` : 'no constructor args')
  );
}

main().catch((err) => {
  console.error(`\nfailed: ${rpcMessage(err)}`);
  process.exit(1);
});
