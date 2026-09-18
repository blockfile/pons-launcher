'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { JsonRpcProvider } = require('ethers');

const config = require('../config');
const shared = require('../evm/provider');
const { tpSendProvider, tpReadProvider, tpChartProvider, _resetChartProvider } = require('./providers');

test.afterEach(() => {
  delete process.env.TP_CHART_RPC_URL;
  delete process.env.TP_CHART_RPC_TIMEOUT_MS;
  _resetChartProvider();
});

test('send and read use the shared evm/provider.js provider', () => {
  assert.equal(tpSendProvider(), shared.provider);
  assert.equal(tpReadProvider(), shared.provider);
});

test('the chart provider is a separate, cached JsonRpcProvider', () => {
  const chart = tpChartProvider();
  assert.ok(chart instanceof JsonRpcProvider);
  assert.notEqual(chart, shared.provider);
  assert.equal(tpChartProvider(), chart, 'one instance per process');
});

test('the chart provider has a static chain id — no RPC call to learn it', async () => {
  // A URL nothing listens on: if getNetwork() sent eth_chainId this would reject.
  process.env.TP_CHART_RPC_URL = 'http://127.0.0.1:9/';
  const net = await tpChartProvider().getNetwork();
  assert.equal(net.chainId, 4663n);
});

test('TP_CHART_RPC_URL and TP_CHART_RPC_TIMEOUT_MS configure only the chart provider', () => {
  process.env.TP_CHART_RPC_URL = 'https://chart.example.invalid/rpc';
  process.env.TP_CHART_RPC_TIMEOUT_MS = '4321';
  const conn = tpChartProvider()._getConnection();
  assert.equal(conn.url, 'https://chart.example.invalid/rpc');
  assert.equal(conn.timeout, 4321);
  assert.notEqual(shared.provider._getConnection().url, 'https://chart.example.invalid/rpc');
});

test('an https chart provider carries its own getUrlFunc, not the send pool', () => {
  process.env.TP_CHART_RPC_URL = 'https://chart.example.invalid/rpc';
  const chartConn = tpChartProvider()._getConnection();
  const sendConn = shared.provider._getConnection();
  assert.notEqual(chartConn.getUrlFunc, sendConn.getUrlFunc);
});

test('an http chart provider carries its own getUrlFunc too — never the global https one', () => {
  process.env.TP_CHART_RPC_URL = 'http://127.0.0.1:9/';
  const chartConn = tpChartProvider()._getConnection();
  const sendConn = shared.provider._getConnection();
  assert.equal(typeof chartConn.getUrlFunc, 'function');
  assert.notEqual(chartConn.getUrlFunc, sendConn.getUrlFunc);
});

// The failure this guards: RPC_URL https (the default) makes evm/provider.js register a
// process-wide https getUrl, and an http chart URL with no getUrlFunc of its own then
// fails EVERY request with 'Protocol "http:" not supported'. A real round trip to a
// local JSON-RPC stub proves the chart provider talks plain http regardless.
test(
  'an http chart URL works while RPC_URL is https (local JSON-RPC stub, no network)',
  { skip: !/^https:/i.test(config.rpcUrl) && 'RPC_URL is not https, so no global https getUrl is registered' },
  async () => {
    const seen = [];
    const stub = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const one = (p) => {
          seen.push(p.method);
          return { jsonrpc: '2.0', id: p.id, result: '0x10' };
        };
        const payload = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
      });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      process.env.TP_CHART_RPC_URL = `http://127.0.0.1:${stub.address().port}/`;
      assert.equal(await tpChartProvider().getBlockNumber(), 16);
      assert.deepEqual(seen, ['eth_blockNumber']);
    } finally {
      _resetChartProvider(); // closes the chart's keep-alive sockets so close() can finish
      stub.closeAllConnections();
      await new Promise((resolve) => stub.close(resolve));
    }
  }
);
