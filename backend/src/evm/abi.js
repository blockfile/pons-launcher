'use strict';

// ABIs transcribed from the verified PonsLaunchFactory source on Robinhood
// Chain (0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB). Field ORDER matters —
// these are positional tuples, and a wrong order silently mislabels a launch.

// struct Socials { string twitter; telegram; discord; website; farcaster; }
// struct TokenParams { string name; symbol; logo; description; Socials socials; address feeWallet; }
const TOKEN_PARAMS =
  'tuple(string name, string symbol, string logo, string description, ' +
  'tuple(string twitter, string telegram, string discord, string website, string farcaster) socials, ' +
  'address feeWallet)';

// struct LaunchConfig — note routerRequiresDeadline, which selects the router
// interface used for the buy (see router.js).
const LAUNCH_CONFIG =
  'tuple(address pairToken, uint256 graduationThreshold, int24 initialTick, uint256 supply, ' +
  'uint16 maxWalletBps, uint16 maxTxBps, uint32 restrictionBlocks, uint24 reservedFee, ' +
  'bool enabled, bool routerRequiresDeadline)';

// struct DexConfig
const DEX_CONFIG =
  'tuple(string name, address factory, address positionManager, address swapRouter, ' +
  'uint24 poolFee, int24 tickSpacing, bool enabled)';

const FACTORY_ABI = [
  `function launchToken(${TOKEN_PARAMS} params, uint256 launchConfigId, uint256 dexId, bytes32 salt) payable returns (address token)`,
  `function predictTokenAddress(${TOKEN_PARAMS} params, uint256 launchConfigId, uint256 dexId, bytes32 salt, address tokenDeployer) view returns (address)`,
  `function getLaunchConfig(uint256 id) view returns (${LAUNCH_CONFIG})`,
  `function getDexConfig(uint256 id) view returns (${DEX_CONFIG})`,
  'function launchConfigCount() view returns (uint256)',
  'function dexConfigCount() view returns (uint256)',
  'function launchFee() view returns (uint256)',
];

// The two router shapes the factory itself switches between in
// _executeInitialBuy, chosen by LaunchConfig.routerRequiresDeadline.
const SWAP_ROUTER_V3_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

const SWAP_ROUTER_02_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

// Getters the launched PonsLauncherToken exposes (used for post-launch reads).
const PONS_TOKEN_ABI = [
  'function launchFactory() view returns (address)',
  'function liquidityPool() view returns (address)',
  'function pairToken() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function deployer() view returns (address)',
  'function restrictionEndBlock() view returns (uint256)',
  'function maxWalletLimit() view returns (uint256)',
  'function maxTxLimit() view returns (uint256)',
];

module.exports = {
  TOKEN_PARAMS,
  LAUNCH_CONFIG,
  DEX_CONFIG,
  FACTORY_ABI,
  SWAP_ROUTER_V3_ABI,
  SWAP_ROUTER_02_ABI,
  PONS_TOKEN_ABI,
};
