'use strict';

// Measures the two numbers that decide whether a bundle wins the tick.
//
// Two launches were lost by roughly one RPC block — about 100ms — between the
// EVM's block.number ticking past the launch block and our first buy reaching
// the wire. That gap has exactly two components:
//
//   1. DETECTION. We only learn the block ticked when a poll comes back saying
//      so. On average that is half a poll interval plus one round trip after
//      the tick actually happened.
//   2. BROADCAST. Once we know, the buy still has to cross the network.
//
// Both are properties of THIS box and THIS RPC endpoint, so they cannot be
// reasoned about from a laptop — they have to be measured where the launcher
// runs. This script measures them, and then says which one is costing the
// block, so the fix is aimed at the right thing.
//
//   npm run latency                    default: 30 samples, 3 ticks (~1 minute)
//   npm run latency -- --samples 100   more samples, tighter percentiles
//   npm run latency -- --ticks 5       watch more ticks (each costs ~16s)
//   npm run latency -- --ticks 0       skip the tick watch entirely (fast)
//   npm run latency -- --poll 10       model a different poll cadence
//
// N ticks measure N-1 intervals, so --ticks 3 is the smallest run that says
// anything about jitter.
//
// NOTHING HERE BROADCASTS A TRANSACTION. The send path is measured with a
// payload that cannot decode as a transaction, so the request travels the exact
// route a real buy would and is refused at the far end. See probeSend below.

const config = require('../src/config');
const { provider, warmPool, poolStats } = require('../src/evm/provider');
const { evmBlockNumber } = require('../src/evm/blocknumber');
const { monotonic, ms, summary } = require('../src/evm/timing');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
}

const SAMPLES = Math.max(1, arg('samples', 30));
const TICKS = Math.max(0, arg('ticks', 3));
const POLL_MS = Math.max(1, arg('poll', config.launchBlockPollMs));

const sleep = (delay) => new Promise((r) => setTimeout(r, delay));

/**
 * Time `fn` `n` times, sequentially. Sequential on purpose: concurrent probes
 * measure how well the box parallelises, and the poll loop this models is not
 * parallel — it makes one request and waits for it.
 */
async function probe(n, fn) {
  const samples = [];
  let failures = 0;
  for (let i = 0; i < n; i++) {
    const started = monotonic();
    try {
      await fn();
      samples.push(monotonic() - started);
    } catch (err) {
      // An error is still a completed round trip when the far end produced it.
      // Only the shape of the answer differed, and the transport is what is
      // being timed, so it counts — unless nothing came back at all.
      if (err && (err.code === 'TIMEOUT' || err.code === 'NETWORK_ERROR')) failures += 1;
      else samples.push(monotonic() - started);
    }
  }
  return { ...summary(samples), failures };
}

/**
 * The broadcast path, without broadcasting.
 *
 * `0xdeadbeef` is not a decodable transaction under any envelope: 0xde opens an
 * RLP list declaring 30 bytes of payload and only three follow, and it is not a
 * typed-envelope prefix either. The node cannot do anything with it but reject
 * it, so there is no payload here that could ever become a real send — while
 * the request still goes to the same method, the same endpoint and the same
 * socket pool a bundle buy uses.
 */
const probeSend = (rpc) => rpc.send('eth_sendRawTransaction', ['0xdeadbeef']);

/**
 * Watch block.number until it has ticked `count` times, polling hard.
 *
 * The poll here is deliberately much faster than the launcher's, because this
 * is measuring when the tick HAPPENED, and the launcher's own poll interval is
 * one of the things under suspicion.
 */
async function watchTicks(rpc, count) {
  const WATCH_POLL_MS = 20;
  const ticks = [];
  let last = await evmBlockNumber(rpc);
  const startedAt = monotonic();
  process.stdout.write(`  watching for ${count} tick${count === 1 ? '' : 's'} from block ${last} `);

  while (ticks.length < count) {
    if (monotonic() - startedAt > (count + 2) * 30000) {
      process.stdout.write(' timed out\n');
      break;
    }
    await sleep(WATCH_POLL_MS);
    let seen;
    try {
      seen = await evmBlockNumber(rpc);
    } catch {
      continue;
    }
    if (seen > last) {
      ticks.push({ at: monotonic(), block: seen, jumped: Number(seen - last) });
      last = seen;
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');

  const intervals = [];
  for (let i = 1; i < ticks.length; i++) intervals.push(ticks[i].at - ticks[i - 1].at);
  return { ticks, intervals, pollMs: WATCH_POLL_MS };
}

const line = (label, s) =>
  `  ${label.padEnd(28)} min ${String(s.min ?? '—').padStart(8)}  median ${String(
    s.median ?? '—'
  ).padStart(8)}  p95 ${String(s.p95 ?? '—').padStart(8)}  max ${String(s.max ?? '—').padStart(8)}${
    s.failures ? `   (${s.failures} no answer)` : ''
  }`;

async function main() {
  console.log('');
  console.log('pons-launcher — RPC latency from this box');
  console.log(`  endpoint   ${config.rpcUrl}`);
  console.log(`  samples    ${SAMPLES}`);
  console.log(`  poll model ${POLL_MS}ms (LAUNCH_BLOCK_POLL_MS)`);
  console.log('');

  // Warm first, then measure. A cold pool would put a TLS handshake into the
  // first sample of every probe and make the medians meaningless — and the
  // launcher warms the pool before it broadcasts anything, so warm is the
  // condition worth measuring.
  await warmPool(8, provider);
  const warmed = poolStats();
  console.log(`  pooled sockets after warm-up: ${warmed.free} free, ${warmed.active} active`);
  if (!warmed.free && /^https:/i.test(config.rpcUrl)) {
    console.log('  NOTE: no sockets were pooled — keep-alive may not be in effect.');
  }
  console.log('');

  console.log('round trip, milliseconds');
  const trivial = await probe(SAMPLES, () => provider.send('eth_chainId', []));
  console.log(line('eth_chainId (transport)', trivial));
  const read = await probe(SAMPLES, () => evmBlockNumber(provider));
  console.log(line('Multicall3 block.number', read));
  const send = await probe(SAMPLES, () => probeSend(provider));
  console.log(line('eth_sendRawTransaction*', send));
  console.log('  * refused at the node — nothing was broadcast.');
  console.log('');

  let tickInfo = null;
  if (TICKS > 0) {
    console.log(`block.number cadence (about 16s per tick, so this takes ~${TICKS * 16}s)`);
    tickInfo = await watchTicks(provider, TICKS);
    if (tickInfo.intervals.length) {
      const iv = summary(tickInfo.intervals);
      const jitter = ms(iv.max - iv.min);
      console.log(
        `  interval   min ${iv.min}ms  median ${iv.median}ms  max ${iv.max}ms   jitter ${jitter}ms`
      );
      const jumps = tickInfo.ticks.map((t) => t.jumped);
      if (jumps.some((j) => j > 1)) {
        console.log(`  NOTE: block.number jumped by ${jumps.join(', ')} — the cadence is not 1:1.`);
      }
    } else {
      // N ticks give N-1 intervals, so one tick measures nothing.
      console.log(
        `  ${tickInfo.ticks.length} tick observed — an interval needs two. Re-run with --ticks 3.`
      );
    }
    console.log('');
  }

  // ── verdict ──────────────────────────────────────────────────────────────
  // Lateness noticing the tick has two parts, and which one dominates decides
  // which lever is worth pulling.
  //
  //   the poll interval  contributes half of itself, because the tick lands
  //                      uniformly somewhere between two polls
  //   the round trip     contributes half of itself, because a read issued at I
  //                      observes the chain around I + rtt/2 and is known at
  //                      I + rtt
  //
  // That second figure is rtt/2 only because the reads now overlap. The old
  // sequential loop slept the interval AFTER waiting out the round trip, so its
  // period was interval + rtt and the round trip was charged twice over. Both
  // numbers are printed, because the difference between them is what the change
  // to blockwait.js was worth on THIS box.
  const rtt = read.median;
  if (rtt === null) {
    console.log('verdict: the block.number read never answered — fix connectivity first.');
    return;
  }
  const fromPoll = POLL_MS / 2;
  const fromNetwork = rtt / 2;
  const sequential = ms((POLL_MS + rtt) / 2 + rtt / 2);
  const detection = ms(fromPoll + fromNetwork);
  const broadcast = send.median ?? rtt;

  console.log('verdict');
  console.log(`  polls overlap on a ${POLL_MS}ms cadence, so the round trip is outside the`);
  console.log(`  period. Sequentially it would have been ${ms(POLL_MS + rtt)}ms.`);
  console.log('');
  console.log(`  expected lateness noticing the tick    ~${detection}ms  (was ~${sequential}ms)`);
  console.log(`  expected time to get a buy on the wire ~${ms(broadcast)}ms`);
  console.log(`  expected total behind the tick         ~${ms(detection + broadcast)}ms`);
  console.log('');
  console.log(`  of which the poll interval costs ~${ms(fromPoll)}ms and the network ~${ms(fromNetwork)}ms.`);
  console.log('');

  if (fromPoll > fromNetwork * 1.5) {
    console.log(`  DOMINATED BY THE POLL INTERVAL (${POLL_MS}ms cadence vs a ${rtt}ms read).`);
    console.log(`  Lowering LAUNCH_BLOCK_POLL_MS is the lever here. It costs one read per`);
    console.log(`  interval for up to 16s — at ${POLL_MS}ms that is ~${Math.round(16000 / POLL_MS)} reads per launch, so`);
    console.log('  watch for rate-limit errors in the launch record before going lower.');
  } else if (fromNetwork > fromPoll * 1.5) {
    console.log(`  DOMINATED BY THE NETWORK (${rtt}ms read vs a ${POLL_MS}ms cadence).`);
    console.log('  Lowering the poll interval will not buy much: the answer is already');
    console.log('  stale when it arrives, and no client-side change can undo that. A closer');
    console.log('  RPC endpoint — ideally one in the same region as the sequencer — is the');
    console.log('  only lever with real headroom left.');
  } else {
    console.log(`  BOTH MATTER ABOUT EQUALLY (${rtt}ms read, ${POLL_MS}ms cadence).`);
    console.log(`  Halving the cadence would save ~${ms(fromPoll / 2)}ms; a closer endpoint would save`);
    console.log('  the network half. Neither alone closes a 100ms gap.');
  }

  if (send.p95 !== null && read.p95 !== null && send.p95 > read.p95 * 2) {
    console.log('');
    console.log(`  The send path is much slower than the read path (p95 ${send.p95}ms vs`);
    console.log(`  ${read.p95}ms). The provider may be rate-limiting or specially routing`);
    console.log('  eth_sendRawTransaction — worth raising with them.');
  }
  console.log('');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`latency: ${err.message}`);
    process.exit(1);
  }
);
