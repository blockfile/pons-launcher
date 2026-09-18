'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { JsonRpcProvider } = require('ethers');

const config = require('../config');
const shared = require('../evm/provider');
const { tpSendProvider, tpReadProvider, tpChartProvider, _resetChartProvider, _resetTpProviders } = require('./providers');

test.afterEach(() => {
  delete process.env.TP_CHART_RPC_URL;
  delete process.env.TP_CHART_RPC_TIMEOUT_MS;
  delete process.env.TP_READ_RPC_URL;
  delete process.env.TP_READ_CONCURRENCY;
  _resetChartProvider();
  _resetTpProviders();
});

// The public page's load must never reach the console's keep-alive pool: a launch's
// bundle broadcasts queue FIFO in that agent behind whatever else holds its sockets.
test('the dApp reads and sends on providers of their OWN, never the console shared one', () => {
  const read = tpReadProvider();
  const send = tpSendProvider();
  assert.ok(read instanceof shared.RetryJsonRpcProvider, 'reads keep the transient-error retry policy');
  assert.ok(send instanceof shared.RetryJsonRpcProvider, 'sends keep the rate-limit-only broadcast retry');
  assert.notEqual(read, shared.provider);
  assert.notEqual(send, shared.provider);
  assert.notEqual(read, send);
  assert.equal(tpReadProvider(), read, 'one read provider per process');
  assert.equal(tpSendProvider(), send, 'one send provider per process');
  const sharedConn = shared.provider._getConnection();
  assert.notEqual(read._getConnection().getUrlFunc, sharedConn.getUrlFunc, 'its own socket pool');
  assert.notEqual(send._getConnection().getUrlFunc, sharedConn.getUrlFunc, 'its own socket pool');
  assert.notEqual(read._getConnection().getUrlFunc, send._getConnection().getUrlFunc);
});

test('TP_READ_RPC_URL points only the read provider elsewhere', () => {
  process.env.TP_READ_RPC_URL = 'https://reads.example.invalid/rpc';
  assert.equal(tpReadProvider()._getConnection().url, 'https://reads.example.invalid/rpc');
  assert.equal(tpSendProvider()._getConnection().url, config.rpcUrl);
});

test('every dApp read waits for one of TP_READ_CONCURRENCY process-wide slots (local stub, no network)', async () => {
  let active = 0;
  let peak = 0;
  let served = 0;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        served += 1;
        const p = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: '0x1' }));
      }, 30);
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  try {
    process.env.TP_READ_RPC_URL = `http://127.0.0.1:${stub.address().port}/`;
    process.env.TP_READ_CONCURRENCY = '3';
    const rpc = tpReadProvider();
    const addrs = Array.from({ length: 12 }, (_, i) => '0x' + String(i % 10).repeat(39) + (i < 10 ? 'a' : 'b'));
    const out = await Promise.all(addrs.map((a) => rpc.send('eth_getBalance', [a, 'latest'])));
    assert.equal(out.length, 12);
    assert.equal(served, 12);
    assert.ok(peak <= 3, `at most 3 reads in flight at once (saw ${peak})`);
  } finally {
    _resetTpProviders();
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  }
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
