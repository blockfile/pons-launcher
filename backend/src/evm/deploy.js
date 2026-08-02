'use strict';

// Compiling and deploying the contracts in contracts/.
//
// Shared by scripts/deploy-contract.js and the console's disperser panel, so
// there is one definition of what gets deployed and on what compiler settings.
// Two implementations would eventually disagree, and the one that disagreed
// silently would be the one that produced bytecode the explorer could not
// verify against the source in this repo.

const fs = require('fs');
const path = require('path');
const { ContractFactory } = require('ethers');

const { provider } = require('./provider');
const { getFees, gasCost } = require('./fees');
const { waitForReceipt } = require('./receipt');

const CONTRACTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts');

// Pinned so the bytecode is reproducible: the explorer's verifier needs the
// exact same settings, and "optimizer was on with 200 runs" is the answer it
// will ask for.
const OPTIMIZER = { enabled: true, runs: 200 };

// Compiling costs a second or two and blocks the event loop, which matters
// because this runs inside the API process. The output is a pure function of
// the source and the settings, so it is only ever paid once per contract.
const compiled = new Map();

function compile(name) {
  if (compiled.has(name)) return compiled.get(name);

  const file = `${name}.sol`;
  const source = fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf8');

  // Required lazily: nothing on the launch path needs a compiler, and loading
  // solc costs both startup time and memory.
  const solc = require('solc');

  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [file]: { content: source } },
        settings: {
          optimizer: OPTIMIZER,
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      })
    )
  );

  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));

  const artifact = out.contracts?.[file]?.[name];
  if (!artifact) throw new Error(`${file} compiled, but contains no contract named ${name}`);

  const result = {
    abi: artifact.abi,
    bytecode: '0x' + artifact.evm.bytecode.object,
    version: solc.version(),
    optimizer: OPTIMIZER,
    warnings: (out.errors || []).filter((e) => e.severity !== 'error').map((e) => e.formattedMessage.trim()),
  };
  compiled.set(name, result);
  return result;
}

/**
 * What deploying `count` copies would cost, without sending anything.
 * @returns {{from, balance, gas, fees, each, total, affordable, version}}
 */
async function estimate(name, count, signer, args = []) {
  const { abi, bytecode, version } = compile(name);
  const from = await signer.getAddress();

  const factory = new ContractFactory(abi, bytecode, signer);
  const deployTx = await factory.getDeployTransaction(...args);
  const gas = await provider.estimateGas({ from, data: deployTx.data });
  const fees = await getFees(25);
  const each = gasCost(fees, gas);
  const total = each * BigInt(count);
  const balance = await provider.getBalance(from);

  return { from, balance, gas, fees, each, total, deployTx, affordable: balance >= total, version };
}

/**
 * Deploy `count` copies, one after another.
 *
 * Nonces are assigned here rather than left to ethers, which asks the node for
 * the pending count before every send. Deploying three in a row, the second
 * send came back "nonce has already been used": the RPC is load balanced, and
 * the backend that answered had not yet seen the first transaction. Counting
 * locally from one reading cannot race that way.
 *
 * Sequential rather than concurrent — a nonce gap left by a failure halfway
 * through stalls every later transaction from this wallet until it is filled.
 *
 * @param {(d: object) => void} [onDeployed] called as each one lands
 * @returns {Promise<Array<{address, txHash, gasUsed}>>}
 * @throws with `err.deployed` set to whatever landed before it failed
 */
async function deploy(name, count, signer, { args = [], onDeployed } = {}) {
  const { deployTx, gas, fees, total, balance, from } = await estimate(name, count, signer, args);
  if (balance < total) {
    const { formatEther } = require('ethers');
    throw new Error(`deployer has ${formatEther(balance)} ETH but needs ${formatEther(total)}`);
  }

  const deployed = [];
  let nonce = await provider.getTransactionCount(from, 'pending');

  try {
    for (let i = 0; i < count; i++) {
      const tx = await signer.sendTransaction({
        ...deployTx,
        nonce: nonce++,
        gasLimit: (gas * 12n) / 10n,
        ...fees,
      });
      const receipt = await waitForReceipt(provider, tx.hash, { timeoutMs: 120_000 });

      if (!receipt || receipt.status !== 1) throw new Error(`deployment ${i + 1} reverted (${tx.hash})`);
      if (!receipt.contractAddress) throw new Error(`deployment ${i + 1} mined without a contract address`);

      // A receipt is not proof there is code at the address — confirm it, or a
      // silently empty deployment would be recorded as usable.
      const code = await provider.getCode(receipt.contractAddress);
      if (code === '0x') throw new Error(`nothing deployed at ${receipt.contractAddress}`);

      const entry = {
        address: receipt.contractAddress,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        deployer: from,
      };
      deployed.push(entry);
      if (onDeployed) onDeployed(entry);
    }
  } catch (err) {
    // Whatever already landed is deployed and paid for. Hand it back on the
    // error so the caller can record it — losing the addresses means paying
    // for them twice.
    err.deployed = deployed;
    throw err;
  }

  return deployed;
}

module.exports = { compile, estimate, deploy, CONTRACTS_DIR, OPTIMIZER };
