// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Pre-signable bundle buys for pons v2.
 *
 * THE PROBLEM
 *
 * In v1 every bundle buy could be signed before the launch existed, because
 * predictTokenAddress named the token in advance. v2 has no such function: the
 * token and its bonding curve are deployed with plain CREATE, so their
 * addresses depend on the launch deployer's nonce — which moves whenever anyone
 * else launches.
 *
 * Signing buys against a guessed curve address has two failure modes, and the
 * second is the dangerous one:
 *
 *   1. The nonce moved, so the address belongs to somebody else's launch. You
 *      spend real money buying a stranger's token.
 *
 *   2. Your buy is ordered BEFORE the launch in the same block. The address has
 *      no code yet, and in the EVM a call to a codeless address SUCCEEDS: the
 *      calldata is ignored and the value is transferred. Your ETH lands at an
 *      address that has no idea it owes you anything, and the curve later
 *      deploys on top of it having credited you nothing. The transaction
 *      reports success. The money is simply gone.
 *
 * In v1 neither applied, because buys went to the router — an existing contract
 * that reverts when the pool is missing. Losing gas is survivable; losing the
 * buy is not.
 *
 * THE FIX
 *
 * Bundle wallets pre-sign calls to THIS contract instead. Its address is fixed
 * and its code exists, so an early arrival reverts rather than vanishing, and
 * there is no address to guess. The launch itself goes through `arm`, which
 * records the curve the factory just created under an epoch number you can read
 * in advance — so the pre-signed calldata is deterministic and can never point
 * at another launch.
 *
 *   1. read nextEpoch()                     → say 7
 *   2. pre-sign buy(7, minOut) from each bundle wallet
 *   3. broadcast arm(...)                   → launches, records epoch 7
 *   4. broadcast the pre-signed buys immediately, without waiting for a receipt
 *
 * If a buy lands before `arm`, epoch 7 is unset and it reverts, costing gas
 * only. If it lands after, it buys the correct curve. Same-block bundles become
 * possible again, with the failure mode returned to "wastes gas" instead of
 * "loses the money".
 *
 * DEPLOYMENT NOTES
 *
 * - This contract becomes the launch's `msg.sender`, so the FACTORY WHITELIST
 *   APPLIES TO THIS CONTRACT, not to your dev wallet. It must be whitelisted
 *   (or launchEnabled must be true) or `arm` reverts NotWhitelisted().
 * - The launch's on-chain deployer will be this contract. Set
 *   params.creatorFeeRecipient to the wallet that should receive creator fees;
 *   it is an explicit field and is not inferred from msg.sender.
 * - Native-quote launches only. ERC-20 pair tokens need approvals and are
 *   deliberately not handled here rather than handled badly.
 */

interface IPonsV2Factory {
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
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
    }

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);
}

interface IPonsV2Curve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
}

contract PonsV2BundleHelper {
    IPonsV2Factory public immutable factory;
    address public owner;

    /// Epoch => the curve that epoch's launch created. Zero until armed.
    mapping(uint256 => address) public curveOf;
    /// Epoch => the token, for convenience when reading results.
    mapping(uint256 => address) public tokenOf;
    /// The epoch the NEXT arm() will use. Read this before pre-signing.
    uint256 public nextEpoch;

    event Armed(uint256 indexed epoch, address indexed token, address indexed curve);
    event Bought(uint256 indexed epoch, address indexed buyer, uint256 quoteIn, uint256 tokensOut);
    event OwnerChanged(address indexed previous, address indexed next);

    error NotOwner();
    error NotArmed(uint256 epoch);
    error NothingSent();
    error RefundFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address factory_) {
        factory = IPonsV2Factory(factory_);
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    function transferOwnership(address next) external onlyOwner {
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /**
     * Launch, and record the resulting curve under the next epoch.
     *
     * Send exactly the factory's launch fee as value. There is no dev buy in
     * v2, so nothing else should be attached.
     *
     * @return epoch the number the pre-signed buys must reference
     */
    function arm(
        IPonsV2Factory.TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken
    ) external payable onlyOwner returns (uint256 epoch, address token, address curve) {
        epoch = nextEpoch;
        // Incremented before the external call so a reverting launch cannot be
        // retried into an epoch that buys were already signed against.
        nextEpoch = epoch + 1;

        (token, curve) = factory.launchToken{value: msg.value}(params, launchConfigId, pairToken);

        curveOf[epoch] = curve;
        tokenOf[epoch] = token;
        emit Armed(epoch, token, curve);
    }

    /**
     * Buy from the curve armed at `epoch`, with the tokens delivered straight to
     * the caller. The whole of msg.value is offered to the curve.
     *
     * Reverts when the epoch is not yet armed — which is exactly what makes an
     * early-arriving pre-signed buy safe: it costs gas and nothing more.
     *
     * Anyone may call this. They spend their own ETH and receive their own
     * tokens, so there is nothing to gate and gating would only add a way for a
     * bundle wallet to be locked out mid-launch.
     */
    function buy(uint256 epoch, uint256 minTokensOut) external payable returns (uint256 tokensOut) {
        if (msg.value == 0) revert NothingSent();

        address curve = curveOf[epoch];
        if (curve == address(0)) revert NotArmed(epoch);

        tokensOut = IPonsV2Curve(curve).buy{value: msg.value}(msg.value, minTokensOut, msg.sender);

        // The curve refunds the unspent remainder when a buy is larger than what
        // is left on it — the case that finishes a launch. That refund arrives
        // here, so pass it on rather than letting it settle in this contract.
        uint256 leftover = address(this).balance;
        if (leftover > 0) {
            (bool ok,) = payable(msg.sender).call{value: leftover}("");
            if (!ok) revert RefundFailed();
        }

        emit Bought(epoch, msg.sender, msg.value, tokensOut);
    }

    /// Accepts curve refunds during buy(). Nothing else should send here.
    receive() external payable {}

    /**
     * Sweep anything stranded. Only reachable by the owner, and only useful if a
     * refund arrived outside a buy() — the normal path forwards it immediately.
     */
    function rescue(address to) external onlyOwner {
        (bool ok,) = payable(to).call{value: address(this).balance}("");
        if (!ok) revert RefundFailed();
    }
}
