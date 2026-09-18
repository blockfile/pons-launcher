'use strict';

// Optional WebSocket push for the chart indexer (spec, backend unit indexer.js: "WSS
// eth_subscribe used when the endpoint supports it; probed at start-up").
//
// getLogs polling stays the ONLY data path: indexer.js reads, dedups, stamps and charts
// every trade exactly as it does without a socket. The socket only steers the polling:
//   - eth_subscribe('logs', <an indexer's live filter>) wakes that indexer the moment
//     one of its logs is pushed, so a live trade is read one getLogs round trip after
//     its block instead of up to 400 ms later;
//   - while the socket is healthy, an indexer with nothing pushed polls every 2 s
//     instead of every 400 ms. That is the saving: 30 open tokens polling every 400 ms
//     is 75 getLogs a second, far more than the chart limiter's two lanes can serve.
// A pushed log is never charted from the push itself, so a socket that drops, lags or
// lies can delay the chart by one 2 s safety poll at worst, and never corrupt it.
//
// Probe: on the first indexer start, then every 5 min while down. Open the socket;
// eth_chainId must be 4663; eth_subscribe('newHeads') must deliver a head within 5 s;
// eth_subscribe('logs') must be accepted (a filter that never matches). Once live, a
// socket that goes 3 s without a head (blocks are ~100 ms) is dropped, and every
// indexer goes straight back to 400 ms polls.
//
// URL: TP_CHART_WSS_URL, or 'off' to disable. Unset, it is the chart RPC URL
// (TP_CHART_RPC_URL, else config.rpcUrl) with http(s):// turned into ws(s)://, the
// form QuickNode serves. The public RPC has no WSS (spec, measured), so there the
// probe fails and nothing changes. The URL carries the endpoint's key: never log it.
//
// Transport: the WHATWG WebSocket global (Node 22+). On an older Node this logs once
// and the indexer polls. ethers' WebSocketProvider is NOT used: its subscriptions chain
// .then() with no rejection handler (node_modules/ethers/lib.commonjs/providers/
// provider-socket.js:42-57, ethers 6.17), so an endpoint that refuses eth_subscribe
// raises an unhandled rejection, and this process, which also runs the launcher, has no
// unhandledRejection handler. It also never reconnects (provider-websocket.js:53-62).

const { CHAIN_ID, POOL_MANAGER, TOPICS } = require('./constants');

const PROBE_MS = 5_000;
const CALL_MS = 5_000;
const STALE_MS = 3_000;
const REPROBE_MS = 300_000;
const EARLY_MAX = 64;
// A logs filter that can never match: no v4 pool has the zero id.
const NEVER_MATCHES = Object.freeze({ address: POOL_MANAGER, topics: [TOPICS.V4_SWAP, '0x' + '0'.repeat(64)] });

const errText = (err) => String((err && (err.message || err)) || 'error').slice(0, 120);

/** The socket URL: explicit, 'off', or the chart RPC URL as ws(s). Null = no socket. */
function wssUrl(env = process.env, fallbackRpcUrl = '') {
  const set = String(env.TP_CHART_WSS_URL || '').trim();
  if (set.toLowerCase() === 'off') return null;
  if (set) return /^wss?:\/\//i.test(set) ? set : null;
  const rpc = String(env.TP_CHART_RPC_URL || fallbackRpcUrl || '').trim();
  return /^https?:\/\//i.test(rpc) ? rpc.replace(/^http/i, 'ws') : null;
}

/** One JSON-RPC-over-WebSocket connection. Never throws; every failure ends in onDown. */
function openLink(url, deps) {
  const ws = new deps.WebSocket(url);
  const calls = new Map(); // request id -> { resolve, reject, timer }
  const subs = new Map(); // subscription id -> handler
  const early = new Map(); // subscription id -> results that beat their eth_subscribe answer
  let nextId = 1;
  let isOpen = false;
  let down = false;
  let downHandler = null;
  let openWaiters = [];

  const deliver = (handler, result) => {
    try {
      handler(result);
    } catch (_err) {
      // a consumer's bug must not take the socket down
    }
  };

  const settleOpen = (err) => {
    const waiters = openWaiters;
    openWaiters = [];
    for (const w of waiters) {
      if (err) w.reject(err);
      else w.resolve();
    }
  };

  const fail = (err) => {
    if (down) return;
    down = true;
    settleOpen(err);
    for (const c of calls.values()) {
      deps.clearTimeout(c.timer);
      c.reject(err);
    }
    calls.clear();
    subs.clear();
    early.clear();
    try {
      ws.close();
    } catch (_err) {
      // already closing
    }
    if (downHandler) downHandler(err);
  };

  ws.addEventListener('open', () => {
    if (down) return;
    isOpen = true;
    settleOpen(null);
  });
  ws.addEventListener('error', () => fail(new Error('socket error')));
  ws.addEventListener('close', () => fail(new Error('socket closed')));
  ws.addEventListener('message', (ev) => {
    if (down || typeof ev.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_err) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && calls.has(msg.id)) {
      const c = calls.get(msg.id);
      calls.delete(msg.id);
      deps.clearTimeout(c.timer);
      if (msg.error) c.reject(new Error(errText(msg.error)));
      else c.resolve(msg.result);
      return;
    }
    if (msg.method === 'eth_subscription' && msg.params) {
      const subId = msg.params.subscription;
      const handler = subs.get(subId);
      if (handler) return deliver(handler, msg.params.result);
      // A notification can arrive in the same read as its own eth_subscribe answer,
      // before subscribe() has registered the handler: hold a few for it.
      const queue = early.get(subId) || [];
      if (queue.length < EARLY_MAX) queue.push(msg.params.result);
      early.set(subId, queue);
      if (early.size > EARLY_MAX) early.delete(early.keys().next().value);
    }
    return undefined;
  });

  function opened() {
    if (down) return Promise.reject(new Error('socket closed'));
    if (isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => openWaiters.push({ resolve, reject }));
  }

  function call(method, params) {
    if (down || !isOpen) return Promise.reject(new Error('socket not open'));
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = deps.setTimeout(() => {
        calls.delete(id);
        reject(new Error(`${method} timed out`));
      }, deps.callMs);
      calls.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        calls.delete(id);
        deps.clearTimeout(timer);
        reject(err);
      }
    });
  }

  return {
    opened,
    call,
    async subscribe(params, handler) {
      const id = await call('eth_subscribe', params);
      if (typeof id !== 'string' || !id) throw new Error('eth_subscribe answered no id');
      if (down) throw new Error('socket closed');
      subs.set(id, handler);
      const queued = early.get(id);
      if (queued) {
        early.delete(id);
        for (const result of queued) deliver(handler, result);
      }
      return id;
    },
    unsubscribe(id) {
      subs.delete(id);
      if (!down && isOpen) call('eth_unsubscribe', [id]).catch(() => {});
    },
    onDown(fn) {
      downHandler = fn;
    },
    close() {
      fail(new Error('closed'));
    },
  };
}

function createWss(overrides = {}) {
  const deps = {
    // lazy: requiring this module reads no config and opens nothing
    url: () => wssUrl(process.env, require('../config').rpcUrl),
    WebSocket: globalThis.WebSocket,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    log: (msg) => console.log(msg),
    probeMs: PROBE_MS,
    callMs: CALL_MS,
    staleMs: STALE_MS,
    reprobeMs: REPROBE_MS,
    ...overrides,
  };

  let started = false;
  let stopped = false;
  let link = null; // the link being probed, or the live one
  let live = false;
  let lastHeadAt = 0;
  let staleTimer = null;
  let reprobeTimer = null;
  let lastSaid = '';
  const watches = new Set(); // { filter, onLog, subId }
  const changeHandlers = new Set();

  const minutes = () => Math.max(1, Math.round(deps.reprobeMs / 60_000));
  const say = (msg) => {
    if (msg === lastSaid) return; // a failure that repeats every 5 min is logged once
    lastSaid = msg;
    deps.log(msg);
  };
  const safe = (fn, arg) => {
    try {
      fn(arg);
    } catch (_err) {
      // one consumer's bug must not stop the others
    }
  };

  function within(promise, ms, what) {
    return new Promise((resolve, reject) => {
      const t = deps.setTimeout(() => reject(new Error(`${what} within ${ms / 1000} s`)), ms);
      promise.then(
        (v) => {
          deps.clearTimeout(t);
          resolve(v);
        },
        (err) => {
          deps.clearTimeout(t);
          reject(err);
        }
      );
    });
  }

  function scheduleProbe() {
    if (stopped || reprobeTimer) return;
    reprobeTimer = deps.setTimeout(runProbe, deps.reprobeMs);
  }

  function unavailable(err) {
    say(`[tp] chart WSS unavailable (${errText(err)}); the chart polls; next probe in ${minutes()} min`);
    scheduleProbe();
  }

  // Nothing may escape as an unhandled rejection: this process also runs the launcher.
  function runProbe() {
    probe().catch(unavailable);
  }

  function start() {
    if (started || stopped) return;
    started = true;
    runProbe();
  }

  async function probe() {
    reprobeTimer = null;
    if (stopped) return;
    const url = deps.url();
    if (!url) {
      say('[tp] chart WSS off: the chart polls every 400 ms');
      return;
    }
    if (typeof deps.WebSocket !== 'function') {
      say('[tp] chart WSS off: this Node has no WebSocket global (Node 22+); the chart polls every 400 ms');
      return;
    }
    const l = openLink(url, deps); // a throw here (a malformed URL) reaches runProbe's catch
    link = l;
    let headSeen;
    let probeDown;
    const gotHead = new Promise((resolve, reject) => {
      headSeen = resolve;
      probeDown = reject;
    });
    gotHead.catch(() => {});
    l.onDown((err) => {
      if (link !== l) return;
      if (live) lost(err);
      else probeDown(err);
    });
    try {
      await within(l.opened(), deps.probeMs, 'no connection');
      const chain = await l.call('eth_chainId', []);
      if (Number(chain) !== CHAIN_ID) throw new Error(`chain ${Number(chain)}, not ${CHAIN_ID}`);
      await l.subscribe(['newHeads'], (h) => {
        if (onHead(l, h)) headSeen();
      });
      const probeSub = await l.subscribe(['logs', { ...NEVER_MATCHES }], () => {});
      l.unsubscribe(probeSub);
      await within(gotHead, deps.probeMs, 'no head');
    } catch (err) {
      if (stopped) return;
      if (link === l) {
        link = null;
        l.close();
      }
      unavailable(err);
      return;
    }
    if (stopped || link !== l) return;
    goLive();
  }

  /** A pushed head: proof of life. Returns whether it was a real head of this link. */
  function onHead(l, h) {
    if (link !== l) return false;
    const n = Number(h && h.number);
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    lastHeadAt = deps.now();
    return true;
  }

  function armStale() {
    if (staleTimer) deps.clearTimeout(staleTimer);
    const wait = Math.max(0, lastHeadAt + deps.staleMs - deps.now());
    staleTimer = deps.setTimeout(() => {
      staleTimer = null;
      if (!live) return;
      if (deps.now() - lastHeadAt >= deps.staleMs) {
        lost(new Error(`no head for ${deps.staleMs / 1000} s`));
        return;
      }
      armStale();
    }, wait);
  }

  function goLive() {
    live = true;
    say('[tp] chart WSS live: pushed logs wake the indexers; safety polls every 2 s');
    armStale();
    for (const w of watches) subscribeWatch(w);
    for (const fn of changeHandlers) safe(fn, true);
  }

  function lost(err) {
    const l = link;
    link = null;
    const wasLive = live;
    live = false;
    if (staleTimer) deps.clearTimeout(staleTimer);
    staleTimer = null;
    for (const w of watches) w.subId = null;
    if (l) l.close();
    if (wasLive) {
      say(`[tp] chart WSS lost (${errText(err)}); back to 400 ms polls; next probe in ${minutes()} min`);
      for (const fn of changeHandlers) safe(fn, false);
    }
    scheduleProbe();
  }

  function onLog(w, log) {
    if (!live || !watches.has(w) || !log || log.removed) return;
    const n = Number(log.blockNumber);
    if (Number.isSafeInteger(n) && n > 0) safe(w.onLog, n);
  }

  function subscribeWatch(w) {
    const l = link;
    if (!live || !l) return;
    l.subscribe(['logs', { address: w.filter.address, topics: w.filter.topics }], (log) => onLog(w, log)).then(
      (id) => {
        if (link !== l || !watches.has(w)) {
          l.unsubscribe(id);
          return;
        }
        w.subId = id;
      },
      (err) => {
        // an endpoint that takes the probe's filter but refuses this one is not usable
        if (link === l && live) lost(err);
      }
    );
  }

  /** Follow one getLogs filter: onLog(blockNumber) for each pushed log while live. */
  function watch(filter, onLogFn) {
    const w = { filter, onLog: onLogFn, subId: null };
    watches.add(w);
    subscribeWatch(w);
    return () => {
      if (!watches.delete(w)) return;
      if (w.subId && link) link.unsubscribe(w.subId);
      w.subId = null;
    };
  }

  function onChange(fn) {
    changeHandlers.add(fn);
    return () => changeHandlers.delete(fn);
  }

  function stop() {
    stopped = true;
    if (reprobeTimer) deps.clearTimeout(reprobeTimer);
    if (staleTimer) deps.clearTimeout(staleTimer);
    reprobeTimer = null;
    staleTimer = null;
    const l = link;
    link = null;
    live = false;
    if (l) l.close();
    watches.clear();
    changeHandlers.clear();
  }

  return { start, stop, live: () => live, watch, onChange };
}

module.exports = { createWss, wssUrl, openLink, PROBE_MS, STALE_MS, REPROBE_MS };
