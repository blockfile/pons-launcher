'use strict';

// Distribute the pair token (SPCX and the like) from ONE launcher-controlled
// wallet to the bundle wallets, so each can pre-sign an untaxed pair-token buy
// that fires in the launch's first block.
//
// Why this exists. A pons v2 launch paired against SPCX can only be sniped in
// the first block — inside the ~3s snipe-tax window — by PRE-SIGNED buys, and a
// pre-signed pair buy (bundle/prepareV2.js, the `pair` funding path) needs the
// wallet to already hold SPCX. The zap cannot do it (its buy calldata is fetched
// at fire time, so it can't be pre-signed, and it can't fire until ~3s after the
// launch confirms — past the window). The aggregator refuses to sell SPCX
// standalone, and the on-chain SPCX pool's liquidity is intermittent, so the
// operator brings their own SPCX (e.g. swapped in MetaMask) into the source
// wallet; this module spreads it across the bundle wallets.
//
// It moves money, so it is deliberately conservative:
//   - it only ever transfers to wallets THIS keystore owns (an id it cannot
//     resolve, or an address that is not a launcher wallet, is refused before
//     anything is signed);
//   - it refuses up front if the source cannot cover the whole distribution, or
//     the gas for it, rather than half-funding the bundle;
//   - transfers go out one at a time, each awaited to its receipt before the
//     next, so a single failure never leaves a nonce gap that strands the rest;
//   - one transfer's failure is reported against that wallet alone and never
//     aborts the others.
//
// It is a PREFLIGHT step: not time-critical, so it favours certainty over speed.

const { getAddress, parseUnits, formatUnits, formatEther, Interface } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { rpcMessage } = require('../evm/errors');
const { getSymbol, readTokenBalance } = require('../evm/erc20');
const { waitForReceipt } = require('../evm/receipt');
const v2mod = require('../evm/v2/factory');
const keystore = require('../wallets/keystore');
const { DEFAULT_VARIANT, devWalletFor, bundleWalletsFor } = require('../wallets/variants');

// SPCX transfers are heavier than a plain ERC-20 move — every transfer makes
// several staticcalls into the RWA AccessControlsRegistry. Generous, and cheap
// to over-reserve since unused gas is refunded.
const TRANSFER_GAS = 200_000n;

// Encoded here rather than through a Contract runner so a transfer is a pure
// calldata build — no provider round-trip to populate it.
const TRANSFER_IFACE = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

/** Strip fields signTransaction rejects, and pin chainId. Mirrors prepareV2. */
function toSignable(tx, { nonce, gasLimit, fees, chainId }) {
  const { from, ...rest } = tx;
  return { ...rest, nonce, gasLimit, chainId, ...fees };
}

/**
 * @param {object} input
 * @param {string} [input.variant]        wallet variant (default v1)
 * @param {string} [input.sourceWalletId] wallet to send FROM; defaults to the
 *   variant's dev wallet (the launch wallet, the natural SPCX holder)
 * @param {string} input.pairToken        the pair token address (SPCX)
 * @param {Array<{walletId:string, amount:(string|number)}>} input.transfers
 *   per-wallet amounts in the pair token's own units (human decimal), matching
 *   the buy sizes the operator set
 * @param {boolean} [input.dryRun]        validate and price, broadcast nothing
 * @param {object} [deps] injectable for tests
 */
async function distributePair(input, deps = {}) {
  const rpc = deps.provider || provider;
  const ks = deps.keystore || keystore;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const feesFn = deps.getFees || getFees;
  const pairEconomicsFn = deps.pairEconomics || v2mod.pairEconomics;
  const symbolFn = deps.getSymbol || getSymbol;
  const balanceFn = deps.readTokenBalance || readTokenBalance;

  const variant = input.variant || DEFAULT_VARIANT;
  const dryRun = Boolean(input.dryRun);
  const transfersIn = Array.isArray(input.transfers) ? input.transfers : [];
  if (!input.pairToken) throw new Error('distributePair: pairToken is required');
  if (transfersIn.length === 0) throw new Error('distributePair: no transfers requested');

  const pair = getAddress(input.pairToken);
  // Decimals from the factory's authoritative economics — the SAME source the
  // launch buy sizes against (prepareV2). The factory reverts
  // PairTokenDecimalsMismatch if the token's own decimals() disagrees, so a
  // distribution sized on the ERC-20 decimals() could silently disagree with the
  // buy's scale; this makes them always agree.
  const { decimals } = await pairEconomicsFn(pair);
  const symbol = await symbolFn(pair);

  // Source: the dev wallet unless a launcher wallet is named. Recipients: ONLY
  // this variant's bundle wallets — SPCX sent to any other wallet (a dev, a
  // different variant, a seed) is not lost but is stranded and mis-sizes the
  // launch, so it is refused rather than silently accepted.
  const allWallets = new Map(ks.list().map((w) => [w.id, w]));
  const dev = devWalletFor(ks, variant);
  const sourceId = input.sourceWalletId || dev.id;
  const source = allWallets.get(sourceId);
  if (!source) throw new Error(`distributePair: unknown source wallet ${sourceId}`);
  const sourceAddr = getAddress(source.address);
  const bundleSet = new Map(bundleWalletsFor(ks, variant).map((w) => [w.id, w]));

  const seen = new Set();
  const items = transfersIn.map((t) => {
    if (seen.has(t.walletId)) throw new Error(`distributePair: wallet ${t.walletId} is listed twice`);
    seen.add(t.walletId);
    const w = bundleSet.get(t.walletId);
    if (!w) throw new Error(`distributePair: ${t.walletId} is not a ${variant} bundle wallet`);
    const address = getAddress(w.address);
    if (address.toLowerCase() === sourceAddr.toLowerCase()) {
      throw new Error(`distributePair: refusing to send to the source wallet itself (${t.walletId})`);
    }
    const amountWei = parseUnits(String(t.amount ?? 0), decimals);
    if (amountWei <= 0n) throw new Error(`distributePair: non-positive amount for ${t.walletId}`);
    return { walletId: w.id, address, amount: formatUnits(amountWei, decimals), amountWei };
  });

  const total = items.reduce((s, i) => s + i.amountWei, 0n);

  // Fund-safety gates: the source must cover the whole distribution AND its gas.
  const fees = await feesFn();
  const perTransferGas = gasCost(fees, TRANSFER_GAS);
  const gasNeeded = perTransferGas * BigInt(items.length);
  const buffer = (() => {
    try {
      return BigInt(parseUnits(String(config.gasBufferEth), 18));
    } catch {
      return 0n;
    }
  })();

  const [pairBalance, nativeBalance] = await Promise.all([
    balanceFn(pair, sourceAddr).then((b) => BigInt(b)),
    rpc.getBalance(sourceAddr).then((b) => BigInt(b)),
  ]);

  if (pairBalance < total) {
    throw new Error(
      `source ${sourceAddr} holds ${formatUnits(pairBalance, decimals)} ${symbol}, needs ` +
        `${formatUnits(total, decimals)} ${symbol} to distribute — top it up (swap more ETH→${symbol}) and retry`
    );
  }
  if (nativeBalance < gasNeeded + buffer) {
    throw new Error(
      `source ${sourceAddr} has ${formatEther(nativeBalance)} ETH, needs about ` +
        `${formatEther(gasNeeded + buffer)} ETH to pay for ${items.length} ${symbol} transfers — top up its ETH`
    );
  }

  const base = {
    variant,
    pairToken: pair,
    pairSymbol: symbol,
    decimals,
    source: { walletId: source.id, address: sourceAddr },
    totalAmount: formatUnits(total, decimals),
    count: items.length,
  };

  if (dryRun) {
    return {
      ...base,
      dryRun: true,
      transfers: items.map((i) => ({ walletId: i.walletId, address: i.address, amount: i.amount, status: 'planned' })),
      confirmed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  const chainId = BigInt(config.chainId);
  const signer = ks.signer(source.id, rpc);

  // One at a time, each awaited to its receipt before the next: the source is a
  // single wallet, so serialising keeps its nonces gap-free even if one reverts.
  const results = [];
  for (const it of items) {
    const entry = { walletId: it.walletId, address: it.address, amount: it.amount };
    try {
      const nonce = await rpc.getTransactionCount(sourceAddr, 'pending');
      const data = TRANSFER_IFACE.encodeFunctionData('transfer', [it.address, it.amountWei]);
      const raw = await signer.signTransaction(toSignable({ to: pair, data }, { nonce, gasLimit: TRANSFER_GAS, fees, chainId }));
      const resp = await rpc.broadcastTransaction(raw);
      entry.hash = resp.hash;
      entry.nonce = nonce;
      const receipt = await awaitReceipt(rpc, resp.hash);
      entry.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
      entry.blockNumber = receipt?.blockNumber ?? null;
    } catch (err) {
      entry.status = 'failed';
      entry.error = rpcMessage(err);
    }
    results.push(entry);
  }

  return {
    ...base,
    dryRun: false,
    transfers: results,
    confirmed: results.filter((r) => r.status === 'confirmed').length,
    failed: results.filter((r) => r.status === 'failed' || r.status === 'reverted').length,
    skipped: 0,
  };
}

module.exports = { distributePair, TRANSFER_GAS };
