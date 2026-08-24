// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Swap native ETH → SPCX in one call, sending the SPCX straight to a recipient.
 *
 * STATUS: written and verified against live V4 state (pool key matches the
 * on-chain pool id, selectors match, encoding simulates via eth_call state
 * override), but NOT DEPLOYED and NOT wired into the app. The SPCX pool's
 * liquidity is intermittent (pons-managed; often zero), so an on-demand swap
 * here is unreliable and silently fills ~0 when the pool is empty. The live path
 * instead pre-loads SPCX the operator swapped in MetaMask and spreads it with
 * backend/src/bundle/distributePair.js. Revive this only if standing liquidity
 * appears — and re-verify the pool key first (see MIGRATION CAVEAT below).
 *
 * Why this exists. The pons zap only sells you a *curve token* (ETH → pair →
 * curve.buy); its aggregator refuses SPCX as a standalone buy target
 * ("unsupported-token"). But a bundle that wants to buy an SPCX-paired launch in
 * the FIRST block — inside the ~3s snipe-tax window — has to pre-sign its buys,
 * and a pre-signed curve buy needs the wallet to already hold SPCX. The only way
 * onto SPCX from ETH on this chain is the Uniswap-V4 pool the zap uses
 * internally. This contract is the smallest thing that does exactly that hop.
 *
 * Shape, deliberately like contracts/Disperse.sol: no owner, no admin, no upgrade
 * path, nothing to rescue. It custodies nothing between transactions — every wei
 * of msg.value is swapped and the resulting SPCX taken straight to the recipient
 * inside the same call, or the whole call reverts. A swap router with privileged
 * functions is a swap router someone has to trust.
 *
 * The pool it trades (poolId 0x4adf369a5426291258cfd0fbc23cf00fab3038fd2b86af86e0c906f1bbd35530,
 * recomputed from these fields to confirm it is the pool the live zap swaps):
 *   currency0   NATIVE ETH  0x0000000000000000000000000000000000000000
 *   currency1   SPCX        0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa  (18 dec)
 *   fee         0x800000    (DYNAMIC_FEE_FLAG — the hook sets the fee per swap)
 *   tickSpacing 2
 *   hooks       0x5131C74AD4D3E2E5e92a37B682Ca9f23a722c880
 * currency0 (native, address(0)) < currency1 (SPCX), so ETH→SPCX is zeroForOne.
 *
 * MIGRATION CAVEAT: pons has already moved this market once (an older WETH/SPCX
 * pool with a different hook is now drained). If they migrate again, this pool
 * key goes stale and swaps here will return ~0 — redeploy with the new key. The
 * backend must simulate (swapExactEthForSpcx eth_call with minSpcxOut=0) and
 * refuse to fund if it returns 0, rather than send ETH into a dead pool.
 *
 * Addresses are constants, not constructor args: the runtime bytecode is then
 * self-contained (the swap can be simulated via eth_call state-override before
 * deploying), and there is nothing to misconfigure at deploy time.
 */

// The V4 core. Currency and IHooks are `address` and BalanceDelta is `int256` at
// the ABI level, so declaring them as such produces byte-identical selectors and
// encodings to the canonical interface.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 delta);
}

contract EthToSpcxSwap {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address internal constant HOOKS = 0x5131C74AD4D3E2E5e92a37B682Ca9f23a722c880;

    uint24 internal constant DYNAMIC_FEE = 0x800000;
    int24 internal constant TICK_SPACING = 2;
    // MIN_SQRT_PRICE + 1: the loosest price limit for a zeroForOne swap, i.e. "no
    // limit". Slippage is enforced by minSpcxOut below, not by the price limit.
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;

    error NotPoolManager();
    error NoValue();
    error InsufficientOutput(uint256 got, uint256 minOut);

    event Swapped(address indexed payer, address indexed recipient, uint256 ethIn, uint256 spcxOut);

    /**
     * Swap the attached ETH for SPCX, sending the SPCX to `recipient`.
     *
     * @param minSpcxOut revert unless at least this many SPCX (18 dec) come out —
     *   the ONLY slippage floor; the pool swap itself takes no minimum. Pass a
     *   value from a fresh simulation (this same function eth_call'd with
     *   minSpcxOut=0), never a stale quote.
     * @param recipient  who receives the SPCX; address(0) means msg.sender.
     * @return out the SPCX received (net of the pool's LP + hook fee).
     */
    function swapExactEthForSpcx(uint256 minSpcxOut, address recipient) external payable returns (uint256 out) {
        if (msg.value == 0) revert NoValue();
        address to = recipient == address(0) ? msg.sender : recipient;
        // All the work happens inside the unlock callback — V4 requires the pool
        // to be unlocked before any swap/settle/take.
        bytes memory res = POOL_MANAGER.unlock(abi.encode(msg.value, minSpcxOut, to));
        out = abi.decode(res, (uint256));
        emit Swapped(msg.sender, to, msg.value, out);
    }

    /**
     * V4 flash-accounting callback. Only the PoolManager may call it, and it only
     * ever runs because swapExactEthForSpcx above called unlock — so the encoded
     * (amountIn, minOut, recipient) is ours, not attacker-supplied.
     */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut, address recipient) = abi.decode(data, (uint256, uint256, address));

        // Exact-input ETH → SPCX. The swap leaves us owing amountIn of currency0
        // (native ETH, delta0 = -amountIn) and owed amountOut of currency1 (SPCX,
        // delta1 = +amountOut). We resolve both below; the unlock succeeds only
        // when both deltas reach zero.
        PoolKey memory key = PoolKey({
            currency0: address(0),
            currency1: SPCX,
            fee: DYNAMIC_FEE,
            tickSpacing: TICK_SPACING,
            hooks: HOOKS
        });
        int256 delta = POOL_MANAGER.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: MIN_SQRT_PRICE_PLUS_ONE
            }),
            ""
        );

        // BalanceDelta packs amount0 in the high 128 bits and amount1 in the low
        // 128. currency1 is SPCX, and for a zeroForOne exact-input swap the
        // swapper RECEIVES currency1, so amount1 is positive. The hook takes its
        // fee out of this delta (AFTER_SWAP_RETURNS_DELTA), so amount1 is already
        // the net SPCX we can take.
        int128 amount1 = int128(delta);
        uint256 received = amount1 > 0 ? uint256(uint128(amount1)) : 0;
        if (received < minOut) revert InsufficientOutput(received, minOut);

        // Take the SPCX out to the recipient (clears delta1), then pay the native
        // ETH we owe (clears delta0). currency0 is native, so settle carries the
        // ETH as value — no wrapping, no sync/transfer.
        POOL_MANAGER.take(SPCX, recipient, received);
        POOL_MANAGER.settle{value: amountIn}();

        return abi.encode(received);
    }
}
