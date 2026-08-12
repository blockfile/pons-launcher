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
    try {
      const res = await provider.broadcastTransaction(signed[i]);
      sent.push({ i, at, hash: res.hash });
    } catch (err) {
      sent.push({ i, at, error: err.shortMessage || err.message });
    }
    await sleep(SPACING_MS);
  }

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
  console.log('  #   sent(ms)   rpc block   idx   vs tick');
  for (const r of rows) {
    const delta = r.block === null ? '' : r.block - tickHead;
    console.log(
      `  ${String(r.i).padStart(2)} ${String(r.at).padStart(9)}   ${String(r.block ?? 'dropped').padStart(9)}   ${String(r.index ?? '-').padStart(3)}   ${
        r.block === null ? '' : delta >= 0 ? `+${delta}` : String(delta)
      }`
    );
  }

  const landed = rows.filter((r) => r.block !== null && r.block >= tickHead);
  if (!landed.length) {
    console.log('\nnothing landed at or after the tick — the ladder ran out too early.');
    return;
  }
  const first = landed[0];
  const gap = first.block - tickHead;
  console.log(
    `\nfirst packet at or after the tick landed ${gap} RPC block(s) past it (tx index ${first.index}).`
  );
  console.log(
    gap <= 1
      ? 'REACHABLE — in-flight submission does put us at the front. The bundle\n' +
          'cannot use it as-is only because a reverted buy burns the nonce, so the\n' +
          'next question is whether that is worth engineering around.'
      : 'OUT OF REACH FROM THIS BOX — we are arriving late even with a packet already\n' +
          'in flight, so the loss is network position, not bundle logic. Copying the\n' +
          "sniper's strategy would not have won these launches."
  );
})();
