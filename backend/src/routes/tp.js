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
const quote = require('../tp/quote');
const broadcast = require('../tp/broadcast');
const { broadcastCost } = require('../tp/limits'); // own line: later tasks' edits anchor on the line above
const { handleStream, parseSid } = require('../tp/stream');

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
// {token, sells: [{address, amount}]} -> {quotes}: cumulative, in the order the
// click sends (tp/quote.js). The send path: venue.cachedVenue costs no chain read
// on a hit. A curve that graduated since the venue was cached answers every row
// reason 'graduated'; re-read the phase ONCE and quote the pool instead (spec:
// "Graduation mid-session").
router.post(
  '/quote',
  readLimit,
  wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TpError('bad_request', 'expected a JSON body {token, sells}');
    }
    if (typeof body.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.token)) {
      throw new TpError('bad_address', 'token is not an address');
    }
    let v = await venue.cachedVenue(body.token.toLowerCase());
    let quotes = await quote.quoteSells(v, body.sells);
    if (v.kind === 'curve' && quotes.some((q) => q.reason === 'graduated')) {
      const fresh = await venue.refreshPhase(v);
      if (fresh && fresh !== v) {
        v = fresh;
        quotes = await quote.quoteSells(v, body.sells);
      }
    }
    res.json({ quotes });
  })
);
// {pairToken, amount} -> quotePairToEth(): the pair -> USDG -> WETH leg that turns
// a token-quoted sell's proceeds into ETH. quote.js validates both fields.
router.post(
  '/quote/pair',
  readLimit,
  wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TpError('bad_request', 'expected a JSON body {pairToken, amount}');
    }
    res.json(await quote.quotePairToEth(body.pairToken, body.amount));
  })
);
// {token, txs: [rawHex], sid?} (<= 100) -> {results}. tp/broadcast.js validates EVERY
// transaction against this token's venue before it sends ANY. The send path:
// venue.cachedVenue costs no chain read on a hit, and the body is checked before
// even that. A token can graduate between the page's load and this click; the page
// then re-arms for Permit2, which the cached curve venue refuses as bad_tx. So on
// a bad_tx, re-read the phase ONCE and re-validate. The happy path never pays for
// that read.
router.post(
  '/broadcast',
  broadcastLimit,
  wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TpError('bad_request', 'expected a JSON body {token, txs}');
    }
    if (typeof body.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.token)) {
      throw new TpError('bad_address', 'token is not an address');
    }
    if (!Array.isArray(body.txs) || body.txs.length === 0) {
      throw new TpError('bad_request', 'txs must be a non-empty list of signed transactions');
    }
    if (body.txs.length > broadcast.MAX_TXS) {
      throw new TpError('too_many', `at most ${broadcast.MAX_TXS} transactions per broadcast`);
    }
    // The chart stream that will show these receipts (tp/stream.js sends its sid in the
    // snapshot); no other viewer of the token hears them. Checked before the venue.
    const sid = parseSid(body.sid);

    let v = await venue.cachedVenue(body.token.toLowerCase());
    let results;
    try {
      results = await broadcast.broadcast(v, body.txs);
    } catch (err) {
      if (!(err instanceof TpError) || err.code !== 'bad_tx') throw err;
      const fresh = await venue.refreshPhase(v);
      if (!fresh || fresh === v) throw err;
      v = fresh;
      results = await broadcast.broadcast(v, body.txs);
    }

    // Fire and forget: the receipts reach the page on the token's stream (receiptBus).
    const sent = results.filter((r) => r.ok).map((r) => r.hash);
    if (sent.length) {
      const token = v.token;
      // The page may not have a stream open yet (its approvals go out on load): its
      // receipts wait in the per-sid replay log, which must be listening first.
      if (sid) handleStream.recordReceipts();
      Promise.resolve()
        .then(() => broadcast.watchReceipts(token, sent, { sid }))
        .catch((e) => console.error('[tp] receipt watch failed:', e && e.message));
    }
    res.json({ results });
  })
);
// GET /api/tp/stream?token=&interval=&sid= -> Server-Sent Events (tp/stream.js). No
// readLimit: open streams are capped per visitor by streamSlots inside handleStream.
router.get('/stream', wrap(handleStream));

// ── the end of the line for every /api/tp request ────────────────────────────
router.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => sendError(res, err));

// Exposed for routes/tp.test.js only.
router.limiters = { readLimit, broadcastLimit };

module.exports = router;
