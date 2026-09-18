'use strict';

// The take-profit dApp's PUBLIC API (dapp.rhbond.xyz → /api/tp/*).
//
// Mounted in server.js as app.use('/api/tp', router) BEFORE app.use('/api', identify):
// no API key, no req.user, no keystore. The server never receives a private key —
// browsers sign locally and POST raw signed transactions. This file and src/tp/** may
// not require ../wallets, ../users, ../middleware/auth or any other route module;
// src/tp/isolation.test.js enforces it.
//
// Every error answers JSON {error, code} (errors.js sendError). The trailing catch-all
// answers 404 itself, so no /api/tp/* request can ever fall through to the console's
// auth-gated routers.

const express = require('express');
const { TpError, sendError } = require('../tp/errors');
const { LIMITS, rateLimit } = require('../tp/limits');
// Called through the module objects (venue.resolveVenue, never destructured) so
// routes/tp.reads.test.js can stub them per test.
const venue = require('../tp/venue');
const state = require('../tp/state');
const { broadcastCost } = require('../tp/limits'); // own line: later tasks' edits anchor on the line above

const router = express.Router();

const readLimit = rateLimit({ windowMs: 60_000, max: LIMITS.readsPerMin });
// Approvals (arming) and everything else draw from SEPARATE per-IP buckets, charged per
// raw tx: arming 100 wallets can never spend the budget a sell click needs (limits.js).
const broadcastLimit = rateLimit({
  windowMs: 60_000,
  max: { send: LIMITS.broadcastTxPerMin, approve: LIMITS.approveTxPerMin },
  cost: broadcastCost,
});

// Express 4 does not catch a rejected promise from an async handler; route every
// handler through this so a throw (TpError or not) reaches the error handler below.
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

// Placeholder for a route whose module has not landed yet. The task that builds each
// module replaces exactly one `notYet` line below with its real handler, and the last
// one deletes `notYet` itself.
const notYet = wrap(async () => {
  throw new TpError('unavailable', 'not available yet', 501);
});

// ── routes ───────────────────────────────────────────────────────────────────
// {venue, mark}. The mark is best effort: a venue whose price will not read
// answers mark: null — nothing, rather than a wrong number.
router.get(
  '/token/:ca',
  readLimit,
  wrap(async (req, res) => {
    const v = await venue.resolveVenue(req.params.ca);
    let mark = null;
    try {
      mark = await state.readMark(v);
    } catch (err) {
      console.warn(`[tp] mark unavailable for ${v.token}: ${err.message}`);
    }
    res.json({ venue: v, mark });
  })
);
// {token, addresses} -> {venue, wallets}. The addresses (<= 100, each
// checksummable) are validated BEFORE any chain read; the venue rides along so
// the page knows which spender `allowance` refers to after a graduation.
router.post(
  '/wallets',
  readLimit,
  wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TpError('bad_request', 'expected a JSON body {token, addresses}');
    }
    const addresses = state.normalizeAddresses(body.addresses);
    const v = await venue.resolveVenue(body.token);
    res.json({ venue: v, wallets: await state.readWallets(v, addresses) });
  })
);
router.get('/fees', readLimit, wrap(async (req, res) => res.json(await state.feeParams())));
router.post('/quote', readLimit, notYet); // quote.quoteSells
router.post('/quote/pair', readLimit, notYet); // quote.quotePairToEth
router.post('/broadcast', broadcastLimit, notYet); // broadcast.broadcast
router.get('/stream', notYet); // stream.handleStream (limited by streamSlots, not readLimit)

// ── the end of the line for every /api/tp request ────────────────────────────
router.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => sendError(res, err));

// Exposed for routes/tp.test.js only.
router.limiters = { readLimit, broadcastLimit };
router.notYet = notYet;

module.exports = router;
