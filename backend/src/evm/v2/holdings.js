'use strict';

// Finding what a bundle can actually sell.
//
// THE SELECTION RULE IS `launched-by-dev INTERSECT held-by-bundle`, AND THE
// FIRST HALF IS THE SAFETY PROPERTY. Do not "improve" this by listing whatever
// the wallets happen to hold.
//
// Selling a token means approving its contract and then calling into it. A
// hostile ERC-20 can do anything it likes inside transferFrom, including
// behaving differently per address. Bundle wallets get dusted constantly — they
// are funded, they are visible on chain, and airdropping them a poisoned token
// costs an attacker nothing. If the picker listed tokens by balance, dusting
// would become a way to get an arbitrary contract approved by twenty funded
// wallets at once, with the operator clicking the button.
//
// So the candidate set is this user's launch history plus, only when history
// has nothing to offer, the factory's own TokenLaunched events filtered on the
// indexed `deployer` — and EVERY candidate is then re-checked against the
// factory's getLaunchedToken record. A token gets into the list only if the
// factory says this dev wallet launched it. History says WHERE TO LOOK; it is
// never proof of provenance. Balances only ever narrow the set; never widen it.
//
// HISTORY IS READ FIRST BECAUSE IT IS FREE AND ALMOST ALWAYS RIGHT.
// data/launches.<user>.json records every launch made through this console,
// with the token and the curve, so the ordinary case answers with zero log
// calls. The log scan below exists for launches this console did not make, and
// it is a bounded last resort — read the comment on LOG_WINDOW before touching
// it, because the unbounded version of it hung /api/sellable in production.

const { Contract, Interface, getAddress, formatUnits, ZeroAddress } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { erc20, ERC20_ABI } = require('../erc20');
const { curve } = require('./curve');
const { FACTORY_V2_ABI, CURVE_V2_ABI } = require('./abi');

const iface = new Interface(FACTORY_V2_ABI);
const curveIface = new Interface(CURVE_V2_ABI);
const erc20Iface = new Interface(ERC20_ABI);

// EVERY READ IN THIS FILE IS BATCHED THROUGH MULTICALL3, AND THAT IS NOT A
// MICRO-OPTIMISATION. This node degrades badly under concurrent requests: the
// same eth_call that answers in 0.5s alone took 22s when issued alongside four
// others, and eight concurrent getLogs took 16s against 0.3s each sequentially.
// Listing five tokens across twenty wallets is 125 reads. One at a time that is
// most of a minute; all at once it is worse. As one multicall it is one request.
//
// Multicall3 is at its standard address on this chain (see evm/blocknumber.js).
// allowFailure is always true, so a hostile token that reverts on symbol() costs
// itself a field and nothing else.
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];
// Keeps a single request from growing unbounded with wallets x tokens.
const MULTICALL_CHUNK = 250;

// ── the log scan, and why every one of these caps is load-bearing ──────────
//
// THE UNBOUNDED WALK HUNG /api/sellable IN PRODUCTION. curl never returned, the
// process was healthy, and the error handler never fired — the request was not
// failing, it was still working. Do not widen this back.
//
// What actually happened: the operator's node (QuickNode) refuses any
// eth_getLogs spanning more than 10000 blocks, so the whole-chain query in
// launchedByDeployer always failed and the walk always ran. The chain is at
// ~28.7M blocks and produces ten a second, so reaching block 0 is thousands of
// SEQUENTIAL round trips. Worse, each window the node refuses is retried four
// times with backoff by RetryJsonRpcProvider (see evm/provider.js) before it is
// even split, and each 500k window then split down to something acceptable is
// 63 refusals and 64 accepted calls. Sixty of those is hours, not seconds.
//
// So the walk is capped three ways and all three are needed:
const LOG_WINDOW = 10_000; // what this node will actually answer, so no splitting
const MAX_WINDOWS = 20; // 200k blocks, newest first — recent launches only
// A window count is NOT a time bound: one refused window can still fan out into
// dozens of calls with backoff between them. This is the bound that holds.
const SCAN_BUDGET_MS = 10_000;
// A refused window is halved and retried; this caps that recursion so a node
// that refuses everything fails loudly instead of issuing thousands of calls.
const MAX_SPLIT_DEPTH = 6;

const BPS = 10_000n;

/**
 * Run many reads as one request.
 * @param {Array<{target: string, callData: string}>} calls
 * @returns {Promise<Array<{success: boolean, returnData: string}>>} positional
 */
async function multicall(calls, deps = {}) {
  if (!calls.length) return [];
  const rpc = deps.provider || provider;
  const mc = new Contract(deps.multicallAddress || config.multicallAddress, MULTICALL3_ABI, rpc);

  const out = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const chunk = calls.slice(i, i + MULTICALL_CHUNK).map((c) => ({
      target: c.target,
      allowFailure: true,
      callData: c.callData,
    }));
    const res = await mc.aggregate3.staticCall(chunk);
    for (const r of res) out.push({ success: r[0], returnData: r[1] });
  }
  return out;
}

/** Decode one multicall slot, or null if that call failed. */
function decodeOr(ifc, name, slot, fallback = null) {
  if (!slot || !slot.success || !slot.returnData || slot.returnData === '0x') return fallback;
  try {
    return ifc.decodeFunctionResult(name, slot.returnData)[0];
  } catch (_err) {
    return fallback;
  }
}

function factoryContract(deps = {}) {
  if (deps.factory) return deps.factory;
  const address = deps.factoryAddress || config.v2FactoryAddress;
  if (!address) throw new Error('PONS_V2_FACTORY is not set');
  return new Contract(address, FACTORY_V2_ABI, deps.provider || provider);
}

/**
 * `p`, or `fallback` if `p` has not settled within `ms`.
 *
 * Nothing in ethers can cancel an in-flight RPC call, so this does not try: the
 * point is that the CALLER stops waiting. The abandoned promise is left to
 * finish on its own, with its rejection swallowed — an unhandled rejection
 * arriving after we have already answered would take the process down, which is
 * a worse outcome than the slow list this exists to avoid.
 */
function withDeadline(p, ms, fallback) {
  const settled = Promise.resolve(p);
  settled.catch(() => {});
  let timer;
  return Promise.race([
    settled,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      if (typeof timer.unref === 'function') timer.unref(); // never hold the process open
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What a truncated scan tells the operator: exactly which blocks it saw. */
function truncationWarning(from, to) {
  // from > to means not one window finished — say "no blocks", not "1001-1000".
  const nothing = from == null || (to != null && from > to);
  const covered = nothing ? 'no blocks' : `blocks ${from}-${to ?? 'head'}`;
  return (
    `the launch scan was truncated and only covered ${covered} — launches older than that ` +
    'appear only if they are in this account launch history'
  );
}

/**
 * getLogs for one range, splitting it in half whenever the node refuses.
 *
 * The RPC's refusal is a count limit as well as a range limit, so there is no
 * window size that is always safe — a dev wallet with thousands of launches
 * would trip it at any width. Halving on refusal converges on whatever this
 * node will actually answer, instead of hardcoding a guess.
 *
 * `outOfTime` is checked before every call AND before every split: the split is
 * where an innocent-looking window turns into 127 requests, and that fan-out is
 * half of what made the old scan hang.
 */
async function getLogsSplitting(rpc, base, from, to, out, depth = 0, outOfTime = () => false) {
  if (outOfTime()) throw new Error('the launch scan ran out of time');
  try {
    const logs = await rpc.getLogs({ ...base, fromBlock: from, toBlock: to });
    out.push(...logs);
  } catch (err) {
    if (from >= to || depth >= MAX_SPLIT_DEPTH || outOfTime()) throw err;
    const mid = Math.floor((from + to) / 2);
    await getLogsSplitting(rpc, base, from, mid, out, depth + 1, outOfTime);
    await getLogsSplitting(rpc, base, mid + 1, to, out, depth + 1, outOfTime);
  }
}

/**
 * Every token this deployer launched that the bounded scan can see, newest
 * first. NOT authoritative on its own and NOT the primary source — see the file
 * header: history is read first, and this only runs when history is empty.
 *
 * ONE CALL FOR THE WHOLE CHAIN IS THE FAST PATH, and the windowed walk below it
 * is only what happens when the node refuses that. This is the opposite of what
 * it looks like it should be, so the measurements are recorded here rather than
 * lost:
 *
 *   whole chain (0 → head), deployer-filtered      2.2s, 1 log
 *   one 500k-block window, deployer-filtered       0.3s
 *   sixty 500k windows, eight at a time           76.0s
 *   eight 500k windows concurrently               16.0s
 *
 * The node serialises concurrent getLogs and then some, so issuing windows in
 * parallel is FIVE TIMES SLOWER than issuing them one at a time. Do not
 * "optimise" the fallback by making it concurrent again — and do not "fix" the
 * slowness by removing the caps either, which is what produced the production
 * hang. A truncated list with a warning beats an endless spinner.
 *
 * The whole-chain query is safe where it works because `deployer` is indexed:
 * that RPC's refusal is a limit on MATCHED logs (10000), and one dev wallet's
 * launches are a handful however long the chain gets. QuickNode instead limits
 * the RANGE, so it refuses the query outright and the walk runs every time —
 * which is why the walk's caps, not the fast path, decide how long this takes.
 *
 * @returns {Promise<{launches: Array<{token,curve,pairToken,launchConfigId,blockNumber}>,
 *                    scannedFrom: number, scannedTo: number, complete: boolean,
 *                    warning: ?string}>}
 *   `complete` is false whenever the walk stopped early — out of windows, out of
 *   time, or refused. It NEVER throws and it never returns nothing when it found
 *   something: whatever was seen comes back, with `warning` saying how far it
 *   got, and the caller must show that rather than present a partial list as the
 *   whole truth.
 */
async function launchedByDeployer(deployer, deps = {}) {
  const rpc = deps.provider || provider;
  const window = deps.window || LOG_WINDOW;
  const maxWindows = deps.maxWindows || MAX_WINDOWS;
  const budgetMs = deps.scanBudgetMs ?? SCAN_BUDGET_MS;
  const now = deps.now || Date.now;
  const address = deps.factoryAddress || config.v2FactoryAddress;

  const head = deps.head ?? (await rpc.getBlockNumber());
  const topics = iface.encodeFilterTopics('TokenLaunched', [null, null, getAddress(deployer)]);
  const base = { address, topics };

  // One clock for the whole scan, started before the first request. Every exit
  // below checks it; nothing in here is allowed to outlive it by more than the
  // call already in flight.
  const stopAt = now() + budgetMs;
  const outOfTime = () => now() >= stopAt;

  const raw = [];
  let scannedFrom;
  let complete;

  let whole = null;
  try {
    whole = await rpc.getLogs({ ...base, fromBlock: 0, toBlock: head });
  } catch (_err) {
    // Too many matches, or a node that will not take a range this wide. Fall
    // back — and note this failure is the NORMAL case on QuickNode, not an edge.
    whole = null;
  }

  if (whole) {
    raw.push(...whole);
    scannedFrom = 0;
    complete = true;
  } else {
    // Backwards from the head, one window at a time, splitting any window the
    // node refuses. Sequential on purpose — see the measurements above.
    let to = head;
    scannedFrom = head + 1;
    complete = false;
    for (let i = 0; i < maxWindows && to >= 0; i++) {
      if (outOfTime()) break;
      const from = Math.max(0, to - window + 1);
      try {
        await getLogsSplitting(rpc, base, from, to, raw, 0, outOfTime);
      } catch (_err) {
        // A window this node will not answer, or the budget running out mid
        // split. Either way the scan stops here and says so; throwing would
        // lose the launches the earlier windows already found.
        break;
      }
      scannedFrom = from;
      if (from === 0) {
        complete = true;
        break;
      }
      to = from - 1;
    }
  }

  // One token can only be launched once, but a re-org replay or an overlapping
  // window would double it — keyed by address so it cannot.
  const byToken = new Map();
  for (const log of raw) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch (_err) {
      continue; // some other event from the same contract
    }
    if (!parsed || parsed.name !== 'TokenLaunched') continue;
    const token = getAddress(parsed.args.token);
    byToken.set(token.toLowerCase(), {
      token,
      curve: getAddress(parsed.args.curve),
      pairToken: getAddress(parsed.args.pairToken),
      launchConfigId: Number(parsed.args.launchConfigId),
      blockNumber: Number(log.blockNumber),
    });
  }

  const launches = [...byToken.values()].sort((a, b) => b.blockNumber - a.blockNumber);
  return {
    launches,
    scannedFrom,
    scannedTo: head,
    complete,
    warning: complete ? null : truncationWarning(scannedFrom, head),
  };
}

/**
 * The factory's own record for a token. This is the authority on who launched
 * it — see the header. `exists` false means the factory has never heard of it,
 * which is reason enough to refuse.
 */
async function describeToken(token, deps = {}) {
  const address = getAddress(token);
  const rec = await factoryContract(deps).getLaunchedToken(address);
  if (!rec.exists) return { token: address, exists: false };
  return {
    token: address,
    curve: getAddress(rec.curve),
    deployer: getAddress(rec.deployer),
    pairToken: getAddress(rec.pairToken),
    creatorTaxBps: Number(rec.creatorTaxBps),
    phase: Number(rec.phase),
    exists: true,
  };
}

/**
 * Whether a curve is still a curve. Read once per token — it is a property of
 * the launch, not of the wallet selling into it.
 */
async function curveState(curveAddress, deps = {}) {
  const c = (deps.curve || curve)(curveAddress, deps.provider || provider);
  const [graduated, readyToGraduate] = await Promise.all([c.graduated(), c.readyToGraduate()]);
  return { graduated, readyToGraduate };
}

/** Everything needed to price a sell against a curve, read in one go. */
async function curvePricing(curveAddress, deps = {}) {
  const c = (deps.curve || curve)(curveAddress, deps.provider || provider);
  const [reserves, feeBps, creatorTaxBps, isNativeQuote] = await Promise.all([
    c.getReserves(),
    c.feeBps(),
    c.creatorTaxBps(),
    c.isNativeQuote(),
  ]);
  return {
    quoteReserve: reserves[0],
    tokenReserve: reserves[1],
    feeBps: Number(feeBps),
    creatorTaxBps: Number(creatorTaxBps),
    isNativeQuote,
  };
}

/**
 * What `curve.sell(tokensIn, 0, ...)` would return, in quote-asset base units.
 *
 * Constant product against the curve's reserves (the quote side includes the
 * phantom reserve, which getReserves already reports), with the curve fee AND
 * the creator tax taken off the OUTPUT.
 *
 * This was verified against the live contract rather than derived from the
 * docs: the same call was run as an eth_call with the allowance overridden, on
 * two real curves — one with creatorTaxBps 0 and one with 500 — and this
 * arithmetic reproduced the contract's answer to the wei in both. Taking the
 * fees off the input instead is out by about 1%, which is what ruled it out.
 * The fixtures in holdings.test.js are those exact readings; if this function
 * is ever changed, those numbers are the check.
 *
 * Pure arithmetic on purpose. Reserves are read once per token, so twenty
 * wallets cost twenty multiplications rather than twenty round trips — and it
 * lets the caller walk the reserves forward to show the tail filling worse.
 *
 * @returns {bigint}
 */
function quoteSellOut({ tokensIn, quoteReserve, tokenReserve, feeBps = 0, creatorTaxBps = 0 }) {
  const amount = BigInt(tokensIn);
  if (amount <= 0n) return 0n;
  const t = BigInt(tokenReserve);
  const q = BigInt(quoteReserve);
  const denom = t + amount;
  if (denom <= 0n) return 0n;
  const gross = (q * amount) / denom;
  const taken = (gross * (BigInt(feeBps) + BigInt(creatorTaxBps))) / BPS;
  const out = gross - taken;
  return out > 0n ? out : 0n;
}

/** symbol and decimals, best effort — a token that will not answer is still sellable. */
async function tokenMeta(token, deps = {}) {
  const c = (deps.erc20 || erc20)(getAddress(token), deps.provider || provider);
  const [symbol, decimals] = await Promise.all([
    c.symbol().catch(() => '???'),
    c.decimals().catch(() => 18),
  ]);
  return { symbol: String(symbol), decimals: Number(decimals) };
}

function balanceOfDefault(token, owner, deps = {}) {
  return (deps.erc20 || erc20)(getAddress(token), deps.provider || provider).balanceOf(
    getAddress(owner)
  );
}

/** Per-wallet balances of one token, as BigInts. Zero balances are kept. */
async function tokenHoldings(token, wallets, deps = {}) {
  const address = getAddress(token);
  if (!wallets.length) return [];

  if (!deps.balanceOf) {
    try {
      const slots = await multicall(
        wallets.map((w) => ({
          target: address,
          callData: erc20Iface.encodeFunctionData('balanceOf', [getAddress(w.address)]),
        })),
        deps
      );
      return wallets.map((w, i) => ({
        walletId: w.id,
        address: getAddress(w.address),
        // A balance that would not read is treated as zero, which can only ever
        // drop a wallet from a sell. Guessing high would sign a sell for tokens
        // that are not there.
        balance: BigInt(decodeOr(erc20Iface, 'balanceOf', slots[i], 0n)),
      }));
    } catch (_err) {
      // No multicall on this chain, or it refused. One call per wallet still
      // works; it is only slower.
    }
  }

  const balanceOf = deps.balanceOf || ((t, o) => balanceOfDefault(t, o, deps));
  const out = [];
  for (const w of wallets) {
    out.push({
      walletId: w.id,
      address: getAddress(w.address),
      balance: BigInt(await balanceOf(address, getAddress(w.address))),
    });
  }
  return out;
}

/**
 * The picker: every token this dev launched that the bundle still holds.
 *
 * HISTORY FIRST, LOG SCAN ONLY IF HISTORY YIELDS NOTHING. `knownTokens` is this
 * user's own launch file and it is the primary source, not a top-up: it is
 * already the right answer for every launch made through this console, and it
 * costs no chain calls at all. The scan runs only when that produced no
 * sellable row, and it is bounded and deadlined — the unbounded version of it
 * hung /api/sellable in production (see LOG_WINDOW). This function never throws
 * on a scan failure and never waits forever for one; it returns what it has
 * with a warning saying what it missed.
 *
 * The consequence, stated so it is a choice and not a surprise: a dev wallet
 * that has BOTH a launch in this history file and a launch made elsewhere will
 * only be offered the ones in the file. That is deliberate. The alternative is
 * paying thousands of round trips on every page load to find a token the
 * operator can still reach by launching through the console.
 *
 * The gate does not move: every candidate, whatever its source, is re-checked
 * against the factory's getLaunchedToken before it is listed. History says
 * where to look; the factory says what is true.
 *
 * Amounts come back as human decimal strings, because everything else the
 * console renders (balanceEth and friends) is a decimal string and a raw base
 * unit shows up as 1e24-scale nonsense. The base units are kept alongside under
 * *Raw for anything that needs to do arithmetic.
 *
 * @param {object} input
 * @param {string} input.deployer the dev wallet
 * @param {Array<{id,address}>} input.wallets bundle wallets
 * @param {string[]} [input.knownTokens] tokens from this user's launch history
 */
async function findSellable({ deployer, wallets = [], knownTokens = [] }, deps = {}) {
  const scan = deps.launchedByDeployer || ((d) => launchedByDeployer(d, deps));
  const describe = deps.describeToken || ((t) => describeToken(t, deps));
  const state = deps.curveState || ((c) => curveState(c, deps));
  const meta = deps.tokenMeta || ((t) => tokenMeta(t, deps));
  const budgetMs = deps.scanBudgetMs ?? SCAN_BUDGET_MS;

  const dev = getAddress(deployer);
  const warnings = [];
  const batched = !deps.describeToken && !deps.curveState && !deps.tokenMeta;

  /**
   * Candidates → listable rows. Everything expensive lives here so that it can
   * be run over history alone, and only then over whatever the scan adds.
   */
  async function evaluate(tokens) {
    if (!tokens.length) return [];

    // ── round one: who launched each candidate ──────────────────────────────
    const records = new Map();
    if (batched) {
      try {
        const slots = await multicall(
          tokens.map((t) => ({
            target: deps.factoryAddress || config.v2FactoryAddress,
            callData: iface.encodeFunctionData('getLaunchedToken', [t]),
          })),
          deps
        );
        tokens.forEach((t, i) => {
          const rec = decodeOr(iface, 'getLaunchedToken', slots[i]);
          records.set(
            t,
            rec && rec.exists
              ? {
                  token: t,
                  curve: getAddress(rec.curve),
                  deployer: getAddress(rec.deployer),
                  pairToken: getAddress(rec.pairToken),
                  creatorTaxBps: Number(rec.creatorTaxBps),
                  phase: Number(rec.phase),
                  exists: true,
                }
              : { token: t, exists: false }
          );
        });
      } catch (_err) {
        records.clear(); // fall through to the per-token path below
      }
    }
    for (const t of tokens) {
      if (records.has(t)) continue;
      try {
        records.set(t, await describe(t));
      } catch (err) {
        warnings.push(`could not read the factory record for ${t}: ${err.message}`);
        records.set(t, { token: t, exists: false });
      }
    }

    // ── the gate ────────────────────────────────────────────────────────────
    // A token the factory does not know, or says someone else launched, never
    // reaches a balance check — let alone an approval. This applies to history
    // exactly as it applies to the scan: a local file naming a token is not
    // evidence that this dev wallet launched it.
    const mine = [];
    for (const t of tokens) {
      const record = records.get(t);
      if (!record || !record.exists) continue;
      if (getAddress(record.deployer) !== dev) {
        warnings.push(
          `${t} is in this account launch history but the factory says ${record.deployer} ` +
            'launched it — not offered'
        );
        continue;
      }
      mine.push(record);
    }

    // ── round two: metadata, curve state and every balance, in one request ──
    const details = new Map();
    if (batched && mine.length) {
      try {
        const calls = [];
        for (const r of mine) {
          calls.push({ target: r.token, callData: erc20Iface.encodeFunctionData('symbol', []) });
          calls.push({ target: r.token, callData: erc20Iface.encodeFunctionData('decimals', []) });
          calls.push({ target: r.curve, callData: curveIface.encodeFunctionData('graduated', []) });
          calls.push({
            target: r.curve,
            callData: curveIface.encodeFunctionData('readyToGraduate', []),
          });
          for (const w of wallets) {
            calls.push({
              target: r.token,
              callData: erc20Iface.encodeFunctionData('balanceOf', [getAddress(w.address)]),
            });
          }
        }
        const slots = await multicall(calls, deps);
        let i = 0;
        for (const r of mine) {
          const symbol = decodeOr(erc20Iface, 'symbol', slots[i++], '???');
          const decimals = decodeOr(erc20Iface, 'decimals', slots[i++], 18);
          const graduated = decodeOr(curveIface, 'graduated', slots[i++], false);
          const readyToGraduate = decodeOr(curveIface, 'readyToGraduate', slots[i++], false);
          const held = wallets.map((w) => ({
            walletId: w.id,
            address: getAddress(w.address),
            balance: BigInt(decodeOr(erc20Iface, 'balanceOf', slots[i++], 0n)),
          }));
          details.set(r.token, {
            symbol: String(symbol),
            decimals: Number(decimals),
            graduated: Boolean(graduated),
            readyToGraduate: Boolean(readyToGraduate),
            held,
          });
        }
      } catch (_err) {
        details.clear(); // fall through
      }
    }

    const out = [];
    for (const record of mine) {
      const token = record.token;
      let detail = details.get(token);
      if (!detail) {
        const [m, curveInfo, held] = await Promise.all([
          meta(token).catch(() => ({ symbol: '???', decimals: 18 })),
          state(record.curve).catch(() => ({ graduated: false, readyToGraduate: false })),
          tokenHoldings(token, wallets, deps),
        ]);
        detail = { ...m, ...curveInfo, held };
      }
      const { symbol, decimals, graduated, readyToGraduate, held } = detail;

      const holders = held.filter((h) => h.balance > 0n);
      if (!holders.length) continue; // old launches fall off the list on their own

      const total = holders.reduce((s, h) => s + h.balance, 0n);
      out.push({
        token,
        symbol,
        decimals,
        curve: record.curve,
        pairToken: record.pairToken,
        phase: record.phase,
        graduated,
        readyToGraduate,
        // One button, but the route is decided by the curve's own state — the
        // operator never picks.
        route: graduated ? 'uniswap-v4' : 'curve',
        totalTokens: formatUnits(total, decimals),
        totalTokensRaw: total.toString(),
        wallets: holders.length,
        holders: holders.map((h) => ({
          walletId: h.walletId,
          address: h.address,
          tokens: formatUnits(h.balance, decimals),
          tokensRaw: h.balance.toString(),
        })),
      });
    }
    return out;
  }

  // ── the free source ────────────────────────────────────────────────────────
  const seen = new Set();
  const fromHistory = [];
  for (const t of knownTokens) {
    try {
      const a = getAddress(t);
      if (seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      fromHistory.push(a);
    } catch (_err) {
      // A malformed address in the history file is not worth failing the list.
    }
  }

  const rows = fromHistory.length ? await evaluate(fromHistory) : [];

  // ── the paid one, only if the free one came back empty ─────────────────────
  let scanned = { from: null, to: null, complete: true, ran: false };
  if (!rows.length) {
    // The scan bounds itself, but a single stalled getLogs is outside its
    // control, so the caller gets its own clock as well. Half again as long as
    // the scan's own budget: enough that an honest scan finishing normally is
    // never cut off, short enough that a dead socket cannot hold the route.
    const timeout = {
      launches: [],
      scannedFrom: null,
      scannedTo: null,
      complete: false,
      warning:
        `the launch scan did not answer within ${Math.round(budgetMs * 1.5)}ms — only launches ` +
        'in this account launch history are listed',
    };
    let found = timeout;
    try {
      found = await withDeadline(scan(dev), Math.round(budgetMs * 1.5), timeout);
    } catch (err) {
      // A scan that fails is a smaller list, never a failed request: the whole
      // point of the picker is that the operator can still exit.
      found = {
        ...timeout,
        warning: `the launch scan failed (${err.message}) — only launches in this account launch history are listed`,
      };
    }

    scanned = {
      from: found.scannedFrom ?? null,
      to: found.scannedTo ?? null,
      complete: Boolean(found.complete),
      ran: true,
    };
    const note =
      found.warning || (found.complete ? null : truncationWarning(scanned.from, scanned.to));
    if (note) warnings.push(note);

    const fresh = [];
    for (const l of found.launches || []) {
      const key = l.token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(getAddress(l.token));
    }
    rows.push(...(await evaluate(fresh)));
  }

  // Biggest position first — that is the one anyone is here to exit.
  rows.sort((a, b) => (BigInt(b.totalTokensRaw) > BigInt(a.totalTokensRaw) ? 1 : -1));

  return {
    deployer: dev,
    tokens: rows,
    scan: scanned,
    warnings,
  };
}

module.exports = {
  launchedByDeployer,
  describeToken,
  curveState,
  curvePricing,
  quoteSellOut,
  tokenMeta,
  tokenHoldings,
  findSellable,
  withDeadline,
  LOG_WINDOW,
  MAX_WINDOWS,
  SCAN_BUDGET_MS,
  ZERO_ADDRESS: ZeroAddress,
};
