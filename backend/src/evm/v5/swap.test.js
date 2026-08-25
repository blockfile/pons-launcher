'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Fund-safety tests for the letscash V4 swap client. Every assertion is anchored
// to something REAL on Robinhood Chain (id 4663), captured once and pinned here
// so the suite runs fully offline (no provider) and stays reproducible:
//
//   • poolId       — reproduces the on-chain poolId of the real CRYINGCAT pool
//                    (0x9712…d4b0) from PoolKey, proving the key (and the HOOK)
//                    is exact. Also proves the config hook is the WRONG hook for
//                    that pool, which is the whole reason resolvePoolKey exists.
//   • BUY calldata — byte-for-byte equals a REAL, successful direct-to-
//                    UniversalRouter V4 buy: tx 0xe6c3d006…1fb2 (this chain).
//   • SELL calldata— byte-for-byte equals a REAL, successful direct-to-router
//                    V4 sell: tx 0xe73ba6ce…c432 (this chain).
//   • full-fill    — the CRYINGCAT buy is a single V4_SWAP, exact-IN, no SWEEP:
//                    the whole input is consumed, so the CashCat hook's
//                    PartialFill/EmptyFill rejection can never trip on shape.
//   • quotes       — minOut = expectedOut·(1−slippage); direction (zeroForOne)
//                    is opposite for buy vs sell; the V4Quoter four-field param
//                    is used (no sqrtPriceLimit).
//   • resolvePoolKey — with StateView faked, picks the one hook whose pool is
//                    initialised, and refuses when none is.
//
// The two real txs are on a NON-letscash pool (a plain hook-less V4 pool). That
// is deliberate and sufficient: they prove the UniversalRouter + V4-action ABI
// encoding — including the older six-field ExactInputSingleParams this router
// still uses — which is the only thing calldata bytes CAN prove. The letscash-
// SPECIFIC correctness (right pool, right hook, actually fills) is proven by the
// poolId reproduction here plus a live eth_call of the exact CRYINGCAT buy bytes
// against forked state (recorded in the fund-safety handoff): a reasonable minOut
// fills, an impossible one reverts. No direct-to-router letscash tx exists to
// byte-match — the letscash UI wraps the router in an unverified helper contract.
// ─────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const { AbiCoder, Interface, getAddress, keccak256 } = require('ethers');

const swap = require('./swap');

const coder = AbiCoder.defaultAbiCoder();
const norm = (a) => getAddress(String(a).toLowerCase());
const NATIVE = '0x0000000000000000000000000000000000000000';

// The canonical UniversalRouter, PROPERLY checksummed. Note the config stores it
// as 0x8876…904 which is NOT valid EIP-55; the module normalises from lower-case.
const UNIVERSAL_ROUTER = getAddress('0x8876789976deCBFcbbBe364623c63652DB8c0904'.toLowerCase());

// ── Real CRYINGCAT pool (letscash) ───────────────────────────────────────────
const CRYINGCAT = norm('0x4F0d7ea112547Af5dAD59959d98B6A8ee3355Bcc');
const CRYINGCAT_POOL_ID = '0x9712563efdedc1a39b0baa30135b21167b2277fd9c694f8057f5ab8b5d18d4b0';
const CASHCAT_HOOK = norm('0xEfe669814e5Eec33406Bd50ffa8331618D076aEc'); // real hook
const CONFIG_HOOK = norm('0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC'); // NOT this pool's

// ── The two real direct-to-router V4 txs we reproduce byte-for-byte ──────────
// Generic (hook-less) V4 pool used by both real txs.
const GEN_TOKEN = norm('0x071E9F718398fB555aa9Ef05CFae0130Bd331720');
const GEN_KEY = {
  currency0: NATIVE,
  currency1: GEN_TOKEN,
  fee: 2500,
  tickSpacing: 25,
  hooks: NATIVE,
};

// tx 0xe6c3d006cab472bcd505775b6dfaece938012bf45e1c726dd4836e6a96291fb2 (BUY)
const REAL_BUY = {
  recipient: norm('0xB5dce978E19673FB0f473587cCc87015ad79dB98'),
  amountIn: 50000000000000000n,
  minOut: 1500485188969850025736676n,
  deadline: 1787623728n,
  value: 50000000000000000n,
  data:
    '0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006a8cf930000000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060b0e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000071e9f718398fb555aa9ef05cfae0130bd33172000000000000000000000000000000000000000000000000000000000000009c400000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000b1a2bc2ec50000000000000000000000000000000000000000000000013dbd770fb0d461fef9e400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000071e9f718398fb555aa9ef05cfae0130bd331720000000000000000000000000b5dce978e19673fb0f473587ccc87015ad79db980000000000000000000000000000000000000000000000000000000000000000',
};

// tx 0xe73ba6ce11111a943c11a97976f53b1836ae9fb7a56abb18e3345c1ed993c432 (SELL)
const REAL_SELL = {
  recipient: norm('0x8DBa9C173E37019b04f28f418733CB6324D0797B'),
  tokensIn: 646256721272013849066561n,
  minOut: 13851605620787280n,
  deadline: 1787623724n,
  data:
    '0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006a8cf92c000000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060b0e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000071e9f718398fb555aa9ef05cfae0130bd33172000000000000000000000000000000000000000000000000000000000000009c40000000000000000000000000000000000000000000000000000000000000019000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000088d9a5a5ae0a67a77c41000000000000000000000000000000000000000000000000003135f6409888500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000071e9f718398fb555aa9ef05cfae0130bd33172000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008dba9c173e37019b04f28f418733cb6324d0797b0000000000000000000000000000000000000000000000000000000000000000',
};

// A deps that supplies stable addresses but NO provider (offline).
const OFFLINE = { provider: null };

// ─────────────────────────────────────────────────────────────────────────────
test('poolId reproduces the real CRYINGCAT pool (proves PoolKey + hook)', () => {
  const { poolKey, poolId, quoteIsCurrency0 } = swap.poolKeyFor(
    { token: CRYINGCAT, quote: NATIVE, hook: CASHCAT_HOOK },
    OFFLINE
  );
  assert.equal(poolId, CRYINGCAT_POOL_ID, 'poolId must match the on-chain pool');
  // Native ETH is address(0), always currency0.
  assert.equal(poolKey.currency0, NATIVE);
  assert.equal(poolKey.currency1, CRYINGCAT);
  assert.equal(poolKey.fee, 0);
  assert.equal(poolKey.tickSpacing, 200);
  assert.equal(poolKey.hooks, CASHCAT_HOOK);
  assert.equal(quoteIsCurrency0, true);
});

test('the config hook is NOT the CRYINGCAT pool hook (per-pool hook is real)', () => {
  const { poolId } = swap.poolKeyFor({ token: CRYINGCAT, quote: NATIVE, hook: CONFIG_HOOK }, OFFLINE);
  assert.notEqual(
    poolId,
    CRYINGCAT_POOL_ID,
    'a swap built with the default/config hook would target a non-existent pool'
  );
});

// ── Fund-safety guards: the wrong-hook footgun is closed ─────────────────────
test('poolKeyFor REFUSES to fall back to the config hook (must be explicit)', () => {
  assert.throws(
    () => swap.poolKeyFor({ token: CRYINGCAT, quote: NATIVE }, OFFLINE),
    /explicit hook is required/,
    'without a verified hook there is no PoolKey — no silent config default'
  );
});

test('buildBuyTx / buildSellTx refuse to build without a verified pool', () => {
  assert.throws(
    () => swap.buildBuyTx({ token: CRYINGCAT, quote: NATIVE, amountInWei: 1n, minOut: 1n, recipient: REAL_BUY.recipient, deadline: 1n }, OFFLINE),
    /verified pool is required/,
    'a buy with neither poolKey nor hook cannot be built'
  );
  assert.throws(
    () => swap.buildSellTx({ token: CRYINGCAT, quote: NATIVE, tokensInWei: 1n, recipient: REAL_SELL.recipient, deadline: 1n }, OFFLINE),
    /verified pool is required/,
    'a sell with neither poolKey nor hook cannot be built'
  );
});

test('buildBuyTx refuses a non-positive minOut (a buy with no floor)', () => {
  for (const minOut of [undefined, 0n, -1n]) {
    assert.throws(
      () => swap.buildBuyTx({ token: CRYINGCAT, quote: NATIVE, amountInWei: 10n ** 16n, minOut, recipient: REAL_BUY.recipient, deadline: 1n, hook: CASHCAT_HOOK }, OFFLINE),
      /minOut must be positive/,
      `minOut=${minOut} must be rejected`
    );
  }
});

test('poolId matches abi.encode(PoolKey) recomputed independently', () => {
  const { poolKey, poolId } = swap.poolKeyFor(
    { token: CRYINGCAT, quote: NATIVE, hook: CASHCAT_HOOK },
    OFFLINE
  );
  const independent = keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  );
  assert.equal(independent, poolId);
});

// ─────────────────────────────────────────────────────────────────────────────
test('buildBuyTx encodes byte-for-byte equal to a real UniversalRouter buy', () => {
  const tx = swap.buildBuyTx(
    {
      token: GEN_TOKEN,
      quote: NATIVE,
      amountInWei: REAL_BUY.amountIn,
      minOut: REAL_BUY.minOut,
      recipient: REAL_BUY.recipient,
      deadline: REAL_BUY.deadline,
      poolKey: GEN_KEY, // exact key of the real tx's pool
    },
    OFFLINE
  );
  assert.equal(tx.to.toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(tx.data.toLowerCase(), REAL_BUY.data.toLowerCase(), 'BUY calldata must be identical');
  assert.equal(tx.value, REAL_BUY.value, 'native buy value = amountIn (no dust, no SWEEP)');
  assert.equal(tx.approvals, undefined, 'a native-ETH buy needs no Permit2 approval');
});

test('buildSellTx encodes byte-for-byte equal to a real UniversalRouter sell', () => {
  const tx = swap.buildSellTx(
    {
      token: GEN_TOKEN,
      quote: NATIVE,
      tokensInWei: REAL_SELL.tokensIn,
      minOut: REAL_SELL.minOut,
      recipient: REAL_SELL.recipient,
      deadline: REAL_SELL.deadline,
      poolKey: GEN_KEY,
    },
    OFFLINE
  );
  assert.equal(tx.to.toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(tx.data.toLowerCase(), REAL_SELL.data.toLowerCase(), 'SELL calldata must be identical');
  assert.equal(tx.value, 0n, 'a token sell carries no native value');
});

test('buildSellTx returns the Permit2 approval steps the sell requires', () => {
  const tx = swap.buildSellTx(
    {
      token: CRYINGCAT,
      quote: NATIVE,
      tokensInWei: 1000n * 10n ** 18n,
      recipient: REAL_SELL.recipient,
      deadline: REAL_SELL.deadline,
      hook: CASHCAT_HOOK,
    },
    OFFLINE
  );
  assert.ok(Array.isArray(tx.approvals) && tx.approvals.length === 2);
  const [erc20Approve, permit2Approve] = tx.approvals;
  // 1. token.approve(Permit2, max)
  assert.equal(erc20Approve.label, 'erc20-approve-permit2');
  assert.equal(erc20Approve.to.toLowerCase(), CRYINGCAT.toLowerCase());
  const erc20Iface = new Interface(['function approve(address,uint256)']);
  const a1 = erc20Iface.decodeFunctionData('approve', erc20Approve.data);
  assert.equal(a1[0].toLowerCase(), '0x000000000022D473030F116dDEE9F6B43aC78BA3'.toLowerCase());
  // 2. Permit2.approve(token, UniversalRouter, ...)
  assert.equal(permit2Approve.label, 'permit2-approve-router');
  assert.equal(permit2Approve.to.toLowerCase(), '0x000000000022D473030F116dDEE9F6B43aC78BA3'.toLowerCase());
  const p2Iface = new Interface(['function approve(address,address,uint160,uint48)']);
  const a2 = p2Iface.decodeFunctionData('approve', permit2Approve.data);
  assert.equal(a2[0].toLowerCase(), CRYINGCAT.toLowerCase());
  assert.equal(a2[1].toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
});

// ─────────────────────────────────────────────────────────────────────────────
// Decode a built execute() back into its command / action / param structure.
function decodeExecute(data) {
  const iface = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
  const [commands, inputs, deadline] = iface.decodeFunctionData('execute', data);
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const EXACT = swap.EXACT_IN_SINGLE_T;
  const s = coder.decode([EXACT], params[0])[0];
  const settle = coder.decode(['address', 'uint256', 'bool'], params[1]);
  const take = coder.decode(['address', 'address', 'uint256'], params[2]);
  return { commands, inputsLen: inputs.length, deadline, actions, swap: s, settle, take };
}

test('CRYINGCAT buy is a single exact-IN full fill (honours PartialFill/EmptyFill)', () => {
  const amountIn = 10n ** 16n; // 0.01 ETH
  const tx = swap.buildBuyTx(
    {
      token: CRYINGCAT,
      quote: NATIVE,
      amountInWei: amountIn,
      minOut: 123n,
      recipient: REAL_BUY.recipient,
      deadline: 999n,
      hook: CASHCAT_HOOK,
    },
    OFFLINE
  );
  const d = decodeExecute(tx.data);

  // ONE command, and it is V4_SWAP (0x10) — no SWEEP appended (msg.value exact).
  assert.equal(d.commands.toLowerCase(), '0x10');
  assert.equal(d.inputsLen, 1);

  // Actions are exactly SWAP_EXACT_IN_SINGLE, SETTLE, TAKE.
  const expectedActions =
    '0x' +
    [swap.ACTION_SWAP_EXACT_IN_SINGLE, swap.ACTION_SETTLE, swap.ACTION_TAKE]
      .map((a) => a.toString(16).padStart(2, '0'))
      .join('');
  assert.equal(d.actions.toLowerCase(), expectedActions);

  // The swap carries the real pool key (its poolId must reproduce CRYINGCAT).
  const pid = keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [
        d.swap.poolKey.currency0,
        d.swap.poolKey.currency1,
        d.swap.poolKey.fee,
        d.swap.poolKey.tickSpacing,
        d.swap.poolKey.hooks,
      ]
    )
  );
  assert.equal(pid, CRYINGCAT_POOL_ID);

  // Exact-IN full fill: the WHOLE input is the swap amount, zeroForOne=true
  // (ETH→token), no explicit price bound, empty hookData.
  assert.equal(d.swap.zeroForOne, true);
  assert.equal(d.swap.amountIn, amountIn, 'the full input is consumed — a full fill');
  assert.equal(d.swap.amountOutMinimum, 123n);
  assert.equal(d.swap.sqrtPriceLimitX96, 0n);
  assert.equal(d.swap.hookData, '0x');

  // SETTLE the native input (payer = router, since ETH rode along as msg.value),
  // TAKE the token to the recipient. Both amounts are the OPEN_DELTA sentinel (0).
  assert.equal(d.settle[0], NATIVE);
  assert.equal(d.settle[1], swap.OPEN_DELTA);
  assert.equal(d.settle[2], false);
  assert.equal(d.take[0].toLowerCase(), CRYINGCAT.toLowerCase());
  assert.equal(d.take[1].toLowerCase(), REAL_BUY.recipient.toLowerCase());
  assert.equal(d.take[2], swap.OPEN_DELTA);

  assert.equal(tx.value, amountIn);
});

test('CRYINGCAT sell flips direction and pulls the token from the seller', () => {
  const tokensIn = 5n * 10n ** 18n;
  const tx = swap.buildSellTx(
    { token: CRYINGCAT, quote: NATIVE, tokensInWei: tokensIn, recipient: REAL_SELL.recipient, deadline: 999n, hook: CASHCAT_HOOK },
    OFFLINE
  );
  const d = decodeExecute(tx.data);
  assert.equal(d.swap.zeroForOne, false, 'sell is token→ETH, the opposite direction');
  assert.equal(d.swap.amountIn, tokensIn);
  assert.equal(d.swap.amountOutMinimum, 0n, 'default sell has NO floor (mirrors pons sell path)');
  // SETTLE the token, payer = the user (Permit2 pull); TAKE native ETH out.
  assert.equal(d.settle[0].toLowerCase(), CRYINGCAT.toLowerCase());
  assert.equal(d.settle[2], true);
  assert.equal(d.take[0], NATIVE);
  assert.equal(tx.value, 0n);
});

// ─────────────────────────────────────────────────────────────────────────────
// USDG (ERC-20 quote) ordering. Uniswap V4 requires currency0 < currency1, so
// which side USDG lands on depends purely on the numeric address comparison.
const USDG = norm('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');

test('USDG ordering: token numerically below USDG ⇒ token is currency0', () => {
  const lowToken = '0x0000000000000000000000000000000000000001';
  const { poolKey, quoteIsCurrency0 } = swap.poolKeyFor({ token: lowToken, quote: USDG, hook: CASHCAT_HOOK }, OFFLINE);
  assert.equal(poolKey.currency0.toLowerCase(), lowToken);
  assert.equal(poolKey.currency1.toLowerCase(), USDG.toLowerCase());
  assert.equal(quoteIsCurrency0, false);
});

test('USDG ordering: token numerically above USDG ⇒ USDG is currency0', () => {
  const highToken = '0xffffffffffffffffffffffffffffffffffffffff';
  const { poolKey, quoteIsCurrency0 } = swap.poolKeyFor({ token: highToken, quote: USDG, hook: CASHCAT_HOOK }, OFFLINE);
  assert.equal(poolKey.currency0.toLowerCase(), USDG.toLowerCase());
  assert.equal(poolKey.currency1.toLowerCase(), highToken);
  assert.equal(quoteIsCurrency0, true);
});

test('USDG buy is an ERC-20-in swap: value 0 + Permit2 approvals for USDG', () => {
  // Use a token above USDG so ordering is deterministic; hook explicit.
  const highToken = '0xffffffffffffffffffffffffffffffffffffffff';
  const tx = swap.buildBuyTx(
    { token: highToken, quote: USDG, amountInWei: 1_000_000n, minOut: 1n, recipient: REAL_BUY.recipient, deadline: 1n, hook: CASHCAT_HOOK },
    OFFLINE
  );
  assert.equal(tx.value, 0n, 'a USDG buy sends no native value');
  assert.ok(Array.isArray(tx.approvals) && tx.approvals.length === 2, 'USDG must be approved via Permit2');
  assert.equal(tx.approvals[0].to.toLowerCase(), USDG.toLowerCase());
  const d = decodeExecute(tx.data);
  assert.equal(d.settle[0].toLowerCase(), USDG.toLowerCase());
  assert.equal(d.settle[2], true, 'USDG is pulled from the user (payerIsUser=true)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Quotes, with a fake provider that answers only the V4Quoter eth_call.
function fakeQuoterProvider(amountOut, captured) {
  const iface = new Interface([`function quoteExactInputSingle(${swap.QUOTE_EXACT_SINGLE_T} params) returns (uint256 amountOut, uint256 gasEstimate)`]);
  return {
    async call(txReq) {
      if (captured) captured.push(txReq);
      // Decode to expose zeroForOne to the test.
      const decoded = iface.decodeFunctionData('quoteExactInputSingle', txReq.data);
      if (captured) captured[captured.length - 1].zeroForOne = decoded[0].zeroForOne;
      return iface.encodeFunctionResult('quoteExactInputSingle', [amountOut, 84000n]);
    },
  };
}

test('quoteBuy applies slippage and quotes in the buy direction (zeroForOne=true for ETH)', async () => {
  const captured = [];
  const provider = fakeQuoterProvider(1000n, captured);
  const { expectedOut, minOut } = await swap.quoteBuy(
    { token: CRYINGCAT, quote: NATIVE, amountInWei: 10n ** 16n, slippageBps: 500, hook: CASHCAT_HOOK },
    { provider }
  );
  assert.equal(expectedOut, 1000n);
  assert.equal(minOut, 950n, 'minOut = expectedOut · (1 − 5%)');
  assert.equal(captured[0].zeroForOne, true, 'buy of an ETH pool is zeroForOne');
});

test('quoteSell defaults to no floor and quotes in the sell direction (zeroForOne=false)', async () => {
  const captured = [];
  const provider = fakeQuoterProvider(2000n, captured);
  const { expectedOut, minOut } = await swap.quoteSell(
    { token: CRYINGCAT, quote: NATIVE, tokensInWei: 10n ** 18n, hook: CASHCAT_HOOK },
    { provider }
  );
  assert.equal(expectedOut, 2000n);
  assert.equal(minOut, 2000n, 'no slippage floor by default');
  assert.equal(captured[0].zeroForOne, false, 'sell of an ETH pool is oneForZero');
});

test('applySlippage floors correctly and treats 0 bps as no floor', () => {
  assert.equal(swap.applySlippage(1000n, 0), 1000n);
  assert.equal(swap.applySlippage(1000n, 100), 990n);
  assert.equal(swap.applySlippage(999n, 50), 994n); // floor(999·9950/10000)=floor(994.005)
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePoolKey with a fake StateView: only the CashCat hook's pool is live.
function fakeStateViewProvider(livePoolId) {
  const iface = new Interface([
    'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
    'function getLiquidity(bytes32) view returns (uint128)',
  ]);
  return {
    async call(txReq) {
      const fn = iface.parseTransaction({ data: txReq.data });
      const poolId = fn.args[0];
      if (fn.name === 'getSlot0') {
        const live = poolId.toLowerCase() === livePoolId.toLowerCase();
        return iface.encodeFunctionResult('getSlot0', [live ? 123456789n : 0n, 0, 0, 0]);
      }
      return iface.encodeFunctionResult('getLiquidity', [poolId.toLowerCase() === livePoolId.toLowerCase() ? 10n ** 20n : 0n]);
    },
  };
}

test('resolvePoolKey picks the hook whose pool StateView reports initialised', async () => {
  const provider = fakeStateViewProvider(CRYINGCAT_POOL_ID);
  // Candidate list puts the WRONG (config) hook first; resolve must skip it.
  const res = await swap.resolvePoolKey(
    { token: CRYINGCAT, quote: NATIVE },
    { provider, candidateHooks: [CONFIG_HOOK, CASHCAT_HOOK] }
  );
  assert.equal(res.hook.toLowerCase(), CASHCAT_HOOK.toLowerCase());
  assert.equal(res.poolId, CRYINGCAT_POOL_ID);
  assert.ok(res.liquidity > 0n);
});

test('resolvePoolKey throws when no candidate hook has a live pool', async () => {
  const provider = fakeStateViewProvider('0x' + 'ff'.repeat(32)); // nothing matches
  await assert.rejects(
    swap.resolvePoolKey({ token: CRYINGCAT, quote: NATIVE }, { provider, candidateHooks: [CONFIG_HOOK, CASHCAT_HOOK] }),
    /No initialised letscash pool/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The SAFE entry points: resolveAndBuildBuy / resolveAndBuildSell. One provider
// answers BOTH the StateView probe (which hook is live) AND the V4Quoter call.
function fakeChainProvider(livePoolId, amountOut) {
  const sv = new Interface([
    'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
    'function getLiquidity(bytes32) view returns (uint128)',
  ]);
  const q = new Interface([
    `function quoteExactInputSingle(${swap.QUOTE_EXACT_SINGLE_T} params) returns (uint256 amountOut, uint256 gasEstimate)`,
  ]);
  return {
    async call(txReq) {
      // Dispatch by selector: StateView reads vs. the Quoter.
      const sel = txReq.data.slice(0, 10);
      if (sel === sv.getFunction('getSlot0').selector) {
        const [poolId] = sv.decodeFunctionData('getSlot0', txReq.data);
        const live = poolId.toLowerCase() === livePoolId.toLowerCase();
        return sv.encodeFunctionResult('getSlot0', [live ? 123456789n : 0n, 0, 0, 0]);
      }
      if (sel === sv.getFunction('getLiquidity').selector) {
        const [poolId] = sv.decodeFunctionData('getLiquidity', txReq.data);
        const live = poolId.toLowerCase() === livePoolId.toLowerCase();
        return sv.encodeFunctionResult('getLiquidity', [live ? 10n ** 20n : 0n]);
      }
      // The Quoter.
      return q.encodeFunctionResult('quoteExactInputSingle', [amountOut, 84000n]);
    },
  };
}

test('resolveAndBuildBuy resolves the live hook, quotes, and builds against it', async () => {
  const provider = fakeChainProvider(CRYINGCAT_POOL_ID, 1_000_000n);
  const res = await swap.resolveAndBuildBuy(
    { token: CRYINGCAT, quote: NATIVE, amountInWei: 10n ** 16n, slippageBps: 100, recipient: REAL_BUY.recipient, deadline: 999n },
    { provider, candidateHooks: [CONFIG_HOOK, CASHCAT_HOOK] }
  );
  // Built against the RESOLVED (real) hook, not the config default.
  assert.equal(res.hook.toLowerCase(), CASHCAT_HOOK.toLowerCase());
  assert.equal(res.poolKey.hooks.toLowerCase(), CASHCAT_HOOK.toLowerCase());
  assert.equal(res.expectedOut, 1_000_000n);
  assert.equal(res.minOut, 990_000n, 'minOut = expectedOut · (1 − 1%)');
  assert.equal(res.value, 10n ** 16n, 'native buy value = amountIn');
  // The calldata carries the resolved pool.
  const d = decodeExecute(res.data);
  const pid = keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [d.swap.poolKey.currency0, d.swap.poolKey.currency1, d.swap.poolKey.fee, d.swap.poolKey.tickSpacing, d.swap.poolKey.hooks]
    )
  );
  assert.equal(pid, CRYINGCAT_POOL_ID, 'buy targets the verified pool');
  assert.equal(d.swap.amountOutMinimum, 990_000n, 'the resolved floor rides in the calldata');
});

test('resolveAndBuildBuy refuses when the quote returns zero output', async () => {
  const provider = fakeChainProvider(CRYINGCAT_POOL_ID, 0n);
  await assert.rejects(
    swap.resolveAndBuildBuy(
      { token: CRYINGCAT, quote: NATIVE, amountInWei: 10n ** 16n, recipient: REAL_BUY.recipient, deadline: 1n },
      { provider, candidateHooks: [CASHCAT_HOOK] }
    ),
    /no output|no price protection/
  );
});

test('resolveAndBuildBuy propagates the no-live-pool error (never builds blind)', async () => {
  const provider = fakeChainProvider('0x' + 'ff'.repeat(32), 1_000_000n);
  await assert.rejects(
    swap.resolveAndBuildBuy(
      { token: CRYINGCAT, quote: NATIVE, amountInWei: 10n ** 16n, recipient: REAL_BUY.recipient, deadline: 1n },
      { provider, candidateHooks: [CONFIG_HOOK, CASHCAT_HOOK] }
    ),
    /No initialised letscash pool/
  );
});

test('resolveAndBuildSell resolves the live hook and builds a token→ETH sell', async () => {
  const provider = fakeChainProvider(CRYINGCAT_POOL_ID, 5n);
  const res = await swap.resolveAndBuildSell(
    { token: CRYINGCAT, quote: NATIVE, tokensInWei: 5n * 10n ** 18n, recipient: REAL_SELL.recipient, deadline: 999n },
    { provider, candidateHooks: [CONFIG_HOOK, CASHCAT_HOOK] }
  );
  assert.equal(res.hook.toLowerCase(), CASHCAT_HOOK.toLowerCase());
  assert.equal(res.minOut, 0n, 'default sell keeps the pons no-floor behaviour');
  assert.equal(res.value, 0n);
  assert.ok(Array.isArray(res.approvals) && res.approvals.length === 2, 'a sell carries its Permit2 approvals');
  const d = decodeExecute(res.data);
  assert.equal(d.swap.zeroForOne, false, 'sell is token→ETH');
});
