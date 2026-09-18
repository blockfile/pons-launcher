'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, id } = require('ethers');

const config = require('../config');
const C = require('./constants');

const ADDRESS_KEYS = [
  'PONS_V2_FACTORY',
  'PONS_V1_FACTORY',
  'MULTICALL3',
  'POOL_MANAGER',
  'STATE_VIEW',
  'V4_QUOTER',
  'UNIVERSAL_ROUTER',
  'PERMIT2',
  'SWAP_ROUTER02',
  'QUOTER_V2',
  'WETH',
  'USDG',
  'NATIVE',
];

test('every address is lower-case 0x + 40 hex', () => {
  for (const k of ADDRESS_KEYS) {
    assert.match(C[k], /^0x[0-9a-f]{40}$/, `${k} = ${C[k]}`);
  }
});

test('addresses match config.js (the one source of truth)', () => {
  const lc = (v) => String(v).toLowerCase();
  assert.equal(C.CHAIN_ID, 4663);
  assert.equal(C.PONS_V2_FACTORY, lc(config.v2FactoryAddress));
  assert.equal(C.PONS_V1_FACTORY, lc(config.factoryAddress));
  assert.equal(C.MULTICALL3, lc(config.multicallAddress));
  assert.equal(C.POOL_MANAGER, lc(config.letscash.poolManager));
  assert.equal(C.STATE_VIEW, lc(config.letscash.stateView));
  assert.equal(C.V4_QUOTER, lc(config.letscash.quoter));
  assert.equal(C.UNIVERSAL_ROUTER, lc(config.letscash.universalRouter));
  assert.equal(C.PERMIT2, lc(config.letscash.permit2));
  assert.equal(C.SWAP_ROUTER02, lc(config.v3Route.swapRouter));
  assert.equal(C.QUOTER_V2, lc(config.v3Route.quoter));
  assert.equal(C.WETH, lc(config.v3Route.weth));
  assert.equal(C.USDG, lc(config.v3Route.usdg));
  assert.equal(C.WETH_USDG_FEE, Number(config.v3Route.wethUsdgFee));
  assert.equal(C.NATIVE, '0x0000000000000000000000000000000000000000');
});

// The browser bundle pins these literals (frontend/src/dapp/chain/constants.js). When no
// env override is set, the backend must resolve to exactly the same addresses, or the
// broadcast validator would refuse every transaction the page builds.
const DEFAULTS = [
  ['PONS_V2_FACTORY', 'PONS_V2_FACTORY', '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'],
  ['PONS_V1_FACTORY', 'FACTORY_ADDRESS', '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb'],
  ['MULTICALL3', 'MULTICALL_ADDRESS', '0xca11bde05977b3631167028862be2a173976ca11'],
  ['POOL_MANAGER', 'LETSCASH_POOL_MANAGER', '0x8366a39cc670b4001a1121b8f6a443a643e40951'],
  ['STATE_VIEW', 'LETSCASH_STATE_VIEW', '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'],
  ['V4_QUOTER', 'LETSCASH_QUOTER', '0x8dc178efb8111bb0973dd9d722ebeff267c98f94'],
  ['UNIVERSAL_ROUTER', 'LETSCASH_UNIVERSAL_ROUTER', '0x8876789976decbfcbbbe364623c63652db8c0904'],
  ['PERMIT2', 'LETSCASH_PERMIT2', '0x000000000022d473030f116ddee9f6b43ac78ba3'],
  ['SWAP_ROUTER02', 'V3_SWAP_ROUTER', '0xcaf681a66d020601342297493863e78c959e5cb2'],
  ['QUOTER_V2', 'V3_QUOTER', '0x5dedb1f91f5f56177bb4d193ad281b33e4f13098'],
  ['WETH', 'V3_WETH', '0x0bd7d308f8e1639fab988df18a8011f41eacad73'],
  ['USDG', 'V3_USDG', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'],
];

for (const [key, envName, literal] of DEFAULTS) {
  test(`${key} defaults to the pinned ${literal}`, { skip: Boolean(process.env[envName]) && `${envName} is set` }, () => {
    assert.equal(C[key], literal);
  });
}

test('WETH_USDG_FEE defaults to 100', { skip: Boolean(process.env.V3_WETH_USDG_FEE) && 'V3_WETH_USDG_FEE is set' }, () => {
  assert.equal(C.WETH_USDG_FEE, 100);
});

test('each topic is keccak256 of its event signature', () => {
  assert.equal(C.TOPICS.CURVE_BUY, id('CurveBuy(address,address,uint256,uint256,uint256,uint256)'));
  assert.equal(C.TOPICS.CURVE_SELL, id('CurveSell(address,address,uint256,uint256,uint256,uint256)'));
  assert.equal(C.TOPICS.V4_SWAP, id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
  assert.equal(C.TOPICS.V3_SWAP, id('Swap(address,address,int256,int256,uint160,uint128,int24)'));
  // and the literals are the ones the research run saw on chain
  assert.equal(C.TOPICS.CURVE_BUY, '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455');
  assert.equal(C.TOPICS.CURVE_SELL, '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df');
  assert.equal(C.TOPICS.V4_SWAP, '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f');
  assert.equal(C.TOPICS.V3_SWAP, '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
});

test('ABI has every contract key, each a frozen list that ethers parses', () => {
  const keys = [
    'V2_FACTORY',
    'V1_FACTORY',
    'V3_FACTORY',
    'CURVE',
    'ERC20',
    'MULTICALL3',
    'STATE_VIEW',
    'V4_QUOTER',
    'V3_POOL',
    'QUOTER_V2',
    'SWAP_ROUTER02',
    'UNIVERSAL_ROUTER',
    'PERMIT2',
    'EVENTS',
  ];
  assert.deepEqual(Object.keys(C.ABI).sort(), [...keys].sort());
  assert.ok(Object.isFrozen(C.ABI));
  for (const k of keys) {
    assert.ok(Array.isArray(C.ABI[k]) && C.ABI[k].length > 0, k);
    assert.ok(Object.isFrozen(C.ABI[k]), `${k} is frozen`);
    assert.doesNotThrow(() => new Interface(C.ABI[k]), k);
  }
});

test('golden selectors — the ones the broadcast allowlist and the builders depend on', () => {
  const sel = (abiKey, sig) => new Interface(C.ABI[abiKey]).getFunction(sig).selector;
  assert.equal(sel('ERC20', 'approve(address,uint256)'), '0x095ea7b3');
  assert.equal(sel('ERC20', 'allowance(address,address)'), '0xdd62ed3e');
  assert.equal(sel('ERC20', 'balanceOf(address)'), '0x70a08231');
  assert.equal(sel('CURVE', 'sell(uint256,uint256,address)'), '0xd04c6983');
  assert.equal(sel('CURVE', 'getReserves()'), '0x0902f1ac');
  assert.equal(sel('CURVE', 'feePolicy()'), '0x82589038');
  assert.equal(sel('PERMIT2', 'approve(address,address,uint160,uint48)'), '0x87517c45');
  assert.equal(sel('PERMIT2', 'allowance(address,address,address)'), '0x927da105');
  assert.equal(sel('UNIVERSAL_ROUTER', 'execute(bytes,bytes[],uint256)'), '0x3593564c');
  assert.equal(sel('SWAP_ROUTER02', 'multicall(bytes[])'), '0xac9650d8');
  assert.equal(sel('SWAP_ROUTER02', 'unwrapWETH9(uint256,address)'), '0x49404b7c');
  assert.equal(sel('SWAP_ROUTER02', 'exactInput((bytes,address,uint256,uint256))'), '0xb858183f');
  assert.equal(
    sel('SWAP_ROUTER02', 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'),
    '0x04e45aaf'
  );
  assert.equal(sel('QUOTER_V2', 'quoteExactInput(bytes,uint256)'), '0xcdca1753');
  assert.equal(sel('QUOTER_V2', 'quoteExactInputSingle((address,address,uint256,uint24,uint160))'), '0xc6a5026a');
  assert.equal(sel('MULTICALL3', 'aggregate3((address,bool,bytes)[])'), '0x82ad56cb');
  assert.equal(sel('MULTICALL3', 'getEthBalance(address)'), '0x4d2301cc');
  assert.equal(sel('STATE_VIEW', 'getSlot0(bytes32)'), '0xc815641c');
  assert.equal(sel('STATE_VIEW', 'getLiquidity(bytes32)'), '0xfa6793d5');
  assert.equal(sel('V3_POOL', 'slot0()'), '0x3850c7bd');
  assert.equal(sel('V3_FACTORY', 'getPool(address,address,uint24)'), '0x1698ee82');
  assert.equal(sel('V2_FACTORY', 'getLaunchedToken(address)'), '0x3cf28b5a');
  assert.equal(sel('V2_FACTORY', 'memeHook()'), '0x6651812c');
  assert.equal(sel('V1_FACTORY', 'getLaunchedToken(address)'), '0x3cf28b5a');
  assert.equal(sel('V1_FACTORY', 'getDexConfig(uint256)'), '0x710bb94c');
  // the router overload that would make encodeFunctionData('multicall') ambiguous is absent
  assert.doesNotThrow(() => new Interface(C.ABI.SWAP_ROUTER02).getFunction('multicall'));
  assert.doesNotThrow(() => new Interface(C.ABI.UNIVERSAL_ROUTER).getFunction('execute'));
});

test('EVENTS decodes all four trade topics', () => {
  const iface = new Interface(C.ABI.EVENTS);
  for (const topic of Object.values(C.TOPICS)) {
    assert.equal(iface.getEvent(topic).topicHash, topic);
  }
  assert.equal(new Interface(C.ABI.V3_POOL).getEvent('Swap').topicHash, C.TOPICS.V3_SWAP);
});
