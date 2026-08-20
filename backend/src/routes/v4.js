'use strict';

/**
 * Every /api/v4/* endpoint — the seasoning campaigns' whole surface.
 *
 * SEPARATE FROM routes/wallets.js, routes/launch.js AND routes/v3.js BY DESIGN,
 * and mounted beside them rather than inside them. A router that can be
 * unmounted in one line is the strongest form of the isolation promise.
 *
 * THE BACKUP GATE IS THE MOST IMPORTANT REFUSAL IN THIS FILE. A campaign is
 * about to send real ETH to hundreds of wallets over three weeks. If the
 * keystore is lost before those keys have been exported even once, every wei is
 * unrecoverable — there is no seed phrase behind these wallets, they are random
 * keys in one encrypted file on one machine. So POST /v4/campaigns refuses to
 * start until every seed wallet in the plan appears in a backup on record, and
 * it names the ones that do not.
 *
 * PREVIEW AND COMMIT ARE SEPARATE CALLS ON PURPOSE. POST /v4/campaigns/preview
 * returns the plan AND the seed that produced it, and never writes anything.
 * POST /v4/campaigns posts that seed and those params back, and this file
 * REGENERATES the plan from them server-side rather than trusting a transfer
 * list a browser has had its hands on. Same seed and same params reproduce the
 * same plan byte for byte (see v4/plan.js and v4/rng.js), so what an operator
 * read in the preview is provably what starts.
 *
 * EVERY PARAMS OBJECT THIS FILE HANDS TO plan.generate() HAS BEEN THROUGH
 * plan.normaliseParams() FIRST. A review of Task 4 proved that generate() can
 * be handed a hand-built params object that skips normaliseParams entirely —
 * it re-validates only the day-boundary invariant, not the rest of
 * normaliseParams's coercion and bounds checks — and silently schedules
 * transfers up to an hour outside their days. This route file is exactly where
 * that mistake would be made, so resolveWalletIds/buildCampaignPreview/
 * resolveCampaignStart below always run `plan.normaliseParams(body.params)`
 * and never assemble a params object of their own.
 */

const crypto = require('crypto');
const express = require('express');
const { formatEther } = require('ethers');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { requireApiKey, requireAuthConfigured } = require('../middleware/auth');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const config = require('../config');
const v4roles = require('../v4/roles');
const plan = require('../v4/plan');
const { storeFor } = require('../v4/store');
const runner = require('../v4/runner');
const rng = require('../v4/rng');
const seasoned = require('../v4/seasoned');

const router = express.Router();

/**
 * BigInts out of the response.
 *
 * Copied rather than imported from another route module — see the header of
 * routes/v3.js, which does the same for the same reason: importing a route
 * module to borrow a seven-line helper pulls its whole router in as a side
 * effect, and this file is meant to be detachable in one line.
 */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

// ── the pure guards ───────────────────────────────────────────────────────
// Exported on module.exports._private so they can be unit-tested without an
// HTTP harness — this repo has no supertest dependency.

function assertV4Role(role) {
  if (!v4roles.isV4Role(role)) {
    throw new Error(`role must be one of ${Object.values(v4roles.ROLES).join(', ')}`);
  }
}

function assertConfirmed(body) {
  if ((body || {}).confirm !== true) throw new Error('this requires { confirm: true }');
}

// How many wallets one POST /v4/wallets/generate call may create.
//
// THIS NUMBER IS A BUDGET FOR BLOCKED TIME, NOT A LIMIT ON WALLETS. Key
// generation runs on the one event loop the runner's timers and every other
// tab's requests share, so a long call stalls a concurrent V1 launch — the one
// thing this feature must never do.
//
// It was 200, because generating cost ~7ms a wallet: keystore.generate() wrote
// the whole file once per wallet, and built each key through
// HDNodeWallet.createRandom(), which mints a BIP-39 mnemonic this keystore
// stores nowhere and immediately discards. Both are fixed — one write per call,
// and keys straight from the CSPRNG — and the measured cost fell from 4815ms
// per thousand to 725ms.
//
// So 5000 now buys roughly the same stall 200 used to: about four seconds at
// the very top, and well under a second for the few hundred a campaign
// actually wants. A ceiling still exists because a typed 500000 should be
// refused rather than freezing the box for six minutes.
const MAX_GENERATE_COUNT = 5000;

function assertGenerateCount(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_GENERATE_COUNT) {
    throw new Error(`count must be between 1 and ${MAX_GENERATE_COUNT}`);
  }
}

function assertMaster(walletId, masters) {
  if (!masters.some((w) => w.id === walletId)) {
    throw new Error(`wallet ${walletId} is not a v4master funding wallet`);
  }
}

/**
 * Only funding wallets may be imported. Seeds may not — see the header on the
 * import route for why an imported key is not a fresh wallet however long it
 * then sits.
 */
function assertImportRole(role) {
  if (role !== v4roles.ROLES.master) {
    throw new Error(
      `only ${v4roles.ROLES.master} wallets can be imported. A ${v4roles.ROLES.seed} wallet is ` +
        'worth seasoning because its history starts with the transfer that funds it, and an ' +
        'imported key already has one. Generate seed wallets instead.'
    );
  }
}

/**
 * A wallet may not be deleted while a campaign still needs it.
 *
 * V4 originally exposed no delete at all, on the reasoning that any wallet in
 * these tables might be halfway through a three-week schedule. That is true of
 * SOME of them and was too blunt for the rest: a funding wallet created by
 * mistake, or one an operator has finished with, has nothing to protect and no
 * way out of the console.
 *
 * So the refusal is narrowed to what actually breaks. A wallet is busy if it
 * funds a campaign that could still run, or is owed a transfer by one — halted
 * counts, because halted is resumable and resuming would then find the wallet
 * gone. Complete and cancelled campaigns hold nothing.
 *
 * @param {object[]} campaigns every campaign in the store
 */
/**
 * When each seed wallet was actually funded, and how long ago.
 *
 * THE BACKUP FILE HAS TO CARRY THIS OR IT CANNOT BE USED SAFELY. The whole
 * value of a seed wallet is its age, and a file of a hundred indistinguishable
 * keys is exactly how an operator reaches for one funded yesterday while
 * believing the batch is five days old. The console shows the age; the file
 * people actually work from did not, and the file is what outlives the tab.
 *
 * `fundedAt` is the moment the transfer was SENT, not the moment the key was
 * made. Those differ by however long the campaign took to reach that wallet —
 * up to the whole length of the run — and it is the funding that starts the
 * clock anything looking at the chain can see.
 *
 * A wallet with no record is `null` rather than zero: never funded and funded
 * moments ago are different facts, and a zero would read as the second.
 */
function fundingFacts(campaigns, nowMs) {
  const byWallet = new Map();
  for (const c of campaigns) {
    for (const t of c.transfers || []) {
      if (t.status !== 'sent' || !t.sentAt) continue;
      const at = Date.parse(t.sentAt);
      byWallet.set(t.walletId, {
        fundedAt: t.sentAt,
        daysSinceFunded: Math.floor((nowMs - at) / plan.DAY_MS),
        campaign: c.name || c.id,
        campaignDay: t.day ?? null,
        amountEth: t.amountEth ?? null,
      });
    }
  }
  return byWallet;
}

function assertNotBusy(walletId, campaigns) {
  const LIVE = new Set(['running', 'paused', 'halted']);
  for (const c of campaigns) {
    if (!LIVE.has(c.status)) continue;
    if (c.masterWalletId === walletId) {
      throw new Error(
        `wallet is funding campaign "${c.name || c.id}" (${c.status}) and cannot be deleted. ` +
          'Cancel that campaign first — cancelling is final, so read what it has already sent.'
      );
    }
    const owed = (c.transfers || []).some((t) => t.walletId === walletId && t.status === 'pending');
    if (owed) {
      throw new Error(
        `campaign "${c.name || c.id}" (${c.status}) still owes this wallet a transfer and cannot ` +
          'pay a wallet that does not exist. Cancel that campaign first.'
      );
    }
  }
}

function assertUnclaimed(walletIds, claimed) {
  const taken = walletIds.filter((id) => claimed.has(id));
  if (taken.length) {
    throw new Error(
      `${taken.length} wallet(s) are already claimed by another campaign: ${taken.slice(0, 5).join(', ')}` +
        `${taken.length > 5 ? '…' : ''}. A wallet funded twice has two funding edges.`
    );
  }
}

function assertBackedUp(walletIds, backedUpFn) {
  const missing = backedUpFn(walletIds);
  if (missing.length) {
    throw new Error(
      `${missing.length} of ${walletIds.length} seed wallets have no key backup on record: ` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}. ` +
        'Download the V4 backup first — these keys exist in one encrypted file and nowhere else, ' +
        'and a campaign funds them with real ETH.'
    );
  }
}

// ── small pure helpers ────────────────────────────────────────────────────

/**
 * V4's own wallets, and nothing else. Used by the backup route so a V4 request
 * can never put another tab's private keys on the wire — the keystore is
 * shared, but the roles are not (see v4/roles.js).
 */
function onlyV4Wallets(wallets) {
  return wallets.filter((w) => v4roles.isV4Role(w.role));
}

/**
 * Which seed wallets a campaign will use.
 *
 * Explicit walletIds must all be known v4seed wallets in this keystore.
 * Omitted means every v4seed wallet that currently exists — the same default
 * v3's resolveRun takes for its bundle targets — so an operator who generated
 * exactly the wallets they want does not have to list them by id.
 */
/**
 * Which kind of campaign a body describes, validated.
 *
 * 'season' feeds fresh seed wallets over weeks and is what every campaign was
 * before splits existed — so an absent `kind` reads as 'season', and nothing
 * written by an older console changes meaning.
 *
 * 'split' spreads one funding wallet across the others, through the same Relay
 * hop, so twelve funders can be filled without twelve hand-made transfers from
 * one address — which is the single most recognisable pattern this feature
 * otherwise leaves behind.
 */
function resolveKind(body) {
  const kind = (body || {}).kind || 'season';
  if (kind !== 'season' && kind !== 'split') {
    throw new Error(`kind must be "season" or "split", not "${kind}"`);
  }
  return kind;
}

/**
 * A split may not pay its own source.
 *
 * Relaying a wallet to itself burns a fee and a gas payment to move ETH in a
 * circle. It is always a mistake, and it is an easy one to make when the source
 * dropdown and the target list are drawn from the same set of wallets.
 */
function assertNotSelfFunding(walletIds, masterWalletId) {
  if (walletIds.includes(masterWalletId)) {
    throw new Error(
      `wallet ${masterWalletId} is the source of this split and cannot also be one of its ` +
        'targets — a wallet cannot Relay to itself.'
    );
  }
}

function resolveWalletIds(body, ks) {
  // A split's targets are the OTHER funding wallets; a season's are the seeds.
  // The source is excluded from the default set rather than being refused
  // later, so "all of them" means what an operator means by it.
  const kind = resolveKind(body);
  const known =
    kind === 'split'
      ? v4roles.masters(ks).filter((w) => w.id !== body.masterWalletId)
      : v4roles.seeds(ks);
  const roleName = kind === 'split' ? v4roles.ROLES.master : v4roles.ROLES.seed;
  if (Array.isArray(body.walletIds) && body.walletIds.length) {
    // Deduplicated before anything downstream sees it. assertUnclaimed only
    // compares against wallets OTHER campaigns have already claimed — a
    // repeated id inside this one request is invisible to it, and would
    // otherwise fund the same address more than once from one plan: exactly
    // the "two funding edges" assertUnclaimed's own message warns about,
    // reachable straight from a request body.
    const ids = [...new Set(body.walletIds.map(String))];
    if (kind === 'split') assertNotSelfFunding(ids, body.masterWalletId);
    const knownIds = new Set(known.map((w) => w.id));
    const missing = ids.filter((id) => !knownIds.has(id));
    if (missing.length) {
      throw new Error(
        `${missing.length} wallet id(s) are not ${roleName} wallets in this keystore: ` +
          `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`
      );
    }
    return ids;
  }
  return known.map((w) => w.id);
}

// A rough per-transfer gas ceiling for the pre-flight balance check ONLY —
// not the authoritative one. v4/relay.js reads the REAL deposit gas out of
// each quote and re-checks the funding wallet's balance immediately before
// every send. This number only has to be close enough that a campaign is not
// accepted here, run for days, and then found short mid-way through.
const PREVIEW_GAS_LIMIT = 80_000n;

/** plan.estimateCost, with a live gas price folded in. */
async function estimateCampaignCost(transfers, deps = {}) {
  const getFeesFn = deps.getFeesFn || getFees;
  const fees = await getFeesFn();
  const perTransferGasWei = gasCost(fees, PREVIEW_GAS_LIMIT);
  return plan.estimateCost(transfers, { gasWei: perTransferGasWei });
}

/**
 * Validate a request body's params through plan.normaliseParams(), resolve
 * which wallets it covers, and — only when that count fits the params —
 * generate the plan. THIS IS THE ONE PLACE body.params IS ALLOWED TO REACH
 * plan.generate(), and it always goes through normaliseParams first.
 *
 * Never throws on infeasibility: `feasible` is reported in the result rather
 * than raised, so a preview can explain why a plan does not fit instead of
 * just failing. Both POST /v4/campaigns/preview and (indirectly, via
 * resolveCampaignStart) POST /v4/campaigns call this.
 */
function buildCampaignPreview(body, ks, deps = {}) {
  const nowFn = deps.nowFn || Date.now;
  const newSeedFn = deps.newSeedFn || rng.newSeed;

  const kind = resolveKind(body);
  const params = plan.normaliseParams(body.params || {});
  const walletIds = resolveWalletIds(body, ks);
  const feasible = plan.feasible(walletIds.length, params);
  const seed = body.seed || newSeedFn();

  if (!feasible.ok) {
    return { seed, kind, params, walletIds, byDay: [], totalEth: '0', transfers: [], feasible };
  }

  // The address map must be drawn from the SAME set resolveWalletIds drew from.
  // Built from seeds alone, a split's ids find no address here and every
  // transfer is generated with `address: undefined` — which surfaces not at
  // preview, not at start, but on the day that transfer comes due.
  const pool = kind === 'split' ? v4roles.masters(ks) : v4roles.seeds(ks);
  const addresses = Object.fromEntries(pool.map((w) => [w.id, w.address]));
  const result = plan.generate({ walletIds, addresses, params, seed, now: nowFn() });
  return { ...result, kind, walletIds, feasible };
}

/**
 * Everything POST /v4/campaigns needs before it may call runner.start(): the
 * funding wallet, a normalised and regenerated plan, and a balance that covers
 * it. Runs the guards in the order the spec fixes: assertMaster, then
 * assertUnclaimed, then assertBackedUp, then plan.feasible, then the balance
 * check — so when more than one thing is wrong, the operator is told about the
 * first one in that list, not whichever the code happened to reach first.
 */
async function resolveCampaignStart(body = {}, ks, store, deps = {}) {
  const getFeesFn = deps.getFeesFn || getFees;
  const rpc = deps.rpc || provider;
  const nowFn = deps.nowFn || Date.now;

  if (!body.name) throw new Error('name is required');
  if (!body.seed) {
    throw new Error(
      'seed is required — call POST /v4/campaigns/preview first and post its seed back, so the plan ' +
        'that starts is provably the plan that was previewed'
    );
  }

  const kind = resolveKind(body);
  const masters = v4roles.masters(ks);
  assertMaster(body.masterWalletId, masters);
  const master = masters.find((w) => w.id === body.masterWalletId);

  // Every params object plan.generate() sees below has been through
  // normaliseParams — see the file header for the bypass this closes.
  const params = plan.normaliseParams(body.params || {});
  const walletIds = resolveWalletIds(body, ks);
  // Re-checked here as well as inside resolveWalletIds, because that function
  // only sees the self-funding case when walletIds was supplied explicitly.
  if (kind === 'split') assertNotSelfFunding(walletIds, body.masterWalletId);

  // FIRST, NOT ONLY. Two awaits follow below — estimateCampaignCost and the
  // balance read — before POST /v4/campaigns reaches runner.start(), and this
  // check compares against OTHER campaigns only, so two requests that land
  // inside that window both pass it and neither sees the other. With
  // `walletIds` omitted both resolve to every v4seed wallet, so the overlap is
  // total. runner.start() therefore re-runs the same check immediately before
  // store.create(), where nothing can await between the check and the write.
  // This one stays because it is what gives the operator the error in the
  // documented guard order, before a fee estimate and an RPC round trip.
  // Only a season claims. A split pays funding wallets, which an operator will
  // top up again — see claimedSeedIds in store.js for why claiming them would
  // block that forever and protect nothing. The backup gate applies to both:
  // every wallet about to receive real ETH needs its key on record first.
  if (kind === 'season') assertUnclaimed(walletIds, store.claimedSeedIds());
  assertBackedUp(walletIds, store.backedUp);

  const feasibility = plan.feasible(walletIds.length, params);
  if (!feasibility.ok) throw new Error(feasibility.reason);

  const pool = kind === 'split' ? masters : v4roles.seeds(ks);
  const addresses = Object.fromEntries(pool.map((w) => [w.id, w.address]));
  // REGENERATED from the seed and params posted back — never a transfer list
  // the browser sent. Same seed and params reproduce the same plan byte for
  // byte, so what the operator read in preview is provably what is about to
  // start.
  const result = plan.generate({ walletIds, addresses, params, seed: body.seed, now: nowFn() });

  const cost = await estimateCampaignCost(result.transfers, { getFeesFn });
  const balance = BigInt(await rpc.getBalance(master.address));
  if (balance < cost.totalWei) {
    throw new Error(
      `funding wallet ${master.address} has ${formatEther(balance)} ETH but this campaign needs about ` +
        `${cost.totalEth} ETH (${result.transfers.length} transfers, Relay fees and gas included) — fund it first`
    );
  }

  return { master, kind, params, walletIds, result, cost };
}

// ── wallets ─────────────────────────────────────────────────────────────────

/**
 * A funding wallet with its balance, and null when the chain will not say.
 *
 * BALANCES FOR THE MASTERS ONLY, NEVER FOR THE SEEDS. A campaign halts the
 * moment its funding wallet runs dry, so this is the one figure the console
 * sizes a campaign against — and there are a handful of masters, one per
 * campaign. The seeds are hundreds, on a tab that re-reads while a campaign
 * runs, and their balance does not move after the single transfer that funds
 * them: the amount that plan sent is already on record in the campaign, so
 * hundreds of RPC calls a minute would buy nothing that is not already known.
 *
 * A balance that cannot be read is null rather than a failed request. GET
 * /v4/wallets is what draws the whole tab, and an unreachable RPC must not be
 * able to hide which wallets exist — that is the moment an operator most needs
 * to see them. null is also deliberately not 0: a wallet drawn empty when it
 * holds two ETH is the reading that has somebody fund it twice.
 */
async function withMasterBalance(wallet, rpc = provider) {
  try {
    return { ...wallet, balanceEth: formatEther(await rpc.getBalance(wallet.address)) };
  } catch (_err) {
    return { ...wallet, balanceEth: null };
  }
}

// GET /api/v4/wallets — V4's two groups. Never key material.
router.get('/v4/wallets', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);

    const masters = v4roles.masters(ks);
    const seeds = v4roles.seeds(ks);

    // "in a campaign" means any campaign not yet terminal — running, paused or
    // halted all still hold a claim on the wallet worth flagging before the
    // operator points a new campaign at it. complete/cancelled campaigns are
    // over and their wallet is free.
    const activeStatuses = new Set(['running', 'paused', 'halted']);
    const busyMasters = new Set(
      store
        .campaigns()
        .filter((c) => activeStatuses.has(c.status))
        .map((c) => c.masterWalletId)
    );

    const claimed = store.claimedSeedIds();
    const missingBackup = new Set(store.backedUp(seeds.map((w) => w.id)));
    const now = Date.now();
    const walletFacts = fundingFacts(store.campaigns(), now);

    const masterRows = await Promise.all(
      masters.map(async (w) => ({ ...(await withMasterBalance(w)), inCampaign: busyMasters.has(w.id) }))
    );

    res.json(
      jsonSafe({
        masters: masterRows,
        seeds: seeds.map((w) => ({
          ...w,
          claimed: claimed.has(w.id),
          backedUp: !missingBackup.has(w.id),
          // Since the key was made. Kept because it is what "this wallet has
          // existed for N days" means to the keystore — but it is NOT the age
          // anything reading the chain can see, and it is not what decides
          // whether a wallet is safe to spend. See daysSinceFunded.
          ageDays: Math.floor((now - Date.parse(w.createdAt)) / plan.DAY_MS),
          // THE AGE THAT MATTERS. Generating a key touches nothing on chain, so
          // a wallet's visible life starts at the transfer that funds it — and
          // in a five-day campaign the wallets fed on the last day are four days
          // younger than the first day's, permanently. null until funded.
          ...(walletFacts.get(w.id) || { fundedAt: null, daysSinceFunded: null }),
        })),
        roles: v4roles.ROLES,
        // The form's starting numbers come from HERE, not from a copy in the
        // console. They were duplicated in V4PlanPanel and drifted the first
        // time this file's DEFAULTS changed: the backend planned 3-day
        // campaigns while the form still opened on 20, so the number an
        // operator read was not the number the server would have used had they
        // left the field alone. One source, shipped with the data the panel
        // already fetches on mount.
        planDefaults: plan.DEFAULTS,
      })
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/v4/seasoned — the seed wallets aged enough for V1/V3 to claim.
router.get('/v4/seasoned', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const wallets = seasoned.available(ks, store, Date.now());
    res.json({
      count: wallets.length,
      minHours: config.seasonedMinHours,
      wallets,
      // Newest-first, per store.graduated() — the V4 console's read-only record
      // of every seed already handed off to V1/V3, so an operator can see where
      // a wallet went without cross-referencing another tab's list.
      graduated: store.graduated(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v4/wallets/generate — fresh wallets in one of V4's two roles.
router.post('/v4/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, role, label } = req.body || {};
    assertV4Role(role);
    const n = Number(count);
    assertGenerateCount(n);

    const made = keystoreFor(req.user.id).generate(n, { role, label });
    activityFor(req.user.id).record('v4', `[v4] generated ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v4/wallets/:id — archive a V4 wallet.
//
// The key is NOT destroyed: keystore.remove() moves the wallet into the
// encrypted archive beside the keystore, recoverable with `npm run
// archive:restore`. It can still be destroyed indirectly — the archive is
// capped, so an old entry may be evicted to make room, and each eviction is
// logged by address because that line is very likely the only remaining trace
// the key ever existed.
//
// REFUSES WHILE A CAMPAIGN STILL NEEDS THE WALLET. See assertNotBusy: a funder
// mid-schedule, or a wallet a live campaign still owes a transfer to, would
// leave that campaign unable to complete and no way to tell why.
//
// ETH IN THE WALLET IS NOT A REFUSAL, only a warning the console shows before
// asking. The balance may be the reason for deleting it — a wallet being
// retired after a sweep — and a route that refused would leave dust permanently
// undeletable.
router.delete('/v4/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const wallet = v4roles
      .all(ks)
      .masters.concat(v4roles.all(ks).seeds)
      .find((w) => w.id === req.params.id);
    if (!wallet) {
      throw new Error(`wallet ${req.params.id} is not a V4 wallet — this route deletes V4's only`);
    }
    assertNotBusy(req.params.id, storeFor(req.user.id).campaigns());

    const out = ks.remove(req.params.id);
    activityFor(req.user.id).record(
      'v4',
      `[v4] archived ${wallet.role} wallet ${out.address} — recoverable from the server until purged`,
      { role: wallet.role, address: out.address }
    );
    // One line per evicted address, never a count. The archive is capped, so
    // this delete may have destroyed an OLDER key to make room — an
    // irreversible loss nobody asked for, on a request about a different
    // wallet, and an address is the only thing an operator can act on.
    for (const gone of out.evicted || []) {
      activityFor(req.user.id).record(
        'v4',
        `evicted wallet ${gone.address} from a full archive — its key is destroyed`,
        { address: gone.address, deletedAt: gone.deletedAt, reason: 'archive full' }
      );
    }
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
});

// POST /api/v4/wallets/import — an existing key, as a FUNDING wallet only.
//
// SEEDS CANNOT BE IMPORTED, and that refusal is the only reason this route
// checks a role at all. A seed wallet is worth seasoning because its entire
// on-chain existence begins with the transfer that funds it: no history, no
// counterparties, nothing to correlate against. A key imported from elsewhere
// has already lived, and whatever it did it did with an address that is now
// about to be aged as though it were new. That is not seasoning a fresh
// wallet, it is seasoning an old one and calling it fresh.
//
// A funding wallet is a different case and is allowed. It is plumbing: it pays
// and does nothing else, and an operator who already holds a clean funded
// wallet saves the one transfer in this whole pipeline that nothing
// randomises. The caveat is real and the console states it — a funder with
// history hands that history to everything it pays for. The Relay hop breaks
// the funder-to-seed edge and does nothing whatever about the funder's past.
//
// requireAuthConfigured for the same reason the backup route carries it: a
// private key crosses the wire, and a deployment with no auth configured must
// fail closed rather than accept one from anybody who can reach the port.
router.post('/v4/wallets/import', requireApiKey, requireAuthConfigured, (req, res, next) => {
  try {
    const { privateKeys, label } = req.body || {};
    const role = (req.body || {}).role || v4roles.ROLES.master;
    assertImportRole(role);
    const keys = (Array.isArray(privateKeys)
      ? privateKeys
      : String(privateKeys || '').split(/[\s,]+/)
    )
      .map((k) => String(k).trim())
      .filter(Boolean);
    if (!keys.length) throw new Error('privateKeys is required');

    const made = keystoreFor(req.user.id).importKeys(keys, { role, label });
    // The keys themselves are never logged — only what they resolved to, the
    // same line routes/wallets.js writes for its own import.
    activityFor(req.user.id).record('v4', `[v4] imported ${made.length} funding wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// POST /api/v4/wallets/backup — every V4 key at once, for an offline backup.
// Same two locks as routes/wallets.js's whole-keystore backup, because the
// risk is identical: whoever holds the file this produces controls every
// wallet in it. requireAuthConfigured fails CLOSED rather than serving keys
// from a deployment that never set up a credential.
router.post(
  '/v4/wallets/backup',
  requireApiKey,
  requireAuthConfigured,
  (req, res, next) => {
    try {
      assertConfirmed(req.body);
      const ks = keystoreFor(req.user.id);
      const store = storeFor(req.user.id);
      const now = Date.now();
      const facts = fundingFacts(store.campaigns(), now);

      // Every V4 key, each carrying WHEN it was funded — see fundingFacts for
      // why a file without that cannot be used safely.
      const all = onlyV4Wallets(ks.exportAll()).map((w) => ({
        ...w,
        ...(facts.get(w.id) || { fundedAt: null, daysSinceFunded: null }),
      }));

      // Optional: only wallets that have been sitting at least this long.
      // Answers the question the file is opened to answer — "which of these is
      // safe to use today" — rather than leaving an operator to sort a hundred
      // rows by hand and get it wrong once. Funding wallets are never filtered
      // out: they are not aged, they are plumbing, and a backup missing the
      // wallet holding the ETH is the one gap this file must never have.
      const minAge = Number((req.body || {}).minAgeDays);
      const seasoned = Number.isFinite(minAge) && minAge > 0;
      const wallets = seasoned
        ? all.filter(
            (w) => w.role === v4roles.ROLES.master || (w.daysSinceFunded ?? -1) >= minAge
          )
        : all;

      // Recorded against what was EXPORTED, not what exists. A filtered
      // download must not mark the wallets it left out as backed up — the gate
      // in step 3 would then let a campaign start on keys that are in no file.
      const ids = wallets.map((w) => w.id);
      store.recordBackup(ids);

      console.warn(`[pons-launcher] V4 KEYSTORE BACKUP EXPORTED — ${wallets.length} private keys`);
      // The count and the fact, never the keys.
      activityFor(req.user.id).record('export', `[v4] downloaded a backup of ${wallets.length} v4 private key(s)`, {
        count: wallets.length,
      });

      res.json({
        exportedAt: new Date().toISOString(),
        chainId: config.chainId,
        count: wallets.length,
        minAgeDays: seasoned ? minAge : null,
        // Said in the file, because the file is read months later by someone
        // who no longer remembers which button produced it.
        note: seasoned
          ? `Filtered: seed wallets funded at least ${minAge} day(s) ago, plus every funding wallet. ` +
            `${all.length - wallets.length} wallet(s) were left out and are NOT in this file.`
          : 'Every V4 wallet. Each seed carries fundedAt and daysSinceFunded — a wallet is only ' +
            'worth what its age is worth, so check that before spending one.',
        warning:
          'These private keys control real funds. Anyone holding this file can spend every wallet in it. ' +
          'Store it offline. There are no mnemonics: the keystore holds private keys only.',
        wallets,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── campaigns ───────────────────────────────────────────────────────────────

// GET /api/v4/campaigns — summaries, not full transfer lists.
router.get('/v4/campaigns', requireApiKey, (req, res, next) => {
  try {
    const store = storeFor(req.user.id);
    const summaries = store.campaigns().map((c) => ({
      ...runner.status(req.user.id, c.id),
      seed: c.seed,
      params: c.params,
      createdAt: c.createdAt,
    }));
    res.json(jsonSafe(summaries));
  } catch (err) {
    next(err);
  }
});

// GET /api/v4/campaigns/:id — one campaign, transfers included.
router.get('/v4/campaigns/:id', requireApiKey, (req, res, next) => {
  try {
    const campaign = storeFor(req.user.id).get(req.params.id);
    if (!campaign) throw new Error(`no campaign ${req.params.id}`);
    const live = runner.status(req.user.id, campaign.id) || {};
    res.json(
      jsonSafe({
        ...campaign,
        armed: live.armed,
        inFlight: live.inFlight,
        nextDueAt: live.nextDueAt,
        nextDueIso: live.nextDueIso,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Divide seed wallets across funding wallets, evenly and deterministically.
 *
 * EVENLY IS NOT A NICETY, it is what keeps every campaign feasible. A plan's
 * floor is `days x perDayMin`, so a funder handed 1 wallet for a 2-day campaign
 * is refused outright while its neighbour with 2 starts fine. Giving every
 * funder the same count means one set of params describes all of them, and a
 * batch either starts completely or refuses completely — never eleven of
 * twenty, leaving an operator to work out which nine and why.
 *
 * Anything that does not divide is left unclaimed rather than pushed onto the
 * last funder. Those wallets are still there for the next batch; a lopsided
 * campaign is not.
 */
function divideSeeds(seedIds, funderIds, seedsPerFunder) {
  const per = Math.max(1, Math.round(Number(seedsPerFunder) || 0));
  const usable = Math.min(funderIds.length, Math.floor(seedIds.length / per));
  if (usable < 1) {
    throw new Error(
      `${seedIds.length} unclaimed seed wallet(s) is not enough for even one funder at ` +
        `${per} each — generate more in step 2, or lower the count.`
    );
  }
  return funderIds.slice(0, usable).map((funderId, i) => ({
    funderId,
    walletIds: seedIds.slice(i * per, (i + 1) * per),
  }));
}

/**
 * POST /api/v4/campaigns/batch — one campaign per funding wallet, in one call.
 *
 * WHY THIS EXISTS. A campaign is one funder feeding its own wallets, because
 * two campaigns sharing a funder would collide on that wallet's nonce. That is
 * the right rule and it is not going away — but it meant an operator holding
 * twenty funders had to set up twenty campaigns by hand, which made the split
 * that fills twenty funders only half a feature.
 *
 * This loops. It is not a new kind of run: every campaign it creates goes
 * through the same resolveCampaignStart as a single one, so every guard, the
 * regenerated plan and the balance check all apply per funder exactly as they
 * would have if the operator had typed each one.
 *
 * PARTIAL SUCCESS IS REPORTED, NOT HIDDEN. The whole point is that the
 * expensive checks are per funder — one wallet short of ETH must not stop the
 * other nineteen — so a failure is recorded against its funder and the loop
 * continues. The response carries both lists and the console draws them.
 */
router.post('/v4/campaigns/batch', requireApiKey, async (req, res, next) => {
  try {
    const body = req.body || {};
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);

    // Only funders that are free. A busy one would be refused by runner.start()
    // anyway; excluding it here means the batch reports "18 started" rather than
    // "18 started, 2 failed" for a state that is not an error.
    const busy = new Set(store.running().map((c) => c.masterWalletId));
    // An ARRAY means "these", even when it is empty — only a missing field
    // means "all of them". Treating [] as absent would turn "none selected"
    // into "every funder", which is the one misreading of this parameter that
    // spends money the caller did not ask to spend.
    const requested = Array.isArray(body.funderIds) ? body.funderIds : null;
    if (requested && !requested.length) throw new Error('funderIds is empty — no funding wallet was chosen');
    const funders = v4roles
      .masters(ks)
      .filter((w) => !busy.has(w.id))
      .filter((w) => !requested || requested.includes(w.id));
    if (!funders.length) throw new Error('no free funding wallets — every one is already running a campaign');

    const claimed = store.claimedSeedIds();
    const seedIds = v4roles
      .seeds(ks)
      .filter((w) => !claimed.has(w.id))
      .map((w) => w.id);

    const slices = divideSeeds(seedIds, funders.map((w) => w.id), body.seedsPerFunder);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

    const started = [];
    const failed = [];
    for (const [i, slice] of slices.entries()) {
      try {
        // A seed of its own per campaign, or twenty funders would run the same
        // schedule — same days, same amounts, same gaps — and the randomisation
        // this feature exists for would be one plan copied twenty times.
        const seed = rng.newSeed();
        const perBody = {
          ...body,
          kind: 'season',
          name: body.name ? `${body.name} ${i + 1}` : `batch ${stamp} · ${i + 1}`,
          masterWalletId: slice.funderId,
          walletIds: slice.walletIds,
          seed,
        };
        const { master, kind, params, result } = await resolveCampaignStart(perBody, ks, store);
        const status = runner.start(req.user.id, {
          id: crypto.randomUUID(),
          name: perBody.name,
          kind,
          masterWalletId: master.id,
          seed: result.seed,
          params,
          transfers: result.transfers,
          byDay: result.byDay,
          totalEth: result.totalEth,
          createdAt: new Date().toISOString(),
        });
        started.push(status);
      } catch (err) {
        failed.push({
          masterWalletId: slice.funderId,
          walletIds: slice.walletIds,
          error: err.message,
        });
      }
    }

    activityFor(req.user.id).record(
      'v4',
      `[v4] batch started ${started.length} campaign(s)` +
        (failed.length ? `, ${failed.length} refused` : ''),
      { started: started.length, failed: failed.map((f) => f.error) }
    );
    res.json(jsonSafe({ started, failed, unusedSeeds: seedIds.length - slices.length * Math.max(1, Math.round(Number(body.seedsPerFunder) || 0)) }));
  } catch (err) {
    next(err);
  }
});

// POST /api/v4/campaigns/preview — a dry run. Broadcasts and writes nothing;
// returns the plan AND the seed that produced it, so the follow-up commit can
// post the same seed back rather than a transfer list the browser generated.
router.post('/v4/campaigns/preview', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const out = buildCampaignPreview(req.body || {}, ks);
    const cost = out.feasible.ok ? await estimateCampaignCost(out.transfers) : null;
    res.json(
      jsonSafe({
        seed: out.seed,
        params: out.params,
        walletIds: out.walletIds,
        byDay: out.byDay,
        totalEth: out.totalEth,
        cost,
        feasible: out.feasible,
      })
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v4/campaigns — creates AND starts. Guard order: assertMaster,
// assertUnclaimed, assertBackedUp, plan.feasible, the balance check — all
// inside resolveCampaignStart — and only then runner.start(). The plan is
// REGENERATED from the posted-back seed and params, never trusted from the
// request as a transfer list.
router.post('/v4/campaigns', requireApiKey, async (req, res, next) => {
  try {
    const body = req.body || {};
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);

    const { master, kind, params, result } = await resolveCampaignStart(body, ks, store);

    const campaign = {
      id: crypto.randomUUID(),
      name: body.name,
      // Persisted so claimedSeedIds can tell the two apart forever after — a
      // split that read back as a season would silently claim twelve funding
      // wallets and refuse to ever top them up again.
      kind,
      masterWalletId: master.id,
      seed: result.seed,
      params,
      transfers: result.transfers,
      byDay: result.byDay,
      totalEth: result.totalEth,
      createdAt: new Date().toISOString(),
    };

    // runner.start() logs its own "[v4] ... started" activity entry — nothing
    // more is added here, or the log would carry two lines for one action.
    const status = runner.start(req.user.id, campaign);
    res.json(jsonSafe(status));
  } catch (err) {
    next(err);
  }
});

router.post('/v4/campaigns/:id/pause', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(runner.pause(req.user.id, req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/v4/campaigns/:id/resume', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(runner.resume(req.user.id, req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/v4/campaigns/:id/cancel', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(runner.cancel(req.user.id, req.params.id)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._private = {
  jsonSafe,
  assertV4Role,
  assertConfirmed,
  assertMaster,
  assertUnclaimed,
  assertBackedUp,
  assertImportRole,
  resolveKind,
  assertNotSelfFunding,
  assertNotBusy,
  divideSeeds,
  fundingFacts,
  assertGenerateCount,
  MAX_GENERATE_COUNT,
  onlyV4Wallets,
  withMasterBalance,
  resolveWalletIds,
  buildCampaignPreview,
  estimateCampaignCost,
  resolveCampaignStart,
};
