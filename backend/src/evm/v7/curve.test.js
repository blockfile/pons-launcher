'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, getAddress, parseEther } = require('ethers');

const config = require('../../config');
const curve = require('./curve');

// Local mirrors of curve.js's own interfaces, used only to (a) encode the fake launcher/
// token reads the module decodes and (b) decode the calldata the builders produce, so a
// test proves the exact bytes, not just that a function ran. They MUST match curve.js.
const CURVE_IFACE = new Interface([
  'function swapExactInput((address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,bytes data)) payable returns (uint256 amountOut)',
  'function quoteExactInput((address tokenIn,address tokenOut,uint256 amountIn)) view returns (uint256 amountOut)',
]);
const TOKEN_IFACE = new Interface([
  'function state() view returns (uint8)',
  'function quoteToken() view returns (address)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const TOKEN = '0x3333333333333333333333333333333333333333';
const LAUNCHER = getAddress(config.flap.launcher);
const NATIVE = '0x0000000000000000000000000000000000000000';
const MASTER = config.flap.tokenMasters[0]; // the configured FlapTaxTokenV3 master
const TOKENS = (n) => BigInt(n) * 10n ** 18n;

// A well-formed EIP-1167 minimal-proxy runtime, delegating to `impl` (verbatim shape).
const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';
const cloneCode = (impl) => '0x' + EIP1167_PREFIX + getAddress(impl).slice(2).toLowerCase() + EIP1167_SUFFIX;

// ── calldata builders (READ-ONLY; the one place the exact flap bytes are built) ───────

test('buildBuyTx is a native-in swapExactInput: selector 0xef7ec2e7, value = amountIn, tokenIn = address(0)', () => {
  const amount = parseEther('3');
  const tx = curve.buildBuyTx({ token: TOKEN, amountInWei: amount, minOut: TOKENS(10) });
  assert.equal(tx.to, LAUNCHER, 'a buy hits the fixed launcher');
  assert.equal(tx.value, amount, 'the native spend rides in as msg.value');
  assert.equal(tx.data.slice(0, 10), '0xef7ec2e7', 'swapExactInput selector');
  const [p] = CURVE_IFACE.decodeFunctionData('swapExactInput', tx.data);
  assert.equal(p.tokenIn, NATIVE, 'native leg is address(0) on the IN side of a buy');
  assert.equal(p.tokenOut, getAddress(TOKEN));
  assert.equal(p.amountIn, amount);
  assert.equal(p.minAmountOut, TOKENS(10));
  assert.equal(p.data, '0x', 'a plain trade carries no extra data');
});

test('buildSellTx is a token-in swapExactInput: selector 0xef7ec2e7, value 0, tokenOut = address(0)', () => {
  const tx = curve.buildSellTx({ token: TOKEN, tokensInWei: TOKENS(100), minOut: 5n });
  assert.equal(tx.to, LAUNCHER);
  assert.equal(tx.value, 0n, 'a sell sends no native — the launcher pays native OUT');
  assert.equal(tx.data.slice(0, 10), '0xef7ec2e7', 'same swapExactInput fn serves both directions');
  const [p] = CURVE_IFACE.decodeFunctionData('swapExactInput', tx.data);
  assert.equal(p.tokenIn, getAddress(TOKEN), 'the token is the IN side of a sell');
  assert.equal(p.tokenOut, NATIVE, 'native leg is address(0) on the OUT side of a sell');
  assert.equal(p.amountIn, TOKENS(100));
  assert.equal(p.minAmountOut, 5n);
});

test('buildApproveTx is a bounded ERC-20 approve (0x095ea7b3) TO the token, spender = launcher', () => {
  const tx = curve.buildApproveTx({ token: TOKEN, amount: TOKENS(100) });
  assert.equal(tx.to, getAddress(TOKEN), 'the approve is sent to the token, not the launcher');
  assert.equal(tx.value, 0n);
  assert.equal(tx.data.slice(0, 10), '0x095ea7b3', 'standard ERC-20 approve selector');
  const [spender, amount] = TOKEN_IFACE.decodeFunctionData('approve', tx.data);
  assert.equal(spender, LAUNCHER, 'the launcher is the spender that pulls the token via transferFrom');
  assert.equal(amount, TOKENS(100), 'bounded to exactly the tokens being sold');
});

// ── quotes (quoteExactInput, native leg = address(0)) ─────────────────────────────────

test('quoteBuy prices a native-in buy: address(0) tokenIn, encoded amountOut decoded back', async () => {
  let seen;
  const rpc = {
    call: async ({ to, data }) => {
      assert.equal(to, LAUNCHER);
      seen = data;
      return CURVE_IFACE.encodeFunctionResult('quoteExactInput', [TOKENS(1234)]);
    },
  };
  const out = await curve.quoteBuy({ token: TOKEN, amountInWei: parseEther('2') }, { provider: rpc });
  assert.equal(out, TOKENS(1234));
  assert.equal(seen.slice(0, 10), '0xfc847c2b', 'quoteExactInput selector');
  const [p] = CURVE_IFACE.decodeFunctionData('quoteExactInput', seen);
  assert.equal(p.tokenIn, NATIVE);
  assert.equal(p.tokenOut, getAddress(TOKEN));
  assert.equal(p.amountIn, parseEther('2'));
});

test('quoteSell prices a token-in sell: token IN, address(0) OUT, and the flap quoter DOES price sells', async () => {
  let seen;
  const rpc = {
    call: async ({ data }) => {
      seen = data;
      return CURVE_IFACE.encodeFunctionResult('quoteExactInput', [parseEther('0.5')]);
    },
  };
  const out = await curve.quoteSell({ token: TOKEN, tokensInWei: TOKENS(100) }, { provider: rpc });
  assert.equal(out, parseEther('0.5'));
  const [p] = CURVE_IFACE.decodeFunctionData('quoteExactInput', seen);
  assert.equal(p.tokenIn, getAddress(TOKEN));
  assert.equal(p.tokenOut, NATIVE);
  assert.equal(p.amountIn, TOKENS(100));
});

// ── token reads: state, quoteToken, and the getTokenV8 word-offset decode ─────────────

test('tokenState decodes the uint8 state and reads it off the TOKEN (not the launcher)', async () => {
  const rpc = {
    call: async ({ to }) => {
      assert.equal(to, getAddress(TOKEN));
      return TOKEN_IFACE.encodeFunctionResult('state', [0]);
    },
  };
  assert.equal(await curve.tokenState(TOKEN, { provider: rpc }), 0);
});

test('tokenState surfaces a graduated state as its number', async () => {
  const rpc = { call: async () => TOKEN_IFACE.encodeFunctionResult('state', [2]) };
  assert.equal(await curve.tokenState(TOKEN, { provider: rpc }), 2);
});

test('quoteTokenOf decodes the checksummed quoteToken address', async () => {
  const rpc = { call: async () => TOKEN_IFACE.encodeFunctionResult('quoteToken', [config.flap.wnative]) };
  assert.equal(await curve.quoteTokenOf(TOKEN, { provider: rpc }), getAddress(config.flap.wnative));
});

// getTokenV8(address) is UNVERIFIED source: decoded by fixed word offset (word[2] =
// circulatingSupply, word[8] = dexSupplyThresh), guarded so a moved layout throws.
function tokenV8Raw({ circulating, thresh, words = 9 }) {
  const arr = new Array(words).fill(0n);
  if (words > 2) arr[2] = circulating;
  if (words > 8) arr[8] = thresh;
  return '0x' + arr.map((w) => BigInt(w).toString(16).padStart(64, '0')).join('');
}

test('tokenCurve decodes circulatingSupply @ word[2] and dexSupplyThresh @ word[8]', async () => {
  const rpc = {
    call: async ({ to, data }) => {
      assert.equal(to, LAUNCHER);
      assert.equal(data.slice(0, 10), '0xf1159a49', 'getTokenV8 selector');
      return tokenV8Raw({ circulating: TOKENS(600_000_000), thresh: TOKENS(800_000_000) });
    },
  };
  const out = await curve.tokenCurve(TOKEN, { provider: rpc });
  assert.equal(out.circulatingSupply, TOKENS(600_000_000));
  assert.equal(out.dexSupplyThresh, TOKENS(800_000_000));
});

test('tokenCurve THROWS on an implausible layout (thresh < circulating) rather than mis-size the graduation guard', async () => {
  const rpc = { call: async () => tokenV8Raw({ circulating: TOKENS(900), thresh: TOKENS(800) }) };
  await assert.rejects(() => curve.tokenCurve(TOKEN, { provider: rpc }), /implausible|layout/);
});

test('tokenCurve THROWS when the response has too few words to read word[8]', async () => {
  const rpc = { call: async () => tokenV8Raw({ circulating: TOKENS(1), thresh: TOKENS(2), words: 3 }) };
  await assert.rejects(() => curve.tokenCurve(TOKEN, { provider: rpc }), /too few words/);
});

// ── provenance: EIP-1167 clone of a configured flap master ────────────────────────────

test('proxyImplementation decodes the impl address from a well-formed EIP-1167 clone', () => {
  assert.equal(curve.proxyImplementation(cloneCode(MASTER)), getAddress(MASTER));
});

test('proxyImplementation returns null for non-1167 bytecode', () => {
  assert.equal(curve.proxyImplementation('0x60806040'), null, 'ordinary contract runtime is not a proxy');
  assert.equal(curve.proxyImplementation('0x'), null, 'an EOA / empty code is not a proxy');
  assert.equal(curve.proxyImplementation(null), null);
});

test('verifyProvenanceByCode ACCEPTS a clone of a configured flap tokenMaster', async () => {
  const rpc = { getCode: async () => cloneCode(MASTER) };
  const out = await curve.verifyProvenanceByCode(TOKEN, { provider: rpc });
  assert.equal(out.ok, true);
  assert.equal(out.impl, getAddress(MASTER));
});

test('verifyProvenanceByCode REJECTS a clone of an impl that is not a flap master', async () => {
  const rpc = { getCode: async () => cloneCode('0x4444444444444444444444444444444444444444') };
  const out = await curve.verifyProvenanceByCode(TOKEN, { provider: rpc });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not a flap tokenMaster/);
});

test('verifyProvenanceByCode REJECTS a non-clone (a decoy ERC-20 has its own bytecode)', async () => {
  const rpc = { getCode: async () => '0x60806040523480156100' };
  const out = await curve.verifyProvenanceByCode(TOKEN, { provider: rpc });
  assert.equal(out.ok, false);
  assert.match(out.reason, /EIP-1167 clone/);
});
