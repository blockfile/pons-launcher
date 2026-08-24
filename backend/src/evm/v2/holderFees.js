'use strict';

// Route a pons v2 launch's creator fee to its HOLDERS instead of one wallet.
//
// This is a POST-LAUNCH, two-step operation, and it can only exist after the
// launch: the distributor is a per-token contract, so there is nothing to point
// at until the token is live.
//
//   1. HOLDER-FEE FACTORY (config.holderFeeFactory).
//      createFor(token) deploys a distributor for that token and returns it. It
//      is permissionless, but the address is a plain CREATE and so NOT
//      predictable — it is read back from the DistributorCreated event, or from
//      distributorOf() which returns zero until the distributor exists. Calling
//      it twice reverts DistributorAlreadyExists(existing); the existing address
//      is decoded out of the revert and reused, which is what makes step 1 safe
//      to retry.
//   2. CORE V2 FACTORY (config.v2FactoryAddress).
//      transferCreatorFeeRecipient(token, distributor) re-points the launch's
//      creator-fee recipient at the distributor. The factory permits this ONLY
//      from the token's CURRENT creatorFeeRecipient and it takes effect
//      immediately — so this module refuses up front unless the signing wallet
//      is that current recipient, rather than sending a transfer that would only
//      revert NotCreatorFeeRecipient after spending gas.
//
// SIGNING IS NOT REINVENTED HERE. Every transaction is sent through the same
// keystore signer the launch path uses — keystore.signer(id, provider) connected
// to an ethers Contract, exactly as routes/distributor.js signs its owner
// transactions. No key material is read, derived or stored in this file.
//
// The whole flow is idempotent: an existing distributor is reused, and a
// recipient already pointed at it is left alone.

const { Contract, Interface, getAddress, ZeroAddress } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { rpcMessage } = require('../errors');
const { FACTORY_V2_ABI, HOLDER_FEE_FACTORY_ABI } = require('./abi');
const erc20mod = require('../erc20');

// The holder-fee factory's own errors and event live here, so a revert is named
// and the DistributorCreated log can be parsed off a receipt.
const HOLDER_FEE_IFACE = new Interface(HOLDER_FEE_FACTORY_ABI);

/** The core v2 factory, for reading getLaunchedToken and re-pointing the recipient. */
function coreFactory(runner = provider) {
  if (!config.v2FactoryAddress) throw new Error('PONS_V2_FACTORY is not set');
  return new Contract(config.v2FactoryAddress, FACTORY_V2_ABI, runner);
}

/** The holder-fee distributor factory. */
function holderFeeFactory(runner = provider) {
  if (!config.holderFeeFactory) throw new Error('HOLDER_FEE_FACTORY is not set');
  return new Contract(config.holderFeeFactory, HOLDER_FEE_FACTORY_ABI, runner);
}

/**
 * The revert data hides in a different slot depending on the node and the ethers
 * path — read every known one before decoding, the same way factory.explainRevert
 * does for the launch errors.
 */
function revertData(err) {
  return (
    err?.data ||
    err?.info?.error?.data ||
    err?.error?.data ||
    err?.revert?.data ||
    (typeof err?.value === 'string' && err.value.startsWith('0x') ? err.value : null)
  );
}

/**
 * The address carried by a DistributorAlreadyExists revert, or null if the error
 * is something else. This is what lets step 1 recover from a race — someone
 * created the distributor between our distributorOf read and our createFor.
 */
function existingFromRevert(err) {
  // ethers v6 may already have decoded the error against the contract's ABI
  // (the holder-fee Contract is built WITH its errors), exposing it as
  // err.revert = { name, args }. Prefer that, then fall back to raw revert data.
  const revert = err?.revert;
  if (revert && revert.name === 'DistributorAlreadyExists' && revert.args) {
    try {
      return getAddress(revert.args.existing ?? revert.args[0]);
    } catch (_err) {
      // fall through to the raw-data path
    }
  }
  const data = revertData(err);
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = HOLDER_FEE_IFACE.parseError(data);
      if (parsed && parsed.name === 'DistributorAlreadyExists') {
        return getAddress(parsed.args.existing);
      }
    } catch (_err) {
      // not a holder-fee error we can name
    }
  }
  return null;
}

/** A holder-fee revert in the contract's own words, or the plain RPC message. */
function explainHolderFeeRevert(err) {
  const revert = err?.revert;
  if (revert && revert.name) {
    const args = revert.args && revert.args.length ? ` (${Array.from(revert.args).map(String).join(', ')})` : '';
    return `${revert.name}${args}`;
  }
  const data = revertData(err);
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = HOLDER_FEE_IFACE.parseError(data);
      if (parsed) {
        const args = parsed.args.length ? ` (${parsed.args.map(String).join(', ')})` : '';
        return `${parsed.name}${args}`;
      }
    } catch (_err) {
      // fall through to the plain message
    }
  }
  return rpcMessage(err);
}

/** distributorOf(token) as a checksummed address, or null when it is still zero. */
async function readDistributorOf(hf, runner, token) {
  const raw = await hf(runner).distributorOf(getAddress(token));
  if (!raw) return null;
  const addr = getAddress(raw);
  return addr === ZeroAddress ? null : addr;
}

/**
 * Pull the created distributor out of a createFor receipt's DistributorCreated
 * log — but ONLY a log that is genuinely this factory's, for this token.
 *
 * The address this returns is fed to transferCreatorFeeRecipient, which the core
 * factory does NOT validate: it will point the creator fee at whatever address it
 * is given. So a look-alike DistributorCreated emitted by some other contract, or
 * a real one for a DIFFERENT token in the same transaction, must never be
 * adopted. Two filters make that airtight:
 *   1. the log must be emitted BY the holder-fee factory (address match), and
 *   2. the event's indexed token must equal the token we created for.
 *
 * @param {object} receipt
 * @param {{token: string, factoryAddress: string}} opts
 */
function distributorFromReceipt(receipt, { token, factoryAddress } = {}) {
  const wantToken = token ? getAddress(token) : null;
  let wantFactory = null;
  try {
    wantFactory = factoryAddress ? getAddress(factoryAddress).toLowerCase() : null;
  } catch (_err) {
    wantFactory = null;
  }

  for (const log of receipt?.logs || []) {
    // Emitted by the holder-fee factory itself, or it is not ours to trust.
    if (wantFactory) {
      let from;
      try {
        from = log.address ? getAddress(log.address).toLowerCase() : null;
      } catch (_err) {
        from = null;
      }
      if (from !== wantFactory) continue;
    }
    let parsed;
    try {
      parsed = HOLDER_FEE_IFACE.parseLog({ topics: [...(log.topics || [])], data: log.data });
    } catch (_err) {
      continue; // some other event
    }
    if (!parsed || parsed.name !== 'DistributorCreated') continue;
    // The indexed token must be the one we asked to create the distributor for.
    if (wantToken && getAddress(parsed.args.token) !== wantToken) continue;
    return getAddress(parsed.args.distributor);
  }
  return null;
}

/**
 * A signer for `walletAddress`. This is the ONLY place a key is touched, and it
 * touches none itself: it hands off to keystore.signer(id, provider), the same
 * helper the launch and sell paths use, after resolving the id from the address.
 *
 * `deps.signer` / `deps.signerFor` are the test/injection seams; production
 * passes `deps.keystore` (the caller's own keystore) and this finds the wallet.
 */
async function resolveSigner(walletAddress, runner, deps) {
  if (deps.signer) return deps.signer;
  if (typeof deps.signerFor === 'function') return deps.signerFor(getAddress(walletAddress));
  const ks = deps.keystore;
  if (!ks) throw new Error('no keystore provided to sign the holder-fee transactions');
  const want = getAddress(walletAddress).toLowerCase();
  const found = ks.list().find((w) => {
    try {
      return getAddress(w.address).toLowerCase() === want;
    } catch (_err) {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      `the creator-fee recipient ${getAddress(walletAddress)} is not a wallet in this keystore — ` +
        'import its private key here first, since it must sign the recipient transfer'
    );
  }
  return ks.signer(found.id, runner);
}

/**
 * Whether holder-fee sharing is on for a token, and to which distributor. A pure
 * read — used by the /status route and safe to call before enabling.
 *
 * @returns {Promise<{token, exists, creatorFeeRecipient?, creatorTaxBps?,
 *                    pairToken?, distributor?: (string|null), sharingEnabled?}>}
 */
async function holderFeeStatus({ token }, deps = {}) {
  const runner = deps.provider || provider;
  const core = deps.coreFactory || coreFactory;
  const hf = deps.holderFeeFactory || holderFeeFactory;

  const address = getAddress(token);
  const rec = await core(runner).getLaunchedToken(address);
  if (!rec.exists) return { token: address, exists: false };

  const creatorFeeRecipient = getAddress(rec.creatorFeeRecipient);
  const pairToken = getAddress(rec.pairToken);
  const distributor = await readDistributorOf(hf, runner, address);
  const sharingEnabled = Boolean(
    distributor && creatorFeeRecipient.toLowerCase() === distributor.toLowerCase()
  );

  // Display-only, best-effort: native ETH has no ERC-20 symbol, and a token that
  // will not answer must never fail the status read — it falls back to null.
  const getSymbol = deps.getSymbol || ((t) => erc20mod.getSymbol(t));
  const pairSymbol =
    pairToken === ZeroAddress ? 'ETH' : await getSymbol(pairToken).catch(() => null);

  return {
    token: address,
    exists: true,
    creatorFeeRecipient,
    creatorTaxBps: Number(rec.creatorTaxBps),
    pairToken,
    pairSymbol,
    distributor,
    sharingEnabled,
  };
}

/**
 * Enable holder-fee sharing for a launched v2 token.
 *
 * @param {object} input
 * @param {string} input.token the launched token
 * @param {string} input.walletAddress the operator wallet we sign from; it MUST
 *   be the token's current creatorFeeRecipient, or the factory would revert the
 *   transfer.
 * @param {object} [deps] injectable: { provider, keystore, signer, signerFor,
 *   coreFactory, holderFeeFactory }
 * @returns {Promise<{token, distributor, alreadyExisted, createTxHash, transferTxHash}>}
 */
async function enableHolderFeeSharing({ token, walletAddress }, deps = {}) {
  const runner = deps.provider || provider;
  const core = deps.coreFactory || coreFactory;
  const hf = deps.holderFeeFactory || holderFeeFactory;

  const address = getAddress(token);
  const wallet = getAddress(walletAddress);

  // ── (a) the launch must exist, and this wallet must be its CURRENT recipient ─
  // Checked before anything is signed. transferCreatorFeeRecipient is callable
  // only by the current recipient, so signing from any other wallet reverts
  // NotCreatorFeeRecipient — refuse with a clear message rather than spend gas.
  const rec = await core(runner).getLaunchedToken(address);
  if (!rec.exists) {
    throw new Error(`${address} is not a pons v2 launch — the factory has no record of it`);
  }
  const current = getAddress(rec.creatorFeeRecipient);
  if (current.toLowerCase() !== wallet.toLowerCase()) {
    // Once sharing is on, the current recipient IS the distributor, not the
    // launch wallet — so distinguish "already enabled" from "wrong signer"
    // rather than tell the operator to sign from a contract.
    const existingDist = await readDistributorOf(hf, runner, address);
    if (existingDist && current.toLowerCase() === existingDist.toLowerCase()) {
      throw new Error(
        `holder fee sharing is already enabled for this token (distributor ${existingDist})`
      );
    }
    throw new Error(
      "holder fee sharing can only be enabled by the token's current creator-fee recipient " +
        `(${current}) — sign from that wallet`
    );
  }

  // The signer for that recipient — resolved through the keystore, no new key
  // handling. Done before any transaction so a missing key fails fast.
  const signer = await resolveSigner(wallet, runner, deps);

  const factoryAddress = deps.holderFeeFactoryAddress || config.holderFeeFactory;

  // ── (b) find or create the per-token distributor ────────────────────────────
  let distributor = await readDistributorOf(hf, runner, address);
  let alreadyExisted = Boolean(distributor);
  let createTxHash = null;

  if (!distributor) {
    try {
      const tx = await hf(signer).createFor(address);
      createTxHash = tx.hash;
      const receipt = await tx.wait(1); // create confirmed before the transfer is sent
      distributor =
        distributorFromReceipt(receipt, { token: address, factoryAddress }) ||
        (await readDistributorOf(hf, runner, address));
    } catch (err) {
      // A race: the distributor was created between the read above and now
      // (possibly by an earlier attempt of ours). The revert carries the address.
      const existing = existingFromRevert(err);
      if (existing) {
        distributor = existing;
        alreadyExisted = true;
      } else {
        throw new Error(
          `could not create the holder-fee distributor for ${address}: ${explainHolderFeeRevert(err)}`
        );
      }
    }
  }

  // Reject a missing or zero distributor explicitly — the string zero address is
  // truthy, so `if (!distributor)` alone would let it through to the transfer.
  if (!distributor || getAddress(distributor) === ZeroAddress) {
    throw new Error(
      `the holder-fee distributor for ${address} was not created and distributorOf still returns ` +
        'zero — refusing to transfer the creator-fee recipient to nothing'
    );
  }
  distributor = getAddress(distributor);

  // AIRTIGHT: whatever source produced this address — the receipt event, a revert,
  // or the getter — confirm it against a fresh distributorOf(token) before handing
  // it to transferCreatorFeeRecipient, which the core factory does not validate.
  // Only ever redirect the fee to the genuine on-chain distributor for THIS token.
  const onChain = await readDistributorOf(hf, runner, address);
  if (!onChain || getAddress(onChain) !== distributor) {
    throw new Error(
      `refusing to redirect the creator fee: the resolved distributor ${distributor} for ${address} ` +
        `does not match the factory's distributorOf (${onChain || ZeroAddress}). No transfer was sent.`
    );
  }

  // ── (c) point the creator-fee recipient at the distributor ──────────────────
  // Idempotent: if the recipient already IS the distributor, sharing is on and
  // there is nothing to send. That happens when a previous attempt created the
  // distributor and transferred, then this ran again.
  let transferTxHash = null;
  if (current.toLowerCase() !== distributor.toLowerCase()) {
    const tx = await core(signer).transferCreatorFeeRecipient(address, distributor);
    transferTxHash = tx.hash;
    await tx.wait(1);
  }

  return { token: address, distributor, alreadyExisted, createTxHash, transferTxHash };
}

module.exports = {
  enableHolderFeeSharing,
  holderFeeStatus,
  coreFactory,
  holderFeeFactory,
  existingFromRevert,
  explainHolderFeeRevert,
  distributorFromReceipt,
};
