'use strict';

// ABIs transcribed from the VERIFIED pons v2 contracts on Robinhood Chain:
//   PonsV2LaunchFactory  0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8
//   PonsV2BondingCurve   (one per launch, e.g. 0x4bD421eB79aCa48d13793c7140582C8ef312d124)
//
// v2 is a different protocol, not a new version of v1. A launch no longer
// creates a pool — it creates a bonding curve holding the whole supply, and a
// Uniswap v4 pool is only built at graduation. There is NO creator allocation
// and NO dev buy: msg.value on launchToken is the launch fee and nothing else.

// struct Socials { string twitter; telegram; discord; website; farcaster; }
const SOCIALS =
  'tuple(string twitter, string telegram, string discord, string website, string farcaster)';

// struct TokenParams — note how much this differs from v1's: no feeWallet, and
// three new fields that fix the token's economics at creation.
//   creatorTaxBps     your cut of every trade, capped by maxCreatorTaxBps, immutable
//   buybackEnabled    spends part of YOUR fee share buying the token back
//   expectedEconomics a commitment from previewLaunchEconomics(); the launch
//                     reverts if the config's economics moved under you
const TOKEN_PARAMS_V2 =
  'tuple(string name, string symbol, string logo, string description, ' +
  `${SOCIALS} socials, ` +
  'address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics)';

const LAUNCH_CONFIG_V2 =
  'tuple(uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, ' +
  'uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled)';

const FACTORY_V2_ABI = [
  `function launchToken(${TOKEN_PARAMS_V2} params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)`,
  `function getLaunchConfig(uint256 id) view returns (${LAUNCH_CONFIG_V2})`,
  'function launchConfigCount() view returns (uint256)',
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function whitelistedLaunchers(address launcher) view returns (bool)',
  'function approvedPairTokens(address pairToken) view returns (bool)',
  'function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 expectedDecimals)',
  'function maxCreatorTaxBps() view returns (uint256)',
  // Produces the bytes32 that TokenParams.expectedEconomics must carry.
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function getLaunchedToken(address token) view returns (tuple(address curve, address pairToken, uint256 launchConfigId, address creator, bool graduated))',
  // token, curve and deployer are all indexed, so a receipt yields the curve
  // address directly — which is what makes the reactive bundle possible.
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
];

const CURVE_V2_ABI = [
  // Native-quote launches send `quoteIn` as value; ERC-20 pairs approve first.
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function token() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function quoteReserve() view returns (uint256)',
  'function tokenReserve() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
];

module.exports = {
  SOCIALS,
  TOKEN_PARAMS_V2,
  LAUNCH_CONFIG_V2,
  FACTORY_V2_ABI,
  CURVE_V2_ABI,
};
