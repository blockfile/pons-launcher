'use strict';

// Measures what an acknowledgement does NOT tell you: how long a transaction
// takes to be SEQUENCED, per endpoint.
//
// `npm run latency` times the request. That is the number this box controls,
// and on the droplet it is excellent (4.7ms median to QuickNode). But an
// acknowledgement only says the endpoint took the bytes; the transaction still
// has to reach the sequencer, and that hop is invisible from here. It is also
// the hop that decides a launch: a bundle that goes out 5ms after the launch
// but is relayed a block later has lost the tier anyway.
//
// So this sends REAL transactions — a self-transfer of 0 ETH, the cheapest
// transaction that exists — through each endpoint in turn, and reports for each
// one how long it took to appear in a block and how many blocks had passed.
//
//   npm run inclusion -- --address 0xYourWallet          10 sends per endpoint
//   npm run inclusion -- --address 0x… --sends 20        more samples
//   npm run inclusion -- --address 0x… --only configured  one endpoint
//   npm run inclusion -- --address 0x… --dry             print the plan, send nothing
//
// THIS SPENDS GAS. Each send is a 21,000-gas self-transfer: at 0.02 gwei that
// is ~0.0000004 ETH, so 30 of them cost well under a cent. It moves NO value —
// the recipient is the sender — and it never touches a wallet's nonce beyond
// the sends it makes, one at a time, each awaited before the next.
//
// Pick a wallet that is not in a live campaign: a bundle wallet between
// launches, or a funder that is idle. The script refuses to run against a
// wallet whose pending nonce is ahead of its latest (something of yours is
// already in flight there).

const { formatEther, parseUnits, Wallet } = require('ethers');

const config = require('../src/config');
const { provider } = require('../src/evm/provider');
const { keystoreFor } = require('../src/wallets/keystore');
const { maskRpcUrl } = require('../src/evm/rpcurl');
const { monotonic, ms, summary } = require('../src/evm/timing');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);
const num = (name, fallback) => {
  const v = Number(arg(name, NaN));
  return Number.isFinite(v) ? v : fallback;
};

// Every endpoint worth comparing. The configured one is what the launcher uses;
// the other two are what a sniper can reach. A URL is only probed if it exists,
// so a box with no QuickNode key still measures the public ones.
function endpoints() {
  const list = [
    ['configured (RPC_URL)', config.rpcUrl],
    ['sequencer', process.env.SEQUENCER_URL || 'https://sequencer.mainnet.chain.robinhood.com'],
    ['public rpc', 'https://rpc.mainnet.chain.robinhood.com'],
  ].filter(([, url]) => Boolean(url));
  const only = arg('only', null);
  if (!only) return list;
  const wanted = list.filter(([name]) => name.toLowerCase().includes(only.toLowerCase()));
  if (!wanted.length) {
    console.error(`--only ${only} matched no endpoint of: ${list.map(([n]) => n).join(', ')}`);
    process.exit(1);
  }
  return wanted;
}

// A raw JSON-RPC send, so the transaction goes exactly where this endpoint is,
// with no provider retry, no batching and no fallback to another URL.
async function sendRaw(url, raw) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  if (!json.result) throw new Error(`no result from ${url}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.result;
}

// NOT provider.getTransactionReceipt: AbstractProvider caches a null receipt by
// tag for 250ms, which would put a 250ms floor under the very measurement this
// script exists to make (bundle/secondtick.js documents the same trap).
async function waitForInclusion(hash, deadlineMs = 30000) {
  const started = monotonic();
  for (;;) {
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (receipt) return receipt;
    if (monotonic() - started > deadlineMs) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main() {
  const address = arg('address', null);
  const sends = Math.max(1, num('sends', 10));
  const dry = flag('dry');

  if (!address) {
    console.error('usage: npm run inclusion -- --address 0xYourWallet [--sends 10] [--only configured] [--dry]');
    process.exit(1);
  }
  const ks = keystoreFor(arg('user', 'default'));
  const entry = ks.list().find((w) => w.address.toLowerCase() === address.toLowerCase());
  if (!entry) {
    console.error(`${address} is not in this keystore`);
    process.exit(1);
  }

  const targets = endpoints();
  const latest = await provider.getTransactionCount(address, 'latest');
  const pending = await provider.getTransactionCount(address, 'pending');
  const balance = await provider.getBalance(address);
  const feeData = await provider.getFeeData();
  const maxFee = feeData.maxFeePerGas || parseUnits('0.05', 'gwei');

  console.log(`wallet   ${address}`);
  console.log(`balance  ${formatEther(balance)} ETH   nonce ${latest} (pending ${pending})`);
  console.log(`sends    ${sends} per endpoint, 21000 gas each, self-transfer of 0 ETH`);
  console.log(`cost     ~${formatEther(BigInt(sends * targets.length) * 21000n * maxFee)} ETH in total\n`);
  // maskRpcUrl, not the URL: a QuickNode token lives in the PATH, and this line
  // printed it whole into a terminal that was then pasted into a chat (2026-09-29).
  for (const [name, url] of targets) console.log(`  ${name.padEnd(22)} ${maskRpcUrl(url)}`);

  const cost = BigInt(sends * targets.length) * 21000n * maxFee;
  if (balance < cost) {
    console.error(
      `
this wallet holds ${formatEther(balance)} ETH and the run needs about ${formatEther(cost)} ETH — ` +
        'pick a wallet with more, or lower --sends'
    );
    process.exit(1);
  }
  if (pending !== latest) {
    console.error(`\nthis wallet has ${pending - latest} transaction(s) in flight — pick an idle one`);
    process.exit(1);
  }
  if (dry) {
    console.log('\n--dry: nothing was sent.');
    return;
  }

  // exportKey returns { address, privateKey } — the key alone is what signs.
  const signer = new Wallet(ks.exportKey(entry.id).privateKey);
  let nonce = latest;
  const results = [];

  for (const [name, url] of targets) {
    const inclusionMs = [];
    const blockGaps = [];
    let failed = 0;
    for (let i = 0; i < sends; i++) {
      const raw = await signer.signTransaction({
        to: address,
        value: 0n,
        nonce: nonce++,
        gasLimit: 21000n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: 0n,
        chainId: Number(config.chainId),
        type: 2,
      });
      const blockBefore = await provider.getBlockNumber();
      const at = monotonic();
      let hash;
      try {
        hash = await sendRaw(url, raw);
      } catch (err) {
        failed += 1;
        // Nothing was accepted, so the nonce is still free. If the node DID take it
        // and only the answer was lost, the nonce is reused and one send replaces
        // the other — both are 0-value self-transfers, so nothing is at stake.
        nonce -= 1;
        console.log(`  ${name}: send ${i + 1} refused — ${err.message.slice(0, 120)}`);
        continue;
      }
      const receipt = await waitForInclusion(hash);
      if (!receipt) {
        failed += 1;
        console.log(`  ${name}: send ${i + 1} never landed within 30s (${hash})`);
        continue;
      }
      inclusionMs.push(monotonic() - at);
      blockGaps.push(receipt.blockNumber - blockBefore);
    }
    results.push({ name, inclusionMs, blockGaps, failed });
  }

  console.log('\ntime from send to the transaction being IN a block');
  for (const r of results) {
    const t = summary(r.inclusionMs);
    const gaps = r.blockGaps.slice().sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    console.log(
      `  ${r.name.padEnd(22)} median ${String(ms(t.median ?? 0)).padStart(7)}ms  p95 ${String(ms(t.p95 ?? 0)).padStart(7)}ms` +
        `  blocks +${median === null ? '?' : median} (min +${gaps[0] ?? '?'}, max +${gaps[gaps.length - 1] ?? '?'})` +
        (r.failed ? `  failed ${r.failed}` : '')
    );
  }

  console.log(
    '\nWHAT IT MEANS. The launcher awaits its launch acknowledgement and then fires the\n' +
      'bundle, so the endpoint that puts a transaction in a block soonest is the one a\n' +
      'launch should use. A median of +0 or +1 blocks is as good as this chain gets; +2\n' +
      'or worse is a whole tax tier when the launch lands late in a second, which is what\n' +
      'LAUNCH_ON_FRESH_SECOND is there to stop being decisive.'
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
