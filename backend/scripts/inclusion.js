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
//   npm run inclusion -- --address 0x… --dual             one path against two
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

const { formatEther, keccak256, parseUnits, Wallet } = require('ethers');

const config = require('../src/config');
const { provider } = require('../src/evm/provider');
const { keystoreFor } = require('../src/wallets/keystore');
const { maskRpcUrl } = require('../src/evm/rpcurl');
const { raceSend } = require('../src/evm/sendrace');
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
  const dual = flag('dual');

  if (!address) {
    console.error('usage: npm run inclusion -- --address 0xYourWallet [--sends 10] [--only configured] [--dual] [--dry]');
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

  // --dual measures the QUESTION, not the endpoints: is the same signed transaction
  // sequenced sooner when it is handed to two paths at once? Both arms lead with the
  // configured endpoint, so the comparison is "that path alone" against "that path
  // plus a spare", and the arms alternate send by send so a busy stretch cannot land
  // on one arm and flatter it.
  const arms = dual
    ? [
        { name: `${targets[0][0]} alone`, urls: [targets[0][1]] },
        {
          name: `${targets[0][0]} + ${targets[1] ? targets[1][0] : '(nothing)'}`,
          urls: targets.slice(0, 2).map((t) => t[1]),
        },
      ]
    : targets.map(([name, url]) => ({ name, urls: [url] }));

  for (const arm of arms) {
    const { name, urls } = arm;
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
      // Raw, not provider.getBlockNumber(): that answer is cached by tag for 250ms
      // (the same trap as bundle/secondtick.js), which on a 100ms chain makes the
      // "before" height up to 2.5 blocks stale and inflates every gap below by that
      // much. The 2026-09-29 run reported +3/+4 blocks against a 193ms median, which
      // is ~2 blocks: the difference was this read, not the chain.
      const blockBefore = Number(await provider.send('eth_blockNumber', []));
      const at = monotonic();
      let hash;
      try {
        if (urls.length === 1) {
          hash = await sendRaw(urls[0], raw);
        } else {
          // The SAME signed bytes down every path, so the same hash: the sequencer
          // takes whichever arrives first and answers the other "already known".
          const race = await raceSend(
            raw,
            urls.map((u) => ({ name: u, send: (r) => sendRaw(u, r) }))
          );
          // A race every path answered as a duplicate still went out — the hash of
          // the signed bytes names it either way.
          hash = race.hash || keccak256(raw);
        }
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

  console.log(`\ntime from send to the transaction being IN a block${dual ? ' — one path against two' : ''}`);
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

  if (dual && results.length === 2 && results[0].inclusionMs.length && results[1].inclusionMs.length) {
    const one = summary(results[0].inclusionMs);
    const two = summary(results[1].inclusionMs);
    const cut = (a, b) => (a && b ? `${(((a - b) / a) * 100).toFixed(0)}%` : '?');
    console.log(
      `\nTWO PATHS AGAINST ONE: median ${ms(one.median)}ms -> ${ms(two.median)}ms (${cut(one.median, two.median)} off), ` +
        `p95 ${ms(one.p95)}ms -> ${ms(two.p95)}ms (${cut(one.p95, two.p95)} off).\n` +
        'The TAIL is what this is for. A bundle buy that lands past ~10 blocks is outside\n' +
        'the 99% snipe-tax window, which is the protection the whole bundle rests on: on\n' +
        'Tomachi (2026-09-29) three of 33 buys landed at +11/+12. A p95 worth having is\n' +
        'what would put the launch burst on evm/sendrace. No cut means the two paths share\n' +
        'a queue upstream, and the launch code stays exactly as it is.'
    );
  }

  console.log(
    '\nWHAT IT MEANS. The launcher awaits its launch acknowledgement and then fires the\n' +
      'bundle, so the endpoint that puts a transaction in a block soonest is the one a\n' +
      'launch should use.\n\n' +
      'ENDPOINTS WITHIN A FEW ms OF EACH OTHER means the wait is not the endpoint: it is\n' +
      'this box to the sequencer plus the sequencer to a block, and no RPC choice changes\n' +
      'it. That was the 2026-09-29 reading from the droplet — 193.1 / 192.3 / 193.9ms\n' +
      'median across QuickNode, the sequencer and the public RPC, about two blocks. What\n' +
      'is left to move it is a box closer to the sequencer, not an RPC_URL edit.\n\n' +
      'ONE ENDPOINT CLEARLY AHEAD means point RPC_URL at it before the next launch.\n\n' +
      'Either way the tax tier is the lever that does not depend on winning the race:\n' +
      'LAUNCH_ON_FRESH_SECOND decides how many blocks of 99% sit behind the launch, and\n' +
      'that is what makes a sniper who does beat you pay 99% for it.'
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
