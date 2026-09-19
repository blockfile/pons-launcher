'use strict';

// The dApp's four RPC handles. NONE of them is the console's shared provider.
//
//   tpSendProvider()  — broadcasts. The same RetryJsonRpcProvider class as the console
//                       (evm/provider.js: a rate-limited broadcast is re-sent, nothing
//                       else is) on the same endpoint (RPC_URL), but its OWN keep-alive
//                       socket pool. The console's pool (maxSockets 96) is what a launch
//                       bundle's eth_sendRawTransaction burst runs through; a public page
//                       sharing it would queue those buys FIFO behind anonymous traffic
//                       (measured: a 31-tx burst went from ~17 ms to ~470 ms median under
//                       one IP's 40 x /wallets burst), and a late bundle lands in a worse
//                       snipe-tax tier.
//   tpReadProvider()  — every public read: wallets, marks, fees, quotes, the venue
//                       lookups (also those a stream open and a bad_tx re-check make).
//                       Its own pool (TP_READ_MAX_SOCKETS, default 12) and a
//                       PROCESS-WIDE cap on requests in flight (TP_READ_CONCURRENCY,
//                       default 12), applied inside the provider so no call site can
//                       forget it. The cap is taken per HTTP attempt, so a read waiting
//                       out a retry backoff holds no slot. Per-IP limits keep visitors
//                       fair to each other; only this cap bounds a load spread over many
//                       addresses. TP_READ_RPC_URL points it at another endpoint
//                       (default RPC_URL).
//   tpReceiptProvider() — the receipt polls ONLY (broadcast.watchReceipts): a 100-wallet
//                       click polls 100 hashes every 250 ms, and another visitor's click
//                       quote must never queue behind them. Same endpoint as the reads,
//                       its own small pool and cap (TP_RECEIPT_MAX_SOCKETS and
//                       TP_RECEIPT_CONCURRENCY, default 4 each): a slow receipt lane
//                       costs a receipt latency, never a click.
//   tpChartProvider() — a SEPARATE JsonRpcProvider for the trade indexer ONLY. Its own
//                       FetchRequest, its own keep-alive socket pool and its own timeout,
//                       so a backfill of 10k-block getLogs windows can never hold a socket
//                       a sell is waiting for. Never use it to send.
//
// TP_CHART_RPC_URL points the indexer at a different endpoint (e.g. the public RPC,
// to keep QuickNode credits for sends); default config.rpcUrl. Any of the URLs may be
// http:// (a local node, an Anvil fork) even when RPC_URL is https://.
//
// Every provider here carries its OWN getUrlFunc, for http as well as https:
// evm/provider.js registers a PROCESS-WIDE getUrl bound to its https.Agent whenever
// RPC_URL is https, and a provider with no getUrlFunc of its own would inherit that
// agent (and refuse every plain-http request: Protocol "http:" not supported). A
// per-request getUrlFunc overrides the global for that provider only (ethers
// FetchRequest#getUrlFunc, copied by clone()).

const http = require('http');
const https = require('https');
const { JsonRpcProvider, FetchRequest } = require('ethers');
const config = require('../config');
const shared = require('../evm/provider');
const { CHAIN_ID } = require('./constants');

const posInt = (v, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** At most `max` calls of run(fn) in flight; the rest wait in arrival order. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const release = () => {
    const next = queue.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else active -= 1;
  };
  return async function run(fn) {
    if (active >= max) await new Promise((resolve) => queue.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function agentFor(url, maxSockets) {
  const options = { keepAlive: true, keepAliveMsecs: 10000, maxSockets, maxFreeSockets: Math.min(maxSockets, 16) };
  return /^https:/i.test(url) ? new https.Agent(options) : new http.Agent(options);
}

/**
 * A RetryJsonRpcProvider on its own socket pool. `limit`: every HTTP request first
 * takes one of its slots — per ATTEMPT (the getUrlFunc), so the retry policy's backoff
 * sleeps (RetryJsonRpcProvider, FetchRequest's 429 throttle) hold none.
 */
function ownProvider(url, { maxSockets, timeoutMs, limit = null }) {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  const agent = agentFor(url, maxSockets);
  const getUrl = FetchRequest.createGetUrlFunc({ agent });
  request.getUrlFunc = limit ? (req, signal) => limit(() => getUrl(req, signal)) : getUrl;
  // staticNetwork: no eth_chainId round trip; batchMaxCount 1: some RH nodes mishandle
  // batch arrays (evm/provider.js).
  const provider = new shared.RetryJsonRpcProvider(request, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  return { provider, agent };
}

let send = null;
let read = null;
let receipt = null;

function tpSendProvider() {
  if (!send) {
    send = ownProvider(config.rpcUrl, {
      maxSockets: posInt(process.env.TP_SEND_MAX_SOCKETS, 100),
      timeoutMs: posInt(process.env.RPC_TIMEOUT_MS, 20000),
    });
  }
  return send.provider;
}

function tpReadProvider() {
  if (!read) {
    const concurrency = posInt(process.env.TP_READ_CONCURRENCY, 12);
    read = ownProvider(process.env.TP_READ_RPC_URL || config.rpcUrl, {
      maxSockets: posInt(process.env.TP_READ_MAX_SOCKETS, 12),
      timeoutMs: posInt(process.env.TP_READ_RPC_TIMEOUT_MS, 20000),
      limit: createLimiter(concurrency),
    });
  }
  return read.provider;
}

function tpReceiptProvider() {
  if (!receipt) {
    receipt = ownProvider(process.env.TP_READ_RPC_URL || config.rpcUrl, {
      maxSockets: posInt(process.env.TP_RECEIPT_MAX_SOCKETS, 4),
      timeoutMs: posInt(process.env.TP_READ_RPC_TIMEOUT_MS, 20000),
      limit: createLimiter(posInt(process.env.TP_RECEIPT_CONCURRENCY, 4)),
    });
  }
  return receipt.provider;
}

let chartProvider = null;
let chartAgent = null;

function chartRpcUrl() {
  return process.env.TP_CHART_RPC_URL || config.rpcUrl;
}

function tpChartProvider() {
  if (chartProvider) return chartProvider;
  const url = chartRpcUrl();
  const request = new FetchRequest(url);
  request.timeout = Number(process.env.TP_CHART_RPC_TIMEOUT_MS) || 15000;
  chartAgent = agentFor(url, 32);
  request.getUrlFunc = FetchRequest.createGetUrlFunc({ agent: chartAgent });
  chartProvider = new JsonRpcProvider(request, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  return chartProvider;
}

/** Tests only: drop the cached chart provider and its socket pool. */
function _resetChartProvider() {
  if (chartProvider) chartProvider.destroy();
  if (chartAgent) chartAgent.destroy();
  chartProvider = null;
  chartAgent = null;
}

/** Tests only: drop the cached read, receipt and send providers and their socket pools. */
function _resetTpProviders() {
  for (const p of [read, receipt, send]) {
    if (!p) continue;
    p.provider.destroy();
    p.agent.destroy();
  }
  read = null;
  receipt = null;
  send = null;
}

module.exports = {
  tpSendProvider,
  tpReadProvider,
  tpReceiptProvider,
  tpChartProvider,
  createLimiter,
  _resetChartProvider,
  _resetTpProviders,
};
