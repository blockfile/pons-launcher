// The addresses the dApp signs against, PINNED into the bundle.
//
// Every value is copied from backend/src/config.js (the defaults that
// backend/src/tp/constants.js reads) and constants.test.js checks them against
// that module, so the browser and the server cannot drift apart. They are pinned
// rather than fetched on purpose: the page must never approve or route through an
// address because a server response named it.
//
// All lower-case. The UniversalRouter's mixed-case literal is NOT a valid EIP-55
// checksum (backend/src/evm/v3/poolswap.js:120-122), so these are only ever
// checksummed with ethers' getAddress() from the lower-case form.

export const CHAIN_ID = 4663; // backend/src/config.js:29

export const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'; // config.js:45
export const PONS_V1_FACTORY = '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb'; // config.js:33
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'; // config.js:144
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'; // config.js:331
export const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904'; // config.js:332
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94'; // config.js:333
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'; // config.js:334
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'; // config.js:335
export const SWAP_ROUTER02 = '0xcaf681a66d020601342297493863e78c959e5cb2'; // config.js:399
export const QUOTER_V2 = '0x5dedb1f91f5f56177bb4d193ad281b33e4f13098'; // config.js:400
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'; // config.js:401
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'; // config.js:402
export const WETH_USDG_FEE = 100; // config.js:405 — the 0.01% WETH/USDG pool

// V4's native-coin sentinel; also a native pons launch's pairToken
// (backend/src/evm/v3/poolswap.js:131-133).
export const NATIVE = '0x0000000000000000000000000000000000000000';

// pons v1 pools are Uniswap v3, fee 10000 (1%), paired with WETH, traded through
// SwapRouter02 without a deadline field (docs/superpowers/specs/
// 2026-07-25-pons-launcher-design.md:242-256).
export const V1_POOL_FEE = 10000;

// USDG<->pairToken tiers the backend route discovery probes
// (backend/src/evm/v3/swaproute.js:54). A route naming any other tier is refused.
export const PAIR_FEE_TIERS = [3000, 500, 100, 10000];

// The pair->ETH route's price-impact ceiling (config.js:410, v3Route.maxImpactBps).
// The QuoterV2 SATURATES on an oversized input, so a slippage floor alone cannot
// see a pool drain (memory: v3-token-quoted-route).
export const MAX_ROUTE_IMPACT_BPS = 1000;

// Timing, in seconds.
export const PERMIT2_EXPIRY_SECONDS = 86400; // spec decision 6: a 24 h Permit2 grant
export const PERMIT2_REARM_MARGIN_SECONDS = 3600; // re-arm when under an hour is left
export const SELL_EXPIRY_MARGIN_SECONDS = 60; // a sell needs a grant alive for at least this
// Router deadline. Generous on purpose: the visitor's clock can be minutes off,
// and minOut, not the deadline, is what protects the price.
export const DEADLINE_SECONDS = 1200;
