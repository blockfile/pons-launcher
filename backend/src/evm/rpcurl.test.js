'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskRpcUrl } = require('./rpcurl');

// The token is not a placeholder for a real one — it is a shape. No value here
// was ever an endpoint of this project's.
const QUICKNODE = 'https://convincing-example-name.robinhood-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef01234567/';

test('a path token never survives masking', () => {
  const masked = maskRpcUrl(QUICKNODE);
  assert.equal(masked, 'https://convincing-example-name.robinhood-mainnet.quiknode.pro/…');
  assert.ok(!masked.includes('0123456789abcdef'), 'the token is gone');
});

test('a query key and userinfo go too', () => {
  assert.equal(maskRpcUrl('https://rpc.example.com/v1?apikey=sekrit'), 'https://rpc.example.com/…');
  // The marker is the tell that something was removed — here the userinfo.
  assert.equal(maskRpcUrl('https://user:pass@rpc.example.com/'), 'https://rpc.example.com/…');
  assert.equal(maskRpcUrl('https://rpc.example.com/path#frag'), 'https://rpc.example.com/…');
});

test('a bare public endpoint is printed whole, because it carries nothing', () => {
  assert.equal(maskRpcUrl('https://rpc.mainnet.chain.robinhood.com'), 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(maskRpcUrl('http://127.0.0.1:8546'), 'http://127.0.0.1:8546');
});

test('nothing unparseable falls through unmasked', () => {
  assert.equal(maskRpcUrl('not a url with a /secret/ in it'), '(unprintable endpoint)');
  assert.equal(maskRpcUrl(''), '(none)');
  assert.equal(maskRpcUrl(null), '(none)');
  assert.equal(maskRpcUrl(undefined), '(none)');
});
