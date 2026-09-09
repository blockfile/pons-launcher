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
// SEED CANDIDATES — see the header. These are addresses the factory has approved
// at some point; membership in this list is NOT a claim that they are approved
// NOW, which is why every one is confirmed live. RWA approvals flip, so this is
// a hint for discovery, never the answer.
//
// IT HOLDS ALL 56 BECAUSE THE SEED IS NOW THE PRIMARY SOURCE, NOT THE FLOOR.
// It carried only 7 well-known pairs while the whole-chain getLogs was expected
// to find the rest. That expectation broke the moment the launcher moved to
// QuickNode, which refuses any getLogs span over 10k blocks: discovery returned
// NOTHING, and the picker silently offered exactly these 7 tokens out of 56. The
// operator noticed the only way anyone could — "no amd here ?" — with AMD
// approved, priced, and simply undiscoverable.
//
// Enumerated from a live read on 2026-09-09 against an endpoint that still
// allows the whole-chain query. Adding them is safe precisely because the seed
// is never trusted: each still goes through approvedPairTokens, so an
// un-approved entry fails exactly as RIVN did when it was removed.
//
// THE REMAINING GAP IS NARROWER BUT REAL: a pair approved AFTER this date is
// invisible to a range-limited node until it is added here. `npm run pairs`
// prints the current list in this format for exactly that reason.
const SEED_CANDIDATES = [
  '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', // AAPL
  '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B', // AMC
  '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', // AMD
  '0x12f190a9F9d7D37a250758b26824B97CE941bF54', // AMZN
  '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4', // BABA
  '0x48E39E56aCdbA37b09020C0b734A613C9a2f100A', // BB
  '0x822CC93fFD030293E9842c30BBD678F530701867', // BE
  '0xceF9027c7d6985b85f0BA431125073529A947A68', // BULL
  '0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4', // cbBTC  (8 decimals)
  '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', // COIN
  '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2', // COST
  '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', // CRCL
  '0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd', // DELL
  '0x1D11f0496982706C5e14A514D4E79F2e6BdE4516', // DJT
  '0x25C288E6D899b9BC30160965aD9644c67e73bE0C', // F
  '0x41F4267525a8AFf329540eF24fD83d9044758B33', // FIG
  '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', // GLD
  '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', // GME
  '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', // GOOGL
  '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09', // HIMS
  '0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619', // IBM
  '0xACEF2e09adb47aD6aBeBAD9fF06689E60615C2B6', // INDA
  '0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80', // JNJ
  '0x8005d266423c7ea827372c9c864491e5786600ea', // LLY
  '0x4e62068525Ab11FE768e29dfD00ef909B9803016', // LULU
  '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', // META
  '0x43B07D15cE533bEc5476d70C22a78a1B2B662155', // MRNA
  '0x62fd0668e10D8B72339BE2DCF7643001688ff13B', // MRVL
  '0xe93237C50D904957Cf27E7B1133b510C669c2e74', // MSFT
  '0xec262a75e413fAfD0dF80480274532C79D42da09', // MSTR
  '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD', // MU
  '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8', // NFLX
  '0x408c14038a04f7bD235329E26d2bf569ee20e250', // NU
  '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', // NVDA
  '0x7066A64c24e4206CD62E83bf198c1E7EB361F51e', // PFE
  '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', // PLTR
  '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', // QQQ
  '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8', // RBLX
  '0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C', // RDDT
  '0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B', // RIVN
  '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5', // SGOV
  '0xF53F66751B1Eff985311b693531E3290F600c410', // SHOP
  '0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8', // SKHY
  '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f', // SLV
  '0xF6589F11Bc40b669e584073F428B05562F568733', // SNAP
  '0xB90A19fF0Af67f7779afF50A882A9CfF42446400', // SNDK
  '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', // SPCX
  '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', // SPY
  '0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67', // TAO
  '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', // TSLA
  '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA', // TSM
  '0x5e81213613b6B86EaB4c6c50d718d34359459786', // TTWO
  '0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2', // UPS
  '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG  (6 decimals)
  '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344', // USO
  '0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E', // WYFI,
];

// The list changes rarely (an owner action), so it is cached. TTL is a safety
// net; the frontend can force a fresh read with refresh:true.
const CACHE_TTL_MS = 5 * 60 * 1000;
// An incomplete read is cached only briefly, so a pair lost to one bad slot
// comes back on the next listing instead of five minutes later.
const INCOMPLETE_TTL_MS = 20 * 1000;
let cache = null; // { at:number, tokens:Array, ttlMs:number }

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

  // The entry carries its OWN ttl: an INCOMPLETE list is cached briefly rather
  // than for the full window. See the `dropped` handling below.
  if (!refresh && cache && Date.now() - cache.at < (cache.ttlMs ?? CACHE_TTL_MS)) return cache.tokens;

  const factoryAddress = deps.factoryAddress || config.v2FactoryAddress;
  // The multicall is injectable so the resolver can be exercised without a chain;
  // production uses the real Multicall3 read.
  const mc = deps.multicall || ((calls) => multicall(rpc, calls, deps));
  const tokens = [nativeOption()];
  // How many approval slots came back decodable. Zero, with candidates to ask
  // about, means the CHAIN did not answer — not that it answered "none".
  let answered = 0;
  // How many the factory said YES to. Round two then reads economics, symbol and
  // decimals for each, and an entry whose economics slot fails to decode is
  // dropped from the list -- silently, and by design, since a token the factory
  // cannot price is unusable. But a MULTICALL that partly fails looks identical
  // to that, and caching it hides an approved pair for the whole window. This is
  // how the two are told apart afterwards.
  let approvedCount = 0;

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
        // A slot that DECODED is evidence the chain answered, whatever it said.
        // Nothing else in this function can tell "the factory approves none of
        // these" apart from "the read failed" — both leave `tokens` at native
        // alone — and those two must not be cached the same way. See below.
        if (decoded) answered += 1;
        return decoded ? Boolean(decoded[0]) : false;
      });

      approvedCount = approved.length;

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
    answered = 0;
  }

  // A FAILED READ MUST NEVER BECOME THE CACHED ANSWER.
  //
  // The degrade-to-native rule above is right — the picker must always have
  // something to pick — but the result was then cached like any other, so ONE
  // bad read blanked every pair balance in the console for the whole five-minute
  // TTL. Observed live: a 31-wallet bundle holding NVDA showed a dash in every
  // row ("31 balances could not be read at all") while a direct Multicall3 read
  // of the same wallets returned every balance in 379ms. The chain was fine; the
  // cache was holding a native-only list produced by one unlucky refill, and
  // GET /wallets swallows the resulting "not an approved pair token" and answers
  // in the native shape, so nothing on screen could say why.
  //
  // `answered` separates the two states that both leave `tokens` at native
  // alone: the factory approving nothing (answered > 0) and the read failing
  // (answered === 0 with candidates to ask about).
  const failed = answered === 0 && tokens.length === 1;
  if (failed) {
    // STALE BUT TRUE beats FRESH BUT EMPTY — for a READ. A list that was right
    // five minutes ago still names the right tokens; a native-only list names
    // none, and the console cannot tell that apart from "you are on a native
    // launch". Only for the cached path: `refresh: true` is what the money paths
    // pass (prepareV2, swapToPair, swapFromPair) precisely so an un-approved
    // token cannot be spent against, and they must keep failing closed here.
    if (!refresh && cache && cache.tokens.length > 1) return cache.tokens;
    // Nothing better to offer. Return native alone WITHOUT caching it, so the
    // very next call retries instead of serving this for five minutes.
    return tokens;
  }

  // Stable order: native first, then the rest by symbol so the picker does not
  // reshuffle between reads.
  const rest = tokens.slice(1).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const ordered = [tokens[0], ...rest];

  // A PARTLY-READ LIST IS NOT A WRONG LIST, BUT IT IS NOT A DURABLE ONE EITHER.
  //
  // Observed: the operator asked why AMD was missing from the v2 picker. AMD is
  // approved and priced -- a live read returns it with phantomQuote 6.6662 and a
  // graduation threshold of 16.6655 -- so the picker was drawing a CACHED list
  // that had lost it. Round two reads economics, symbol and decimals for each
  // approved token, and one economics slot failing to decode drops that token:
  //
  //     if (!econ) return; // an approved token the factory cannot price
  //
  // which is right for a token that genuinely cannot be priced, and wrong for a
  // multicall that partly failed -- and the two are indistinguishable at that
  // line. The `answered` guard above only watches round ONE, so an incomplete
  // round two sailed past it and stood for the full five minutes.
  //
  // It is still SERVED: 55 pairs is far better than none, and a token may be
  // unpriceable forever, so refusing to cache would hammer the chain on every
  // listing. It just does not get to STAND for long -- a short ttl on the entry
  // makes the next request re-read and heal it.
  const dropped = approvedCount - (ordered.length - 1);
  cache = {
    at: Date.now(),
    tokens: ordered,
    ttlMs: dropped > 0 ? INCOMPLETE_TTL_MS : CACHE_TTL_MS,
  };
  return ordered;
}

/** Drop the cache — used by tests and the refresh path. */
function clearPairTokenCache() {
  cache = null;
}

module.exports = { resolvePairTokens, clearPairTokenCache, SEED_CANDIDATES };
