'use strict';

// The dApp's three RPC handles. NONE of them is the console's shared provider.
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
//                       lookups (also those a stream open and a bad_tx re-check make) and
//                       the receipt polls. Its own pool (TP_READ_MAX_SOCKETS, default 12)
//                       and a PROCESS-WIDE cap on reads in flight (TP_READ_CONCURRENCY,
//                       default 12), applied inside the provider so no call site can
//                       forget it. Per-IP limits keep visitors fair to each other; only
//                       this cap bounds a load spread over many addresses.
//                       TP_READ_RPC_URL points it at another endpoint (default RPC_URL).
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

/** A RetryJsonRpcProvider whose every JSON-RPC request first takes a limiter slot. */
class LimitedProvider extends shared.RetryJsonRpcProvider {
  async _send(payload) {
    const limit = this._tpLimit;
    return limit ? limit(() => super._send(payload)) : super._send(payload);
  }
}

function agentFor(url, maxSockets) {
  const options = { keepAlive: true, keepAliveMsecs: 10000, maxSockets, maxFreeSockets: Math.min(maxSockets, 16) };
  return /^https:/i.test(url) ? new https.Agent(options) : new http.Agent(options);
}

function ownProvider(url, { maxSockets, timeoutMs, limit = null }) {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  const agent = agentFor(url, maxSockets);
  request.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
  // staticNetwork: no eth_chainId round trip; batchMaxCount 1: some RH nodes mishandle
  // batch arrays (evm/provider.js).
  const provider = new LimitedProvider(request, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  provider._tpLimit = limit;
  return { provider, agent };
}

let send = null;
let read = null;

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

/** Tests only: drop the cached read and send providers and their socket pools. */
function _resetTpProviders() {
  for (const p of [read, send]) {
    if (!p) continue;
    p.provider.destroy();
    p.agent.destroy();
  }
  read = null;
  send = null;
}

module.exports = { tpSendProvider, tpReadProvider, tpChartProvider, createLimiter, _resetChartProvider, _resetTpProviders };
