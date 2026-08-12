'use strict';

// Can we land a transaction in the first RPC block after the EVM tick?
//
// The v1 factory refuses any buy where block.number == launchBlock, so the
// first legal moment is the tick to launchBlock+1. That block is not an
// instant: block.number advances about every 15 seconds while the chain
// produces an RPC block every ~100ms, so the first legal EVM block is roughly
// 150 RPC blocks wide. Getting 32 buys somewhere inside it is easy. Getting
// them in EARLY is what sets the price, and that is the thing being lost.
//
// The sniper wins that position by having a transaction already in flight when
// the tick lands — it submits continuously and eats the reverts. A bundle
// cannot copy that directly, because a reverted buy still consumes the wallet's
// nonce and the pre-signed sequence dies with it. Before paying to find out
// whether that is worth solving, this measures whether the arrival itself is
// even achievable from this box:
//
//   how many RPC blocks after the tick does our first packet land?
//
// It answers that with self-transfers rather than buys. A self-transfer cannot
// revert, so every nonce in the ladder lands and the full arrival sequence is
// visible — which is exactly the measurement, with none of the launch risk. If
// we cannot reach the first RPC block here, no amount of bundle tuning reaches
// it on a real launch.
//
//   npm run tick-race -- --key 0xPRIVATEKEY              price it, send nothing
//   npm run tick-race -- --key 0xPRIVATEKEY --broadcast  run it for real
//   npm run tick-race -- --key 0x... --count 60 --broadcast
//
// COSTS REAL ETH when --broadcast is given: `count` self-transfers at 21000 gas
// each. At the fees seen on this chain that is a small fraction of a cent, and
// the dry run prints the figure before anything is sent.
//
// Use a THROWAWAY wallet. This burns a contiguous run of nonces, which is
// precisely what must never happen to a wallet holding a pre-signed bundle.

const { Wallet, formatEther } = require('ethers');
const config = require('../src/config');
const { provider, warmPool } = require('../src/evm/provider');
const { evmBlockNumber } = require('../src/evm/blocknumber');
const { monotonic, ms } = require('../src/evm/timing');

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

const COUNT = Math.max(4, Number(arg('count', 40)) || 40);
const SPACING_MS = Math.max(20, Number(arg('spacing', 100)) || 100);
const BROADCAST = flag('broadcast');
const KEY = arg('key', process.env.TICK_RACE_KEY || '');

const sleep = (d) => new Promise((r) => setTimeout(r, d));

/**
 * Sign `count` self-transfers at consecutive nonces.
 *
 * Signed up front, exactly as a bundle is: the point of the experiment is the
 * arrival time of an already-signed payload, so signing must not sit on the
 * critical path any more than it does in the real thing.
 */
async function ladder(wallet, nonce, count, fees) {
  const txs = [];
  for (let i = 0; i < count; i++) {
    txs.push(
      await wallet.signTransaction({
        to: wallet.address,
        value: 0n,
        nonce: nonce + i,
        gasLimit: 21000n,
        chainId: config.chainId,
        type: 2,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
    );
  }
  return txs;
}

(async () => {
  if (!KEY) {
    console.error('need a throwaway funded key: --key 0x... (or TICK_RACE_KEY)');
    process.exit(1);
  }

  const wallet = new Wallet(KEY, provider);
  const [balance, nonce, fees] = await Promise.all([
    provider.getBalance(wallet.address),
    provider.getTransactionCount(wallet.address, 'pending'),
    provider.getFeeData(),
  ]);

  const perTx = 21000n * (fees.maxFeePerGas ?? 1n);
  const worst = perTx * BigInt(COUNT);

  console.log(`wallet   ${wallet.address}`);
  console.log(`balance  ${formatEther(balance)} ETH`);
  console.log(`plan     ${COUNT} self-transfers, one every ${SPACING_MS}ms across one tick`);
  console.log(`cost     up to ${formatEther(worst)} ETH at ${fees.maxFeePerGas} wei/gas\n`);

  if (balance < worst) {
    console.error('balance will not cover the run — fund the wallet or lower --count');
    process.exit(1);
  }
  if (!BROADCAST) {
    console.log('dry run — nothing sent. Re-run with --broadcast to measure for real.');
    return;
  }

  await warmPool();
  const signed = await ladder(wallet, nonce, COUNT, fees);

  // Spam starts BEFORE the tick on purpose. The whole hypothesis is that a
  // packet already in flight beats one sent in reaction to the tick, so the
  // run has to straddle the boundary rather than begin at it.
  let tickAt = null;
  let tickHead = null;
  let tickSeenMs = null;
  const start = monotonic();
  let last = await evmBlockNumber();

  // The head has to be sampled from the SAME provider that broadcasts, and
  // recorded per packet, or the comparison is meaningless: this RPC is load
  // balanced across nodes at different heights, and a head read from one node
  // can sit tens of blocks ahead of where another node is including. The first
  // run of this script compared landings against a single head read at tick
  // time and produced packets landing 26 blocks BEFORE they were sent.
  //
  // Polled in the background so reading it at broadcast time costs nothing on
  // the path being measured.
  let head = await provider.getBlockNumber();
  let sending = true;
  const heads = (async () => {
    while (sending) {
      try {
        head = await provider.getBlockNumber();
      } catch {
        /* a dropped poll is not the measurement */
      }
      await sleep(40);
    }
  })();

  const watch = (async () => {
    while (tickAt === null) {
      try {
        const n = await evmBlockNumber();
        if (n !== last) {
          tickAt = n;
          tickSeenMs = ms(monotonic() - start);
          tickHead = await provider.getBlockNumber();
        }
      } catch {
        /* a dropped poll is not the measurement */
      }
      await sleep(25);
    }
  })();

  const sent = [];
  for (let i = 0; i < COUNT; i++) {
    const at = ms(monotonic() - start);
    const headAtSend = head;
    try {
      const res = await provider.broadcastTransaction(signed[i]);
      sent.push({ i, at, headAtSend, hash: res.hash });
    } catch (err) {
      sent.push({ i, at, headAtSend, error: err.shortMessage || err.message });
    }
    await sleep(SPACING_MS);
  }
  sending = false;
  await heads;

  // Give the watcher a moment to catch a tick that landed near the end, then
  // stop waiting on it either way — a run that straddled no tick is a result,
  // not a hang.
  await Promise.race([watch, sleep(20_000)]);

  console.log('waiting for receipts…\n');
  const rows = [];
  for (const s of sent) {
    if (!s.hash) {
      rows.push({ ...s, block: null });
      continue;
    }
    try {
      const r = await provider.waitForTransaction(s.hash, 1, 30_000);
      rows.push({ ...s, block: r?.blockNumber ?? null, index: r?.index ?? null });
    } catch {
      rows.push({ ...s, block: null });
    }
  }

  if (tickAt === null) {
    console.log('no tick occurred during the run — raise --count and try again.');
    return;
  }

  console.log(`tick to block.number ${tickAt} seen at +${tickSeenMs}ms, rpc head ${tickHead}\n`);
  console.log('  #   sent(ms)   head@send   rpc block   idx   lag');
  for (const r of rows) {
    const lag = r.block === null ? null : r.block - r.headAtSend;
    console.log(
      `  ${String(r.i).padStart(2)} ${String(r.at).padStart(9)}   ${String(r.headAtSend).padStart(9)}   ${String(
        r.block ?? 'dropped'
      ).padStart(9)}   ${String(r.index ?? '-').padStart(3)}   ${lag === null ? '' : `+${lag}`}`
    );
  }

  // THE number. How many RPC blocks pass between handing a signed transaction
  // to the RPC and it being included — measured against the head that same
  // provider reported a moment before the send.
  const lags = rows.filter((r) => r.block !== null).map((r) => r.block - r.headAtSend);
  if (!lags.length) {
    console.log('\nnothing landed — cannot measure inclusion lag.');
    return;
  }
  const sorted = [...lags].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const best = sorted[0];
  console.log(
    `\ninclusion lag: best ${best} blocks, median ${median}, worst ${sorted[sorted.length - 1]}`
  );

  // A launch is lost or won inside one EVM block, which is ~150 RPC blocks
  // wide. What matters is whether the lag is small enough that a packet sent
  // just after the tick still lands near the front of it.
  console.log(
    best <= 2
      ? 'REACTION IS ENOUGH — a buy sent on seeing the tick lands almost immediately,\n' +
          'so the front of the block is reachable without pre-submitting and without\n' +
          'burning nonces on reverts. The loss is somewhere else in the fire path.'
      : `PRE-SUBMISSION REQUIRED — a packet takes ~${median} RPC blocks (~${Math.round(
          median * 100
        )}ms) to be\nincluded, so a buy sent on seeing the tick lands ~${Math.round(
          median * 100
        )}ms into the block and the\nsniper, whose packets were already queued, is ahead of it by about that much.\n\n` +
          `That gap sets the PRICE you enter at, not whether you get in — the legal block\n` +
          `is ~150 RPC blocks wide and all 32 buys land inside it comfortably.\n\n` +
          `Ladder depth is NOT this number. To always have a packet in flight you must\n` +
          `cover the tick's jitter (run \`npm run latency\` for it — measured at ~4.5s), so\n` +
          `depth is jitter / send-interval, and every rung before the tick reverts and\n` +
          `burns a nonce. Price that against what ${Math.round(median * 100)}ms of head start is worth first.`
  );
})();
