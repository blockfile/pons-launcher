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
const { LIMITS, rateLimit, readCost, clientIp } = require('../tp/limits');
// Called through the module objects (venue.resolveVenue, never destructured) so
// routes/tp.reads.test.js can stub them per test.
const venue = require('../tp/venue');
const state = require('../tp/state');
const quote = require('../tp/quote');
const broadcast = require('../tp/broadcast');
const { broadcastCost } = require('../tp/limits'); // own line: later tasks' edits anchor on the line above
const { handleStream, parseSid } = require('../tp/stream');
const tokenInfo = require('../tp/tokenInfo'); // module object: routes/tp.reads.test.js stubs it
const logo = require('../tp/logo'); // module object: routes/tp.logo.test.js stubs getLogo
const { createAccountRouter } = require('../tp/account');

const router = express.Router();

// A /wallets read pays by fan-out (limits.readCost): ~one RPC per address it reads.
const readLimit = rateLimit({ windowMs: 60_000, max: LIMITS.readsPerMin, cost: readCost });
// POST /quote in its own bucket: a pool click needs one exact quote, and the page's
// preview refresh or its wallet reads must never be what spends it.
const quoteLimit = rateLimit({ windowMs: 60_000, max: LIMITS.quotesPerMin });
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
// {venue, mark, info, figures}. The venue and the mark are v1's: the mark is best effort
// (a price that will not read is mark: null — nothing, rather than a wrong number), and
// after the venue it is ALL this route waits for. The route is also the sell click's
// stale-mark fallback (the page's ui/session.js sell -> api.getToken), so the header's
// reads never ride on it: the token info (tokenInfo.js, cached forever) and a v1 pool's
// balances (memoised 15 s) are started, or joined, beside the mark read, and go out only
// as far as they have answered when the mark does. A token's first load usually has its
// info (one multicall against the mark's two round trips); when not, info is null and
// the header's one re-read finds it cached. figures is the header's live half from this
// mark (curve progress, pool liquidity), which the stream's 'stats' keeps current.
router.get(
  '/token/:ca',
  readLimit,
  wrap(async (req, res) => {
    const v = await venue.resolveVenue(req.params.ca);
    // The mark read starts first, so the read provider's queue (providers.js) serves it
    // ahead of the header's reads when every slot is busy.
    const marking = (async () => state.readMark(v))();
    tokenInfo.peekInfo(v); // starts or joins the info read; never waited for
    tokenInfo.peekPoolBalances(v); // v1 only; the same
    let mark = null;
    try {
      mark = await marking;
    } catch (err) {
      console.warn(`[tp] mark unavailable for ${v.token}: ${err.message}`);
    }
    // Whatever of them has answered by now; neither call reads the chain.
    const info = tokenInfo.cachedInfo(v.token);
    const pool = tokenInfo.cachedPoolBalances(v);
    res.json({ venue: v, mark, info, figures: tokenInfo.figures(v, mark, info, pool) });
  })
);
// GET /logo/:ca -> the token's logo image, or 404 {error} (the page then draws an
// identicon). The request names a TOKEN, never a URL: the venue gate admits genuine pons
// tokens only (cachedVenue: no chain read once the token is known), and the source is
// what tokenInfo reduced the token's own logo text to: a CID, which tp/logo.js fetches
// from fixed IPFS gateways only, or an https URL (never sent to the page), which it
// fetches through the SSRF-safe tp/safeFetch.js. Either way it checks size and magic
// bytes and caches it. Served from this origin, so the page's CSP keeps img-src 'self' data:.
router.get(
  '/logo/:ca',
  readLimit,
  wrap(async (req, res) => {
    const v = await venue.cachedVenue(req.params.ca);
    const info = await tokenInfo.readTokenInfo(v);
    const source = info && info.logo ? info.logo : null;
    let got = { ok: false, permanent: true, reason: 'no_logo' };
    // The caller key holds one visitor to a couple of fetches at a time, so a page of
    // dead CIDs cannot own every slot; a request that waits past the budget comes back
    // shed (404, no-store) rather than queueing behind them with no deadline.
    const by = { by: clientIp(req) };
    let gone = false;
    req.on('close', () => {
      gone = true;
    });
    if (source && source.cid) got = await logo.getLogo(source.cid, by);
    else if (source && source.url) got = await logo.getHttpsLogo(source.url, by);
    if (gone || res.writableEnded) return undefined; // the visitor left: nothing to send
    res.set(logo.LOGO_HEADERS);
    if (!got.ok) {
      res.set('Cache-Control', got.permanent ? logo.CACHE_NONE_FINAL : logo.CACHE_NONE_RETRY);
      return res.status(404).json({ error: 'this token has no logo that can be shown' });
    }
    res.set('Content-Type', got.type);
    // Immutable only for bytes that hash to their CID. A dag-pb logo is the gateway's
    // word, and an https host's logo its host's: browsers keep it a day, as the server
    // does (tp/logo.js UNVERIFIED_TTL_MS).
    res.set('Cache-Control', got.verified === true ? logo.CACHE_HIT : logo.CACHE_HIT_UNVERIFIED);
    return res.status(200).send(got.bytes);
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
// {token, sells: [{address, amount}], ahead?} -> {quotes}: cumulative, in the order
// the click sends (tp/quote.js), behind `ahead` — the tokens the visitor's earlier
// sells still have in flight (not a row). The send path: venue.cachedVenue costs no chain read
// on a hit. A curve that graduated since the venue was cached answers every row
// reason 'graduated'; re-read the phase ONCE and quote the pool instead (spec:
// "Graduation mid-session").
router.post(
  '/quote',
  quoteLimit,
  wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TpError('bad_request', 'expected a JSON body {token, sells}');
    }
    if (typeof body.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.token)) {
      throw new TpError('bad_address', 'token is not an address');
    }
    const opts = { ahead: body.ahead };
    let v = await venue.cachedVenue(body.token.toLowerCase());
    let quotes = await quote.quoteSells(v, body.sells, {}, opts);
    if (v.kind === 'curve' && quotes.some((q) => q.reason === 'graduated')) {
      const fresh = await venue.refreshPhase(v);
      if (fresh && fresh !== v) {
        v = fresh;
        quotes = await quote.quoteSells(v, body.sells, {}, opts);
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
// /api/tp/account/*: SIWE login, the session cookie and (tp/vaultStore.js) the
// encrypted wallet list. Its own limits, CSRF guard, 404 and error handler
// (tp/account.js); it holds ciphertext only and never a key.
router.use('/account', createAccountRouter());

// ── the end of the line for every /api/tp request ────────────────────────────
router.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => sendError(res, err));

// Exposed for routes/tp.test.js only.
router.limiters = { readLimit, quoteLimit, broadcastLimit };

module.exports = router;
