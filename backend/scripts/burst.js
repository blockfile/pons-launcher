'use strict';

// Measures what a BUNDLE-SIZED BURST of broadcasts actually costs — the number
// `npm run latency` cannot tell you.
//
// WHY THIS EXISTS, AND WHY latency.js IS NOT ENOUGH. latency.js sends its probes
// ONE AT A TIME, so it measures a quiet endpoint and reports a happy number: on a
// live launcher box it read eth_sendRawTransaction at 3.8ms median, 7.5ms p95. A
// launch does not send one transaction. It sends one per bundle wallet, all at
// once, and a per-second cap that a sequential probe never approaches is exactly
// what a burst of 31 walks into.
//
// The evidence that prompted this. On a 31-wallet paired launch every wallet was
// exempt and every wallet arrived — but not together:
//
//     +2: 12 wallets   +3: 1   +5: 7   +7: 5   +10: 5   +20: 1
//
// A staircase over ~3.6 seconds, from an endpoint whose median send is under 4ms.
// Thirty-one concurrent sends should land within tens of milliseconds of each
// other, so something is serialising them. The two candidates both live below the
// Promise.all in fireV2:
//
//   1. THE RETRY. evm/provider.js treats a rate-limited broadcast as retryable and
//      sleeps 40ms * attempt between tries. A burst that trips a cap therefore
//      spreads itself out in ~40/80/120ms steps, which is the shape observed.
//   2. THE SOCKETS. The agent holds maxSockets: 96, but a burst that finds the
//      pool cold pays a TLS handshake per connection, and handshakes are not free
//      when they are simultaneous.
//
// This script separates them: it warms the pool the way fireV2 does, fires N
// sends CONCURRENTLY, and reports both the spread and every rate-limit refusal it
// saw. If the spread is flat and no refusals appear, the burst is not the problem
// and the staircase is somewhere else. If the spread is a staircase and refusals
// appear, the endpoint's per-second cap is the launch's real bottleneck and no
// amount of code will fix it — the plan does.
//
// NOTHING IS BROADCAST. Every probe carries a payload that cannot decode as a
// transaction, so the request travels the exact route a real buy would, is
// refused at the far end, and moves nothing. This is the same trick latency.js
// uses and it is the reason this is safe to run against mainnet, on the box, at
// any time — including while a launch is NOT in progress. Do not run it during
// one: it competes for the same rate-limit budget it is measuring.
//
//   npm run burst                 default: 31 concurrent, one round
//   npm run burst -- --n 40       size it to your bundle
//   npm run burst -- --rounds 3   three bursts, 2s apart, to see a cap recover
//   npm run burst -- --warm 0     skip the warm-up, to price a cold pool

const { provider, warmPool, poolStats, isRateLimited } = require('../src/evm/provider');
const { monotonic, ms, summary } = require('../src/evm/timing');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
}

const N = Math.max(1, arg('n', 31));
const ROUNDS = Math.max(1, arg('rounds', 1));
const WARM = Math.max(0, arg('warm', N * 2 + 2));
const GAP_MS = Math.max(0, arg('gap', 2000));

const sleep = (delay) => new Promise((r) => setTimeout(r, delay));

// Refused at the node: "0xdeadbeef" cannot decode as a transaction, so the far
// end rejects it after doing the same work it would do for a real one.
const probe = (rpc) => rpc.send('eth_sendRawTransaction', ['0xdeadbeef']);

/**
 * One burst: N concurrent sends, each timed from the moment the burst started.
 *
 * Timed from a SHARED start rather than per-request, because the question is not
 * "how long did each take" but "how far apart did they land" — which is what a
 * block delta on chain actually shows.
 */
async function burst(rpc, n) {
  const started = monotonic();
  const settled = await Promise.allSettled(
    Array.from({ length: n }, async () => {
      try {
        await probe(rpc);
        return { at: monotonic() - started, limited: false };
      } catch (err) {
        // The refusal we EXPECT is a decode error. A rate limit is a different
        // animal and is the whole point of the run, so it is counted apart.
        return { at: monotonic() - started, limited: isRateLimited(err), err };
      }
    })
  );
  return settled.map((s) => s.value).filter(Boolean);
}

(async () => {
  const rpc = provider;

  console.log('');
  console.log('pons-launcher — burst behaviour from this box');
  console.log(`  concurrency  ${N} sends at once${ROUNDS > 1 ? ` x ${ROUNDS} rounds, ${GAP_MS}ms apart` : ''}`);
  console.log(`  warm-up      ${WARM} sockets${WARM === 0 ? ' (cold pool on purpose)' : ''}`);
  console.log('  * every probe is refused at the node — nothing is broadcast.');
  console.log('');

  if (WARM > 0) {
    try {
      await warmPool(WARM, rpc);
    } catch (err) {
      console.log(`  warm-up failed (${err.message}) — continuing cold`);
    }
  }
  const warmed = poolStats();
  console.log(`  pooled sockets after warm-up: ${warmed.free} free, ${warmed.active} active`);
  if (WARM > 0 && warmed.free < Math.min(WARM, N)) {
    console.log(
      `  NOTE: asked for ${WARM} sockets and got ${warmed.free}. The burst below will pay a` +
        ' handshake for the rest.'
    );
  }
  console.log('');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const out = await burst(rpc, N);
    const times = out.map((o) => o.at);
    const limited = out.filter((o) => o.limited).length;
    const s = summary(times);
    const spread = Math.max(...times) - Math.min(...times);

    console.log(`round ${round}`);
    console.log(
      `  landed   min ${s.min.toFixed(1)}ms  median ${s.median.toFixed(1)}ms  ` +
        `p95 ${s.p95.toFixed(1)}ms  max ${s.max.toFixed(1)}ms`
    );
    console.log(`  spread   ${spread.toFixed(1)}ms between the first and the last`);
    console.log(`  rate-limited refusals: ${limited} of ${N}`);

    // A block on this chain is ~0.101s, and the snipe tax steps on whole
    // wall-clock SECONDS. Both are what the spread has to be read against, so
    // both are stated rather than left as arithmetic for the reader.
    console.log(
      `  => about ${(spread / 101).toFixed(1)} block(s) of separation, ` +
        `${spread >= 1000 ? 'ENOUGH TO CROSS A TAX STEP' : 'inside one tax step'}`
    );
    if (round < ROUNDS) await sleep(GAP_MS);
  }

  console.log('');
  console.log('reading this');
  console.log('  A FLAT spread with no refusals means the burst is not the bottleneck —');
  console.log('  look at what happens between the launch and the buys instead.');
  console.log('  A STAIRCASE, or any rate-limited refusals, means the endpoint is capping');
  console.log('  the burst. No code change fixes that: raise the plan\'s rate limit, or');
  console.log('  split the bundle across two endpoints.');
  console.log('');

  process.exit(0);
})().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
