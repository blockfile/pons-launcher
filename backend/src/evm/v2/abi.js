'use strict';

// ABIs transcribed from the VERIFIED pons v2 contracts on Robinhood Chain.
//
//   PonsV2LaunchFactory   0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
//   PonsV2LaunchDeployer  0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42
//   PonsV2LaunchForwarder 0xe33E9E479dF8802cb0866d5d05258bEc4cF62948
//   PonsV2BondingCurve    one per launch, deployed by the deployer
//
// NOT the address in the docs (0x7E1EAbd5…). That deployment has never emitted
// an event and its launchEnabled is still false; this one has thousands of
// launches. The docs list addresses that were superseded without a changelog,
// so these were found by scanning the chain for the TokenLaunched topic and
// reading the verified source of whatever emitted it.
//
// v2 is a different protocol, not a new version of v1. A launch creates a
// bonding curve holding the whole supply; a Uniswap v4 pool is only built at
// graduation.
//
// Two things here shape the whole bundle:
//
//   1. A SNIPE TAX. Every buy in the opening window pays a tax starting at
//      snipeTaxStartBps (99% live) and decaying exponentially to zero across
//      snipeTaxSeconds (3 live). It is charged on the RECIPIENT, not the buyer.
//   2. An EXEMPTION LIST. launchToken takes up to 32 addresses exempt from that
//      tax, applied atomically inside the launch. The source calls this "the
//      sanctioned pathway for organized teams that bundle their opening buys
//      across several wallets".
//
// So on v2 the bundle does not race anyone. It is declared.

const SOCIALS =
  'tuple(string twitter, string telegram, string discord, string website, string farcaster)';

// struct TokenParams. `salt` is new since the version this project first
// targeted, and it is what makes the token and curve addresses predictable
// before the launch is sent — which is what lets the bundle be pre-signed.
const TOKEN_PARAMS_V2 =
  'tuple(string name, string symbol, string logo, string description, ' +
  `${SOCIALS} socials, ` +
  'address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, ' +
  'bytes32 expectedEconomics, bytes32 salt)';

const LAUNCH_CONFIG_V2 =
  'tuple(uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, ' +
  'uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled)';

// struct FeePolicySnapshot, read from the meme hook at launch time and frozen
// into the curve.
const FEE_POLICY =
  'tuple(address protocolFeeRecipient, uint16 protocolFeeShareBps, uint16 buybackBurnBps, ' +
  'uint16 hookFeeBps, uint16 maxInternalPriceImpactBps)';

// struct LaunchDeployment — what the factory hands the deployer. Every field is
// derived from factory state and the caller's params, so it can be rebuilt off
// chain and fed to predictLaunchAddresses.
const LAUNCH_DEPLOYMENT =
  'tuple(address pairToken, address creatorFeeRecipient, address originalDeployer, ' +
  `address feePolicy, ${FEE_POLICY} policy, address feeEscrow, address buybackVault, ` +
  'uint256 phantomQuote, uint256 curveFeeBps, uint256 creatorTaxBps, bool buybackEnabled, ' +
  'uint256 graduationThreshold, uint256 supply, bytes32 salt, string name, string symbol, ' +
  `string logo, string description, ${SOCIALS} socials)`;

const FACTORY_V2_ABI = [
  `function launchToken(${TOKEN_PARAMS_V2} params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)`,
  `function launchToken(${TOKEN_PARAMS_V2} params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)`,

  // Gating. canLaunch() is the real check — whitelistedLaunchers is only one
  // input to it, and reading that mapping alone said "false" while canLaunch
  // said "true" for the same wallet.
  'function canLaunch(address launcher) view returns (bool)',
  'function launchEnabled() view returns (bool)',
  'function whitelistedLaunchers(address launcher) view returns (bool)',

  'function launchFee() view returns (uint256)',
  'function launchConfigCount() view returns (uint256)',
  `function getLaunchConfig(uint256 id) view returns (${LAUNCH_CONFIG_V2})`,
  'function approvedPairTokens(address pairToken) view returns (bool)',
  'function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
  'function maxCreatorTaxBps() view returns (uint256)',

  // The wiring the launch path depends on, and the source of the deployment
  // struct's non-caller fields.
  'function launchDeployer() view returns (address)',
  'function launchForwarder() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function buybackVault() view returns (address)',
  'function memeHook() view returns (address)',

  'function snipeTaxStartBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',

  'function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',

  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
];

// The deployer is where the addresses come from, and the only reason the v2
// bundle can be pre-signed at all.
const DEPLOYER_V2_ABI = [
  `function predictLaunchAddresses(${LAUNCH_DEPLOYMENT} params) view returns (address token, address curve)`,
  'function factory() view returns (address)',
];

// Atomic launch + opening buy + exemption list in one transaction. This is the
// v2 equivalent of v1's atomic dev buy: the dev's tokens are bought inside the
// launch, so nothing can get in front of them.
const FORWARDER_V2_ABI = [
  `function launchAndBuy(${TOKEN_PARAMS_V2} params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)`,
  'function factory() view returns (address)',
];

const MEME_HOOK_V2_ABI = [`function currentFeePolicy() view returns (${FEE_POLICY})`];

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

  // Whether a wallet will pay the opening tax. Checked against the RECIPIENT of
  // the buy, so a bundle wallet buying for itself must be on the list.
  'function snipeTaxExempt(address account) view returns (bool)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function snipeTaxStartBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
];

// The factory refuses a list longer than this (MAX_SNIPE_TAX_EXEMPTIONS).
const MAX_SNIPE_TAX_EXEMPTIONS = 32;

// ...BUT THE FORWARDER ALLOWS ONE FEWER, and the difference is a revert rather
// than a truncation. launchAndBuy appends its own buy recipient to the list
// before passing it on, so a caller-supplied 32 becomes 33 at the factory and
// fails. Probed against the live contracts: factory-direct takes 32 and
// reverts at 33; launchAndBuy takes 31 and reverts at 32.
//
// This is the cap that matters for a bundle, because launchAndBuy is the only
// path with an atomic dev buy. A launcher written to the documented 32 reverts
// on exactly the configuration an operator is most likely to want.
const MAX_EXEMPTIONS_VIA_FORWARDER = MAX_SNIPE_TAX_EXEMPTIONS - 1;

// Every custom error declared by the four v2 contracts (factory, forwarder,
// deployer, curve), transcribed from their VERIFIED sources. The other ABI
// arrays above carry only functions and events, so without these a revert comes
// back as a bare 4-byte selector — which is exactly why a launch that reverted
// ExemptionListTooLong showed the operator nothing. factory.explainRevert
// decodes against these.
const V2_ERROR_ABI = [
  "error AlreadySet()",
  "error CombinedFeeTooHigh()",
  "error CoreLpFeeMustBeZero()",
  "error Create2EmptyBytecode()",
  "error CreatorTaxTooHigh()",
  "error CurveFeeTooHigh()",
  "error CurveNotQuotable()",
  "error ExemptionListTooLong()",
  "error FailedDeployment()",
  "error FeeTransferFailed()",
  "error GraduationExecutorNotSet()",
  "error GraduationRescueTooEarly(uint256 availableAt)",
  "error GraduationSeedNotViable()",
  "error GraduationStillViable()",
  "error InexactTransfer(address token, uint256 expected, uint256 received)",
  "error InsufficientBalance(uint256 balance, uint256 needed)",
  "error InvalidBasisPoints()",
  "error InvalidGraduationThreshold()",
  "error InvalidLaunchConfigId()",
  "error InvalidPhantomQuote()",
  "error InvalidSnipeTaxWindow()",
  "error InvalidTickSpacing()",
  "error InvalidTokenParams()",
  "error LaunchConfigDisabled()",
  "error LaunchDependenciesNotWired()",
  "error LaunchDeployerNotSet()",
  "error LaunchEconomicsMismatch(bytes32 expected, bytes32 actual)",
  "error LaunchFeeNotPaid()",
  "error MetadataTooLong()",
  "error NativeValueMismatch(uint256 sent, uint256 expected)",
  "error NoPendingChange()",
  "error NotApprovedLauncher()",
  "error NotBuybackController()",
  "error NotCreatorFeeRecipient()",
  "error NotFactory()",
  "error NotLaunchForwarder()",
  "error NotReadyToGraduate()",
  "error NotWhitelisted()",
  "error NothingToGraduate()",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnershipCannotBeRenounced()",
  "error PairTokenDecimalsMismatch(uint8 expected, uint8 actual)",
  "error PairTokenDecimalsUnavailable()",
  "error PairTokenEconomicsInvalid()",
  "error PairTokenNotApproved()",
  "error PairTokenValidationFailed()",
  "error ReentrancyGuardReentrantCall()",
  "error RefundFailed()",
  "error SafeERC20FailedOperation(address token)",
  "error SqrtPriceOutOfBounds()",
  "error SupplyTooHigh()",
  "error SupplyTooLow()",
  "error TimelockExpired(uint256 expiresAt)",
  "error TimelockNotElapsed(uint256 effectiveAt)",
  "error TokenNotFound()",
  "error UnsupportedPrice()",
  "error WrongGraduationPhase()",
  "error ZeroAddress()",
  "error ZeroAmount()",
];

module.exports = {
  SOCIALS,
  TOKEN_PARAMS_V2,
  LAUNCH_CONFIG_V2,
  FEE_POLICY,
  LAUNCH_DEPLOYMENT,
  FACTORY_V2_ABI,
  DEPLOYER_V2_ABI,
  FORWARDER_V2_ABI,
  MEME_HOOK_V2_ABI,
  CURVE_V2_ABI,
  V2_ERROR_ABI,
  MAX_SNIPE_TAX_EXEMPTIONS,
  MAX_EXEMPTIONS_VIA_FORWARDER,
};
