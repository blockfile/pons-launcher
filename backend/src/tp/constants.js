'use strict';

// Every address, topic and ABI fragment the take-profit dApp's backend uses.
//
// TAB ISOLATION: the fragments below are COPIED from other tabs' modules (cited per
// line), never imported from them — see memory "v4-seasoning-isolation-rule". The
// addresses are read from ../config (shared infra every tab already uses), so an env
// override moves the dApp together with the rest of the process. The browser bundle
// pins the same addresses in frontend/src/dapp/chain/constants.js; the broadcast
// validator refuses anything addressed elsewhere, so the two must agree — the
// defaults are pinned by constants.test.js.
//
// Every address is stored LOWER-CASE. Compare lower-case to lower-case; call
// ethers.getAddress() on a value only when a checksummed form is needed (the
// UniversalRouter's mixed-case literal in config is NOT a valid EIP-55 checksum —
// evm/v5/swap.js:189-193 — so never feed a raw config string to getAddress).

const config = require('../config');

const lower = (a) => String(a).toLowerCase();

const CHAIN_ID = 4663;

// pons v2 launch factory — config.js:44-45. Registry: getLaunchedToken(token).
const PONS_V2_FACTORY = lower(config.v2FactoryAddress);
// pons v1 PonsLaunchFactory — config.js:33. Registry: getLaunchedToken(token).
const PONS_V1_FACTORY = lower(config.factoryAddress);
// Multicall3 at its standard address — config.js:143-144.
const MULTICALL3 = lower(config.multicallAddress);
// The chain's Uniswap V4 singletons — config.js:331-336. Shared by every V4 pool on
// 4663 (verified: StateView.poolManager() == V4Quoter.poolManager() == the pons
// memeHook's poolManager(), evm/v3/poolswap.js:112-129).
const POOL_MANAGER = lower(config.letscash.poolManager);
const STATE_VIEW = lower(config.letscash.stateView);
const V4_QUOTER = lower(config.letscash.quoter);
const UNIVERSAL_ROUTER = lower(config.letscash.universalRouter);
const PERMIT2 = lower(config.letscash.permit2);
// Uniswap v3 periphery + the ETH<->USDG<->pair route — config.js:398-405. SwapRouter02
// is also every pons v1 dex config's swapRouter (docs/superpowers/specs/
// 2026-07-25-pons-launcher-design.md:252).
const SWAP_ROUTER02 = lower(config.v3Route.swapRouter);
const QUOTER_V2 = lower(config.v3Route.quoter);
const WETH = lower(config.v3Route.weth);
const USDG = lower(config.v3Route.usdg);
const WETH_USDG_FEE = Number(config.v3Route.wethUsdgFee);
// pons' pairToken for a native-quoted launch, and V4's native currency sentinel
// (evm/v3/poolswap.js:131-133).
const NATIVE = '0x0000000000000000000000000000000000000000';

// Trade-event topic0s, confirmed live by the 2026-09-19 research run and recomputed
// from their signatures by constants.test.js.
const TOPICS = Object.freeze({
  // Emitted BY THE CURVE: data [quoteIn, tokensOut, fee, 0]; both indexed = the trader.
  CURVE_BUY: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  // Emitted BY THE CURVE: data [tokensIn, quoteOut, fee, 0]; both indexed = the trader.
  CURVE_SELL: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  // PoolManager Swap — ALWAYS filter topic1 = poolId (the manager carries every V4 pool).
  V4_SWAP: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  // Uniswap v3 pool Swap (pons v1).
  V3_SWAP: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
});

// ── ABI fragments ────────────────────────────────────────────────────────────

// pons v2 getLaunchedToken record — evm/v2/abi.js:93.
const LAUNCHED_TOKEN_V2 =
  'tuple(address token, address curve, address deployer, address creatorFeeRecipient, ' +
  'address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, ' +
  'uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, ' +
  'uint256 sweptTokens, uint256 sweptAt, bool exists)';

// pons v1 records — evm/abi.js:16-35.
const LAUNCH_CONFIG_V1 =
  'tuple(address pairToken, uint256 graduationThreshold, int24 initialTick, uint256 supply, ' +
  'uint16 maxWalletBps, uint16 maxTxBps, uint32 restrictionBlocks, uint24 reservedFee, ' +
  'bool enabled, bool routerRequiresDeadline)';
const DEX_CONFIG_V1 =
  'tuple(string name, address factory, address positionManager, address swapRouter, ' +
  'uint24 poolFee, int24 tickSpacing, bool enabled)';
const LAUNCHED_TOKEN_V1 =
  'tuple(address token, address deployer, address pairedToken, address positionManager, ' +
  'uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, ' +
  'uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount)';

// V4 PoolKey and the V4Quoter's FOUR-field param (no sqrtPriceLimitX96) — evm/v5/swap.js:130-140.
const POOLKEY_T = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const QUOTE_EXACT_SINGLE_T = `tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)`;

const freeze = (list) => Object.freeze(list.slice());

const ABI = Object.freeze({
  V2_FACTORY: freeze([
    `function getLaunchedToken(address token) view returns (${LAUNCHED_TOKEN_V2})`, // evm/v2/abi.js:93
    'function memeHook() view returns (address)', // evm/v2/abi.js:88
    'function approvedPairTokens(address pairToken) view returns (bool)', // evm/v2/abi.js:78
  ]),
  V1_FACTORY: freeze([
    `function getLaunchedToken(address token) view returns (${LAUNCHED_TOKEN_V1})`, // evm/abi.js:41
    `function getDexConfig(uint256 id) view returns (${DEX_CONFIG_V1})`, // evm/abi.js:40
    `function getLaunchConfig(uint256 id) view returns (${LAUNCH_CONFIG_V1})`, // evm/abi.js:39
  ]),
  // The v1 dex factory: pool discovery from the factory's own getPool, never the token's
  // self-reported liquidityPool() — evm/pricing.js:27,33-35.
  V3_FACTORY: freeze(['function getPool(address, address, uint24) view returns (address)']),
  CURVE: freeze([
    'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)', // evm/v2/abi.js:133
    'function isNativeQuote() view returns (bool)', // evm/v2/abi.js:134
    'function pairToken() view returns (address)', // evm/v2/abi.js:135
    'function token() view returns (address)', // evm/v2/abi.js:136
    'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)', // evm/v2/abi.js:137
    'function sellableTokens() view returns (uint256)', // evm/v2/abi.js:142
    'function readyToGraduate() view returns (bool)', // evm/v2/abi.js:145
    'function graduated() view returns (bool)', // evm/v2/abi.js:146
    'function feeBps() view returns (uint256)', // evm/v2/abi.js:147
    'function creatorTaxBps() view returns (uint256)', // evm/v2/abi.js:148
    // The launch's frozen fee policy == its V4 hook — evm/v3/poolswap.js:143.
    'function feePolicy() view returns (address)',
    // Launch constants for the token header (tokenInfo.js). NOT in the repo before it:
    // selectors read off live curve bytecode and matched in the openchain signature DB
    // (2026-09-19); readable on all 278 sampled v2 curves, graduated ones included.
    'function launchedAt() view returns (uint256)', // 0xbf56b371: unix s == the launch block's timestamp
    'function phantomQuote() view returns (uint256)', // 0xc57eadfc: the virtual quote reserve
    'function launchSupply() view returns (uint256)', // 0x3f7ed6b7: tokens on the curve at launch
  ]),
  // The pons TOKEN's own metadata getter: one selector on v1 and v2, curve and graduated
  // (0xabb1dc44; the decode round-trips on 428 sampled tokens, 2026-09-19). NOT in the
  // repo before tokenInfo.js. The token has no setter, so the answer never changes.
  PONS_TOKEN: freeze([
    'function getTokenInfo() view returns (address deployer, string logo, string description, tuple(string twitter, string telegram, string discord, string website, string farcaster) socials)',
  ]),
  ERC20: freeze([
    'function name() view returns (string)',
    'function symbol() view returns (string)', // evm/erc20.js:10
    'function decimals() view returns (uint8)', // evm/erc20.js:9
    'function totalSupply() view returns (uint256)', // evm/erc20.js:11
    'function balanceOf(address) view returns (uint256)', // evm/erc20.js:8
    'function allowance(address owner, address spender) view returns (uint256)', // v5/launch.js:55
    'function approve(address spender, uint256 amount) returns (bool)', // evm/v3/swaproute.js:42
  ]),
  MULTICALL3: freeze([
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)', // evm/erc20.js:51
    'function getEthBalance(address addr) view returns (uint256)', // evm/erc20.js:55
    // CAUTION: on this chain block.number is the L1-derived number (~16 s), NOT the RPC
    // height (~100 ms) — evm/blocknumber.js:3-15. Never use it as a log/receipt block.
    'function getBlockNumber() view returns (uint256 blockNumber)',
    'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
    'function getBasefee() view returns (uint256 basefee)',
  ]),
  STATE_VIEW: freeze([
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)', // evm/v5/swap.js:153
    'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)', // evm/v5/swap.js:154
  ]),
  V4_QUOTER: freeze([
    // Non-view on chain (reverts to return); call with eth_call / staticCall only — evm/v5/swap.js:147-150.
    `function quoteExactInputSingle(${QUOTE_EXACT_SINGLE_T} params) returns (uint256 amountOut, uint256 gasEstimate)`,
  ]),
  V3_POOL: freeze([
    'function token0() view returns (address)', // evm/pricing.js:29
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)', // evm/pricing.js:30
    'function liquidity() view returns (uint128)', // evm/distributor.js:61
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  ]),
  QUOTER_V2: freeze([
    // Multi-hop; state-mutating, staticCall only — evm/v3/swaproute.js:37-41.
    'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
    // Single-hop: Uniswap v3-periphery IQuoterV2 (selector 0xc6a5026a). NOT in the repo
    // before this module — first exercised by the Anvil-fork run.
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ]),
  SWAP_ROUTER02: freeze([
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)', // evm/abi.js:61
    'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)', // evm/v3/swaproute.js:33
    // ONLY the bytes[] overload (0xac9650d8): declaring the deadline overload too would make
    // encodeFunctionData('multicall', …) ambiguous — evm/abi.js:62, evm/v3/swaproute.js:34.
    'function multicall(bytes[] data) payable returns (bytes[] results)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable', // evm/abi.js:63
  ]),
  UNIVERSAL_ROUTER: freeze([
    // ONLY the deadline overload (0x3593564c) — evm/v5/swap.js:143-145.
    'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  ]),
  PERMIT2: freeze([
    'function approve(address token, address spender, uint160 amount, uint48 expiration)', // evm/v5/swap.js:178
    // Permit2 AllowanceTransfer's public mapping (selector 0x927da105). NOT in the repo
    // before this module — first exercised by the Anvil-fork run.
    'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  ]),
  // Every trade event the indexer decodes. Two events share the name "Swap": look them up
  // by topic (Interface.parseLog / getEvent(topicHash)) or full signature, never by name.
  EVENTS: freeze([
    'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 reserved)',
    'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 reserved)',
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  ]),
});

module.exports = {
  CHAIN_ID,
  PONS_V2_FACTORY,
  PONS_V1_FACTORY,
  MULTICALL3,
  POOL_MANAGER,
  STATE_VIEW,
  V4_QUOTER,
  UNIVERSAL_ROUTER,
  PERMIT2,
  SWAP_ROUTER02,
  QUOTER_V2,
  WETH,
  USDG,
  WETH_USDG_FEE,
  NATIVE,
  TOPICS,
  ABI,
};
