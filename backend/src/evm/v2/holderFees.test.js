'use strict';

// holderFees.js with every contract mocked — no chain, no keys, no broadcasts.
//
// The four cases that decide whether real owner transactions go out safely:
//   (a) the signing wallet is not the current recipient  → throw, send nothing
//   (b) no distributor yet                               → createFor, then transfer
//   (c) a distributor already exists                     → skip createFor, transfer
//   (d) createFor reverts DistributorAlreadyExists       → decode it, continue
// plus the fully-enabled idempotent no-op, and the pure status read.

const test = require('node:test');
const assert = require('node:assert');
const { Interface, getAddress, ZeroAddress } = require('ethers');

const { HOLDER_FEE_FACTORY_ABI } = require('./abi');
const holderFees = require('./holderFees');

const IFACE = new Interface(HOLDER_FEE_FACTORY_ABI);

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const DIST = '0xdddddddddddddddddddddddddddddddddddddddd';
const FACTORY = '0x70e95cc5f03db2906081e7a8d16e4c4209291507';

/** A createFor receipt carrying the DistributorCreated event the real one emits. */
function createdReceipt(token, distributor) {
  const { topics, data } = IFACE.encodeEventLog('DistributorCreated', [
    getAddress(token),
    getAddress(distributor),
  ]);
  return { status: 1, logs: [{ address: getAddress(FACTORY), topics, data }] };
}

/** An error shaped like a reverted call carrying DistributorAlreadyExists(existing). */
function alreadyExistsRevert(existing) {
  const err = new Error('execution reverted');
  err.data = IFACE.encodeErrorResult('DistributorAlreadyExists', [getAddress(existing)]);
  return err;
}

/**
 * Injectable deps whose two "contracts" record what was called. `signer` and
 * `provider` are dummies — the mock factories ignore the runner entirely.
 */
function makeDeps({ recipient = WALLET, distributorOf = ZeroAddress, createResult = null, taxBps = 500 } = {}) {
  const calls = { createFor: 0, transfer: 0, createArgs: null, transferArgs: null };

  const coreFactory = () => ({
    async getLaunchedToken(addr) {
      return {
        token: getAddress(addr),
        curve: OTHER,
        deployer: WALLET,
        creatorFeeRecipient: getAddress(recipient),
        pairToken: ZeroAddress,
        graduationThreshold: 0n,
        poolFee: 3000,
        tickSpacing: 60,
        creatorTaxBps: taxBps,
        buybackEnabled: false,
        phase: 1,
        sweptQuote: 0n,
        sweptTokens: 0n,
        sweptAt: 0n,
        exists: true,
      };
    },
    async transferCreatorFeeRecipient(addr, newRecipient) {
      calls.transfer += 1;
      calls.transferArgs = [getAddress(addr), getAddress(newRecipient)];
      return { hash: '0xtransfer', async wait() { return { status: 1 }; } };
    },
  });

  const holderFeeFactory = () => ({
    async distributorOf() {
      return distributorOf;
    },
    async createFor(addr) {
      calls.createFor += 1;
      calls.createArgs = [getAddress(addr)];
      if (createResult && createResult.throws) throw createResult.throws;
      return { hash: '0xcreate', async wait() { return createResult ? createResult.receipt : { status: 1, logs: [] }; } };
    },
  });

  return { deps: { provider: {}, signer: {}, coreFactory, holderFeeFactory }, calls };
}

// ── (a) recipient mismatch → throws, nothing is sent ────────────────────────

test('refuses — and signs nothing — when the wallet is not the current recipient', async () => {
  const { deps, calls } = makeDeps({ recipient: OTHER });

  await assert.rejects(
    () => holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps),
    (err) => {
      assert.match(err.message, /current creator-fee recipient/);
      assert.match(err.message, new RegExp(getAddress(OTHER)));
      return true;
    }
  );

  assert.equal(calls.createFor, 0, 'no distributor is created on a refusal');
  assert.equal(calls.transfer, 0, 'no transfer is attempted on a refusal');
});

// ── (b) no distributor → createFor then transfer, distributor from the event ─

test('creates the distributor then transfers, reading the address from the event', async () => {
  const { deps, calls } = makeDeps({
    recipient: WALLET,
    distributorOf: ZeroAddress,
    createResult: { receipt: createdReceipt(TOKEN, DIST) },
  });

  const out = await holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps);

  assert.equal(out.distributor, getAddress(DIST));
  assert.equal(out.alreadyExisted, false);
  assert.equal(out.createTxHash, '0xcreate');
  assert.equal(out.transferTxHash, '0xtransfer');

  assert.equal(calls.createFor, 1);
  assert.equal(calls.transfer, 1);
  assert.deepEqual(calls.createArgs, [getAddress(TOKEN)]);
  assert.deepEqual(calls.transferArgs, [getAddress(TOKEN), getAddress(DIST)], 'recipient points at the distributor');
});

test('falls back to distributorOf when the create receipt carries no event', async () => {
  // The event is the primary source; a receipt without it must not abort — the
  // module re-reads distributorOf, which by then returns the new address.
  const calls = { createFor: 0, transfer: 0 };
  let created = false;
  const deps = {
    provider: {},
    signer: {},
    coreFactory: () => ({
      async getLaunchedToken(addr) {
        return { creatorFeeRecipient: getAddress(WALLET), creatorTaxBps: 500, pairToken: ZeroAddress, exists: true, curve: OTHER, deployer: WALLET };
      },
      async transferCreatorFeeRecipient() {
        calls.transfer += 1;
        return { hash: '0xtransfer', async wait() { return { status: 1 }; } };
      },
    }),
    holderFeeFactory: () => ({
      async distributorOf() {
        return created ? getAddress(DIST) : ZeroAddress;
      },
      async createFor() {
        calls.createFor += 1;
        return { hash: '0xcreate', async wait() { created = true; return { status: 1, logs: [] }; } };
      },
    }),
  };

  const out = await holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps);
  assert.equal(out.distributor, getAddress(DIST));
  assert.equal(calls.createFor, 1);
  assert.equal(calls.transfer, 1);
});

// ── (c) existing distributor → skip createFor, still transfer ───────────────

test('reuses an existing distributor and skips createFor, but still transfers', async () => {
  const { deps, calls } = makeDeps({ recipient: WALLET, distributorOf: getAddress(DIST) });

  const out = await holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps);

  assert.equal(out.distributor, getAddress(DIST));
  assert.equal(out.alreadyExisted, true);
  assert.equal(out.createTxHash, null, 'createFor was not called, so there is no create hash');
  assert.equal(out.transferTxHash, '0xtransfer');

  assert.equal(calls.createFor, 0, 'an existing distributor is not re-created');
  assert.equal(calls.transfer, 1);
});

test('no-ops the transfer when the recipient already IS the distributor', async () => {
  // Fully enabled already: retrying with the distributor as the wallet is a
  // clean no-op — nothing created, nothing transferred.
  const { deps, calls } = makeDeps({ recipient: DIST, distributorOf: getAddress(DIST) });

  const out = await holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: DIST }, deps);

  assert.equal(out.distributor, getAddress(DIST));
  assert.equal(out.alreadyExisted, true);
  assert.equal(out.createTxHash, null);
  assert.equal(out.transferTxHash, null, 'already the recipient — nothing to transfer');
  assert.equal(calls.createFor, 0);
  assert.equal(calls.transfer, 0);
});

// ── (d) DistributorAlreadyExists revert → decode existing, continue ─────────

test('decodes a DistributorAlreadyExists revert and continues to the transfer', async () => {
  const { deps, calls } = makeDeps({
    recipient: WALLET,
    distributorOf: ZeroAddress, // read says none, so createFor is attempted...
    createResult: { throws: alreadyExistsRevert(DIST) }, // ...but it races and reverts
  });

  const out = await holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps);

  assert.equal(out.distributor, getAddress(DIST), 'the existing address is decoded out of the revert');
  assert.equal(out.alreadyExisted, true);
  assert.equal(out.createTxHash, null, 'the create reverted, so it never produced a hash');
  assert.equal(out.transferTxHash, '0xtransfer');

  assert.equal(calls.createFor, 1, 'createFor was attempted');
  assert.equal(calls.transfer, 1, 'and the transfer still happened');
  assert.deepEqual(calls.transferArgs, [getAddress(TOKEN), getAddress(DIST)]);
});

test('decodes a DistributorAlreadyExists that ethers already turned into err.revert', async () => {
  // ethers v6 decodes the error against the contract ABI itself, so the address
  // can arrive as err.revert.args rather than as raw err.data — both must work.
  const err = new Error('execution reverted');
  err.revert = { name: 'DistributorAlreadyExists', args: [getAddress(DIST)] };
  const { deps, calls } = makeDeps({
    recipient: WALLET,
    distributorOf: ZeroAddress,
    createResult: { throws: err },
  });

  const out = await holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps);
  assert.equal(out.distributor, getAddress(DIST));
  assert.equal(out.alreadyExisted, true);
  assert.equal(calls.transfer, 1);
});

test('a non-DistributorAlreadyExists create revert aborts before any transfer', async () => {
  const err = new Error('boom');
  err.data = IFACE.encodeErrorResult('UnknownLaunch', [getAddress(TOKEN)]);
  const { deps, calls } = makeDeps({
    recipient: WALLET,
    distributorOf: ZeroAddress,
    createResult: { throws: err },
  });

  await assert.rejects(
    () => holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps),
    /UnknownLaunch/
  );
  assert.equal(calls.transfer, 0, 'a failed create must not fall through to a transfer');
});

test('refuses a token the factory has no record of', async () => {
  const deps = {
    provider: {},
    signer: {},
    coreFactory: () => ({
      async getLaunchedToken(addr) {
        return { exists: false, token: getAddress(addr) };
      },
    }),
    holderFeeFactory: () => ({ async distributorOf() { return ZeroAddress; } }),
  };
  await assert.rejects(
    () => holderFees.enableHolderFeeSharing({ token: TOKEN, walletAddress: WALLET }, deps),
    /not a pons v2 launch/
  );
});

// ── the status read ──────────────────────────────────────────────────────────

test('status reports sharing on when the recipient is the distributor', async () => {
  const deps = {
    provider: {},
    coreFactory: () => ({
      async getLaunchedToken(addr) {
        return { creatorFeeRecipient: getAddress(DIST), creatorTaxBps: 500, pairToken: ZeroAddress, exists: true };
      },
    }),
    holderFeeFactory: () => ({ async distributorOf() { return getAddress(DIST); } }),
  };
  const out = await holderFees.holderFeeStatus({ token: TOKEN }, deps);
  assert.equal(out.exists, true);
  assert.equal(out.sharingEnabled, true);
  assert.equal(out.distributor, getAddress(DIST));
  assert.equal(out.creatorFeeRecipient, getAddress(DIST));
});

test('status reports sharing off when there is no distributor yet', async () => {
  const deps = {
    provider: {},
    coreFactory: () => ({
      async getLaunchedToken(addr) {
        return { creatorFeeRecipient: getAddress(WALLET), creatorTaxBps: 0, pairToken: ZeroAddress, exists: true };
      },
    }),
    holderFeeFactory: () => ({ async distributorOf() { return ZeroAddress; } }),
  };
  const out = await holderFees.holderFeeStatus({ token: TOKEN }, deps);
  assert.equal(out.sharingEnabled, false);
  assert.equal(out.distributor, null);
  assert.equal(out.creatorTaxBps, 0);
});
