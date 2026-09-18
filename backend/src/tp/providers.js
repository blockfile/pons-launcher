'use strict';

// The dApp's three RPC handles.
//
//   tpSendProvider()  — the process's shared provider (evm/provider.js): keep-alive
//                       pool, broadcast-safe retry policy. Broadcasts and receipts.
//   tpReadProvider()  — the same object, for the warm state reads (wallets, mark,
//                       quotes). Reads and sends sharing it is what the console does.
//   tpChartProvider() — a SEPARATE JsonRpcProvider for the trade indexer ONLY. Its own
//                       FetchRequest, its own keep-alive socket pool (an https.Agent or
//                       an http.Agent, matching the URL) and its own timeout, so a
//                       backfill of 10k-block getLogs windows can never hold a socket a
//                       sell is waiting for. Never use it to send.
//
// TP_CHART_RPC_URL points the indexer at a different endpoint (e.g. the public RPC,
// to keep QuickNode credits for sends); default config.rpcUrl. It may be http:// (a
// local node, an Anvil fork) even when RPC_URL is https://.

const http = require('http');
const https = require('https');
const { JsonRpcProvider, FetchRequest } = require('ethers');
const config = require('../config');
const shared = require('../evm/provider');
const { CHAIN_ID } = require('./constants');

function tpSendProvider() {
  return shared.provider;
}

function tpReadProvider() {
  return shared.provider;
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
  // ALWAYS its own getUrlFunc, for http as well as https. evm/provider.js:25-27
  // registers a PROCESS-WIDE getUrl bound to an https.Agent whenever RPC_URL is
  // https; a provider with no getUrlFunc of its own inherits it, and node then
  // refuses every plain-http request (Protocol "http:" not supported. Expected
  // "https:"). A per-request getUrlFunc overrides the global for this provider only
  // (ethers FetchRequest#getUrlFunc, copied by clone()), and gives the chart its own
  // socket pool either way.
  const agentOptions = { keepAlive: true, keepAliveMsecs: 10000, maxSockets: 32, maxFreeSockets: 8 };
  chartAgent = /^https:/i.test(url) ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
  request.getUrlFunc = FetchRequest.createGetUrlFunc({ agent: chartAgent });
  // staticNetwork: no eth_chainId round trip; batchMaxCount 1: some RH nodes mishandle
  // batch arrays (evm/provider.js:117-122).
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

module.exports = { tpSendProvider, tpReadProvider, tpChartProvider, _resetChartProvider };
