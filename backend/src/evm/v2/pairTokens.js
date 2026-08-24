'use strict';

// Which quote assets a pons v2 launch may be priced in.
//
// THE FACTORY HAS NO ENUMERATION FUNCTION. approvedPairTokens(addr) answers yes
// or no for one address, but nothing lists them, so the authoritative source is
// the event PairTokenApprovalUpdated(address indexed pairToken, bool approved):
// every address ever approved (or un-approved) has appeared in it at least once.
//
//   discover candidates from the event  →  confirm each LIVE with
//   approvedPairTokens  →  enrich with the token's own symbol/decimals and the
//   factory's pairTokenEconomics.
//
// The live confirmation is the whole point. An approval can be flipped OFF later
// — RIVN was removed — and the event history still carries its old approve=true,
// so trusting the last event would list a token the factory now rejects.
// approvedPairTokens is the truth; the event only tells us where to look.
//
// TWO SOURCES OF CANDIDATES, AND WHY:
//
//   1. The event logs. Authoritative and forward-compatible: a pair approved
//      tomorrow shows up here with no code change. A whole-chain getLogs is the
//      fast path and it works on a node that limits getLogs by MATCHED count
//      (the default Robinhood RPC), because these events are a handful however
//      long the chain gets.
//   2. A seed list of known RWA addresses. NOT a source of truth — every one is
//      still put through approvedPairTokens before it is listed, so a removed
//      token fails exactly as it should. The seed exists so the well-known pairs
//      still resolve on a node that limits getLogs by RANGE (QuickNode refuses
//      any span over 10k blocks — see evm/v2/holdings.js), whose whole-chain
//      query fails and whose approval events are far older than any bounded
//      backward window could reach. The seed is the floor; the logs are the
//      ceiling. Neither is trusted without the live check.
//
// Deliberately NO windowed backward log scan. That is the exact shape that hung
// /api/sellable in production (holdings.js, LOG_WINDOW). The whole-chain query
// either works (matched-count-limited node) or fails fast (range-limited node),
// and the seed covers the second case. A newly approved token that is in the
// seed's blind spot AND unreachable by the whole-chain query is the one gap; it
// is documented, rare, and a refresh or a seed entry closes it.
//
// Native ETH (address(0)) is ALWAYS the first option and is special: it uses the
// LaunchConfig's own phantomQuote/graduationThreshold, not pairTokenEconomics.

const { Contract, Interface, getAddress, ZeroAddress } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { ERC20_ABI } = require('../erc20');
const { FACTORY_V2_ABI } = require('./abi');

const factoryIface = new Interface(FACTORY_V2_ABI);
const erc20Iface = new Interface(ERC20_ABI);

// Multicall3, standard address on this chain (see evm/config + holdings.js).
// allowFailure is always true, so one token that reverts on symbol() costs
// itself a field, never the whole list.
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];

// SEED CANDIDATES — see the header. These are addresses the factory has approved
// at some point; membership in this list is NOT a claim that they are approved
// NOW, which is why every one is confirmed live. RWA approvals flip, so this is
// a hint for discovery, never the answer.
const SEED_CANDIDATES = [
  '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', // SPCX
  '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', // NVDA
  '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', // TSLA
  '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', // GOOGL
  '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', // AAPL
  '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', // GME
  '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG (6 decimals)
];

// The list changes rarely (an owner action), so it is cached. TTL is a safety
// net; the frontend can force a fresh read with refresh:true.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null; // { at:number, tokens:Array }

/** The native-ETH option, always first and always present. */
function nativeOption() {
  return {
    symbol: 'ETH',
    address: ZeroAddress,
    decimals: 18,
    native: true,
    // Native inherits the LaunchConfig's own reserve/threshold, so there is no
    // per-token economics to report here. The console reads these off the config.
    phantomQuote: null,
    graduationThreshold: null,
  };
}

function multicallContract(rpc, deps = {}) {
  return new Contract(deps.multicallAddress || config.multicallAddress, MULTICALL3_ABI, rpc);
}

async function multicall(rpc, calls, deps = {}) {
  if (!calls.length) return [];
  const res = await multicallContract(rpc, deps).aggregate3.staticCall(
    calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))
  );
  return res.map((r) => ({ success: r[0], returnData: r[1] }));
}

function decodeOr(ifc, name, slot, fallback = null) {
  if (!slot || !slot.success || !slot.returnData || slot.returnData === '0x') return fallback;
  try {
    return ifc.decodeFunctionResult(name, slot.returnData);
  } catch (_err) {
    return fallback;
  }
}

/**
 * Every address that has ever appeared in a PairTokenApprovalUpdated event.
 * Best-effort: a node that refuses the whole-chain query returns the empty set,
 * and the seed carries the load. Never throws.
 */
async function candidatesFromLogs(rpc, factoryAddress) {
  const out = new Set();
  try {
    const topics = factoryIface.encodeFilterTopics('PairTokenApprovalUpdated', []);
    const logs = await rpc.getLogs({ address: factoryAddress, topics, fromBlock: 0, toBlock: 'latest' });
    for (const log of logs) {
      try {
        const parsed = factoryIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === 'PairTokenApprovalUpdated') {
          out.add(getAddress(parsed.args.pairToken).toLowerCase());
        }
      } catch (_err) {
        // some other event from the same contract
      }
    }
  } catch (_err) {
    // Range-limited node, or a transient failure. The seed still resolves the
    // known pairs; this is exactly the case the seed exists for.
  }
  return out;
}

/**
 * The currently-approved pair tokens, native first, each enriched with the data
 * the console needs to size and price a launch against it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.refresh] bypass the cache and read the chain again
 * @param {object}  [opts.provider] injectable for tests
 * @returns {Promise<Array<{symbol,address,decimals,phantomQuote,graduationThreshold,native?}>>}
 *   Always includes native ETH, even when every chain read fails — the launch
 *   form must never be left with nothing to pick.
 */
async function resolvePairTokens(opts = {}) {
  const refresh = Boolean(opts.refresh);
  const rpc = opts.provider || provider;
  const deps = opts;

  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.tokens;

  const factoryAddress = deps.factoryAddress || config.v2FactoryAddress;
  // The multicall is injectable so the resolver can be exercised without a chain;
  // production uses the real Multicall3 read.
  const mc = deps.multicall || ((calls) => multicall(rpc, calls, deps));
  const tokens = [nativeOption()];

  try {
    // ── candidate set: logs ∪ seed, deduped, lowercased ──────────────────────
    const fromLogs = await candidatesFromLogs(rpc, factoryAddress);
    const candidates = [];
    const seen = new Set();
    for (const raw of [...SEED_CANDIDATES, ...fromLogs]) {
      let addr;
      try {
        addr = getAddress(raw);
      } catch (_err) {
        continue;
      }
      const key = addr.toLowerCase();
      if (key === ZeroAddress.toLowerCase() || seen.has(key)) continue;
      seen.add(key);
      candidates.push(addr);
    }

    if (candidates.length) {
      // ── round one: which candidates are approved RIGHT NOW ─────────────────
      const approvedSlots = await mc(
        candidates.map((addr) => ({
          target: factoryAddress,
          callData: factoryIface.encodeFunctionData('approvedPairTokens', [addr]),
        }))
      );
      const approved = candidates.filter((_addr, i) => {
        const decoded = decodeOr(factoryIface, 'approvedPairTokens', approvedSlots[i], null);
        return decoded ? Boolean(decoded[0]) : false;
      });

      // ── round two: economics + symbol + decimals for the approved ones ─────
      if (approved.length) {
        const calls = [];
        for (const addr of approved) {
          calls.push({
            target: factoryAddress,
            callData: factoryIface.encodeFunctionData('pairTokenEconomics', [addr]),
          });
          calls.push({ target: addr, callData: erc20Iface.encodeFunctionData('symbol', []) });
          calls.push({ target: addr, callData: erc20Iface.encodeFunctionData('decimals', []) });
        }
        const slots = await mc(calls);
        approved.forEach((addr, i) => {
          const econ = decodeOr(factoryIface, 'pairTokenEconomics', slots[i * 3], null);
          if (!econ) return; // an approved token the factory cannot price is unusable
          const symbol = decodeOr(erc20Iface, 'symbol', slots[i * 3 + 1], null);
          const erc20Decimals = decodeOr(erc20Iface, 'decimals', slots[i * 3 + 2], null);
          // The factory's own economics decimals is authoritative: the launch
          // reverts PairTokenDecimalsMismatch if the token disagrees with it, so
          // that is the number the launch math must use.
          const decimals = Number(econ[2]);
          tokens.push({
            symbol: symbol ? String(symbol[0]) : `${addr.slice(0, 6)}…${addr.slice(-4)}`,
            address: getAddress(addr),
            decimals,
            erc20Decimals: erc20Decimals != null ? Number(erc20Decimals[0]) : null,
            phantomQuote: econ[0].toString(),
            graduationThreshold: econ[1].toString(),
          });
        });
      }
    }
  } catch (_err) {
    // A total failure still returns native alone rather than throwing — the
    // form has to be usable even when the RPC is unhappy.
  }

  // Stable order: native first, then the rest by symbol so the picker does not
  // reshuffle between reads.
  const rest = tokens.slice(1).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const ordered = [tokens[0], ...rest];
  cache = { at: Date.now(), tokens: ordered };
  return ordered;
}

/** Drop the cache — used by tests and the refresh path. */
function clearPairTokenCache() {
  cache = null;
}

module.exports = { resolvePairTokens, clearPairTokenCache, SEED_CANDIDATES };
