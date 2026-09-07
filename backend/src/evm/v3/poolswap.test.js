'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Fund-safety tests for V3's graduated-pool (Uniswap V4) leg.
//
// Every assertion is anchored to something REAL on Robinhood Chain (id 4663),
// captured once and pinned here so the suite runs fully offline (no provider,
// no network) and stays reproducible:
//
//   • poolId       — reproduces the on-chain poolId of the REAL graduated pons
//                    pool for token 0xd8865AA9…b101 / SPCX, and of a REAL
//                    NATIVE-quoted graduated pons pool. Proves the PoolKey — the
//                    currency ORDER above all — is exactly the chain's.
//   • wrong keys   — the same key with the currencies reversed, the hook dropped,
//                    the fee changed or the tickSpacing changed hashes to a
//                    DIFFERENT pool, every one of which StateView reports
//                    uninitialised on-chain. Pinned so a future edit that breaks
//                    the ordering cannot pass.
//   • calldata     — the SWAP_EXACT_IN_SINGLE param buildSellToPair emits is
//                    BYTE-FOR-BYTE identical to that of a REAL, confirmed,
//                    direct-to-UniversalRouter V4 sell on this very pons pool:
//                    tx 0x766d3e73…061d. See the note on actions below.
//   • fill         — the exact calldata pinned below was eth_simulateV1'd against
//                    LIVE state and FILLED; a too-tight minOut reverted
//                    V4TooLittleReceived. Numbers in FILL EVIDENCE.
//   • impact guard — driven by the REAL saturating quotes this pool returns, so
//                    the guard is tested against the behaviour it exists for.
//   • gates        — phase, provenance, uninitialised pool, dry liquidity,
//                    floorless build. All with an injected fake chain.
//
// ── ON THE ONE DIFFERENCE FROM THE REAL TX ───────────────────────────────────
// The real pons tx plans its actions as SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
// (0x060c0f); this module emits SWAP_EXACT_IN_SINGLE, SETTLE, TAKE (0x060b0e) so
// it can name an explicit recipient. Both are valid plans for this router, and the
// 0x060b0e shape is itself byte-proven against two other real confirmed V4 swaps on
// this same router (see evm/v5/swap.test.js) AND live-filled on the pons hook's own
// pools here. The bytes that carry the POOL — the 384-byte swap param — are
// identical either way, which is what the byte-for-byte test below asserts.
//
// ── FILL EVIDENCE (eth_simulateV1, live state, read-only: nothing was signed) ──
// ERC-20-quoted pool (token 0xd8865AA9…b101 / SPCX 0x4a0E65A3…5eEa):
//   SELL 1,000,000e18 token, minOut 21514857779166072 (1% under a fresh quote):
//     approvals + execute all status 0x1; the seller's SPCX balance rose by
//     21,732,179,574,915,225 — EXACTLY the quoter's expectedOut, and ≥ minOut.
//   Same sell with minOut = expectedOut·2: reverted
//     0x8b063d73 (V4TooLittleReceived) with args (43464359149830450, 21732179574915225).
//   BUY 0.01 SPCX: filled 421,889,244,615,101,980,751,101 = expectedOut exactly.
// NATIVE-quoted pool (token 0x2416A8bc…8860, currency0 = address(0)):
//   BUY 0.01 ETH: filled 610,861,360,121,112,857,653,190 = expectedOut exactly;
//     with minOut·2 it reverted 0x8b063d73.
//   SELL the whole position to a THIRD address: the native proceeds
//     (9,409,764,135,290,033 wei) landed at that explicit recipient — NOT stranded
//     in the router — with the hook taking its cut separately (291,023,633,050,206).
// In all four directions the amount received equalled the quoter's expectedOut to
// the wei, which is why minOut can be sized straight off a quote. (The absolute
// figures are point-in-time — these pools trade — so it is the INVARIANT that is
// the evidence: fill == expectedOut, every time, in both directions, on both a
// native- and an ERC-20-quoted pool. The one thing pinned as bytes is the sell
// calldata below, which is asserted rather than described.)
//
// ── LIVE GATE EVIDENCE ───────────────────────────────────────────────────────
// resolvePonsPool refused, against the live chain: SPCX (not a pons launch), and
// three freshly launched phase-0 tokens (naming each one's curve). isGraduated
// returned null / false / true for those three cases respectively.
// ─────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const { AbiCoder, Interface, getAddress, keccak256 } = require('ethers');

const poolswap = require('./poolswap');
const { FACTORY_V2_ABI } = require('../v2/abi');

const coder = AbiCoder.defaultAbiCoder();
const norm = (a) => getAddress(String(a).toLowerCase());
const NATIVE = '0x0000000000000000000000000000000000000000';

// ── The real graduated pons pool, read off-chain ─────────────────────────────
const TOKEN = norm('0xd8865AA9052A5E2f59641bB613cA84ec9377b101');
const SPCX = norm('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa');
const CURVE = norm('0x03eF670d7ec0E1c93e1A6CFA3bc24883c3492D81');
const MEME_HOOK = norm('0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044');
const POOL_ID = '0x048c7f7f128df4df2ca6394512ee2f949b9cff0ab4cb39ec84dd28aa8c39ff62';
const POOL_FEE = 0;
const TICK_SPACING = 200;

// A real NATIVE-quoted graduated pons pool.
const NATIVE_TOKEN = norm('0x2416A8bc9C617628A9105F6315F0c32E0A438860');
const NATIVE_CURVE = norm('0x2C2438f78c88439f40b636eAED748D3070049037');
const NATIVE_POOL_ID = '0x077fcab0018a28dd0cc50ac1e62f224a0206252636cd4c419d6649a8c7806ea2';

const UNIVERSAL_ROUTER = norm('0x8876789976deCBFcbbBe364623c63652DB8c0904');
const PERMIT2 = norm('0x000000000022D473030F116dDEE9F6B43aC78BA3');
const V2_FACTORY = norm('0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');

// tx 0x766d3e730b9a286ea34d50b46b35bab7d86de1efbf708bd56377e02232fc061d — a REAL,
// confirmed, direct-to-UniversalRouter V4 SELL on the pons pool above. This is its
// SWAP_EXACT_IN_SINGLE param, verbatim: the PoolKey (SPCX as currency0, the token
// as currency1, fee 0, tickSpacing 200, the meme hook), zeroForOne=false, the
// amounts, sqrtPriceLimitX96=0 and empty hookData.
const REAL_SWAP_PARAM =
  '0x0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000004a0e65a3eccec6dbe60ae065f2e7bb85fae35eea' +
  '000000000000000000000000d8865aa9052a5e2f59641bb613ca84ec9377b101' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000000000c8' +
  '000000000000000000000000e5e702641ea86f4ae6cc3cdaed2b886f976be044' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000004d3978050d77ea2feb3ec' +
  '0000000000000000000000000000000000000000000000000201910dc66dd21f' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000140' +
  '0000000000000000000000000000000000000000000000000000000000000000';
const REAL_AMOUNT_IN = 5834917310826115873289196n;
const REAL_MIN_OUT = 144556151402254879n;
const REAL_SELLER = norm('0xD01D7d0f1D7dB0aA59FD346762aA4a9c10dA2257');
const REAL_DEADLINE = 1788700234n;

// The EXACT bytes that were eth_simulateV1'd against live state and FILLED
// (see FILL EVIDENCE). Pinned so a change to the encoding cannot pass unnoticed.
const FILLED_SELL = {
  tokensIn: 10n ** 24n,
  minOut: 21514857779166072n,
  recipient: norm('0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952'),
  deadline: 4102444800n,
  filled: 21732179574915225n,
  data:
    '0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000f4865700000000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060b0e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000004a0e65a3eccec6dbe60ae065f2e7bb85fae35eea000000000000000000000000d8865aa9052a5e2f59641bb613ca84ec9377b101000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c8000000000000000000000000e5e702641ea86f4ae6cc3cdaed2b886f976be044000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d3c21bcecceda1000000000000000000000000000000000000000000000000000000004c6fa62f51fb780000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000d8865aa9052a5e2f59641bb613ca84ec9377b1010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000004a0e65a3eccec6dbe60ae065f2e7bb85fae35eea000000000000000000000000267444d099b10fb5ed7c3cc7b7c767adca5749520000000000000000000000000000000000000000000000000000000000000000',
};

// ─────────────────────────────────────────────────────────────────────────────
// A fake chain. One `call` handler answers the factory, the curve's hook pin, the
// StateView reads and the V4Quoter, so every test below runs with no network.
// ─────────────────────────────────────────────────────────────────────────────
const factoryIface = new Interface(FACTORY_V2_ABI);
const curveIface = new Interface(['function feePolicy() view returns (address)']);
const stateViewIface = new Interface([
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
  'function getLiquidity(bytes32) view returns (uint128)',
]);
const quoterIface = new Interface([
  'function quoteExactInputSingle(tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

/** The getLaunchedToken tuple, in the ABI's field order. */
function launchTuple({
  token = TOKEN,
  curve = CURVE,
  pairToken = SPCX,
  poolFee = POOL_FEE,
  tickSpacing = TICK_SPACING,
  phase = 2,
  exists = true,
} = {}) {
  return [
    token, curve,
    '0x00000000000000000000000000000000000000e1', // deployer
    '0x00000000000000000000000000000000000000e2', // creatorFeeRecipient
    pairToken,
    72200000000000000000n, // graduationThreshold
    poolFee, tickSpacing,
    100, // creatorTaxBps
    false, // buybackEnabled
    phase,
    0n, 0n, 0n, // sweptQuote, sweptTokens, sweptAt
    exists,
  ];
}

/**
 * @param {object} o
 * @param {bigint|((amountIn:bigint,zeroForOne:boolean)=>bigint)} o.quote  quoter answer
 * @param {string} o.livePoolId   the only poolId StateView reports initialised
 * @param {bigint} o.liquidity
 * @param {string|null} o.curveHook  what curve.feePolicy() returns (null = no getter)
 */
function fakeChain({
  launch = launchTuple(),
  quote = 1_000_000n,
  livePoolId = POOL_ID,
  liquidity = 121386547349988583533409n,
  curveHook = MEME_HOOK,
  memeHook = MEME_HOOK,
  sqrtPriceX96 = 531709703853426516962518755306327n,
} = {}) {
  const seen = { getSlot0: 0, getLiquidity: 0, quotes: [], feePolicy: 0, memeHook: 0 };
  const provider = {
    async call(txReq) {
      const sel = String(txReq.data).slice(0, 10);
      if (sel === factoryIface.getFunction('getLaunchedToken').selector) {
        return factoryIface.encodeFunctionResult('getLaunchedToken', [launch]);
      }
      if (sel === factoryIface.getFunction('memeHook').selector) {
        seen.memeHook += 1;
        return factoryIface.encodeFunctionResult('memeHook', [memeHook]);
      }
      if (sel === curveIface.getFunction('feePolicy').selector) {
        seen.feePolicy += 1;
        if (curveHook === null) throw new Error('execution reverted'); // curve has no pin
        return curveIface.encodeFunctionResult('feePolicy', [curveHook]);
      }
      if (sel === stateViewIface.getFunction('getSlot0').selector) {
        seen.getSlot0 += 1;
        const [poolId] = stateViewIface.decodeFunctionData('getSlot0', txReq.data);
        const live = poolId.toLowerCase() === String(livePoolId).toLowerCase();
        return stateViewIface.encodeFunctionResult('getSlot0', [live ? sqrtPriceX96 : 0n, 176239, 0, 0]);
      }
      if (sel === stateViewIface.getFunction('getLiquidity').selector) {
        seen.getLiquidity += 1;
        const [poolId] = stateViewIface.decodeFunctionData('getLiquidity', txReq.data);
        const live = poolId.toLowerCase() === String(livePoolId).toLowerCase();
        return stateViewIface.encodeFunctionResult('getLiquidity', [live ? liquidity : 0n]);
      }
      if (sel === quoterIface.getFunction('quoteExactInputSingle').selector) {
        const [params] = quoterIface.decodeFunctionData('quoteExactInputSingle', txReq.data);
        seen.quotes.push({ amountIn: params.exactAmount, zeroForOne: params.zeroForOne });
        const out = typeof quote === 'function' ? quote(params.exactAmount, params.zeroForOne) : quote;
        return quoterIface.encodeFunctionResult('quoteExactInputSingle', [out, 84000n]);
      }
      throw new Error('unexpected call ' + sel);
    },
  };
  return { provider, v2Factory: V2_FACTORY, seen };
}

/**
 * A LINEAR (zero-impact) quoter: out = in · num / den. Note that a CONSTANT fake
 * quoter would not do — returning the same output for the thousandth-sized probe
 * as for the full amount is, correctly, a 99.9% price impact, and the guard would
 * refuse it. That is the guard working, so the fakes have to be honest about rates.
 */
const rate = (num, den) => (amountIn) => (BigInt(amountIn) * BigInt(num)) / BigInt(den);
const ONE_TO_ONE = rate(1n, 1n);

/** Decode a built execute() back into commands / actions / params. */
function decodeExecute(data) {
  const iface = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
  const [commands, inputs, deadline] = iface.decodeFunctionData('execute', data);
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  return { commands, inputsLen: inputs.length, deadline, actions, params };
}
function decodeSwapParam(param) {
  const T =
    'tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,' +
    'bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)';
  return coder.decode([T], param)[0];
}
const poolIdOf = (k) =>
  keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE POOLKEY — the currency order, the hook, the fee, the tickSpacing
// ═════════════════════════════════════════════════════════════════════════════

test('resolvePonsPool reproduces the REAL graduated pons poolId (SPCX-quoted)', async () => {
  const deps = fakeChain();
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);

  assert.equal(pool.poolId, POOL_ID, 'poolId must match the on-chain pool');
  // V4 sorts currencies ascending: SPCX (0x4a0E…) is numerically below the token
  // (0xd886…), so SPCX is currency0. Getting this backwards targets a pool the
  // chain has never initialised.
  assert.ok(BigInt(SPCX) < BigInt(TOKEN), 'the pinned ordering premise still holds');
  assert.equal(pool.poolKey.currency0, SPCX);
  assert.equal(pool.poolKey.currency1, TOKEN);
  assert.equal(pool.poolKey.fee, POOL_FEE);
  assert.equal(pool.poolKey.tickSpacing, TICK_SPACING);
  assert.equal(pool.poolKey.hooks, MEME_HOOK);
  assert.equal(pool.quoteIsCurrency0, true, 'the PAIR token is currency0 here');
  assert.equal(pool.isNativeQuote, false);
  assert.equal(pool.pairToken, SPCX);
  assert.equal(pool.curve, CURVE);
  assert.equal(pool.phase, poolswap.PHASE_GRADUATED);
  assert.ok(pool.liquidity > 0n);
});

test('resolvePonsPool reproduces a REAL NATIVE-quoted graduated pons poolId', async () => {
  const deps = fakeChain({
    launch: launchTuple({ token: NATIVE_TOKEN, curve: NATIVE_CURVE, pairToken: NATIVE }),
    livePoolId: NATIVE_POOL_ID,
  });
  const pool = await poolswap.resolvePonsPool({ token: NATIVE_TOKEN }, deps);

  assert.equal(pool.poolId, NATIVE_POOL_ID);
  // address(0) is the numerically smallest address, so native is ALWAYS currency0.
  assert.equal(pool.poolKey.currency0, NATIVE);
  assert.equal(pool.poolKey.currency1, NATIVE_TOKEN);
  assert.equal(pool.isNativeQuote, true, 'proceeds come out as native ETH — no swaproute leg needed');
  assert.equal(pool.quoteIsCurrency0, true);
});

test('poolId recomputed independently equals the one resolvePonsPool returns', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  assert.equal(poolIdOf(pool.poolKey), pool.poolId);
  assert.equal(poolIdOf(pool.poolKey), POOL_ID);
});

test('every WRONG PoolKey hashes somewhere else (order, hook, fee, tickSpacing)', () => {
  // The correct key, then each single-field mutation. On-chain, StateView reports
  // sqrtPriceX96 = 0 for every one of these — they are pools that do not exist.
  const right = { currency0: SPCX, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: MEME_HOOK };
  assert.equal(poolIdOf(right), POOL_ID);

  const wrong = {
    'currencies reversed': { ...right, currency0: TOKEN, currency1: SPCX },
    'hook dropped': { ...right, hooks: NATIVE },
    'fee 3000': { ...right, fee: 3000 },
    'tickSpacing 60': { ...right, tickSpacing: 60 },
    'ETH instead of the pair': { ...right, currency0: NATIVE },
  };
  for (const [label, key] of Object.entries(wrong)) {
    assert.notEqual(poolIdOf(key), POOL_ID, `${label} must NOT hash to the live pool`);
  }
});

test('the hook is PINNED BY THE LAUNCH (curve.feePolicy), not the factory default', async () => {
  // A factory whose memeHook() has since been re-pointed must not change the pool
  // an already-graduated launch resolves to.
  const deps = fakeChain({ curveHook: MEME_HOOK, memeHook: '0x00000000000000000000000000000000deadbeef' });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  assert.equal(pool.hook, MEME_HOOK);
  assert.equal(pool.hookSource, 'curve.feePolicy');
  assert.equal(pool.poolId, POOL_ID);
  assert.equal(deps.seen.memeHook, 0, 'the factory default is never even read when the curve pins one');
});

test('a curve with no feePolicy() getter falls back to factory.memeHook()', async () => {
  const deps = fakeChain({ curveHook: null });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  assert.equal(pool.hook, MEME_HOOK);
  assert.equal(pool.hookSource, 'factory.memeHook');
  assert.equal(deps.seen.memeHook, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE GATES — nothing gets built against a pool that is not there
// ═════════════════════════════════════════════════════════════════════════════

test('resolvePonsPool refuses a token the pons factory never launched', async () => {
  const deps = fakeChain({ launch: launchTuple({ exists: false }) });
  await assert.rejects(
    poolswap.resolvePonsPool({ token: SPCX }, deps),
    /is not a pons v2 launch/,
    'provenance comes from the factory itself — a look-alike stops here'
  );
});

test('resolvePonsPool refuses a token still on its bonding curve, and names the curve', async () => {
  const deps = fakeChain({ launch: launchTuple({ phase: poolswap.PHASE_CURVE }) });
  await assert.rejects(poolswap.resolvePonsPool({ token: TOKEN }, deps), (err) => {
    assert.match(err.message, /has NOT graduated \(phase 0\)/);
    assert.match(err.message, new RegExp(CURVE, 'i'), 'the message points at the curve to trade instead');
    return true;
  });
});

test('resolvePonsPool refuses an in-between phase rather than guessing', async () => {
  const deps = fakeChain({ launch: launchTuple({ phase: 1 }) });
  await assert.rejects(poolswap.resolvePonsPool({ token: TOKEN }, deps), /phase 1.*mid-migration/s);
});

test('resolvePonsPool refuses a PoolKey the chain has not initialised', async () => {
  // Nothing is initialised — e.g. a hook that is right on paper and wrong on-chain.
  const deps = fakeChain({ livePoolId: '0x' + 'ff'.repeat(32) });
  await assert.rejects(poolswap.resolvePonsPool({ token: TOKEN }, deps), /is NOT initialised on-chain/);
});

test('resolvePonsPool refuses an initialised pool with no liquidity', async () => {
  const deps = fakeChain({ liquidity: 0n });
  await assert.rejects(poolswap.resolvePonsPool({ token: TOKEN }, deps), /holds NO liquidity/);
  // ...unless the caller explicitly accepts one.
  const pool = await poolswap.resolvePonsPool({ token: TOKEN, requireLiquidity: false }, deps);
  assert.equal(pool.poolId, POOL_ID);
  assert.equal(pool.liquidity, 0n);
});

test('resolvePonsPool requires a token address', async () => {
  await assert.rejects(poolswap.resolvePonsPool({}, fakeChain()), /a token address is required/);
});

test('isGraduated separates "not a pons launch" from "not bonded yet"', async () => {
  assert.equal(await poolswap.isGraduated(SPCX, fakeChain({ launch: launchTuple({ exists: false }) })), null);
  assert.equal(await poolswap.isGraduated(TOKEN, fakeChain({ launch: launchTuple({ phase: 0 }) })), false);
  assert.equal(await poolswap.isGraduated(TOKEN, fakeChain()), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE CALLDATA — byte-for-byte against a REAL confirmed pons V4 swap
// ═════════════════════════════════════════════════════════════════════════════

test('buildSellToPair emits the REAL pons tx\'s SWAP param, byte for byte', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const tx = poolswap.buildSellToPair(
    { pool, tokensIn: REAL_AMOUNT_IN, minOut: REAL_MIN_OUT, recipient: REAL_SELLER, deadline: REAL_DEADLINE },
    fakeChain()
  );
  const d = decodeExecute(tx.data);
  assert.equal(
    d.params[0].toLowerCase(),
    REAL_SWAP_PARAM.toLowerCase(),
    'the 384 bytes carrying the PoolKey, direction, amounts, price bound and hookData must be identical ' +
      'to the real confirmed swap on this pool'
  );
  // Same command byte as the real tx; the settle/take shape is the documented
  // difference (SETTLE/TAKE for an explicit recipient vs the real tx's *_ALL).
  assert.equal(d.commands.toLowerCase(), '0x10', 'one V4_SWAP command, no SWEEP');
  assert.equal(d.inputsLen, 1);
  assert.equal(d.actions.toLowerCase(), '0x060b0e');
  assert.equal(d.deadline, REAL_DEADLINE);
  assert.equal(tx.to.toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
});

test('the pinned sell calldata that FILLED on live state is still what we build', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const tx = poolswap.buildSellToPair(
    {
      pool,
      tokensIn: FILLED_SELL.tokensIn,
      minOut: FILLED_SELL.minOut,
      recipient: FILLED_SELL.recipient,
      deadline: FILLED_SELL.deadline,
    },
    fakeChain()
  );
  assert.equal(tx.data.toLowerCase(), FILLED_SELL.data.toLowerCase(), 'these exact bytes filled the live pons pool');
  assert.equal(tx.value, 0n);
});

test('the swap param decodes to the verified pool, exact-in, no price bound, no hookData', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const tokensIn = 5n * 10n ** 18n;
  const tx = poolswap.buildSellToPair(
    { pool, tokensIn, minOut: 7n, recipient: REAL_SELLER, deadline: 999n },
    fakeChain()
  );
  const s = decodeSwapParam(decodeExecute(tx.data).params[0]);
  assert.equal(poolIdOf(s.poolKey), POOL_ID, 'the calldata targets the verified pool');
  assert.equal(s.zeroForOne, false, 'a sell spends the TOKEN, which is currency1 here');
  assert.equal(s.amountIn, tokensIn, 'the WHOLE input is consumed — exact-in, a full fill by construction');
  assert.equal(s.amountOutMinimum, 7n, 'minOut is the only slippage floor');
  assert.equal(s.sqrtPriceLimitX96, 0n, 'no explicit price bound');
  assert.equal(s.hookData, '0x', 'the pons meme hook needs no hookData (confirmed by the live fills)');
});

test('a buy is the OPPOSITE direction to a sell', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const common = { pool, minOut: 1n, recipient: REAL_SELLER, deadline: 999n };
  const buy = decodeSwapParam(decodeExecute(poolswap.buildBuyFromPair({ ...common, amountIn: 10n }).data).params[0]);
  const sell = decodeSwapParam(decodeExecute(poolswap.buildSellToPair({ ...common, tokensIn: 10n }).data).params[0]);
  assert.equal(buy.zeroForOne, true, 'the buy spends SPCX (currency0)');
  assert.equal(sell.zeroForOne, false);
  assert.notEqual(buy.zeroForOne, sell.zeroForOne);
});

test('settle/take name the right currencies, the right payer and the recipient', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const recipient = norm('0x00000000000000000000000000000000000000aa');
  const d = decodeExecute(
    poolswap.buildSellToPair({ pool, tokensIn: 10n, minOut: 1n, recipient, deadline: 9n }).data
  );
  const settle = coder.decode(['address', 'uint256', 'bool'], d.params[1]);
  const take = coder.decode(['address', 'address', 'uint256'], d.params[2]);
  assert.equal(settle[0], TOKEN, 'SETTLE pays the token in');
  assert.equal(settle[1], 0n, 'OPEN_DELTA sentinel');
  assert.equal(settle[2], true, 'the router PULLS the token from the seller via Permit2');
  assert.equal(take[0], SPCX, 'TAKE collects the pair token');
  assert.equal(take[1], recipient, 'delivered to the named recipient');
  assert.equal(take[2], 0n);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. VALUE, APPROVALS, AND THE NO-FLOOR REFUSAL
// ═════════════════════════════════════════════════════════════════════════════

test('a NATIVE-pair buy rides ETH in as msg.value and needs no approval', async () => {
  const deps = fakeChain({
    launch: launchTuple({ token: NATIVE_TOKEN, curve: NATIVE_CURVE, pairToken: NATIVE }),
    livePoolId: NATIVE_POOL_ID,
  });
  const pool = await poolswap.resolvePonsPool({ token: NATIVE_TOKEN }, deps);
  const amountIn = 10n ** 16n;
  const tx = poolswap.buildBuyFromPair({ pool, amountIn, minOut: 1n, recipient: REAL_SELLER, deadline: 9n }, deps);
  assert.equal(tx.value, amountIn, 'value is EXACTLY amountIn — no dust left in the router, no SWEEP needed');
  assert.equal(tx.approvals, undefined);
  const d = decodeExecute(tx.data);
  const settle = coder.decode(['address', 'uint256', 'bool'], d.params[1]);
  assert.equal(settle[0], NATIVE);
  assert.equal(settle[2], false, 'the router settles the ETH it already holds; it does not pull it');
});

test('an ERC-20-pair buy carries no value and the two Permit2 approvals', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const tx = poolswap.buildBuyFromPair(
    { pool, amountIn: 10n ** 16n, minOut: 1n, recipient: REAL_SELLER, deadline: 9n },
    fakeChain()
  );
  assert.equal(tx.value, 0n);
  assert.equal(tx.approvals.length, 2);
  assert.deepEqual(tx.approvals.map((a) => a.label), ['erc20-approve-permit2', 'permit2-approve-router']);
  assert.equal(tx.approvals[0].to.toLowerCase(), SPCX.toLowerCase(), 'the PAIR token is what gets pulled on a buy');
});

test('a sell always carries the two Permit2 approvals for the TOKEN', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const tx = poolswap.buildSellToPair(
    { pool, tokensIn: 10n ** 18n, minOut: 1n, recipient: REAL_SELLER, deadline: 9n },
    fakeChain()
  );
  assert.equal(tx.value, 0n);
  const [erc20, permit2] = tx.approvals;
  const a1 = new Interface(['function approve(address,uint256)']).decodeFunctionData('approve', erc20.data);
  assert.equal(erc20.to.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(a1[0].toLowerCase(), PERMIT2.toLowerCase());
  const a2 = new Interface(['function approve(address,address,uint160,uint48)']).decodeFunctionData('approve', permit2.data);
  assert.equal(permit2.to.toLowerCase(), PERMIT2.toLowerCase());
  assert.equal(a2[0].toLowerCase(), TOKEN.toLowerCase());
  assert.equal(a2[1].toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(a2[2], 10n ** 18n, 'the Permit2 allowance is bounded to THIS sell');
});

test('NEITHER builder will produce a floorless swap', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  for (const minOut of [undefined, null, 0n, -1n]) {
    assert.throws(
      () => poolswap.buildSellToPair({ pool, tokensIn: 10n, minOut, recipient: REAL_SELLER, deadline: 9n }),
      /minOut must be positive/,
      `sell minOut=${minOut} must be refused — a pool swap with no floor can be sandwiched to nothing`
    );
    assert.throws(
      () => poolswap.buildBuyFromPair({ pool, amountIn: 10n, minOut, recipient: REAL_SELLER, deadline: 9n }),
      /minOut must be positive/,
      `buy minOut=${minOut} must be refused`
    );
  }
});

test('a builder refuses an unverified pool, a zero amount, no recipient, no deadline', async () => {
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, fakeChain());
  const ok = { pool, tokensIn: 10n, minOut: 1n, recipient: REAL_SELLER, deadline: 9n };
  assert.throws(() => poolswap.buildSellToPair({ ...ok, pool: undefined }), /a verified pool is required/);
  assert.throws(() => poolswap.buildSellToPair({ ...ok, pool: { token: TOKEN } }), /a verified pool is required/);
  assert.throws(() => poolswap.buildSellToPair({ ...ok, tokensIn: 0n }), /positive input amount/);
  assert.throws(() => poolswap.buildSellToPair({ ...ok, tokensIn: undefined }), /positive input amount/);
  assert.throws(() => poolswap.buildSellToPair({ ...ok, recipient: undefined }), /recipient is required/);
  assert.throws(() => poolswap.buildSellToPair({ ...ok, deadline: undefined }), /positive deadline/);
  assert.throws(() => poolswap.buildSellToPair({ ...ok, deadline: 0n }), /positive deadline/);
});

test('buildApprovals returns the two unsigned steps on their own', () => {
  const [erc20, permit2] = poolswap.buildApprovals({ inputToken: TOKEN, amount: 5n });
  assert.equal(erc20.to.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(permit2.to.toLowerCase(), PERMIT2.toLowerCase());
  assert.equal(erc20.value, 0n);
  assert.equal(permit2.value, 0n);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE IMPACT GUARD — the quoter saturates, so a floor alone cannot see a drain
// ═════════════════════════════════════════════════════════════════════════════

// The REAL quotes the reference pons pool returns for a BUY (SPCX in), captured
// live. A tiny probe gets 4.2e7 tokens per SPCX; 1,000,000 SPCX gets 7.8e2 per
// SPCX and hands back ~the whole side of the pool — and the quoter does NOT
// revert, it just returns that. A slippage floor derived from the same quote
// "expects" the drained output and permits it; only this comparison sees it.
const REAL_SATURATING_QUOTES = new Map([
  [10000000000000n, 441383242599802683730n],
  [10000000000000000n, 441139592984427742366140n],
  [1000000000000000n, 44135908512867901326493n],
  [1000000000000000000n, 41825911914621219248629557n],
  [1000000000000000000000n, 784163430236149305015648774n],
  [1000000000000000000000000n, 798332448957471409374798285n],
]);
const saturatingQuoter = (amountIn) => {
  const hit = REAL_SATURATING_QUOTES.get(amountIn);
  if (hit == null) throw new Error('no pinned quote for ' + amountIn);
  return hit;
};

test('assessImpact reads ~0 on a small trade and ~100% on one that drains the pool', async () => {
  const deps = fakeChain({ quote: saturatingQuoter });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);

  const small = await poolswap.assessBuyImpact({ pool, amountIn: 10000000000000000n }, deps);
  assert.equal(small.probeIn, 10000000000000n, 'the probe is a thousandth of the trade');
  assert.ok(small.impactBps < 20, `a 0.01-SPCX buy should be near-spot, got ${small.impactBps}bps`);
  assert.equal(small.fullOut, 441139592984427742366140n);

  const mid = await poolswap.assessBuyImpact({ pool, amountIn: 1000000000000000000n }, deps);
  assert.ok(mid.impactBps > 400 && mid.impactBps < 700, `a 1-SPCX buy reads ~5%, got ${mid.impactBps}bps`);

  const huge = await poolswap.assessBuyImpact({ pool, amountIn: 1000000000000000000000000n }, deps);
  assert.ok(huge.impactBps > 9000, `a pool-draining buy must read enormous, got ${huge.impactBps}bps`);
  // The quoter SATURATED rather than reverting — that is the whole point.
  assert.equal(huge.fullOut, 798332448957471409374798285n);
});

test('a trade too small to divide by 1000 is its own probe (impact 0, no false refusal)', async () => {
  const deps = fakeChain({ quote: 5n });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  const res = await poolswap.assessSellImpact({ pool, tokensIn: 500n }, deps);
  assert.equal(res.probeIn, 500n);
  assert.equal(res.impactBps, 0);
});

test('assessImpact reports the worst when there is no spot rate to compare against', async () => {
  const deps = fakeChain({ quote: 0n });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  const res = await poolswap.assessSellImpact({ pool, tokensIn: 10n ** 24n }, deps);
  assert.equal(res.impactBps, 10_000);
  assert.equal(await poolswap.assessImpact({ poolKey: pool.poolKey, zeroForOne: true, amountIn: 0n }, deps).then((r) => r.impactBps), 10_000);
});

test('the quote REFUSES a pool-draining trade, and liquidate:true is the way past', async () => {
  const deps = fakeChain({ quote: saturatingQuoter });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  const amountIn = 1000000000000000000000000n;

  await assert.rejects(
    poolswap.quoteBuyFromPair({ pool, amountIn }, deps),
    /would move the pool 99\.9% \(max 10%\)/,
    'the guard refuses rather than merely reporting — an integrator who forgets to look is still safe'
  );
  // An exit must always get out; it accepts the pool's price to do it.
  const forced = await poolswap.quoteBuyFromPair({ pool, amountIn, liquidate: true }, deps);
  assert.equal(forced.expectedOut, 798332448957471409374798285n);
  assert.ok(forced.impactBps > 9000);
  // ...and a caller may set its own cap.
  await assert.rejects(poolswap.quoteBuyFromPair({ pool, amountIn: 1000000000000000000n, maxImpactBps: 100 }, deps), /would move the pool/);
});

test('a healthy quote returns expectedOut, the floor, and the impact it measured', async () => {
  const deps = fakeChain({ quote: saturatingQuoter });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  const q = await poolswap.quoteBuyFromPair({ pool, amountIn: 10000000000000000n, slippageBps: 100 }, deps);
  assert.equal(q.expectedOut, 441139592984427742366140n);
  assert.equal(q.minOut, (441139592984427742366140n * 9900n) / 10000n, 'minOut = expectedOut · (1 − 1%)');
  assert.equal(q.poolId, POOL_ID);
  assert.equal(q.pairToken, SPCX);
  assert.equal(q.isNativeQuote, false);
  assert.ok(q.impactBps >= 0);
});

test('the default floor is 3%, and 20% when liquidating — the same numbers the route leg uses', async () => {
  const deps = fakeChain({ quote: rate(1n, 10n ** 15n) }); // 1e21 in -> 1e6 out, linearly
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  const cycle = await poolswap.quoteSellToPair({ pool, tokensIn: 10n ** 21n }, deps);
  assert.equal(cycle.expectedOut, 1_000_000n);
  assert.equal(cycle.impactBps, 0, 'a linear quoter has no price impact');
  assert.equal(cycle.minOut, (1_000_000n * BigInt(10_000 - poolswap.DEFAULT_SLIPPAGE_BPS)) / 10_000n);
  const exit = await poolswap.quoteSellToPair({ pool, tokensIn: 10n ** 21n, liquidate: true }, deps);
  assert.equal(exit.minOut, (1_000_000n * BigInt(10_000 - poolswap.EXIT_SLIPPAGE_BPS)) / 10_000n);
  assert.ok(exit.minOut < cycle.minOut, 'an exit accepts a wider price — but never a floorless one');
});

test('a quote refuses a zero-output pool rather than sizing a trade against nothing', async () => {
  const deps = fakeChain({ quote: 0n });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  await assert.rejects(poolswap.quoteSellToPair({ pool, tokensIn: 10n ** 21n, liquidate: true }, deps), /returned no output/);
  await assert.rejects(poolswap.quoteSellToPair({ pool, tokensIn: 0n }, deps), /positive input amount/);
});

test('the quote asks the quoter in the right direction, both ways', async () => {
  const deps = fakeChain({ quote: ONE_TO_ONE });
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  deps.seen.quotes.length = 0;
  await poolswap.quoteSellToPair({ pool, tokensIn: 10n ** 21n }, deps);
  assert.ok(deps.seen.quotes.length >= 2, 'the probe and the full amount, and nothing more');
  assert.ok(deps.seen.quotes.every((q) => q.zeroForOne === false), 'a sell spends currency1 here');
  deps.seen.quotes.length = 0;
  await poolswap.quoteBuyFromPair({ pool, amountIn: 10n ** 15n }, deps);
  assert.ok(deps.seen.quotes.every((q) => q.zeroForOne === true), 'a buy spends currency0 here');
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE SAFE ENTRY POINTS
// ═════════════════════════════════════════════════════════════════════════════

test('resolveAndBuildSell resolves, quotes, guards and builds in one call', async () => {
  const deps = fakeChain({ quote: rate(1n, 10n ** 15n) }); // 1e21 in -> 1e6 out
  const res = await poolswap.resolveAndBuildSell(
    { token: TOKEN, tokensIn: 10n ** 21n, slippageBps: 100, recipient: REAL_SELLER, deadline: 999n },
    deps
  );
  assert.equal(res.pool.poolId, POOL_ID);
  assert.equal(res.expectedOut, 1_000_000n);
  assert.equal(res.minOut, 990_000n);
  assert.equal(res.to.toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(res.approvals.length, 2);
  const s = decodeSwapParam(decodeExecute(res.data).params[0]);
  assert.equal(poolIdOf(s.poolKey), POOL_ID, 'built against the VERIFIED pool');
  assert.equal(s.amountOutMinimum, 990_000n, 'the resolved floor rides in the calldata');
});

test('resolveAndBuildBuy does the same in the other direction', async () => {
  const deps = fakeChain({
    launch: launchTuple({ token: NATIVE_TOKEN, curve: NATIVE_CURVE, pairToken: NATIVE }),
    livePoolId: NATIVE_POOL_ID,
    quote: rate(1n, 5n * 10n ** 9n), // 1e16 in -> 2e6 out
  });
  const res = await poolswap.resolveAndBuildBuy(
    { token: NATIVE_TOKEN, amountIn: 10n ** 16n, slippageBps: 50, recipient: REAL_SELLER, deadline: 999n },
    deps
  );
  assert.equal(res.pool.poolId, NATIVE_POOL_ID);
  assert.equal(res.minOut, 1_990_000n);
  assert.equal(res.value, 10n ** 16n);
  assert.equal(res.approvals, undefined);
});

test('a safe entry point never builds when the pool cannot be resolved', async () => {
  const deps = fakeChain({ launch: launchTuple({ phase: 0 }) });
  await assert.rejects(
    poolswap.resolveAndBuildSell({ token: TOKEN, tokensIn: 10n ** 21n, recipient: REAL_SELLER, deadline: 9n }, deps),
    /has NOT graduated/
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. THE VENUE ADDRESSES
// ═════════════════════════════════════════════════════════════════════════════

test('the V4 singletons are the chain-wide ones a real pons swap actually used', () => {
  // Verified live, not assumed: StateView.poolManager(), V4Quoter.poolManager()
  // and the pons meme hook's own poolManager() all return this PoolManager, and
  // the real confirmed pons V4 swap went to this UniversalRouter.
  assert.equal(poolswap.UNIVERSAL_ROUTER(), UNIVERSAL_ROUTER);
  assert.equal(norm(poolswap._private.V4_ADDRESSES.poolManager), norm('0x8366a39CC670B4001A1121B8F6A443A643e40951'));
  assert.equal(norm(poolswap._private.V4_ADDRESSES.quoter), norm('0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94'));
  assert.equal(norm(poolswap._private.V4_ADDRESSES.stateView), norm('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b'));
  assert.equal(norm(poolswap._private.V4_ADDRESSES.permit2), PERMIT2);
});

test('every venue address is overridable through deps (nothing is hard-wired)', async () => {
  const otherRouter = norm('0x00000000000000000000000000000000000000a1');
  const otherPermit2 = norm('0x00000000000000000000000000000000000000a2');
  const deps = { ...fakeChain(), universalRouter: otherRouter, permit2: otherPermit2 };
  const pool = await poolswap.resolvePonsPool({ token: TOKEN }, deps);
  const tx = poolswap.buildSellToPair({ pool, tokensIn: 10n, minOut: 1n, recipient: REAL_SELLER, deadline: 9n }, deps);
  assert.equal(tx.to, otherRouter);
  assert.equal(tx.approvals[1].to, otherPermit2);
});
