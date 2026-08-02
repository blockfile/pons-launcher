// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Send native ETH to many addresses in one transaction.
 *
 * Two reasons this exists rather than looping from the client:
 *
 *   1. Twenty separate transfers is twenty concurrent broadcasts, which is
 *      exactly the pattern that trips RPC rate limiting — a sweep failed that
 *      way with every transfer rejected. One call cannot be half-rate-limited.
 *   2. Gas. One transaction pays the 21k base cost once instead of per
 *      transfer, which is roughly 20% cheaper at twenty recipients and 24% at
 *      a hundred.
 *
 * Below about five recipients it is CHEAPER to send individually — measured:
 * three recipients through a multisend cost 68,847 gas against 63,585 for three
 * plain transfers. The caller is expected to know that; funding.js does.
 *
 * No owner, no admin, no upgrade path, nothing to rescue. It holds no balance
 * between transactions: every wei sent is either forwarded or the whole call
 * reverts. That is deliberate — a disperser with privileged functions is a
 * disperser someone has to trust.
 */
contract Disperse {
    error LengthMismatch(uint256 recipients, uint256 amounts);
    error NoRecipients();
    error ValueMismatch(uint256 sent, uint256 required);
    error TransferFailed(address to, uint256 amount);

    event Dispersed(address indexed from, uint256 recipients, uint256 total);

    /**
     * @param to      recipients, in order
     * @param amounts wei for each, index-matched to `to`
     *
     * msg.value must equal the sum exactly. Requiring exactness rather than
     * refunding a remainder means a mistyped amount reverts instead of quietly
     * sending the wrong totals — the failure you want is the loud one.
     */
    function disperse(address[] calldata to, uint256[] calldata amounts) external payable {
        if (to.length != amounts.length) revert LengthMismatch(to.length, amounts.length);
        if (to.length == 0) revert NoRecipients();

        uint256 total;
        for (uint256 i; i < to.length; ++i) {
            total += amounts[i];
            // .call rather than .transfer: the 2300 gas stipend breaks any
            // recipient that is a contract with a receive hook, and bundle
            // wallets are not always plain EOAs.
            (bool ok,) = to[i].call{value: amounts[i]}("");
            if (!ok) revert TransferFailed(to[i], amounts[i]);
        }

        if (total != msg.value) revert ValueMismatch(msg.value, total);
        emit Dispersed(msg.sender, to.length, total);
    }

    /**
     * The common case: the same amount to everyone. Saves calldata, which is
     * most of the cost of a large batch.
     */
    function disperseEqual(address[] calldata to, uint256 amount) external payable {
        if (to.length == 0) revert NoRecipients();

        uint256 total = amount * to.length;
        if (total != msg.value) revert ValueMismatch(msg.value, total);

        for (uint256 i; i < to.length; ++i) {
            (bool ok,) = to[i].call{value: amount}("");
            if (!ok) revert TransferFailed(to[i], amount);
        }
        emit Dispersed(msg.sender, to.length, total);
    }
}
