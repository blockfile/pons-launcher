'use strict';

// The trigger buy: one swap, split across many wallets, in one transaction.
//
// THE STRATEGY THIS SERVES, in one paragraph. A v1 pool opens with about 1.36
// ETH of depth against the whole supply, so a bot spending 0.05-0.07 ETH takes
// 4-5% of it. Those bots exit by selling into whatever buys next, and a
// thirty-wallet bundle racing for the pool the moment trading opens is exactly
// that exit — measured over 139 launches, bundles firing more than five blocks
// after the open were sniped for 1.945% of supply against 0.096% for those
// firing at it, and the bots' profit tracks the operator ETH landing behind
// them, not the token. So this path does not race. The launch carries no dev
// buy, the bots take a position into a pool with nothing behind it, and after
// they have given it back — every observed hold is under 68 seconds — this
// buys once and fans the proceeds out.
//
// WHAT THE CALLER MUST GET RIGHT, and it is not the part that looks risky:
//
//   * WAIT FOR THE RESTRICTION WINDOW. Until restrictionsEndBlock the buy leg
//     lands on the distributor and is capped at maxWalletBps — about 0.0714
//     ETH, or 5% of supply. Over that it reverts inside the pool as "TF",
//     which is v3's TransferHelper masking the token's real reason, so the
//     error will not tell you what happened. quoteTrigger below refuses early.
//   * minOut IS THE POINT. It is not slippage tolerance, it is the guard that
//     makes the buy revert rather than fill at a price somebody else moved.
//
// The distribution leg is unconstrained, which is the whole reason for a
// contract: the token's hook gates every cap on `_isPairPool(from)`, so
// pool->distributor is checked and distributor->wallet is not.

const { Contract, Interface, parseEther, formatEther } = require('ethers');
const { provider } = require('./provider');
const { getConfigs } = require('./factory');

const DISTRIBUTOR_ABI = [
  'function launchAndDistribute(address factory, (string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address feeWallet) params, uint256 launchConfigId, uint256 dexId, bytes32 salt, address[] wallets, uint16[] shares) payable returns (address token, uint256 supply)',
  'function buyAndDistribute(address router, address weth, address token, uint24 poolFee, uint256 minOut, address[] wallets, uint16[] shares) payable returns (uint256 amountOut)',
  'function sweep(address token) returns (uint256)',
  'function launcherOf(address token) view returns (address)',
  'function TOTAL_BPS() view returns (uint256)',
  'event Launched(address indexed token, address indexed launcher, uint256 devBuy, uint256 recipients)',
  'event Distributed(address indexed token, uint256 amountIn, uint256 amountOut, uint256 recipients)',
  // The contract's own errors, so a revert from it decodes to a name rather
  // than a selector. Easy to forget: an ABI of functions and events alone will
  // parse every call correctly and every failure not at all.
  'error NoRecipients()',
  'error LengthMismatch(uint256 recipients, uint256 shares)',
  'error SharesMustSumToBps(uint256 got)',
  'error TransferFailed(address to, uint256 amount)',
  'error FeeWalletMustBeZero()',
  'error NothingToSpend()',
  'error NotBeneficiary(address token, address caller)',
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
];

const iface = new Interface(DISTRIBUTOR_ABI);

// Every error PonsLaunchFactory declares. A revert from inside launchToken
// surfaces through our call, and without these it reads only as "unknown
// custom error" — which names nothing and rules out nothing.
const FACTORY_ERRORS = [
  'error DexDisabled()',
  'error FeeTransferFailed()',
  'error InvalidBasisPoints()',
  'error InvalidDexConfig()',
  'error InvalidDexId()',
  'error InvalidLaunchConfigId()',
  'error InvalidMaxTxBasisPoints()',
  'error InvalidTick()',
  'error InvalidTokenParams()',
  'error LaunchConfigDisabled()',
  'error LaunchFeeNotPaid()',
  'error NotWhitelisted()',
  'error PoolAlreadyExists()',
  'error ReentrancyGuardReentrantCall()',
  'error RouterNotSet()',
  'error SafeERC20FailedOperation(address)',
  'error SupplyTooLow()',
  'error TokenDeploymentFailed()',
  'error TokenNotFound()',
  'error ZeroAddress()',
];
const factoryIface = new Interface(FACTORY_ERRORS);

// What each one actually means for someone filling in the launch form.
const REVERT_HINTS = {
  NothingToSpend: 'the distributor holds no ETH — stage the buy first (step 4)',
  FeeWalletMustBeZero: 'feeWallet must be zero or the factory sends the supply elsewhere',
  NoRecipients: 'no bundle wallets were passed',
  SharesMustSumToBps: 'the shares do not add up to 10000',
  TransferFailed: 'a token transfer to a bundle wallet failed',
  InvalidTokenParams:
    'the factory rejected the name, symbol, logo or description — check none are empty and the symbol is short',
  LaunchFeeNotPaid: 'the value sent was below the launch fee',
  LaunchConfigDisabled: 'launch config 0 is disabled on this factory',
  DexDisabled: 'dex config 0 is disabled on this factory',
  NotWhitelisted: 'this factory is gated and the distributor is not on its list',
  PoolAlreadyExists: 'that salt has been used — retry, a fresh one is drawn each time',
  TokenDeploymentFailed: 'CREATE2 failed — almost always a salt already used',
};

/**
 * Turn per-wallet ETH weights into basis points that sum to exactly 10000.
 *
 * The contract takes shares rather than amounts because the tokens received
 * are not known until the swap returns. Rounding is absorbed by the LAST
 * entry, matching the contract, which hands the final wallet the true
 * remainder rather than a computed share.
 *
 * @param {number[]} weights any positive numbers; only their ratio matters
 * @returns {number[]} basis points, summing to 10000
 */
function sharesFromWeights(weights) {
  const total = weights.reduce((a, b) => a + Number(b || 0), 0);
  if (!(total > 0)) throw new Error('weights must sum to something positive');

  const bps = weights.map((w) => Math.floor((Number(w || 0) / total) * 10_000));
  const drift = 10_000 - bps.reduce((a, b) => a + b, 0);
  bps[bps.length - 1] += drift;
  if (bps.some((b) => b < 0)) throw new Error('a wallet resolved to a negative share');
  return bps;
}

/** Equal shares across n wallets, remainder on the last. */
function equalShares(n) {
  return sharesFromWeights(new Array(n).fill(1));
}

/**
 * Read the dex parameters this launch actually used, rather than assuming.
 * @returns {Promise<{router: string, weth: string, poolFee: number}>}
 */
async function dexParams() {
  const { launchConfigs, dexConfigs } = await getConfigs();
  const launch = launchConfigs.find((c) => c.enabled) || launchConfigs[0];
  const dex = dexConfigs.find((d) => d.enabled) || dexConfigs[0];
  return {
    router: dex.swapRouter,
    weth: launch.pairToken,
    poolFee: Number(dex.poolFee),
  };
}

/**
 * What a trigger of `amountEth` would receive right now, and whether it is
 * safe to send yet.
 *
 * The quote is a real eth_call against the live pool through the distributor,
 * not a curve model — by the time this runs the pool exists and can be asked.
 * That matters because the whole strategy turns on buying AFTER other people
 * have moved the price, so a modelled opening price would be answering a
 * different question.
 *
 * @returns {Promise<{amountOut: bigint, ok: boolean, reason: string|null}>}
 */
async function quoteTrigger({ distributor, token, amountEth, wallets, shares, from }) {
  const { router, weth, poolFee } = await dexParams();
  const value = parseEther(String(amountEth));
  const c = new Contract(distributor, DISTRIBUTOR_ABI, provider);

  try {
    // minOut 0 for the quote only. The real send never uses 0 — see buildTriggerTx.
    const amountOut = await c.buyAndDistribute.staticCall(
      router,
      weth,
      token,
      poolFee,
      0n,
      wallets,
      shares,
      { value, from }
    );
    return { amountOut, ok: true, reason: null };
  } catch (err) {
    const msg = err.shortMessage || err.message || '';
    // "TF" is v3's TransferHelper failing on the pool's transfer out, which is
    // how the token's maxWallet revert reaches us during the restriction
    // window. Worth naming, because the raw error says nothing.
    const early = /\bTF\b/.test(msg);
    return {
      amountOut: 0n,
      ok: false,
      reason: early
        ? 'the pool refused the transfer — almost certainly still inside the restriction window, ' +
          'where this buy is capped at ~5% of supply (~0.0714 ETH). Wait for restrictionsEndBlock.'
        : msg.slice(0, 200),
    };
  }
}

/**
 * Build the trigger transaction.
 *
 * @param {bigint} minOut floor on tokens received. REQUIRED and never 0 —
 *   a zero floor buys at any price, which is how a buyer becomes an exit.
 */
function buildTriggerTx({ distributor, router, weth, token, poolFee, minOut, wallets, shares, amountEth }) {
  if (!(minOut > 0n)) throw new Error('minOut must be greater than zero');
  return {
    to: distributor,
    data: iface.encodeFunctionData('buyAndDistribute', [
      router,
      weth,
      token,
      poolFee,
      minOut,
      wallets,
      shares,
    ]),
    value: parseEther(String(amountEth)),
  };
}

/**
 * Build the atomic launch: launch, take the whole initial buy, fan it out.
 *
 * The value sent is the launch fee PLUS the dev buy — the factory takes its
 * fee and treats the remainder as the initial buy, so there is no separate
 * amount to pass. The contract spends its entire balance, which is msg.value
 * plus anything pre-staged, so capital can arrive from several wallets without
 * any one of them ever holding the full sum.
 *
 * feeWallet is forced to zero here and the contract refuses a non-zero one.
 * With it set the factory makes THAT address the initial-buy recipient, the
 * supply never reaches the contract, and the fan-out would distribute nothing
 * — after the launch fee has already been spent.
 */
function buildLaunchTx({
  distributor,
  factory,
  params,
  launchConfigId = 0,
  dexId = 0,
  salt,
  wallets,
  shares,
  valueWei,
}) {
  const tokenParams = {
    name: params.name,
    symbol: params.symbol,
    logo: params.logo || '',
    description: params.description || '',
    socials: {
      twitter: params.socials?.twitter || '',
      telegram: params.socials?.telegram || '',
      discord: params.socials?.discord || '',
      website: params.socials?.website || '',
      farcaster: params.socials?.farcaster || '',
    },
    feeWallet: '0x0000000000000000000000000000000000000000',
  };

  return {
    to: distributor,
    data: iface.encodeFunctionData('launchAndDistribute', [
      factory,
      tokenParams,
      launchConfigId,
      dexId,
      salt,
      wallets,
      shares,
    ]),
    value: valueWei,
  };
}

/**
 * Turn a revert into something that names itself.
 *
 * ethers reports "execution reverted (unknown custom error)" whenever the
 * four-byte selector is not in the ABI it was given, and provider.call() is
 * given no ABI at all. Every error this contract can throw is known here, so
 * decode against it first; anything else is reported WITH its selector, which
 * is enough to look up rather than guess at.
 */
function explainRevert(err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  const hex = typeof data === 'string' ? data : data?.data;
  if (!hex || hex === '0x') {
    return err.shortMessage || err.message || 'reverted with no reason';
  }

  for (const [where, i] of [
    ['distributor', iface],
    ['factory', factoryIface],
  ]) {
    try {
      const parsed = i.parseError(hex);
      if (parsed) {
        const args = parsed.args.map((a) => String(a)).join(', ');
        const hint = REVERT_HINTS[parsed.name];
        return `${parsed.name}(${args}) from the ${where}${hint ? ` — ${hint}` : ''}`;
      }
    } catch (_err) {
      /* try the next ABI */
    }
  }

  // Not ours. The selector is the useful part — it identifies the error even
  // when the throwing contract's ABI is not to hand.
  return `reverted with custom error ${hex.slice(0, 10)} (from the factory or the pool, not the distributor)`;
}

/** The token address out of a mined atomic launch. */
function launchedTokenFrom(receipt) {
  for (const log of receipt?.logs || []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'Launched') return parsed.args.token;
    } catch (_err) {
      /* not ours */
    }
  }
  return null;
}

/** Pull the amountOut back out of a mined trigger. */
function amountOutFrom(receipt) {
  for (const log of receipt?.logs || []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'Distributed') return parsed.args.amountOut;
    } catch (_err) {
      /* not ours */
    }
  }
  return null;
}

module.exports = {
  DISTRIBUTOR_ABI,
  POOL_ABI,
  sharesFromWeights,
  equalShares,
  dexParams,
  quoteTrigger,
  buildTriggerTx,
  buildLaunchTx,
  launchedTokenFrom,
  explainRevert,
  amountOutFrom,
};
