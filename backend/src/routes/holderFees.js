'use strict';

// /api/v2/holder-fees/* — turn a launched v2 token's creator fee into a payout
// to its HOLDERS, on the real pons v2 (Robinhood Chain).
//
// Its own router, mounted beside the others, sharing only the factory and the
// keystore — the same separation routes/distributor.js and routes/v3.js keep.
// NOTE: routes/distributor.js is the launcher's OWN bundle distributor and is
// unrelated to this; the "distributor" here is the pons holder-fee contract.
//
// Two endpoints:
//   POST /api/v2/holder-fees/enable  { token, wallet }  — createFor + transfer
//   GET  /api/v2/holder-fees/status?token=              — pure read
//
// The enable route sits behind requireApiKey, the same gate every other v2
// mutation route uses (see routes/launch.js). The heavy lifting — and every
// signature — lives in evm/v2/holderFees.js, which reuses the keystore signer.

const express = require('express');
const { getAddress } = require('ethers');
const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const { requireApiKey } = require('../middleware/auth');
const { activityFor } = require('../store/activity');
const holderFees = require('../evm/v2/holderFees');

const router = express.Router();

/** A checksummed address, or a clear 400-worthy error naming the field. */
function requireAddress(value, what) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${what} is required`);
  try {
    return getAddress(raw);
  } catch (_err) {
    throw new Error(`${what} is not a valid address`);
  }
}

// GET /api/v2/holder-fees/status?token= — is sharing on, and to which
// distributor. A read, so it needs no confirmation and works in DRY_RUN.
router.get('/v2/holder-fees/status', requireApiKey, async (req, res, next) => {
  try {
    const token = requireAddress(req.query.token, 'token');
    res.json(await holderFees.holderFeeStatus({ token }));
  } catch (err) {
    next(err);
  }
});

// POST /api/v2/holder-fees/enable { token, wallet } — deploy the token's
// distributor if needed, then point its creator-fee recipient at it. Real
// on-chain owner transactions, so it is refused in DRY_RUN the same way the
// other v2 money routes are.
router.post('/v2/holder-fees/enable', requireApiKey, async (req, res, next) => {
  try {
    const token = requireAddress(req.body?.token, 'token');
    const wallet = requireAddress(req.body?.wallet, 'wallet');
    if (config.dryRun) {
      throw new Error('DRY_RUN is on — nothing would be broadcast, so holder fee sharing is not enabled');
    }

    const result = await holderFees.enableHolderFeeSharing(
      { token, walletAddress: wallet },
      { keystore: keystoreFor(req.user.id) }
    );

    activityFor(req.user.id).record(
      'deploy',
      `enabled holder fee sharing for ${token} → distributor ${result.distributor}` +
        (result.alreadyExisted ? ' (reused existing distributor)' : ''),
      {
        token,
        distributor: result.distributor,
        createTxHash: result.createTxHash,
        transferTxHash: result.transferTxHash,
      }
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
