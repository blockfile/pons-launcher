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
// So the candidate set comes from the factory's own TokenLaunched events
// filtered on the indexed `deployer`, unioned with this user's launch history,
// and EVERY candidate is then re-checked against the factory's getLaunchedToken
// record — a token gets into the list only if the factory says this dev wallet
// launched it. Balances only ever narrow that set; they never widen it.
//
// The deployer being indexed is what makes this cheap: one filtered getLogs
// enumerates every launch a dev wallet ever made. The public RPC refuses a
// query matching more than 10000 logs, so the scan walks backwards in windows
// and splits any window the node refuses.

const { Contract, Interface, getAddress, formatUnits, ZeroAddress } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { erc20 } = require('../erc20');
const { curve } = require('./curve');
const { FACTORY_V2_ABI } = require('./abi');

const iface = new Interface(FACTORY_V2_ABI);
const TOKEN_LAUNCHED = iface.getEvent('TokenLaunched');

// Blocks per getLogs call. Robinhood Chain makes blocks fast enough that a
// naive fromBlock:0 query is refused outright, so the scan is windowed.
const LOG_WINDOW = 500_000;
// How far back the scan is willing to walk before giving up and saying so.
// LOG_WINDOW * MAX_WINDOWS blocks of history, in that many sequential reads.
const MAX_WINDOWS = 60;
// A refused window is halved and retried; this caps that recursion so a node
// that refuses everything fails loudly instead of issuing thousands of calls.
const MAX_SPLIT_DEPTH = 6;

const BPS = 10_000n;

function factoryContract(deps = {}) {
  if (deps.factory) return deps.factory;
  const address = deps.factoryAddress || config.v2FactoryAddress;
  if (!address) throw new Error('PONS_V2_FACTORY is not set');
  return new Contract(address, FACTORY_V2_ABI, deps.provider || provider);
}

/**
 * getLogs for one range, splitting it in half whenever the node refuses.
 *
 * The RPC's refusal is a count limit, not a range limit, so there is no window
 * size that is always safe — a dev wallet with thousands of launches would trip
 * it at any width. Halving on refusal converges on whatever this node will
 * actually answer, instead of hardcoding a guess.
 */
async function getLogsSplitting(rpc, base, from, to, out, depth = 0) {
  try {
    const logs = await rpc.getLogs({ ...base, fromBlock: from, toBlock: to });
    out.push(...logs);
  } catch (err) {
    if (from >= to || depth >= MAX_SPLIT_DEPTH) throw err;
    const mid = Math.floor((from + to) / 2);
    await getLogsSplitting(rpc, base, from, mid, out, depth + 1);
    await getLogsSplitting(rpc, base, mid + 1, to, out, depth + 1);
  }
}

/**
 * Every token this deployer launched, newest first.
 *
 * @returns {Promise<{launches: Array<{token,curve,pairToken,launchConfigId,blockNumber}>,
 *                    scannedFrom: number, complete: boolean}>}
 *   `complete` is false when the walk ran out of windows before reaching block
 *   0 — the caller must say so rather than presenting a partial list as the
 *   whole truth.
 */
async function launchedByDeployer(deployer, deps = {}) {
  const rpc = deps.provider || provider;
  const window = deps.window || LOG_WINDOW;
  const maxWindows = deps.maxWindows || MAX_WINDOWS;
  const address = deps.factoryAddress || config.v2FactoryAddress;

  const head = deps.head ?? (await rpc.getBlockNumber());
  const topics = iface.encodeFilterTopics('TokenLaunched', [null, null, getAddress(deployer)]);

  const raw = [];
  let to = head;
  let scannedFrom = head + 1;
  let complete = false;

  for (let i = 0; i < maxWindows && to >= 0; i++) {
    const from = Math.max(0, to - window + 1);
    await getLogsSplitting(rpc, { address, topics }, from, to, raw);
    scannedFrom = from;
    if (from === 0) {
      complete = true;
      break;
    }
    to = from - 1;
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
  return { launches, scannedFrom, complete };
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
  const balanceOf = deps.balanceOf || ((t, o) => balanceOfDefault(t, o, deps));
  const address = getAddress(token);
  return Promise.all(
    wallets.map(async (w) => ({
      walletId: w.id,
      address: getAddress(w.address),
      balance: BigInt(await balanceOf(address, getAddress(w.address))),
    }))
  );
}

/**
 * The picker: every token this dev launched that the bundle still holds.
 *
 * Amounts come back as human decimal strings, because everything else the
 * console renders (balanceEth and friends) is a decimal string and a raw base
 * unit shows up as 1e24-scale nonsense. The base units are kept alongside under
 * *Raw for anything that needs to do arithmetic.
 *
 * @param {object} input
 * @param {string} input.deployer the dev wallet
 * @param {Array<{id,address}>} input.wallets bundle wallets
 * @param {string[]} [input.knownTokens] tokens from local launch history
 */
async function findSellable({ deployer, wallets = [], knownTokens = [] }, deps = {}) {
  const scan = deps.launchedByDeployer || ((d) => launchedByDeployer(d, deps));
  const describe = deps.describeToken || ((t) => describeToken(t, deps));
  const state = deps.curveState || ((c) => curveState(c, deps));
  const meta = deps.tokenMeta || ((t) => tokenMeta(t, deps));

  const dev = getAddress(deployer);
  const warnings = [];

  const scanned = await scan(dev);
  if (!scanned.complete) {
    warnings.push(
      `the launch scan only scanned back to block ${scanned.scannedFrom} — launches older than ` +
        'that appear only if they are in this account launch history'
    );
  }

  // Union, deduped by address. History is a convenience for launches older than
  // the scan window; it is NOT a second source of authority — every candidate
  // is checked against the factory below regardless of where it came from.
  const candidates = new Map();
  for (const l of scanned.launches) candidates.set(l.token.toLowerCase(), l.token);
  for (const t of knownTokens) {
    try {
      const a = getAddress(t);
      if (!candidates.has(a.toLowerCase())) candidates.set(a.toLowerCase(), a);
    } catch (_err) {
      // A malformed address in the history file is not worth failing the list.
    }
  }

  const rows = [];
  for (const token of candidates.values()) {
    let record;
    try {
      record = await describe(token);
    } catch (err) {
      warnings.push(`could not read the factory record for ${token}: ${err.message}`);
      continue;
    }

    // The gate. A token the factory does not know, or says someone else
    // launched, never reaches a balance check — let alone an approval.
    if (!record.exists) continue;
    if (getAddress(record.deployer) !== dev) {
      warnings.push(
        `${token} is in this account launch history but the factory says ${record.deployer} ` +
          'launched it — not offered'
      );
      continue;
    }

    const [{ symbol, decimals }, curveInfo, held] = await Promise.all([
      meta(token).catch(() => ({ symbol: '???', decimals: 18 })),
      state(record.curve).catch(() => ({ graduated: false, readyToGraduate: false })),
      tokenHoldings(token, wallets, deps),
    ]);

    const holders = held.filter((h) => h.balance > 0n);
    if (!holders.length) continue; // old launches fall off the list on their own

    const total = holders.reduce((s, h) => s + h.balance, 0n);
    rows.push({
      token,
      symbol,
      decimals,
      curve: record.curve,
      pairToken: record.pairToken,
      phase: record.phase,
      graduated: curveInfo.graduated,
      readyToGraduate: curveInfo.readyToGraduate,
      // One button, but the route is decided by the curve's own state — the
      // operator never picks.
      route: curveInfo.graduated ? 'uniswap-v4' : 'curve',
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

  // Biggest position first — that is the one anyone is here to exit.
  rows.sort((a, b) => (BigInt(b.totalTokensRaw) > BigInt(a.totalTokensRaw) ? 1 : -1));

  return {
    deployer: dev,
    tokens: rows,
    scan: { from: scanned.scannedFrom, complete: scanned.complete },
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
  LOG_WINDOW,
  MAX_WINDOWS,
  ZERO_ADDRESS: ZeroAddress,
};
