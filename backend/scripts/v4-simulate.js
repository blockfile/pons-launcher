'use strict';

// Watch a whole seasoning campaign run, before trusting one that takes weeks.
//
// A V4 campaign is the only job in this codebase whose first honest feedback is
// three weeks away. Everything about it is unit-tested against a fake clock, and
// a fake clock proves the arithmetic and nothing else: it never shows a plan
// arriving at a runner, a runner re-arming four hundred times, or a store being
// rewritten after every send. This script does. It generates a real plan, hands
// it to the real runner backed by the real store, and runs the whole thing at a
// compression the caller picks — `--scale 1440` is a day a minute, so a 20-day
// campaign is watchable over a coffee.
//
// The compression is ONLY a clock. Nothing else is faked down:
//
//   plan.js      real — the plan is generated exactly as a campaign's is
//   store.js     real — every send is persisted, atomically, to a real file
//   runner.js    real — the same arm/fire/re-arm loop a live campaign runs
//   activity.js  real — the same log the console reads
//   relay.js     STUBBED. This is the money path and it must never be reached.
//
// WHAT IT ASSERTS, AND WHY EACH ONE IS THE THING WORTH ASSERTING:
//
//   every wallet funded exactly once   a wallet funded twice has two funding
//                                      edges, which is the shape this whole
//                                      strategy exists to avoid; a wallet
//                                      funded zero times is one the operator
//                                      believes is seasoned and is not
//   no two sends share an instant      two sends on one instant from one
//                                      funding wallet share a nonce, and one
//                                      of them silently disappears
//   daily counts inside the range      the per-day count is the column a
//                                      filter would group by
//   every transfer inside its day      a day that runs over into the next is
//                                      how a "20-day" campaign becomes a
//                                      21-day one with a visible seam
//
// Usage:
//   npm run v4:simulate --workspace backend -- --scale 1440 --wallets 400 --days 20
//   node scripts/v4-simulate.js --help

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── SAFETY, ABOVE EVERY require() OF src/ ───────────────────────────────────
//
// src/config.js reads KEYSTORE_PATH, HISTORY_PATH and USERS_PATH ONCE, at
// require time, and v4/store.js and store/activity.js both derive their file
// from HISTORY_PATH's directory. Redirecting them here — before anything reads
// config — makes it impossible for this script to write into a real
// deployment's data directory, whatever the environment or the .env file says.
// dotenv does not overwrite a variable that already exists, so this wins over
// backend/.env too.
//
// That matters more than it looks: a live deployment's data directory holds the
// keystore, and this script is the kind of thing somebody runs without reading.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-simulate-'));
process.env.DRY_RUN = 'true';
process.env.KEYSTORE_PATH = path.join(SANDBOX, 'wallets.keystore.json');
process.env.HISTORY_PATH = path.join(SANDBOX, 'launches.json');
process.env.USERS_PATH = path.join(SANDBOX, 'users.json');

const plan = require('../src/v4/plan');
const rng = require('../src/v4/rng');
const v4store = require('../src/v4/store');
const { createRunner } = require('../src/v4/runner');

const USER = 'default';
const DAY_MS = plan.DAY_MS;

// ── arguments ───────────────────────────────────────────────────────────────

const FLAGS = {
  scale: 'how many campaign-seconds pass per real second (1440 = a day a minute)',
  wallets: 'how many seed wallets the campaign funds',
  days: 'how many days the campaign runs over',
  'per-day-min': 'fewest transfers on any one day',
  'per-day-max': 'most transfers on any one day',
  'amount-min': 'smallest transfer, in ETH',
  'amount-max': 'largest transfer, in ETH',
  'gap-min-ms': 'shortest gap between two transfers, in campaign-milliseconds',
  'gap-max-ms': 'longest gap between two transfers, in campaign-milliseconds',
  seed: 'plan seed — the same seed reproduces the same schedule exactly',
  quiet: 'only print the day summaries and the assertions, not every send',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [flag, inline] = argv[i].slice(2).split('=');
    if (inline !== undefined) {
      out[flag] = inline;
      continue;
    }
    const next = argv[i + 1];
    out[flag] = next !== undefined && !next.startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

function usage() {
  console.log('Replay a V4 seasoning campaign at a time compression.\n');
  console.log('  node scripts/v4-simulate.js [options]\n');
  for (const [flag, help] of Object.entries(FLAGS)) {
    console.log(`  --${flag.padEnd(12)} ${help}`);
  }
  console.log('\nDefaults are v4/plan.js\'s own DEFAULTS, at --scale 1440 and --wallets 400.');
}

// ── formatting ──────────────────────────────────────────────────────────────

function hhmmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Offset from campaign start, as an operator reads a schedule: `d3 07:41:02`. */
function offset(ms) {
  return `d${String(Math.floor(ms / DAY_MS) + 1).padStart(2, ' ')} ${hhmmss(ms % DAY_MS)}`;
}

function eth(n) {
  return Number(n).toFixed(6);
}

// ── the fakes, and only these ───────────────────────────────────────────────

/** The whole money path, replaced. Records the send and returns a plausible receipt. */
function stubTransfer(sends, guard) {
  let n = 0;
  return async ({ campaignId, walletId, toAddress, amountWei }) => {
    // The runner promises ONE send at a time per campaign, because two sends
    // from one funding wallet share a nonce. That promise is checkable from
    // here and nowhere else, so it is checked here.
    if (guard.inFlight) {
      guard.violations.push(
        `two sends overlapped: ${guard.inFlight} was still in flight when ${walletId} started`
      );
    }
    guard.inFlight = walletId;
    // A real Relay round trip is seconds; a zero-cost stub would hide any
    // overlap the inFlight guard exists to prevent. One tick is enough to make
    // the overlap reachable if the guard were ever removed.
    await new Promise((r) => setImmediate(r));
    guard.inFlight = null;

    n += 1;
    sends.push({ campaignId, walletId, toAddress, amountWei, order: n, at: Date.now() });
    return {
      hash: `0x${n.toString(16).padStart(64, '0')}`,
      requestId: `0x${n.toString(16).padStart(64, 'f')}`,
      depositAddress: `0x${'d'.repeat(40)}`,
    };
  };
}

/** A deterministic address per seed wallet. Never a real key — nothing signs. */
function addressFor(i) {
  return `0x${(i + 1).toString(16).padStart(40, '0')}`;
}

// ── the run ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return 0;
  }

  const scale = Number(args.scale ?? 1440);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('--scale must be a positive number');
  const walletCount = Math.round(Number(args.wallets ?? 400));
  if (!Number.isInteger(walletCount) || walletCount < 1) {
    throw new Error('--wallets must be a positive integer');
  }
  const quiet = args.quiet === 'true' || args.quiet === '1';

  // Straight through the real validator — the same one the route uses, and the
  // one that refuses a config whose densest day cannot fit its own gap floor.
  const params = plan.normaliseParams({
    days: args.days,
    perDayMin: args['per-day-min'],
    perDayMax: args['per-day-max'],
    amountMinEth: args['amount-min'],
    amountMaxEth: args['amount-max'],
    gapMinMs: args['gap-min-ms'],
    gapMaxMs: args['gap-max-ms'],
  });

  const check = plan.feasible(walletCount, params);
  if (!check.ok) {
    console.error(`NOT FEASIBLE: ${check.reason}`);
    return 1;
  }

  const seed = args.seed || rng.newSeed();
  const walletIds = Array.from({ length: walletCount }, (_, i) => `sim-${i + 1}`);
  const addresses = Object.fromEntries(walletIds.map((id, i) => [id, addressFor(i)]));

  // ── the compressed clock ──────────────────────────────────────────────────
  //
  // The ONLY thing this script fakes about time. `nowFn` runs the campaign's
  // clock `scale` times faster than the wall clock, and `setTimeoutFn` divides
  // every delay the runner asks for by the same number. The runner re-reads
  // nowFn each time it re-arms, so the error does not accumulate over 400 sends.
  const realStart = Date.now();
  const campaignStart = realStart;
  const nowFn = () => campaignStart + Math.round((Date.now() - realStart) * scale);
  const timers = new Set();
  const setTimeoutFn = (fn, ms) => {
    const t = setTimeout(fn, Math.max(0, ms / scale));
    timers.add(t);
    return t;
  };
  const clearTimeoutFn = (t) => {
    timers.delete(t);
    return clearTimeout(t);
  };

  const genStart = Date.now();
  const result = plan.generate({ walletIds, addresses, params, seed, now: campaignStart });
  const genMs = Date.now() - genStart;

  const estimatedMs = (result.transfers[result.transfers.length - 1].dueAt - campaignStart) / scale;

  console.log('V4 seasoning — compressed replay. Nothing is broadcast; relay.js is not reached.\n');
  console.log(`  seed            ${seed}`);
  console.log(`  wallets         ${walletCount}`);
  console.log(`  days            ${params.days} at ${params.perDayMin}–${params.perDayMax} a day`);
  console.log(`  amounts         ${params.amountMinEth}–${params.amountMaxEth} ETH`);
  console.log(`  gaps            ${Math.round(params.gapMinMs / 60000)}–${Math.round(params.gapMaxMs / 60000)} min`);
  console.log(`  total           ${result.totalEth} ETH across ${result.transfers.length} transfers`);
  console.log(`  plan generated  in ${genMs}ms`);
  console.log(`  scale           ${scale}× — ${params.days} campaign-days in about ${hhmmss(estimatedMs)}`);
  console.log(`  sandbox         ${SANDBOX}`);
  console.log('');

  const sends = [];
  const guard = { inFlight: null, violations: [] };
  const runner = createRunner({
    // Real store, real activity log — both already redirected into SANDBOX.
    storeForFn: v4store.storeFor,
    transferFn: stubTransfer(sends, guard),
    // The keystore is never opened: the runner only passes it through to the
    // transfer function, and the transfer function here is a stub.
    keystoreForFn: () => ({ list: () => [], signer: () => ({}) }),
    rolesResolve: () => ({ id: 'sim-master', address: `0x${'1'.repeat(40)}` }),
    usersFn: () => [USER],
    setTimeoutFn,
    clearTimeoutFn,
    nowFn,
  });

  const campaign = {
    id: `sim-${seed.slice(0, 8)}`,
    name: 'simulated seasoning',
    masterWalletId: 'sim-master',
    seed,
    params,
    transfers: result.transfers,
    byDay: result.byDay,
    totalEth: result.totalEth,
    createdAt: new Date(campaignStart).toISOString(),
  };

  const width = String(result.transfers.length).length;
  let printed = 0;
  let lastDay = 0;

  runner.start(USER, campaign);

  // The runner unrefs its timers so a campaign can never hold a server open, so
  // something here has to. A ref'd interval doubles as the progress watcher.
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      while (printed < sends.length) {
        const send = sends[printed];
        const transfer = result.transfers.find((t) => t.walletId === send.walletId);
        if (!quiet) {
          if (transfer.day !== lastDay) {
            const summary = result.byDay[transfer.day - 1];
            console.log(
              `\n  ── day ${transfer.day} — ${summary.count} transfer(s), ${summary.totalEth} ETH ──`
            );
            lastDay = transfer.day;
          }
          console.log(
            `  [${String(send.order).padStart(width)}/${result.transfers.length}] ` +
              `${offset(transfer.dueAt - campaignStart)}  ${new Date(transfer.dueAt).toISOString()}  ` +
              `${eth(transfer.amountEth)} ETH → ${transfer.address}  (real +${hhmmss(send.at - realStart)})`
          );
        }
        printed += 1;
      }

      const status = runner.status(USER, campaign.id);
      if (status && (status.status === 'complete' || status.status === 'halted')) {
        clearInterval(tick);
        resolve(status);
      }
    }, 50);
  });

  const realMs = Date.now() - realStart;
  const status = runner.status(USER, campaign.id);
  runner._reset();

  // ── the assertions ────────────────────────────────────────────────────────
  //
  // Read back off DISK, not out of the objects this process has been holding.
  // The whole claim of the feature is that the plan survives on disk, so
  // asserting against the in-memory copy would assert the wrong thing.
  v4store._reset();
  const persisted = v4store.storeFor(USER).get(campaign.id);
  const transfers = persisted.transfers;

  const failures = [];
  const note = (ok, what, detail) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(what);
  };

  console.log(`\n  campaign ${status.status} in ${hhmmss(realMs)} of real time ` +
    `(${status.sent} sent, ${status.abandoned} abandoned, ${status.pending} pending)\n`);

  // 1. Every wallet funded exactly once.
  const fundedCounts = new Map();
  for (const send of sends) fundedCounts.set(send.walletId, (fundedCounts.get(send.walletId) || 0) + 1);
  const missing = walletIds.filter((id) => !fundedCounts.has(id));
  const twice = [...fundedCounts.entries()].filter(([, n]) => n > 1);
  note(
    sends.length === walletCount && !missing.length && !twice.length,
    'every wallet funded exactly once',
    `${sends.length} send(s) for ${walletCount} wallet(s)` +
      (missing.length ? `, ${missing.length} never funded (${missing.slice(0, 5).join(', ')})` : '') +
      (twice.length ? `, ${twice.length} funded more than once (${twice.slice(0, 5).map(([id, n]) => `${id}×${n}`).join(', ')})` : '')
  );

  // 2. No two sends share an instant.
  const byInstant = new Map();
  for (const t of transfers) byInstant.set(t.dueAt, (byInstant.get(t.dueAt) || 0) + 1);
  const collisions = [...byInstant.entries()].filter(([, n]) => n > 1);
  note(
    !collisions.length,
    'no two sends share an instant',
    collisions.length
      ? `${collisions.length} instant(s) carry more than one transfer`
      : `${byInstant.size} distinct due times for ${transfers.length} transfers`
  );

  // And the same thing again from the other side: the runner never had two in
  // flight at once. A duplicate dueAt is one route to a shared nonce; a slow
  // send overlapping the next tick is the other.
  note(!guard.violations.length, 'never two sends in flight at once', guard.violations[0] || 'inFlight held throughout');

  // 3. Daily counts stayed inside the configured range.
  const perDay = new Map();
  for (const t of transfers) perDay.set(t.day, (perDay.get(t.day) || 0) + 1);
  const outOfRange = [...perDay.entries()].filter(
    ([, n]) => n < params.perDayMin || n > params.perDayMax
  );
  const counts = [...perDay.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  note(
    perDay.size === params.days && !outOfRange.length,
    `daily counts inside ${params.perDayMin}–${params.perDayMax}`,
    `${perDay.size} day-group(s), counts ${Math.min(...counts)}–${Math.max(...counts)}` +
      (outOfRange.length ? `, out of range on day(s) ${outOfRange.map(([d]) => d).join(', ')}` : '')
  );

  // 4. Every transfer landed inside its own day's window.
  const spilled = transfers.filter((t) => {
    const dayStart = campaignStart + (t.day - 1) * DAY_MS;
    return t.dueAt < dayStart || t.dueAt >= dayStart + DAY_MS;
  });
  note(
    !spilled.length,
    'every transfer inside its own day',
    spilled.length
      ? `${spilled.length} spilled, worst by ${hhmmss(Math.max(...spilled.map((t) => Math.abs(t.dueAt - (campaignStart + (t.day - 1) * DAY_MS)) - DAY_MS)))}`
      : `${transfers.length} transfers across ${params.days} days`
  );

  // Not one of the four, but free to check and the thing an operator would
  // notice first: sends went out in the order the plan asked for.
  const planOrder = transfers.slice().sort((a, b) => a.dueAt - b.dueAt).map((t) => t.walletId);
  const sentOrder = sends.map((s) => s.walletId);
  const firstDivergence = planOrder.findIndex((id, i) => id !== sentOrder[i]);
  note(
    firstDivergence === -1,
    'sends fired in schedule order',
    firstDivergence === -1 ? `${sentOrder.length} in order` : `diverges at position ${firstDivergence + 1}`
  );

  console.log('');
  for (const day of [...perDay.keys()].sort((a, b) => a - b)) {
    const rows = transfers.filter((t) => t.day === day).sort((a, b) => a.dueAt - b.dueAt);
    const gaps = rows.slice(1).map((t, i) => t.dueAt - rows[i].dueAt);
    const dayEth = rows.reduce((s, t) => s + Number(t.amountEth), 0);
    console.log(
      `  day ${String(day).padStart(2)}  ${String(rows.length).padStart(3)} sends  ` +
        `${offset(rows[0].dueAt - campaignStart)} → ${offset(rows[rows.length - 1].dueAt - campaignStart)}  ` +
        `gaps ${hhmmss(Math.min(...gaps))}–${hhmmss(Math.max(...gaps))}  ${dayEth.toFixed(6)} ETH`
    );
  }

  console.log(
    `\n${failures.length ? `${failures.length} ASSERTION(S) FAILED` : 'ALL ASSERTIONS PASSED'} — ` +
      `${sends.length} send(s), ${params.days} day-group(s), ${hhmmss(realMs)} real, ` +
      `${hhmmss(estimatedMs * scale)} of campaign time at ${scale}×.`
  );
  console.log(`Sandbox left in place for inspection: ${SANDBOX}`);

  return failures.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`SIMULATION ERROR: ${err.message}`);
    process.exit(1);
  });
