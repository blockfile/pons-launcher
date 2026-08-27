'use strict';

// The letscash.fun (CashCat) launch factory — the "v5" tab's read + build client.
//
// READ-ONLY. Nothing in this file signs or broadcasts. It reads the LIVE
// factory, decodes its launch menu, builds the unsigned `launch` calldata, runs
// the launch as a static `eth_call` to preview it, and pulls the token/pool out
// of a receipt. Signing and firing belong to a later stage; this module only
// ever hands back `{ to, data, value }` and decoded views.
//
// The factory (config.letscash.factory 0x5bd1Fbe7…) is an ERC1967 proxy in front
// of `CashCatFactoryVNext` (impl 0x3dFd73A6…, verified on Robinhood Chain). The
// ABI fragments below were transcribed from that verified impl — see the header
// on CASHCAT_FACTORY_ABI for the exact signatures and how they were confirmed.
//
// Three facts about this factory shape everything here and are easy to get wrong:
//
//   1. Config ids do NOT start at zero. `initializeVNext` moved the id counter to
//      FIRST_CONFIG_ID (1000) and the retired v1 menu lives below that,
//      unreachable through `getLaunchConfig`. The live menu is the half-open
//      range [firstConfigId(), nextConfigId()) — iterating from 0 reverts
//      InvalidConfigId a thousand times before reaching anything real. (The
//      historical CRYINGCAT launch used configId 16, a *pre-migration* id — it
//      is not in today's menu, and that is expected.)
//
//   2. The ETH sentinel address(0) is NOT in `approvedQuote`. `approvedQuote(0x0)`
//      returns FALSE on the live chain, yet every ETH-quoted config launches
//      fine, because `_launch` skips the approval check for the zero address:
//      `if (!quote.isAddressZero() && !approvedQuote[quote]) revert`. So native
//      ETH is implicitly always allowed; only ERC-20 quotes (USDG) are gated by
//      the mapping. Reading approvedQuote(0x0) and reporting ETH as disabled is
//      the trap — see approvedQuotes() below.
//
//   3. A launch address must carry the "cc" stamp. `launch` reverts
//      VanityAddressRequired unless the token's address ends in a lowercase "cc"
//      (last byte 0xcc AND its EIP-55 checksum renders both trailing chars
//      lowercase), and QuoteMustSortFirst unless the quote sorts below the token.
//      A salt is therefore not free — it must be mined with `mineSalt` first, and
//      an un-mined salt makes buildLaunchTx's calldata revert in simulateLaunch.

const {
  Contract,
  Interface,
  AbiCoder,
  getAddress,
  keccak256,
  toUtf8Bytes,
  ZeroAddress,
} = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { rpcMessage } = require('../errors');

// ─────────────────────────────── ABI ────────────────────────────────────────
//
// A focused subset of the verified CashCatFactoryVNext ABI — every signature was
// read live from Blockscout (/api/v2/smart-contracts/0x3dFd73A6…) and its
// selector / topic0 confirmed against the on-chain deployment. Kept inline (no
// separate abi.js) so the whole v5 read client is one self-contained file.
//
// The launch tuple, EXACTLY as the impl declares it (selector 0x75154d70):
//   launch(
//     (string name, string symbol, string logo, string description,
//      string metadataURI,
//      (string telegram, string twitter, string discord, string website,
//       string extra) socials,
//      address creator) params,
//     uint256 configId, uint256 firstBuyIn, uint256 firstBuyMinOut, bytes32 salt
//   ) payable returns (address token, bytes32 poolId)
const CASHCAT_FACTORY_ABI = [
  // ── launch entrypoints ────────────────────────────────────────────────────
  'function launch((string name,string symbol,string logo,string description,string metadataURI,(string telegram,string twitter,string discord,string website,string extra) socials,address creator) params,uint256 configId,uint256 firstBuyIn,uint256 firstBuyMinOut,bytes32 salt) payable returns (address token,bytes32 poolId)',
  // Fee stream assigned at launch to one address, or split across up to four
  // (shares are bps, must sum to 10000). selfBurn configs reject a split.
  'function launchWithFeeSplit((string name,string symbol,string logo,string description,string metadataURI,(string telegram,string twitter,string discord,string website,string extra) socials,address creator) params,uint256 configId,uint256 firstBuyIn,uint256 firstBuyMinOut,bytes32 salt,address[] recipients,uint16[] shares) payable returns (address token,bytes32 poolId)',
  // EIP-2612 variant: the ERC-20 first buy is approved by signature in the same
  // call. Only meaningful for a token-quoted (USDG) launch — reverts
  // PermitNotApplicable for an ETH pool or a zero first buy.
  'function launchWithPermit((string name,string symbol,string logo,string description,string metadataURI,(string telegram,string twitter,string discord,string website,string extra) socials,address creator) params,uint256 configId,uint256 firstBuyIn,uint256 firstBuyMinOut,bytes32 salt,address[] recipients,uint16[] shares,(uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s) p) payable returns (address token,bytes32 poolId)',

  // ── the launch menu ───────────────────────────────────────────────────────
  'function launchEnabled() view returns (bool)',
  'function launchFee() view returns (uint256)',
  'function FIRST_CONFIG_ID() view returns (uint256)',
  'function firstConfigId() pure returns (uint256)',
  'function nextConfigId() view returns (uint256)',
  'function configCount() view returns (uint256)',
  'function launchConfigCount() view returns (uint256)',
  'function publishedConfigCount() view returns (uint256)',
  'function retiredConfigCount() view returns (uint256)',
  'function getLaunchConfig(uint256 configId) view returns ((uint256 moduleSetId,address quote,uint256 supply,int24 tickSpacing,int24 startTick,uint16 creatorFeeBps,uint24 feeRate,bool enabled,bool selfBurn,bool exists))',
  'function getModuleSet(uint256 id) view returns ((address hook,address tokenMaster,address selfBurner,address splitterMaster,bool exists))',
  'function approvedQuote(address) view returns (bool)',

  // ── address / salt prediction ─────────────────────────────────────────────
  'function predictTokenAddress((string name,string symbol,string logo,string description,string metadataURI,(string telegram,string twitter,string discord,string website,string extra) socials,address creator),uint256 configId,address sender,bytes32 salt) view returns (address)',
  'function mineSalt((string name,string symbol,string logo,string description,string metadataURI,(string telegram,string twitter,string discord,string website,string extra) socials,address creator),uint256 configId,address sender,uint256 start,uint256 rounds) view returns (bytes32 salt,address token)',

  // ── wiring / constants ────────────────────────────────────────────────────
  'function treasury() view returns (address)',
  'function poolManager() view returns (address)',
  'function MAX_FEE_RATE() view returns (uint24)',
  'function PIPS_PER_BP() view returns (uint24)',
  'function BPS_DENOMINATOR() view returns (uint256)',

  // ── events (topic0 confirmed against a live launch receipt) ───────────────
  // 0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897
  'event TokenLaunched(address indexed token,address indexed creator,bytes32 indexed poolId,uint256 configId,uint256 firstBuyIn,uint256 firstBuyOut,address hook,address feeRecipient)',
  // 0x4fc41a12b1f4beaba92b64a385eb351c4d7a0e2131b20e8a33e2c21d008d24b5
  'event TokenLaunchedVNext(address indexed token,bytes32 indexed poolId,address quote,uint256 moduleSetId,address splitter)',

  // ── custom errors, so a reverted preview reads as words not bytes ─────────
  'error CreatorMustBeSender()',
  'error VanityAddressRequired()',
  'error QuoteMustSortFirst()',
  'error QuoteNotApproved()',
  'error ConfigDisabled()',
  'error LaunchesPaused()',
  'error InvalidConfigId()',
  'error IncorrectValue()',
  'error FirstBuySlippage()',
  'error EmptyString()',
  'error SaltNotFound()',
  'error NotInitialized()',
  'error PermitNotApplicable()',
  'error PermitValueMismatch()',
  'error PermitFailed()',
  'error InvalidFeeRoute()',
  'error FeeRouteForbidden()',
  'error SupplyOutOfRange()',
  'error SeedLiquidityAboveTickCap(uint256 seedLiquidity,uint256 cap)',
  'error InsufficientBalance(uint256 balance,uint256 needed)',
];

// The Uniswap-V4 PoolManager's Initialize event, emitted by config.letscash
// .poolManager (0x8366a39C…) inside every launch. Not on the factory — the pool
// is created on the manager — so it needs its own interface.
//   topic0 0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438
//        = keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
const V4_POOL_MANAGER_ABI = [
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
];

const FACTORY_IFACE = new Interface(CASHCAT_FACTORY_ABI);
const POOL_MANAGER_IFACE = new Interface(V4_POOL_MANAGER_ABI);
const CODER = AbiCoder.defaultAbiCoder();

// Selectors / topics, resolved once from the interfaces above.
const LAUNCH_SELECTOR = FACTORY_IFACE.getFunction('launch').selector; // 0x75154d70
const TOKEN_LAUNCHED_TOPIC = FACTORY_IFACE.getEvent('TokenLaunched').topicHash;
const TOKEN_LAUNCHED_VNEXT_TOPIC = FACTORY_IFACE.getEvent('TokenLaunchedVNext').topicHash;
const INITIALIZE_TOPIC = POOL_MANAGER_IFACE.getEvent('Initialize').topicHash;

// From the impl's own constants. FIRST_CONFIG_ID and PIPS_PER_BP are also
// readable on-chain and are read live by getConfigs; these mirror them for the
// pure helpers that must not touch the chain.
const VANITY_LAST_BYTE = 0xcc;
const PIPS_PER_BP = 100n; // feeRate is in pips (1/100 of a bp); 10000 pips = 1%

/** The factory contract, bound to an injected runner (defaults to the live provider). */
function factory(runner = provider) {
  return new Contract(config.letscash.factory, CASHCAT_FACTORY_ABI, runner);
}

// ───────────────────────────── pure helpers ─────────────────────────────────

/**
 * True when `address` carries the CashCat "cc" stamp, mirroring the impl's
 * `_hasVanitySuffix` byte-for-byte: the last address byte is 0xcc AND the EIP-55
 * checksum of the 40 lowercase hex chars keeps both trailing chars lowercase
 * (checksum byte 19's two nibbles are each < 8). Equivalent to
 * `getAddress(a).endsWith('cc')`, since EIP-55 lowercases exactly those nibbles —
 * but written the long way so it reads as the same computation the contract does.
 * @param {string} address
 * @returns {boolean}
 */
function hasVanitySuffix(address) {
  const lower = getAddress(address).toLowerCase().slice(2); // 40 hex chars, no 0x
  if (parseInt(lower.slice(38, 40), 16) !== VANITY_LAST_BYTE) return false;
  const checksum = keccak256(toUtf8Bytes(lower));
  const byte19 = parseInt(checksum.slice(2 + 38, 2 + 40), 16);
  return byte19 >> 4 < 8 && (byte19 & 0xf) < 8;
}

/**
 * Normalise a launch params object into the exact tuple order the ABI expects,
 * filling every string default so a caller that omits an optional social does
 * not shift the encoding. Accepts the human-friendly `{ socials: {…} }` shape.
 * @returns {[string,string,string,string,string,[string,string,string,string,string],string]}
 */
function normalizeParams(params) {
  if (!params || typeof params !== 'object') throw new Error('params object is required');
  const s = params.socials || {};
  const str = (v) => (v == null ? '' : String(v));
  return [
    str(params.name),
    str(params.symbol),
    str(params.logo),
    str(params.description),
    str(params.metadataURI),
    [str(s.telegram), str(s.twitter), str(s.discord), str(s.website), str(s.extra)],
    getAddress(params.creator),
  ];
}

/**
 * The V4 PoolKey a launch builds, and its PoolId. Every letscash pool is
 * currency0 = quote (ETH sentinel 0x0 or USDG), currency1 = token, fee 0,
 * hook = the config's module-set hook. PoolId is keccak256(abi.encode(key)) —
 * verified to reproduce the on-chain id for a real launch.
 * @returns {{ key: object, poolId: string }}
 */
function poolKeyFor({ quote = ZeroAddress, token, hook, tickSpacing = config.letscash.tickSpacing, fee = config.letscash.poolFee }) {
  const key = {
    currency0: getAddress(quote),
    currency1: getAddress(token),
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    hooks: getAddress(hook),
  };
  const poolId = keccak256(
    CODER.encode(
      ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
      [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
    )
  );
  return { key, poolId };
}

/** Just the PoolId for a launch's inputs — a thin wrapper over poolKeyFor. */
function computePoolId(args) {
  return poolKeyFor(args).poolId;
}

/**
 * Turn a reverted call/estimate into the factory's own error name. The revert
 * data hides in different places depending on node and ethers path, so this digs
 * it out of every known slot before decoding it against the factory errors.
 * Falls back to the plain RPC message when there is no custom error to name.
 * @param {unknown} err
 * @returns {string}
 */
function explainRevert(err) {
  const data =
    err?.data ||
    err?.info?.error?.data ||
    err?.error?.data ||
    err?.revert?.data ||
    (typeof err?.value === 'string' && err.value.startsWith('0x') ? err.value : null);

  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = FACTORY_IFACE.parseError(data);
      if (parsed) {
        const args = parsed.args.length ? ` (${parsed.args.map(String).join(', ')})` : '';
        return `${parsed.name}${args}`;
      }
    } catch (_err) {
      // Not one of the factory (or built-in Error/Panic) errors — fall through,
      // but keep the raw selector: an error this factory ABI does not know almost
      // always comes from a sub-contract the launch calls (the CashCat hook, the
      // V4 PoolManager during the atomic first buy, Permit2). Surfacing its 4-byte
      // selector is what makes an otherwise-blank "unknown custom error"
      // identifiable — look the selector up (e.g. openchain.xyz/signatures).
    }
    return `unknown custom error ${data.slice(0, 10)} (from a sub-contract — likely the hook or the V4 pool, not the factory)`;
  }
  return rpcMessage(err);
}

// ─────────────────────────── config-menu decode ─────────────────────────────

/**
 * Human labels for a config's economics.
 *   feeRate is in pips (1/100 bp). taxRateBps mirrors the token's own rounding
 *   (ceil to a bp, the impl's `_tokenConfig`), and taxPercent is the plain
 *   percentage the menu shows. mode is the creator-vs-self-burn split.
 */
function decodeConfig(id, c) {
  const feeRatePips = BigInt(c.feeRate);
  const taxRateBps = Number((feeRatePips + (PIPS_PER_BP - 1n)) / PIPS_PER_BP); // ceil(pips/100)
  const quote = getAddress(c.quote);
  const native = quote === ZeroAddress;
  return {
    configId: id,
    moduleSetId: Number(c.moduleSetId),
    quoteAsset: quote,
    quoteIsNative: native,
    quoteSymbol: symbolForQuote(quote),
    supply: c.supply.toString(),
    tickSpacing: Number(c.tickSpacing),
    startTick: Number(c.startTick),
    creatorFeeBps: Number(c.creatorFeeBps),
    feeRatePips: Number(feeRatePips),
    taxRateBps,
    taxPercent: Number(feeRatePips) / 10000, // 10000 pips === 1%
    taxLabel: `${Number(feeRatePips) / 10000}%`,
    mode: c.selfBurn ? 'selfburn' : 'creator',
    selfBurn: Boolean(c.selfBurn),
    enabled: Boolean(c.enabled),
    exists: Boolean(c.exists),
  };
}

// The quote assets a letscash launch can name are exactly two on the live menu:
// native ETH (the 0x0 sentinel) and USDG. Resolved from config so the common
// case needs no extra chain read; an unknown ERC-20 quote falls back to a short
// form of its address. Callers wanting a live symbol for an exotic quote can
// enrich the returned address themselves via evm/erc20.getSymbol.
function symbolForQuote(quote) {
  const a = getAddress(quote);
  if (a === ZeroAddress) return 'ETH';
  if (a.toLowerCase() === config.letscash.usdg) return 'USDG';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Everything the launch form renders, read from the LIVE factory:
 *   - launchEnabled + launchFee (wei),
 *   - the launch menu, enumerated over [firstConfigId(), nextConfigId()) and
 *     decoded (NOT [0, count) — see the file header),
 *   - the approved quote assets, with the ETH-sentinel gotcha handled.
 *
 * @param {{ runner?: object }} [deps] inject a runner (needs only `.call`) for tests.
 */
async function getConfigs(deps = {}) {
  const f = factory(deps.runner || provider);

  const [launchEnabled, launchFee, firstId, nextId] = await Promise.all([
    f.launchEnabled(),
    f.launchFee(),
    f.firstConfigId(),
    f.nextConfigId(),
  ]);

  const first = Number(firstId);
  const next = Number(nextId);

  // Sequential, like the v2 reader: one getLaunchConfig per id over the live
  // range. ~60 reads; the provider retries transient blips. Any id in range is
  // guaranteed to exist (ids are handed out contiguously and never skipped), so
  // a revert here is a real fault, not an empty slot.
  const configs = [];
  for (let id = first; id < next; id++) {
    const c = await f.getLaunchConfig(id);
    configs.push(decodeConfig(id, c));
  }

  // Distinct non-native quotes from the menu, each checked against approvedQuote.
  // Native ETH is added unconditionally: address(0) is never in the mapping
  // (approvedQuote(0x0) === false on-chain) yet is always launchable because
  // `_launch` skips the check for it. Reporting it as approved is correct;
  // reading the mapping for it would wrongly say "disabled".
  const seen = new Set();
  const nonNative = [];
  for (const cfg of configs) {
    if (cfg.quoteIsNative) continue;
    const key = cfg.quoteAsset.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    nonNative.push(cfg.quoteAsset);
  }
  const approvals = await Promise.all(nonNative.map((q) => f.approvedQuote(q)));
  const approvedQuotes = [
    {
      address: ZeroAddress,
      symbol: 'ETH',
      native: true,
      approved: true,
      note: 'ETH sentinel — never checked against approvedQuote; _launch always allows address(0)',
    },
    ...nonNative.map((q, i) => ({
      address: q,
      symbol: symbolForQuote(q),
      native: false,
      approved: Boolean(approvals[i]),
    })),
  ];

  return {
    factory: getAddress(config.letscash.factory),
    launchEnabled: Boolean(launchEnabled),
    launchFeeWei: launchFee.toString(),
    firstConfigId: first,
    nextConfigId: next,
    count: configs.length,
    approvedQuotes,
    configs,
  };
}

/** Single-asset approvedQuote check. Native ETH short-circuits to true. */
async function approvedQuote(asset, deps = {}) {
  const a = getAddress(asset);
  if (a === ZeroAddress) return true; // sentinel, never in the mapping
  return factory(deps.runner || provider).approvedQuote(a);
}

// ────────────────────────── predict / mine salt ─────────────────────────────

/**
 * The token address `launch` would deploy for `sender`/`salt`. The impl keeps
 * params/configId in the signature for ABI stability but the clone's init code
 * is constant, so only sender and salt actually move the address (configId still
 * has to name an existing config, else InvalidConfigId).
 * @returns {Promise<string>} checksummed address
 */
async function predictToken({ params, configId, sender, salt }, deps = {}) {
  const f = factory(deps.runner || provider);
  const addr = await f.predictTokenAddress(normalizeParams(params), configId, getAddress(sender), salt);
  return getAddress(addr);
}

/**
 * Mine a salt whose token address wins the "cc" stamp (and sorts above the
 * quote). This is a VIEW — the search runs on-chain inside a single `eth_call`,
 * bounded by `rounds`, so cost is one round trip covering all `rounds` tries,
 * not one per try.
 *
 * COST: the stamp lands with probability ~1/1024 per try for an ETH quote
 * (~1/2048 for USDG, which also demands quote < token), so a few thousand rounds
 * almost always hit — measured ~240ms for 4000 rounds against the live node. On
 * a miss the impl reverts SaltNotFound; call again with `start` advanced past the
 * window already tried. `timeoutMs` guards a pathologically slow node.
 *
 * @param {{params:object, configId:number|bigint, sender:string, start?:bigint|number, rounds?:number, timeoutMs?:number}} args
 * @returns {Promise<{ salt: string, token: string } | null>} null on SaltNotFound within `rounds`.
 */
async function mineSalt({ params, configId, sender, start = 0n, rounds = 5000, timeoutMs }, deps = {}) {
  const f = factory(deps.runner || provider);
  const call = f.mineSalt(normalizeParams(params), configId, getAddress(sender), BigInt(start), BigInt(rounds));
  const race = timeoutMs
    ? Promise.race([
        call,
        new Promise((_res, rej) => setTimeout(() => rej(new Error(`mineSalt timed out after ${timeoutMs}ms`)), timeoutMs)),
      ])
    : call;
  try {
    const [salt, token] = await race;
    return { salt, token: getAddress(token) };
  } catch (err) {
    // A miss within the window is an expected, retryable outcome — surfaced as
    // null so the caller can widen `start`. Any other revert is a real fault.
    if (/SaltNotFound/.test(explainRevert(err))) return null;
    throw err;
  }
}

// ───────────────────────────── build / simulate ─────────────────────────────

/**
 * The unsigned `launch` transaction: `{ to, data, value }`. Nothing is signed or
 * sent — the caller signs and broadcasts later.
 *
 * value:
 *   - ETH-quoted pool (quote = 0x0, the default): value = launchFee + firstBuyIn.
 *     The factory reverts IncorrectValue on anything else.
 *   - ERC-20-quoted pool (USDG): value = launchFee ONLY. firstBuyIn is pulled
 *     from the creator by transferFrom, so it must be approved to the factory
 *     first (or launched via launchWithPermit). `firstBuyFromAllowance` in the
 *     return flags this.
 *
 * The impl also enforces params.creator == msg.sender (CreatorMustBeSender); if
 * `sender` is supplied it is checked here so that reverts before a broadcast.
 *
 * @param {{ params:object, configId:number|bigint, firstBuyIn?:bigint|string,
 *   firstBuyMinOut?:bigint|string, salt:string, launchFeeWei:bigint|string,
 *   quote?:string, sender?:string }} args
 * @returns {{ to:string, data:string, value:bigint, quote:string, firstBuyFromAllowance:boolean }}
 */
function buildLaunchTx({ params, configId, firstBuyIn = 0n, firstBuyMinOut = 0n, salt, launchFeeWei, quote = ZeroAddress, sender }) {
  if (salt == null) throw new Error('salt is required — mine one with mineSalt first');
  if (launchFeeWei == null) throw new Error('launchFeeWei is required — read it from getConfigs()');

  const fee = BigInt(launchFeeWei);
  const firstBuy = BigInt(firstBuyIn);
  const minOut = BigInt(firstBuyMinOut);
  const quoteAddr = getAddress(quote);
  const native = quoteAddr === ZeroAddress;

  const normalized = normalizeParams(params);
  if (sender && getAddress(sender) !== normalized[6]) {
    throw new Error(
      `params.creator (${normalized[6]}) must equal the sender (${getAddress(sender)}) — the factory reverts CreatorMustBeSender`
    );
  }

  // ETH first buy rides along in value; an ERC-20 first buy does not (pulled via
  // allowance), so its value is the fee alone.
  const value = native ? fee + firstBuy : fee;

  const data = FACTORY_IFACE.encodeFunctionData('launch', [normalized, configId, firstBuy, minOut, salt]);

  return {
    to: getAddress(config.letscash.factory),
    data,
    value,
    quote: quoteAddr,
    firstBuyFromAllowance: !native && firstBuy > 0n,
  };
}

/**
 * Static-call the built launch to preview it — never broadcasts. Returns the
 * token address and PoolId the launch WOULD produce (the `launch` return tuple),
 * or a decoded revert reason.
 *
 * NOTE: `launch` returns only (address token, bytes32 poolId) — the first-buy
 * amount out is NOT in the return; it is emitted in the TokenLaunched event, so
 * read it from parseLaunchReceipt after a real broadcast (or price it with the
 * quoter, out of scope here).
 *
 * @param {{to:string,data:string,value:bigint}} txFields  from buildLaunchTx
 * @param {string} from  the eventual sender (must equal params.creator)
 * @returns {Promise<{ok:true,token:string,poolId:string}|{ok:false,reason:string}>}
 */
async function simulateLaunch(txFields, from, deps = {}) {
  const runner = deps.runner || provider;
  try {
    const raw = await runner.call({
      to: txFields.to,
      data: txFields.data,
      value: txFields.value,
      from: getAddress(from),
    });
    const [token, poolId] = FACTORY_IFACE.decodeFunctionResult('launch', raw);
    return { ok: true, token: getAddress(token), poolId };
  } catch (err) {
    return { ok: false, reason: explainRevert(err) };
  }
}

// ─────────────────────────── receipt parsing ────────────────────────────────

/**
 * Pull the launched token, pool and first-buy result out of a mined receipt, so
 * the fire path learns where the token/pool landed. Reads three events by
 * topic0, tolerant of address casing:
 *   - TokenLaunched  (factory): token, creator, poolId, configId, firstBuyIn,
 *     firstBuyOut, hook, feeRecipient.
 *   - TokenLaunchedVNext (factory, optional): quote, moduleSetId, splitter.
 *   - Initialize (V4 poolManager): the pool's currencies, fee, tickSpacing,
 *     hook, sqrtPriceX96, tick.
 *
 * Returns null when no TokenLaunched is present. When both a TokenLaunched and an
 * Initialize are found their PoolIds are cross-checked and `poolIdMismatch` is
 * set if they disagree (they never should).
 *
 * @param {{logs: Array<{address:string, topics:string[], data:string}>}} receipt
 */
function parseLaunchReceipt(receipt, _deps = {}) {
  const logs = (receipt && receipt.logs) || [];

  let launched = null;
  let vnext = null;
  let pool = null;

  for (const log of logs) {
    const topic0 = log.topics && log.topics[0];
    if (!topic0) continue;
    try {
      if (topic0 === TOKEN_LAUNCHED_TOPIC) {
        const p = FACTORY_IFACE.parseLog({ topics: [...log.topics], data: log.data });
        launched = {
          token: getAddress(p.args.token),
          creator: getAddress(p.args.creator),
          poolId: p.args.poolId,
          configId: Number(p.args.configId),
          firstBuyIn: p.args.firstBuyIn.toString(),
          firstBuyOut: p.args.firstBuyOut.toString(),
          hook: getAddress(p.args.hook),
          feeRecipient: getAddress(p.args.feeRecipient),
        };
      } else if (topic0 === TOKEN_LAUNCHED_VNEXT_TOPIC) {
        const p = FACTORY_IFACE.parseLog({ topics: [...log.topics], data: log.data });
        vnext = {
          token: getAddress(p.args.token),
          poolId: p.args.poolId,
          quote: getAddress(p.args.quote),
          moduleSetId: Number(p.args.moduleSetId),
          splitter: getAddress(p.args.splitter),
        };
      } else if (topic0 === INITIALIZE_TOPIC) {
        const p = POOL_MANAGER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
        pool = {
          poolId: p.args.id,
          currency0: getAddress(p.args.currency0),
          currency1: getAddress(p.args.currency1),
          fee: Number(p.args.fee),
          tickSpacing: Number(p.args.tickSpacing),
          hooks: getAddress(p.args.hooks),
          sqrtPriceX96: p.args.sqrtPriceX96.toString(),
          tick: Number(p.args.tick),
        };
      }
    } catch (_err) {
      // A same-topic0 log from an unrelated contract, or a shape we do not
      // decode — skip it rather than fail the whole parse.
    }
  }

  if (!launched) return null;

  return {
    token: launched.token,
    poolId: launched.poolId,
    creator: launched.creator,
    configId: launched.configId,
    firstBuyIn: launched.firstBuyIn,
    firstBuyOut: launched.firstBuyOut,
    hook: launched.hook,
    feeRecipient: launched.feeRecipient,
    // From TokenLaunchedVNext when present.
    quote: vnext ? vnext.quote : null,
    moduleSetId: vnext ? vnext.moduleSetId : null,
    splitter: vnext ? vnext.splitter : null,
    // From the V4 Initialize event when present.
    pool,
    poolIdMismatch: pool ? pool.poolId !== launched.poolId : false,
  };
}

// ─────────────────────────── provenance lookup ──────────────────────────────

const LOG_WINDOW = 500_000; // backward-walk window when the node refuses the whole range
const MAX_SPLIT_DEPTH = 12; // caps the halving recursion for one refused window

// getLogs for [from,to], halving the range whenever the node refuses it (block-range
// caps, response-size caps). Appends into `out`. The same technique v2/holdings.js
// uses for the pons factory's TokenLaunched scan, kept local so v5/v6 own their copy.
async function getLogsSplitting(rpc, base, from, to, out, depth = 0) {
  try {
    const logs = await rpc.getLogs({ ...base, fromBlock: from, toBlock: to });
    out.push(...logs);
  } catch (err) {
    if (depth >= MAX_SPLIT_DEPTH || from >= to) throw err;
    const mid = Math.floor((from + to) / 2);
    await getLogsSplitting(rpc, base, from, mid, out, depth + 1);
    await getLogsSplitting(rpc, base, mid + 1, to, out, depth + 1);
  }
}

/**
 * Verify a token is a GENUINE letscash launch and return the authoritative hook +
 * poolId the factory assigned it — the provenance gate v6's dusting guard needs (a
 * decoy ERC-20 with a look-alike pool is exactly the honeypot this refuses).
 *
 * It filters the factory's own TokenLaunched events by the token (an indexed topic),
 * so a hit is proof the launchpad minted this token, and the event's `hook` is the
 * real per-pool hook — INCLUDING a per-token vanity hook, which an allowlist of known
 * hooks could never accept. Reads only; returns null when the factory never launched
 * this token.
 *
 * Fast path is one getLogs over the whole range; a node that refuses it triggers a
 * backward windowed walk that splits any window it still refuses, so the lookup is
 * reliable regardless of the RPC's range cap. Set config.letscash.factoryDeployBlock
 * to bound the scan to a single fast call.
 *
 * @returns {Promise<null|{token:string,creator:string,poolId:string,hook:string,configId:number}>}
 */
async function findLaunch(token, deps = {}) {
  const rpc = deps.provider || provider;
  const address = getAddress(config.letscash.factory);
  const tokenAddr = getAddress(token);
  // TokenLaunched(token indexed, creator indexed, poolId indexed, ...): filter on the
  // token topic alone, leaving creator/poolId unconstrained.
  const base = { address, topics: FACTORY_IFACE.encodeFilterTopics('TokenLaunched', [tokenAddr]) };
  const from = deps.fromBlock ?? config.letscash.factoryDeployBlock ?? 0;
  const head = deps.head ?? (await rpc.getBlockNumber());

  const raw = [];
  try {
    raw.push(...(await rpc.getLogs({ ...base, fromBlock: from, toBlock: head })));
  } catch {
    // The node refused the whole range — walk it from the head down, one window at a
    // time, splitting any window it still refuses, stopping at the first hit.
    for (let to = head; to >= from && raw.length === 0; to -= LOG_WINDOW) {
      const lo = Math.max(from, to - LOG_WINDOW + 1);
      await getLogsSplitting(rpc, base, lo, to, raw);
    }
  }
  if (raw.length === 0) return null;

  // The most recent, on the vanishingly unlikely chance a token address recurs.
  const log = raw[raw.length - 1];
  const p = FACTORY_IFACE.parseLog({ topics: [...log.topics], data: log.data });
  return {
    token: getAddress(p.args.token),
    creator: getAddress(p.args.creator),
    poolId: p.args.poolId,
    hook: getAddress(p.args.hook),
    configId: Number(p.args.configId),
  };
}

// ─────────────────────── FAST provenance (no getLogs) ────────────────────────
//
// v6's dusting guard used to prove a token via findLaunch — a getLogs scan that 504s on a
// range-capped RPC. This proves it the way V3 does (one view/read), because a real letscash
// token is an EIP-1167 minimal-proxy CLONE of a factory `tokenMaster`: eth_getCode(token)
// yields the 45-byte proxy runtime carrying the implementation address, and that impl must
// be one the factory's module sets name. One eth_getCode, no logs.

// EIP-1167 runtime: 10-byte prefix, 20-byte implementation, 15-byte suffix = 45 bytes.
const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

/** The implementation a minimal-proxy delegates to (checksummed), or null if not one. */
function proxyImplementation(code) {
  if (typeof code !== 'string') return null;
  const hex = code.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 90 || !hex.startsWith(EIP1167_PREFIX) || !hex.endsWith(EIP1167_SUFFIX)) return null;
  return getAddress('0x' + hex.slice(20, 60));
}

/**
 * The tokenMasters and hooks the LIVE config menu references, read from the factory's
 * module sets — so any module set letscash adds is picked up automatically. eth_calls only
 * (no getLogs), parallelized. Returns lowercased address Sets.
 */
async function moduleSets(deps = {}) {
  const f = factory(deps.runner || deps.provider || provider);
  const [first, next] = (await Promise.all([f.firstConfigId(), f.nextConfigId()])).map(Number);
  const span = Math.max(0, next - first);
  const cfgs = await Promise.all(Array.from({ length: span }, (_, i) => f.getLaunchConfig(first + i)));
  const setIds = [...new Set(cfgs.map((c) => Number(c.moduleSetId)))];
  const sets = await Promise.all(setIds.map((id) => f.getModuleSet(id)));
  const tokenMasters = new Set();
  const hooks = new Set();
  for (const s of sets) {
    if (!s.exists) continue;
    tokenMasters.add(getAddress(s.tokenMaster).toLowerCase());
    hooks.add(getAddress(s.hook).toLowerCase());
  }
  return { tokenMasters, hooks };
}

// The allowlist, always at least the config seed so the first request never waits on the
// factory read. Refreshed in the background on a TTL and on demand; the seed is verified
// live, and the factory read only ADDS to it.
let _legit = null;
let _legitAt = 0;
let _legitRefreshing = null;
const LEGIT_TTL_MS = 10 * 60_000;

// Normalise a list of addresses, SKIPPING any that are malformed — a mis-checksummed
// operator env var must not throw and disable the whole guard.
function normAddrs(list) {
  const out = [];
  for (const a of list || []) {
    try {
      out.push(getAddress(a).toLowerCase());
    } catch {
      /* skip a bad address rather than break v6 */
    }
  }
  return out;
}

function seedLegit() {
  return {
    tokenMasters: new Set(normAddrs(config.letscash.tokenMasters)),
    hooks: new Set(normAddrs([config.letscash.hook, ...(config.letscash.legitHooks || [])])),
  };
}

function legitSetsSync() {
  if (!_legit) _legit = seedLegit();
  return _legit;
}

/** Force a refresh from the factory (inflight-deduped). Never rejects — keeps the seed. */
function refreshLegitSets(deps = {}) {
  if (_legitRefreshing) return _legitRefreshing;
  _legitRefreshing = (async () => {
    try {
      const derived = await moduleSets(deps);
      const seed = seedLegit();
      _legit = {
        tokenMasters: new Set([...seed.tokenMasters, ...derived.tokenMasters]),
        hooks: new Set([...seed.hooks, ...derived.hooks]),
      };
      _legitAt = Date.now();
    } catch {
      /* keep whatever we have — the seed is always valid */
    } finally {
      _legitRefreshing = null;
    }
  })();
  return _legitRefreshing;
}

/** The current allowlist (never blocks). Kicks off a background refresh when stale. */
async function legitSets(deps = {}) {
  const cur = legitSetsSync();
  if (Date.now() - _legitAt > LEGIT_TTL_MS && !_legitRefreshing) refreshLegitSets(deps);
  return cur;
}

/** Populate + refresh at boot so the first readPool is warm. Best-effort. */
function warmLegitSets(deps = {}) {
  legitSetsSync();
  refreshLegitSets(deps);
}

/**
 * PROVENANCE: is this token a genuine letscash launch? — one eth_getCode. It must be an
 * EIP-1167 clone of a factory tokenMaster. A decoy ERC-20 (its own bytecode, or a proxy to
 * some other impl) is rejected. A proxy to an UNKNOWN impl forces ONE factory refresh and
 * re-checks (self-heals a brand-new tokenMaster) before rejecting.
 *
 * @returns {Promise<{ok:true,impl:string}|{ok:false,reason:string}>}
 */
async function verifyProvenanceByCode(token, deps = {}) {
  const rpc = deps.provider || provider;
  const code = await rpc.getCode(getAddress(token));
  const impl = proxyImplementation(code);
  if (!impl) return { ok: false, reason: 'not an EIP-1167 clone of a letscash tokenMaster' };
  const implLc = impl.toLowerCase();
  if (legitSetsSync().tokenMasters.has(implLc)) return { ok: true, impl };
  // A well-formed proxy to an UNKNOWN impl — maybe a brand-new tokenMaster. Kick a
  // TTL-guarded BACKGROUND refresh (never awaited: an unknown-impl proxy must not cost ~60
  // awaited eth_calls per request — that is a DoS vector) and reject for now. A genuine new
  // tokenMaster self-heals on the next request once the refresh lands.
  if (Date.now() - _legitAt > LEGIT_TTL_MS && !_legitRefreshing) refreshLegitSets(deps);
  return { ok: false, reason: `implementation ${impl} is not a letscash tokenMaster` };
}

module.exports = {
  // reads
  getConfigs,
  findLaunch,
  // fast provenance (no getLogs)
  proxyImplementation,
  moduleSets,
  legitSets,
  legitSetsSync,
  refreshLegitSets,
  warmLegitSets,
  verifyProvenanceByCode,
  approvedQuote,
  predictToken,
  mineSalt,
  // build / preview (no broadcast)
  buildLaunchTx,
  simulateLaunch,
  parseLaunchReceipt,
  // pure helpers
  factory,
  normalizeParams,
  hasVanitySuffix,
  poolKeyFor,
  computePoolId,
  decodeConfig,
  symbolForQuote,
  explainRevert,
  // ABI / constants, for reuse and tests
  CASHCAT_FACTORY_ABI,
  V4_POOL_MANAGER_ABI,
  FACTORY_IFACE,
  POOL_MANAGER_IFACE,
  LAUNCH_SELECTOR,
  TOKEN_LAUNCHED_TOPIC,
  TOKEN_LAUNCHED_VNEXT_TOPIC,
  INITIALIZE_TOPIC,
};
