'use strict';

// GET /api/tp/stream?token=&interval=&sid= — the chart's Server-Sent Events feed
// (spec: backend unit stream.js). Public and key-less: it carries chain data, plus the
// receipts of the visitor's OWN broadcasts.
//
//   snapshot {venue, interval, bars, trades, mark, status, sid}   first, and again
//            whenever the indexer's history grows (1 h → 24 h), so the chart can setData
//   trades   Trade[]            bar {interval, bar}   (one per bucket a batch touched)
//   mark     Mark               phase Venue           status {state, detail, historySeconds}
//   receipt  {hash, from, status, block, gasUsed}     (receiptBus: this token AND this sid)
//   ping     {}  every 15 s — under nginx's read timeout, and it detects a dead socket
//
// RECEIPTS ARE SCOPED TO THE VISITOR. Every stream has a sid: 32 random hex characters
// (128 bits), sent in its snapshot, or the one the client passes back in ?sid= so its
// streams (a reconnect, a timeframe switch) share one. The browser puts the sid in its
// POST /broadcast body; the receipt watcher tags each receipt with it, and a stream
// forwards only the receipts carrying its own sid. Pushed to every viewer of the token,
// a bundle's receipts (every wallet of one click, landing together) would let any
// stranger link those wallets to each other, which the chain alone does not show.
// A stream opened with ?sid= first replays that sid's receipts of the last 150 s for
// this token (a reconnect gap loses none); the browser drops the ones it already has.
//
// The client reads it with fetch + ReadableStream (frontend api.js openStream), not
// EventSource, and reconnects itself.
//
// A disconnect is detected on the RESPONSE's 'close' (the socket closing), never the
// request's: once a body parser has read a request body, the IncomingMessage emits
// 'close' at once (measured while writing this: 0 ms after express.json() read a GET
// body, before any header was sent) — that is not the visitor leaving.
//
// Open streams are capped per visitor by limits.streamSlots, keyed by clientIp(req) —
// never req.ip, which is nginx's 127.0.0.1 for everyone (Task 1 contract note 1).

const { randomBytes } = require('crypto');
const { isAddress } = require('ethers');
const { TpError, sendError: sendJsonError } = require('./errors');
const { clientIp, streamSlots } = require('./limits');
const { INTERVALS } = require('./candles');

// Built from a char code, never typed as an escape (memory: write-tool-escapes).
const LF = String.fromCharCode(10);
const PING_MS = 15_000;
// Bars per snapshot: a day at every interval except 1 s, which sends its last hour
// (86,400 one-second bars would be ~8 MB of JSON).
const SNAPSHOT_BARS = Object.freeze({ 1: 3600, 15: 5760, 60: 1440, 300: 288, 3600: 24 });
const SNAPSHOT_TRADES = 100;
const MAX_BUFFERED = 2 * 1024 * 1024; // a client this far behind is dropped, not buffered
const SID_RE = /^[0-9a-f]{32}$/;
// Receipts kept for a returning sid: the receipt watcher gives up after 120 s, so
// 150 s covers every receipt it can announce.
const REPLAY_MS = 150_000;
const REPLAY_PER_SID = 400;
const REPLAY_SIDS = 5_000;

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

const lc = (s) => String(s || '').toLowerCase();

/** One SSE frame. JSON.stringify escapes every newline, so data is one line. */
function frame(event, data) {
  return 'event: ' + event + LF + 'data: ' + JSON.stringify(data) + LF + LF;
}

/**
 * A client-supplied sid: null when absent, the sid when well-formed; anything else is
 * TpError('bad_request'). POST /broadcast (routes/tp.js) checks its body's sid with it.
 */
function parseSid(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !SID_RE.test(value)) {
    throw new TpError('bad_request', 'sid must be the 32 hex characters the chart stream sent');
  }
  return value;
}

const receiptData = (r) => ({ hash: r.hash, from: r.from, status: r.status, block: r.block, gasUsed: r.gasUsed });

/** The receipts of the last REPLAY_MS per sid, for a stream that reopens with that sid. */
function createReceiptLog(now) {
  const bySid = new Map(); // sid -> [{ at, token, data }] oldest first
  const prune = (list, t) => {
    while (list.length && t - list[0].at > REPLAY_MS) list.shift();
  };
  return {
    record(r) {
      if (!r || typeof r.sid !== 'string' || !SID_RE.test(r.sid)) return;
      const t = now();
      let list = bySid.get(r.sid);
      if (!list) {
        if (bySid.size >= REPLAY_SIDS) bySid.delete(bySid.keys().next().value);
        list = [];
        bySid.set(r.sid, list);
      }
      prune(list, t);
      list.push({ at: t, token: lc(r.token), data: receiptData(r) });
      if (list.length > REPLAY_PER_SID) list.shift();
    },
    replay(sid, token) {
      const list = bySid.get(sid);
      if (!list) return [];
      prune(list, now());
      if (!list.length) {
        bySid.delete(sid);
        return [];
      }
      return list.filter((e) => e.token === token).map((e) => e.data);
    },
  };
}

/** JSON {error, code} before the stream starts (errors.sendError); after, just end it. */
function sendError(res, err) {
  if (res.headersSent) {
    if (typeof res.end === 'function') res.end();
    return;
  }
  sendJsonError(res, err);
}

function createStreamHandler(overrides = {}) {
  const deps = {
    // lazy, so requiring this module (routes/tp.js) builds nothing
    resolveVenue: (ca) => require('./venue').resolveVenue(ca),
    acquire: (venue) => require('./indexer').acquire(venue),
    release: (token) => require('./indexer').release(token),
    receiptBus: null,
    streamSlots: null,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    newSid: () => randomBytes(16).toString('hex'),
    now: () => Date.now(),
    ...overrides,
  };

  const receiptLog = createReceiptLog(deps.now);
  let recorderOn = null; // the bus the replay recorder listens on (one listener per handler)
  const receiptBus = () => {
    const bus = deps.receiptBus || require('./broadcast').receiptBus;
    if (recorderOn !== bus) {
      if (bus.getMaxListeners() !== 0) bus.setMaxListeners(0); // one listener per open stream
      bus.on('receipt', (r) => receiptLog.record(r));
      recorderOn = bus;
    }
    return bus;
  };

  async function handleStream(req, res) {
    const q = req.query || {};
    const token = typeof q.token === 'string' ? q.token.trim().toLowerCase() : '';
    if (!isAddress(token)) {
      return sendError(res, new TpError('bad_address', 'token must be a 0x contract address'));
    }
    const interval = q.interval === undefined || q.interval === '' ? 1 : Number(q.interval);
    if (!INTERVALS.includes(interval)) {
      return sendError(res, new TpError('bad_request', `interval must be one of ${INTERVALS.join(', ')}`));
    }
    let givenSid;
    try {
      givenSid = parseSid(q.sid);
    } catch (err) {
      return sendError(res, err);
    }
    const bus = receiptBus(); // before any await: every receipt from here on is recorded

    const slots = deps.streamSlots || streamSlots;
    const ip = clientIp(req);
    if (!slots.acquire(ip)) {
      return sendError(res, new TpError('rate_limited', 'too many open charts from this address', 429));
    }
    let slotHeld = true;
    const releaseSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      slots.release(ip);
    };

    // The client may leave while the venue is being resolved.
    let gone = false;
    const onEarlyClose = () => {
      gone = true;
    };
    res.on('close', onEarlyClose);

    let venue;
    let indexer;
    try {
      venue = await deps.resolveVenue(token);
      indexer = deps.acquire(venue);
    } catch (err) {
      res.removeListener('close', onEarlyClose);
      releaseSlot();
      return sendError(res, err);
    }
    res.removeListener('close', onEarlyClose);
    const key = lc(venue.token);
    if (gone) {
      deps.release(key);
      releaseSlot();
      return undefined;
    }

    const sid = givenSid || deps.newSid();
    let done = false;
    let pinger = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (pinger !== null) deps.clearInterval(pinger);
      indexer.removeListener('trades', onTrades);
      indexer.removeListener('mark', onMark);
      indexer.removeListener('phase', onPhase);
      indexer.removeListener('status', onStatus);
      bus.removeListener('receipt', onReceipt);
      deps.release(key);
      releaseSlot();
    };

    const send = (event, data) => {
      if (done) return;
      res.write(frame(event, data));
      if (res.writableLength > MAX_BUFFERED) {
        finish();
        if (typeof res.destroy === 'function') res.destroy();
      }
    };

    const snapshot = () =>
      send('snapshot', {
        venue: indexer.venue,
        interval,
        bars: indexer.bars(interval, SNAPSHOT_BARS[interval]),
        trades: indexer.recentTrades(SNAPSHOT_TRADES),
        mark: indexer.mark || null,
        status: indexer.status(),
        sid,
      });

    let historySent = indexer.status().historySeconds || 0;

    function onTrades(trades) {
      send('trades', trades);
      const buckets = [...new Set(trades.map((t) => t.ts - (t.ts % interval)))].sort((a, b) => a - b);
      for (const time of buckets) {
        const bar = indexer.barAt(interval, time);
        if (bar) send('bar', { interval, bar });
      }
    }
    function onMark(mark) {
      send('mark', mark);
    }
    function onPhase(next) {
      send('phase', next);
    }
    function onStatus(st) {
      send('status', st);
      if ((st.historySeconds || 0) > historySent) {
        historySent = st.historySeconds;
        snapshot();
      }
    }
    function onReceipt(r) {
      // Only this visitor's receipts: the sid its own POST /broadcast carried.
      if (!r || r.sid !== sid || lc(r.token) !== key) return;
      send('receipt', receiptData(r));
    }

    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    snapshot();
    // A returning sid first gets what it missed (the browser drops duplicates).
    if (givenSid) for (const r of receiptLog.replay(sid, key)) send('receipt', r);
    // Everything above and below is synchronous: no event can fall between the
    // snapshot, the replay and the subscriptions.
    indexer.on('trades', onTrades);
    indexer.on('mark', onMark);
    indexer.on('phase', onPhase);
    indexer.on('status', onStatus);
    bus.on('receipt', onReceipt);
    pinger = deps.setInterval(() => send('ping', {}), PING_MS);
    res.on('close', finish);
    res.on('error', finish);
    return undefined;
  }

  // Start the replay log before the first stream opens. The page signs its approvals
  // on load, and they can reach POST /broadcast before its stream has connected; on a
  // freshly started server no stream would have attached the recorder yet, and those
  // receipts would be lost. routes/tp.js calls this before it watches a sid's receipts.
  handleStream.recordReceipts = () => {
    receiptBus();
  };
  return handleStream;
}

const handleStream = createStreamHandler();

module.exports = { handleStream, createStreamHandler, parseSid, frame, SSE_HEADERS, PING_MS, SNAPSHOT_BARS, REPLAY_MS };
