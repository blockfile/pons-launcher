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
    error NoValue();
    error SharesMustSumToBps(uint256 got);
    error TransferFailed(address to, uint256 amount);

    /// Shares are in basis points and must sum to exactly this.
    uint256 public constant TOTAL_BPS = 10_000;

    event Distributed(address indexed token, uint256 amountIn, uint256 amountOut, uint256 recipients);

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
        if (msg.value == 0) revert NoValue();

        uint256 sum;
        for (uint256 i; i < shares.length; ++i) sum += shares[i];
        if (sum != TOTAL_BPS) revert SharesMustSumToBps(sum);

        // The router spends WETH, not native ETH, so wrap and approve here
        // rather than expecting the caller to hold WETH. Approving exactly
        // msg.value leaves no standing allowance behind.
        IWETH(weth).deposit{value: msg.value}();
        IWETH(weth).approve(router, msg.value);

        amountOut = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: weth,
                tokenOut: token,
                fee: poolFee,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Integer division leaves a remainder. The last recipient takes
        // whatever is actually left rather than a computed share, so the
        // contract cannot end the call holding dust — and so the sum of the
        // transfers is exactly amountOut regardless of rounding.
        uint256 sent;
        uint256 last = wallets.length - 1;
        for (uint256 i; i < last; ++i) {
            uint256 cut = (amountOut * shares[i]) / TOTAL_BPS;
            sent += cut;
            if (!IERC20(token).transfer(wallets[i], cut)) revert TransferFailed(wallets[i], cut);
        }
        uint256 remainder = amountOut - sent;
        if (!IERC20(token).transfer(wallets[last], remainder)) {
            revert TransferFailed(wallets[last], remainder);
        }

        emit Distributed(token, msg.value, amountOut, wallets.length);
    }
}
