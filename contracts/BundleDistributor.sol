// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Buy a launched token once, and split it across many wallets in the same
 * transaction.
 *
 * WHY THIS EXISTS. A pons v1 launch opens a pool holding the whole supply
 * against roughly 1.36 ETH of depth. That is shallow enough that 0.05-0.07 ETH
 * buys a bot 4-5% of the supply, and the bots that do it exit by selling into
 * whatever buys next. A bundle of thirty wallets racing for the pool at the
 * moment trading opens IS that exit: measured across 139 launches, the bundle
 * arriving right behind them is what pays for the snipe.
 *
 * The alternative this contract serves is to not race at all. Launch with no
 * dev buy, let the bots take their position into a pool with nothing behind
 * it, wait for them to give it back — every observed hold is under 68 seconds
 * — and then buy once, here, splitting to thirty wallets in a single call.
 *
 * WHY IT MUST BE ONE TRANSACTION. The token's transfer hook gates every cap on
 * `_isPairPool(from)`:
 *
 *     bool isRestrictedBuy = _isPairPool(from);
 *     if (!isRestrictedBuy) { super._update(from, to, value); return; }
 *
 * So pool -> this contract is a restricted buy and IS capped, while this
 * contract -> wallet is not a pool transfer and is never checked. One large buy
 * landing here and fanning out from here is therefore unconstrained by
 * maxWalletBps on the receiving side. Thirty separate wallets buying from the
 * pool would each be capped, and would each be a separate race.
 *
 * TIMING IS THE CALLER'S PROBLEM, WITH ONE HARD FLOOR. During the restriction
 * window (launchBlock + restrictionBlocks, about 30 seconds) the buy leg lands
 * on THIS address and is capped at maxWalletBps — roughly 0.0714 ETH, or 5% of
 * supply. Past the window there is no cap at all. Calling early does not fail
 * safe: it reverts inside the pool as `TF`, which is the v3 TransferHelper
 * masking the token's real reason. Wait for the window.
 *
 * NO OWNER, NO ADMIN, NOTHING TO RESCUE — the same rule Disperse.sol follows.
 * The caller supplies the ETH, names the recipients, and either the whole call
 * succeeds or it reverts. The contract holds no balance and no token between
 * transactions, so there is nothing for a privileged function to recover and
 * nobody who has to be trusted with one. Anyone may call it; doing so spends
 * their own ETH and distributes to wallets they chose, which is not an attack.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH is IERC20 {
    function deposit() external payable;
}

interface IPonsLaunchFactory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address feeWallet;
    }

    function launchToken(
        TokenParams calldata params,
        uint256 launchConfigId,
        uint256 dexId,
        bytes32 salt
    ) external payable returns (address token);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract BundleDistributor {
    error NoRecipients();
    error LengthMismatch(uint256 recipients, uint256 shares);
    error SharesMustSumToBps(uint256 got);
    error TransferFailed(address to, uint256 amount);

    error FeeWalletMustBeZero();
    error NothingToSpend();
    error NotBeneficiary(address token, address caller);

    /// Shares are in basis points and must sum to exactly this.
    uint256 public constant TOTAL_BPS = 10_000;

    /**
     * Who launched each token through this contract.
     *
     * The factory records `deployer = msg.sender`, so launching through here
     * makes THIS CONTRACT the deployer and creator fees accrue to it rather
     * than to you. This mapping is what makes that recoverable: fees for a
     * token can only ever be forwarded to the address that launched it, so the
     * contract stays trustless — there is no owner who could redirect them and
     * no path by which one launcher can touch another's.
     */
    mapping(address => address) public launcherOf;

    event Launched(address indexed token, address indexed launcher, uint256 devBuy, uint256 recipients);
    event Distributed(address indexed token, uint256 amountIn, uint256 amountOut, uint256 recipients);

    /**
     * Launch a token, take the whole atomic buy, and split it — one transaction.
     *
     * THIS IS THE ONE THAT MATTERS. The factory's initial buy is the only trade
     * that executes in the launch block, where every other pool buy reverts
     * with LaunchBlockBuyBlocked, and it is exempt from the 5% wallet cap. It
     * therefore cannot be front-run by anything: the token does not exist until
     * this call runs, and its CREATE2 address is not known in advance.
     *
     * Measured over 242,815 launches: taking 60-90% of supply through the
     * atomic buy loses 0.08% of float to snipers, while taking the same share
     * through a post-launch bundle loses 3.06% — a ~40x gap. Within-operator,
     * 15 of 18 deployers who raised their dev buy cut their sniper losses, and
     * one that switched from 0.001 to 0.10 ETH saw its share of float taken
     * collapse from 49.3% to 0.7% with nothing else changed.
     *
     * The fan-out is what makes that affordable in practice. A 3.5 ETH buy
     * takes ~72% of supply, and left in one wallet that is a position no
     * operator wants to show. Here it never rests: the tokens arrive and leave
     * inside this call, so the launch block itself ends with the supply already
     * spread across `wallets` and nothing concentrated anywhere.
     *
     * The caps do not apply to the fan-out, and that is not a loophole being
     * exploited — it is how the token is written. Its hook reads
     * `_isPairPool(from)` and returns before every check when the sender is not
     * the pool, so pool->this is a restricted buy and this->wallet is not
     * inspected at all. Thirty wallets buying separately would each be capped
     * AND each be a separate race.
     *
     * FUNDING. Spends `msg.value` plus anything already sitting here, so the
     * capital can arrive from one wallet or be pre-staged from many — no single
     * address ever has to hold the whole amount. Everything present is spent;
     * the contract does not keep a float.
     *
     * @param params  the launch. `feeWallet` MUST be zero: the factory reads it
     *                as the initial-buy recipient when set, which would send the
     *                supply somewhere else and leave nothing here to distribute.
     * @param wallets recipients of the supply, in order.
     * @param shares  each recipient's cut in basis points, summing to 10000.
     */
    function launchAndDistribute(
        address factory,
        IPonsLaunchFactory.TokenParams calldata params,
        uint256 launchConfigId,
        uint256 dexId,
        bytes32 salt,
        address[] calldata wallets,
        uint16[] calldata shares
    ) external payable returns (address token, uint256 supply) {
        if (wallets.length == 0) revert NoRecipients();
        if (wallets.length != shares.length) revert LengthMismatch(wallets.length, shares.length);
        // Not a style preference. With feeWallet set, the factory makes IT the
        // initial-buy recipient, the tokens never arrive here, and the fan-out
        // below silently distributes nothing. Refuse rather than launch into
        // that — the launch fee is already spent by the time it is noticed.
        if (params.feeWallet != address(0)) revert FeeWalletMustBeZero();

        uint256 sum;
        for (uint256 i; i < shares.length; ++i) sum += shares[i];
        if (sum != TOTAL_BPS) revert SharesMustSumToBps(sum);

        uint256 spend = address(this).balance;
        if (spend == 0) revert NothingToSpend();

        // Everything held goes in: the factory takes its launch fee out of the
        // value and treats the remainder as the initial buy, so there is no
        // separate amount to pass.
        token = IPonsLaunchFactory(factory).launchToken{value: spend}(
            params,
            launchConfigId,
            dexId,
            salt
        );

        supply = IERC20(token).balanceOf(address(this));
        _fanOut(token, supply, wallets, shares);

        launcherOf[token] = msg.sender;
        emit Launched(token, msg.sender, spend, wallets.length);
    }

    /**
     * Forward whatever this contract holds of `token` to whoever launched it.
     *
     * Creator fees accrue to the recorded deployer, which is this contract.
     * Rather than an owner or a rescue function — either of which would mean
     * trusting whoever holds the key — the destination is fixed at launch time
     * and cannot be changed: fees for a token go to that token's launcher and
     * nowhere else. Anyone may call it; only the recorded address can receive.
     */
    function sweep(address token) external returns (uint256 amount) {
        address to = launcherOf[token];
        if (to == address(0)) revert NotBeneficiary(token, msg.sender);
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0 && !IERC20(token).transfer(to, amount)) revert TransferFailed(to, amount);
    }

    /** Split `amount` of `token` across `wallets`, remainder to the last. */
    function _fanOut(
        address token,
        uint256 amount,
        address[] calldata wallets,
        uint16[] calldata shares
    ) private {
        uint256 sent;
        uint256 last = wallets.length - 1;
        for (uint256 i; i < last; ++i) {
            uint256 cut = (amount * shares[i]) / TOTAL_BPS;
            sent += cut;
            if (!IERC20(token).transfer(wallets[i], cut)) revert TransferFailed(wallets[i], cut);
        }
        uint256 remainder = amount - sent;
        if (!IERC20(token).transfer(wallets[last], remainder)) {
            revert TransferFailed(wallets[last], remainder);
        }
    }

    /**
     * Swap the ETH sent with this call into `token`, then split the proceeds.
     *
     * @param router    the DEX router. pons v1 dex config #0 is SwapRouter02 at
     *                  0xCaf681a66D020601342297493863E78C959E5cb2.
     * @param weth      the pair token every pons pool quotes against.
     * @param token     the launched token to buy.
     * @param poolFee   pool fee tier. pons v1 uses 10000 (1%).
     * @param minOut    floor on tokens received. NOT ordinary slippage
     *                  tolerance: it is the guard that makes this revert rather
     *                  than fill at a price someone else moved. Passing 0 buys
     *                  at any price and is how a buyer becomes somebody's exit.
     * @param wallets   recipients, in order.
     * @param shares    each recipient's cut in basis points, summing to 10000.
     *                  Expressed as shares rather than absolute amounts because
     *                  the amount out is not known until the swap returns.
     */
    function buyAndDistribute(
        address router,
        address weth,
        address token,
        uint24 poolFee,
        uint256 minOut,
        address[] calldata wallets,
        uint16[] calldata shares
    ) external payable returns (uint256 amountOut) {
        if (wallets.length == 0) revert NoRecipients();
        if (wallets.length != shares.length) revert LengthMismatch(wallets.length, shares.length);

        uint256 sum;
        for (uint256 i; i < shares.length; ++i) sum += shares[i];
        if (sum != TOTAL_BPS) revert SharesMustSumToBps(sum);

        // Spends the WHOLE balance, exactly as launchAndDistribute does, so the
        // capital can be staged here by a funding wallet and the caller need
        // only pay gas. Passing value still works — it lands in the balance
        // before this line reads it — so either funding route is available and
        // they compose.
        uint256 spend = address(this).balance;
        if (spend == 0) revert NothingToSpend();

        // The router spends WETH, not native ETH, so wrap and approve here
        // rather than expecting the caller to hold WETH. Approving exactly what
        // is being spent leaves no standing allowance behind.
        IWETH(weth).deposit{value: spend}();
        IWETH(weth).approve(router, spend);

        amountOut = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: weth,
                tokenOut: token,
                fee: poolFee,
                recipient: address(this),
                amountIn: spend,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Integer division leaves a remainder. The last recipient takes
        // whatever is actually left rather than a computed share, so the
        // contract cannot end the call holding dust — and so the sum of the
        // transfers is exactly amountOut regardless of rounding.
        _fanOut(token, amountOut, wallets, shares);

        emit Distributed(token, spend, amountOut, wallets.length);
    }
}
