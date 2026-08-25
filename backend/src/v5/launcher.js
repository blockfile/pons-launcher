'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — LAUNCHER RESCUE: get value OUT of the v5dev launcher, and un-stick it.
//
// The launcher is otherwise a value SINK: /fund and /v5/bundle only spend it INTO
// the bundle wallets, and /sweep only pulls value INTO it. So leftover launch ETH,
// swept ETH/USDG, and any un-fanned-out token supply accumulate in v5dev with no
// console path back out — recoverable only by exporting the key. And a launch or
// approve tx that neither mines nor drops "bricks" the launcher: prepareLaunch's
// settled-nonce guard refuses every new launch while that tx is in flight, and
// /v5/launch/resolve cannot clear a tx that is neither mined nor dropped.
//
// This module closes both gaps with two operator actions, both signing from the
// singleton v5dev wallet:
//   withdrawFromLauncher — send ETH or an ERC-20 (USDG / the launched token / any
//                          address) from v5dev to an EXTERNAL address the operator
//                          controls. The missing "value out" path.
//   cancelStuckLauncherTx — a 0-value self-transfer at the launcher's STUCK nonce
//                          with a bumped fee, replacing a launch/approve tx that is
//                          neither mining nor dropping so the launcher un-bricks.
// ─────────────────────────────────────────────────────────────────────────────

const { Interface, parseEther, formatEther, parseUnits, formatUnits, getAddress, isAddress, ZeroAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { keystoreFor } = require('../wallets/keystore');
const { getDecimals, getSymbol, readTokenBalance } = require('../evm/erc20');
const v5roles = require('./roles');

const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const ETH_SEND_GAS = 21_000n;
const ERC20_SEND_GAS = 100_000n;
const FEE_BUMP_PCT = 25;
// The cancel/replace must out-bid the stuck tx's own fee for the node to accept
// the replacement, and we don't know that fee — so bump aggressively by default.
const CANCEL_FEE_BUMP_PCT = 100;

function toSignable({ to, data = '0x', value = 0n }, { nonce, gasLimit, fees, chainId }) {
  return { to, data, value: BigInt(value), nonce, gasLimit, chainId, ...fees };
}

/** Map an asset selector to {native, address}: eth/native/0x0 → ETH; usdg → USDG; an address → that token. */
function resolveAsset(asset) {
  const a = String(asset ?? 'eth').toLowerCase();
  if (a === 'eth' || a === 'native' || a === ZeroAddress.toLowerCase()) return { native: true, address: ZeroAddress };
  if (a === 'usdg') return { native: false, address: getAddress(config.letscash.usdg) };
  if (isAddress(a)) return { native: false, address: getAddress(a) };
  throw new Error(`unknown asset "${asset}" — use "eth", "usdg", or a token address`);
}

function isAll(amount) {
  if (amount == null) return true;
  const a = String(amount).toLowerCase();
  return a === 'all' || a === 'max' || a === '';
}

/**
 * The launcher's holdings + whether it has a stuck (unconfirmed) tx, for the
 * console. Read-only.
 */
async function launcherStatus(input = {}, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const decimalsOf = deps.getDecimals || getDecimals;
  const readBal = deps.readTokenBalance || readTokenBalance;

  const dev = roles.dev(ks);
  if (!dev) throw new Error('no v5dev launcher wallet — generate one first');
  const usdgAddr = getAddress(config.letscash.usdg);
  const [eth, pendingNonce, latestNonce, usdgBal, usdgDec] = await Promise.all([
    prov.getBalance(dev.address),
    prov.getTransactionCount(dev.address, 'pending'),
    prov.getTransactionCount(dev.address, 'latest'),
    readBal(usdgAddr, dev.address),
    decimalsOf(usdgAddr),
  ]);
  // The launched token(s) balance is per-token; the caller can pass one to include.
  let tokenInfo = null;
  if (input.token && isAddress(String(input.token))) {
    const t = getAddress(input.token);
    const [tBal, tDec, tSym] = await Promise.all([
      readBal(t, dev.address),
      decimalsOf(t),
      (deps.getSymbol || getSymbol)(t),
    ]);
    tokenInfo = { token: t, symbol: tSym, balance: formatUnits(tBal, Number(tDec)) };
  }
  return {
    address: dev.address,
    eth: formatEther(eth),
    usdg: formatUnits(usdgBal, Number(usdgDec)),
    token: tokenInfo,
    inFlight: Number(pendingNonce) - Number(latestNonce), // >0 ⇒ a stuck/unconfirmed tx
    stuckNonce: pendingNonce > latestNonce ? Number(latestNonce) : null,
  };
}

/**
 * Withdraw ETH or an ERC-20 from the launcher to an EXTERNAL address.
 *
 * @param {{ to:string, asset?:string, amount?:string|'all' }} input
 *   asset: 'eth' (default) | 'usdg' | a token address. amount: units of the asset, or 'all'.
 * @returns {Promise<object>} { asset, to, amount, hash, status }
 */
async function withdrawFromLauncher(input = {}, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const getFeesFn = deps.getFees || getFees;
  const decimalsOf = deps.getDecimals || getDecimals;
  const symbolOf = deps.getSymbol || getSymbol;
  const readBal = deps.readTokenBalance || readTokenBalance;
  const dryRun = deps.dryRun ?? config.dryRun;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;

  const dev = roles.dev(ks);
  if (!dev) throw new Error('no v5dev launcher wallet — nothing to withdraw from');
  if (!input.to || !isAddress(String(input.to))) throw new Error('to must be an address you control');
  const to = getAddress(input.to);
  const { native, address } = resolveAsset(input.asset);
  const all = isAll(input.amount);

  // Optional gas override — the default 21000 (ETH) / 100000 (ERC-20) covers an
  // EOA recipient and a standard token, but a contract recipient (Safe/AA) or a
  // hooked token needs more; without a lever such a withdrawal would just revert.
  const gasOverride = (() => {
    if (input.gas == null) return null;
    const g = BigInt(input.gas);
    if (g < 21_000n) throw new Error('gas override must be at least 21000');
    if (g > 500_000n) throw new Error('gas override is capped at 500,000');
    return g;
  })();
  const ethGas = gasOverride ?? ETH_SEND_GAS;
  const ercGas = gasOverride ?? ERC20_SEND_GAS;

  const fees = await getFeesFn(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);

  // Refuse while the launcher has a tx in flight — signing at the pending nonce
  // would sit this withdrawal behind it, and if that tx were evicted this strands.
  // Cancel the stuck tx first (that path targets the stuck nonce on purpose).
  const [pendingNonce, latestNonce] = await Promise.all([
    prov.getTransactionCount(dev.address, 'pending'),
    prov.getTransactionCount(dev.address, 'latest'),
  ]);
  if (pendingNonce > latestNonce) {
    throw new Error(
      'the launcher has an unconfirmed tx in flight — wait for it to settle, or cancel it first ' +
        '(POST /v5/launcher/cancel), before withdrawing'
    );
  }

  if (native) {
    const balance = await prov.getBalance(dev.address);
    const gasReserve = gasCost(fees, ethGas);
    let value;
    if (all) {
      value = balance - gasReserve;
      if (value <= 0n) throw new Error(`the launcher holds ${formatEther(balance)} ETH — too little to cover the send gas`);
    } else {
      value = parseEther(String(input.amount));
      if (value <= 0n) throw new Error('amount must be positive');
      if (value + gasReserve > balance) {
        throw new Error(`the launcher holds ${formatEther(balance)} ETH but the withdrawal + gas needs ${formatEther(value + gasReserve)}`);
      }
    }
    if (dryRun) return { simulated: true, asset: 'ETH', to, amount: formatEther(value), status: 'simulated', hash: null };
    const raw = await ks.signer(dev.id, prov).signTransaction(toSignable({ to, value }, { nonce: pendingNonce, gasLimit: ethGas, fees, chainId }));
    const resp = await prov.broadcastTransaction(raw);
    const receipt = await awaitReceipt(prov, resp.hash);
    return { asset: 'ETH', to, amount: formatEther(value), hash: resp.hash, status: !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted' };
  }

  // ERC-20 (USDG or a token).
  const [decimals, symbol, balance] = await Promise.all([
    decimalsOf(address),
    symbolOf(address),
    readBal(address, dev.address),
  ]);
  const dec = Number(decimals);
  const amountWei = all ? balance : parseUnits(String(input.amount), dec);
  if (amountWei <= 0n) throw new Error(`the launcher holds 0 ${symbol}`);
  if (amountWei > balance) {
    throw new Error(`the launcher holds ${formatUnits(balance, dec)} ${symbol} but the withdrawal is ${formatUnits(amountWei, dec)}`);
  }
  const ethBalance = await prov.getBalance(dev.address);
  const gasNeeded = gasCost(fees, ercGas);
  if (ethBalance < gasNeeded) {
    throw new Error(`the launcher needs ~${formatEther(gasNeeded)} ETH to pay the ${symbol} transfer gas — fund it with a little ETH first`);
  }
  if (dryRun) return { simulated: true, asset: symbol, token: address, to, amount: formatUnits(amountWei, dec), status: 'simulated', hash: null };
  const data = erc20Iface.encodeFunctionData('transfer', [to, amountWei]);
  const raw = await ks.signer(dev.id, prov).signTransaction(toSignable({ to: address, data }, { nonce: pendingNonce, gasLimit: ercGas, fees, chainId }));
  const resp = await prov.broadcastTransaction(raw);
  const receipt = await awaitReceipt(prov, resp.hash);
  return { asset: symbol, token: address, to, amount: formatUnits(amountWei, dec), hash: resp.hash, status: !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted' };
}

/**
 * Replace a STUCK launcher tx with a 0-value self-transfer at the same (stuck)
 * nonce and a bumped fee, so a launch/approve that is neither mining nor dropping
 * is displaced. Best effort: the bump must exceed the stuck tx's own fee, so a
 * higher `feeBumpPct` may be needed (the node returns "replacement underpriced"
 * otherwise, surfaced to the caller).
 *
 * @param {{ feeBumpPct?: number }} input
 * @returns {Promise<object>} { nonce, hash, status } or { nothingStuck:true }
 */
async function cancelStuckLauncherTx(input = {}, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const getFeesFn = deps.getFees || getFees;
  const dryRun = deps.dryRun ?? config.dryRun;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;

  const dev = roles.dev(ks);
  if (!dev) throw new Error('no v5dev launcher wallet');
  const [pendingNonce, latestNonce] = await Promise.all([
    prov.getTransactionCount(dev.address, 'pending'),
    prov.getTransactionCount(dev.address, 'latest'),
  ]);
  if (pendingNonce <= latestNonce) {
    return { nothingStuck: true, message: 'the launcher has no unconfirmed tx — nothing to cancel', nonce: Number(latestNonce) };
  }
  // The stuck tx occupies `latestNonce` (the first unmined nonce). Replace it.
  const bump = input.feeBumpPct != null ? Number(input.feeBumpPct) : CANCEL_FEE_BUMP_PCT;
  const fees = await getFeesFn(bump);
  const chainId = BigInt(config.chainId);
  if (dryRun) return { simulated: true, nonce: Number(latestNonce), feeBumpPct: bump, status: 'simulated', hash: null };
  const raw = await ks.signer(dev.id, prov).signTransaction(
    toSignable({ to: dev.address, value: 0n }, { nonce: Number(latestNonce), gasLimit: ETH_SEND_GAS, fees, chainId })
  );
  const resp = await prov.broadcastTransaction(raw);
  const receipt = await awaitReceipt(prov, resp.hash);
  return {
    nonce: Number(latestNonce),
    feeBumpPct: bump,
    hash: resp.hash,
    status: !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted',
  };
}

module.exports = {
  launcherStatus,
  withdrawFromLauncher,
  cancelStuckLauncherTx,
  resolveAsset,
  toSignable,
  ETH_SEND_GAS,
  ERC20_SEND_GAS,
  CANCEL_FEE_BUMP_PCT,
};
