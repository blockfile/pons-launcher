'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ZeroAddress, getAddress, parseEther, Interface } = require('ethers');

const { prepareSell, APPROVE_GAS, SELL_GAS } = require('./prepareSell');

const DEV = '0x1ada673a00000000000000000000000000000000';
const STRANGER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURVE = '0xca11a000000000000000000000000000000000a1';
// v1: a launch the OLD factory claims, sold through the swap router.
const V1_TOKEN = '0x86d26b51fd707abd05b04084fbb6c1db3708e7de';
const ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const DEX_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';

const W1 = { id: 'w1', address: '0x1111111111111111111111111111111111111111', role: 'bundle' };
const W2 = { id: 'w2', address: '0x2222222222222222222222222222222222222222', role: 'bundle' };

const erc20Iface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const curveIface = new Interface([
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
]);
const routerIface = new Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
]);

function fakeKeystore(wallets = [W1, W2]) {
  const signed = [];
  return {
    signed,
    devWallet: () => ({ id: 'dev', address: getAddress(DEV), role: 'dev' }),
    bundleWallets: () => wallets,
    list: () => [{ id: 'dev', address: getAddress(DEV), role: 'dev' }, ...wallets],
    signer: (id) => ({
      async signTransaction(tx) {
        signed.push({ id, tx });
        return `SIGNED:${id}:${tx.nonce}`;
      },
    }),
  };
}

function fakeProvider({ balances = {}, nonces = {} } = {}) {
  return {
    async getBalance(addr) {
      return balances[getAddress(addr)] ?? parseEther('1');
    },
    async getTransactionCount(addr) {
      return nonces[getAddress(addr)] ?? 5;
    },
  };
}

// Reserves from a real curve; see holdings.test.js for where they came from.
const PRICING = {
  quoteReserve: 1729500000000000000n,
  tokenReserve: 971379011274934952298352125n,
  feeBps: 100,
  creatorTaxBps: 0,
  isNativeQuote: true,
};

function deps(over = {}) {
  return {
    keystore: fakeKeystore(),
    provider: fakeProvider(),
    fees: { type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n },
    dryRun: false,
    describeToken: async (token) => ({
      token: getAddress(token),
      curve: getAddress(CURVE),
      deployer: getAddress(DEV),
      pairToken: ZeroAddress,
      creatorTaxBps: 0,
      phase: 1,
      exists: true,
    }),
    // The v1 registry knows nothing unless a test says otherwise. Injected on
    // every case so no test can reach the network to find that out.
    describeV1Token: async (token) => ({ token: getAddress(token), protocol: 'v1', exists: false }),
    sellRoute: async () => ({
      dexConfig: { swapRouter: ROUTER, poolFee: 10000, factory: DEX_FACTORY },
      launchConfig: { pairToken: WETH, routerRequiresDeadline: false },
    }),
    poolPrice: async () => ({
      pool: '0x5830952895fdb70121b6d0161b13280610305011',
      // The live pool's price for 0x86D26b51…, read off the chain.
      sqrtPriceX96: 2146001890159706666683605869625172n,
      tokenIsToken0: false,
    }),
    curveState: async () => ({ graduated: false, readyToGraduate: false }),
    curvePricing: async () => PRICING,
    tokenMeta: async () => ({ symbol: 'AYE', decimals: 18 }),
    balanceOf: async () => 10n ** 24n,
    chainId: 4663,
    ...over,
  };
}

/** deps() with the token owned by the v1 factory instead of the v2 one. */
function v1Deps(over = {}) {
  return deps({
    describeToken: async (token) => ({ token: getAddress(token), protocol: 'v2', exists: false }),
    describeV1Token: async (token) => ({
      token: getAddress(token),
      protocol: 'v1',
      deployer: getAddress(DEV),
      pairToken: getAddress(WETH),
      poolFee: 10000,
      dexId: 0,
      launchConfigId: 0,
      exists: true,
    }),
    ...over,
  });
}

test('a token the dev wallet did not launch is refused before anything is signed', async () => {
  const ks = fakeKeystore();
  await assert.rejects(
    () =>
      prepareSell(
        { token: TOKEN },
        deps({
          keystore: ks,
          describeToken: async () => ({
            token: getAddress(TOKEN),
            curve: getAddress(CURVE),
            deployer: getAddress(STRANGER),
            pairToken: ZeroAddress,
            phase: 1,
            exists: true,
          }),
        })
      ),
    /was not launched by this dev wallet/
  );
  assert.equal(ks.signed.length, 0, 'nothing may be signed for a token we did not launch');
});

test('a token neither factory has heard of is refused', async () => {
  await assert.rejects(
    () =>
      prepareSell(
        { token: TOKEN },
        deps({ describeToken: async () => ({ token: getAddress(TOKEN), exists: false }) })
      ),
    /is not a pons launch/
  );
});

test('a v1 token the v1 factory says someone else launched is refused before anything is signed', async () => {
  const ks = fakeKeystore();
  await assert.rejects(
    () =>
      prepareSell(
        { token: V1_TOKEN },
        v1Deps({
          keystore: ks,
          describeV1Token: async (token) => ({
            token: getAddress(token),
            protocol: 'v1',
            deployer: getAddress(STRANGER),
            pairToken: getAddress(WETH),
            poolFee: 10000,
            dexId: 0,
            launchConfigId: 0,
            exists: true,
          }),
        })
      ),
    /was not launched by this dev wallet/
  );
  assert.equal(ks.signed.length, 0, 'the v1 gate is the same gate — nothing may be signed');
});

test('a graduated token is refused loudly rather than guessed at', async () => {
  const ks = fakeKeystore();
  await assert.rejects(
    () =>
      prepareSell(
        { token: TOKEN },
        deps({ keystore: ks, curveState: async () => ({ graduated: true, readyToGraduate: true }) })
      ),
    /not yet supported/
  );
  // A wrong Uniswap v4 encoding loses real money; refusing does not.
  assert.equal(ks.signed.length, 0);
});

test('approve and sell take consecutive nonces from the same wallet', async () => {
  const plan = await prepareSell(
    { token: TOKEN },
    deps({
      provider: fakeProvider({
        nonces: { [getAddress(W1.address)]: 7, [getAddress(W2.address)]: 42 },
      }),
    })
  );

  const a = plan.wallets.find((w) => w.walletId === 'w1');
  const b = plan.wallets.find((w) => w.walletId === 'w2');
  assert.equal(a.approve.nonce, 7);
  assert.equal(a.sell.nonce, 8);
  assert.equal(b.approve.nonce, 42);
  assert.equal(b.sell.nonce, 43);
  assert.ok(a.approve.raw && a.sell.raw, 'both are signed at preflight, nothing at fire time');
});

test('the approval is for exactly the balance — no standing allowance is left behind', async () => {
  const ks = fakeKeystore([W1]);
  const balance = 12345n * 10n ** 18n;
  await prepareSell({ token: TOKEN }, deps({ keystore: ks, balanceOf: async () => balance }));

  const approve = ks.signed.find((s) => erc20Iface.parseTransaction({ data: s.tx.data })?.name === 'approve');
  const parsed = erc20Iface.parseTransaction({ data: approve.tx.data });
  assert.equal(getAddress(parsed.args[0]), getAddress(CURVE), 'the spender is the curve, nothing else');
  assert.equal(parsed.args[1], balance);
  assert.equal(getAddress(approve.tx.to), getAddress(TOKEN));
});

test('minQuoteOut is zero — the no-floor decision, asserted so it is not quietly undone', async () => {
  const ks = fakeKeystore([W1]);
  const balance = 999n * 10n ** 18n;
  const plan = await prepareSell(
    { token: TOKEN },
    deps({ keystore: ks, balanceOf: async () => balance })
  );

  const sell = ks.signed.find((s) => curveIface.parseTransaction({ data: s.tx.data })?.name === 'sell');
  const parsed = curveIface.parseTransaction({ data: sell.tx.data });
  assert.equal(parsed.args[0], balance, 'the whole balance — this is all-or-nothing');
  assert.equal(parsed.args[1], 0n, 'NO SLIPPAGE FLOOR. Deliberate. See the design doc.');
  assert.equal(getAddress(parsed.args[2]), getAddress(W1.address), 'proceeds stay in the wallet that sold');
  assert.equal(plan.minQuoteOut, '0');
});

// ── routing: v1 and v2 build different transactions ────────────────────────

test('a v1 token routes to the swap router, not to a curve', async () => {
  const ks = fakeKeystore([W1]);
  const balance = 72915n * 10n ** 18n;
  const plan = await prepareSell(
    { token: V1_TOKEN },
    v1Deps({ keystore: ks, balanceOf: async () => balance })
  );

  assert.equal(plan.protocol, 'v1');
  assert.equal(plan.route, 'swap-router');
  assert.equal(plan.curve, null, 'a v1 launch has no curve');
  assert.equal(getAddress(plan.spender), getAddress(ROUTER));

  // The approval goes to the router — the only contract that needs to move the
  // tokens — and for exactly the balance.
  const approve = ks.signed.find(
    (s) => erc20Iface.parseTransaction({ data: s.tx.data })?.name === 'approve'
  );
  const parsedApprove = erc20Iface.parseTransaction({ data: approve.tx.data });
  assert.equal(getAddress(parsedApprove.args[0]), getAddress(ROUTER));
  assert.equal(parsedApprove.args[1], balance);
  assert.equal(getAddress(approve.tx.to), getAddress(V1_TOKEN));

  // The sell is the buy reversed: swap the whole balance for the pair token,
  // then unwrap it to the wallet that sold, in one transaction.
  const sell = ks.signed.find(
    (s) => routerIface.parseTransaction({ data: s.tx.data })?.name === 'multicall'
  );
  assert.equal(getAddress(sell.tx.to), getAddress(ROUTER));
  const [calls] = routerIface.parseTransaction({ data: sell.tx.data }).args;
  assert.equal(calls.length, 2, 'swap then unwrap');

  const swap = routerIface.decodeFunctionData('exactInputSingle', calls[0])[0];
  assert.equal(getAddress(swap.tokenIn), getAddress(V1_TOKEN));
  assert.equal(getAddress(swap.tokenOut), getAddress(WETH));
  assert.equal(Number(swap.fee), 10000);
  assert.equal(swap.amountIn, balance, 'the whole balance — this is all-or-nothing');
  assert.equal(swap.amountOutMinimum, 0n, 'NO SLIPPAGE FLOOR. Deliberate. See the design doc.');
  assert.equal(
    getAddress(swap.recipient),
    getAddress(ROUTER),
    'the swap pays the router: its output is WETH, and it is unwrapped in the next call. ' +
      'Verified against the live router — address(0) reverts with "TF" on this one.'
  );

  const unwrap = routerIface.decodeFunctionData('unwrapWETH9', calls[1]);
  assert.equal(unwrap[0], 0n, 'no floor on the unwrap either');
  assert.equal(getAddress(unwrap[1]), getAddress(W1.address), 'proceeds stay in the wallet that sold');

  assert.equal(plan.minQuoteOut, '0');
  assert.equal(plan.isNativeQuote, true, 'the WETH is unwrapped, so the wallet ends up with ETH');
});

test('v1 and v2 route to different builders from the same entry point', async () => {
  const v2 = await prepareSell({ token: TOKEN }, deps());
  const v1 = await prepareSell({ token: V1_TOKEN }, v1Deps());

  assert.equal(v2.route, 'curve');
  assert.equal(v1.route, 'swap-router');
  assert.notEqual(getAddress(v2.spender), getAddress(v1.spender));
  // The v2 sell calls the curve; the v1 sell calls the router. Neither shape
  // parses as the other.
  const v2sell = v2.wallets[0].sell;
  const v1sell = v1.wallets[0].sell;
  assert.equal(v2sell.nonce, v2.wallets[0].approve.nonce + 1);
  assert.equal(v1sell.nonce, v1.wallets[0].approve.nonce + 1);
});

test('approve and sell take consecutive nonces on the v1 route too', async () => {
  const plan = await prepareSell(
    { token: V1_TOKEN },
    v1Deps({
      provider: fakeProvider({
        nonces: { [getAddress(W1.address)]: 11, [getAddress(W2.address)]: 90 },
      }),
    })
  );

  const a = plan.wallets.find((w) => w.walletId === 'w1');
  const b = plan.wallets.find((w) => w.walletId === 'w2');
  assert.equal(a.approve.nonce, 11);
  assert.equal(a.sell.nonce, 12);
  assert.equal(b.approve.nonce, 90);
  assert.equal(b.sell.nonce, 91);
  assert.ok(a.approve.raw && a.sell.raw, 'both signed at preflight, nothing at fire time');
});

test('a v1 preflight quotes the pool, and says the number is a ceiling', async () => {
  const plan = await prepareSell(
    { token: V1_TOKEN },
    v1Deps({ keystore: fakeKeystore([W1]), balanceOf: async () => 72915416942227609343587n })
  );

  // The live pool returned 98383459876113 wei for this exact position under
  // eth_call; the spot estimate is 0.007% above it, being impact-free.
  assert.equal(plan.wallets[0].estEthOutRaw, '98390581041968');
  assert.ok(Number(plan.estEthOutTotal) > 0);
  assert.ok(plan.warnings.some((w) => /ceiling/.test(w)));
});

test('a v1 pool that cannot be read gives null estimates and a warning, not a failure', async () => {
  const plan = await prepareSell(
    { token: V1_TOKEN },
    v1Deps({
      poolPrice: async () => {
        throw new Error('no pool');
      },
    })
  );

  assert.equal(plan.wallets.length, 2, 'the sell is still prepared');
  assert.ok(plan.wallets.every((w) => w.estEthOut === null));
  assert.ok(plan.warnings.some((w) => /could not quote/i.test(w)));
});

test('a wallet holding none of the token is skipped, not signed', async () => {
  const ks = fakeKeystore();
  const plan = await prepareSell(
    { token: TOKEN },
    deps({
      keystore: ks,
      balanceOf: async (_t, owner) => (getAddress(owner) === getAddress(W2.address) ? 0n : 10n ** 21n),
    })
  );

  assert.deepEqual(plan.wallets.map((w) => w.walletId), ['w1']);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].walletId, 'w2');
  assert.match(plan.skipped[0].reason, /holds none/);
  assert.ok(plan.warnings.some((w) => /holds none/.test(w)));
  assert.equal(ks.signed.length, 2, 'one approve and one sell, for the one wallet that holds any');
});

test('a wallet that cannot pay for its own gas is skipped and the rest still sign', async () => {
  const plan = await prepareSell(
    { token: TOKEN },
    deps({
      provider: fakeProvider({ balances: { [getAddress(W2.address)]: 1n } }),
    })
  );

  assert.deepEqual(plan.wallets.map((w) => w.walletId), ['w1']);
  assert.match(plan.skipped[0].reason, /does not cover/);
});

test('every wallet holding nothing means there is nothing to do, and it says so', async () => {
  await assert.rejects(
    () => prepareSell({ token: TOKEN }, deps({ balanceOf: async () => 0n })),
    /no bundle wallet holds/
  );
});

test('preflight quotes what each wallet would receive, and the tail fills worse', async () => {
  const plan = await prepareSell({ token: TOKEN }, deps({ balanceOf: async () => 10n ** 24n }));

  const [first, second] = plan.wallets;
  assert.ok(Number(first.estEthOut) > 0, 'an operator arming a floor-less sell must see a number');
  assert.ok(
    Number(second.estEthOut) < Number(first.estEthOut),
    'the second wallet sells into a curve the first already drained'
  );
  assert.ok(Number(plan.estEthOutTotal) > 0);
  // The estimate is order-dependent and the sequencer picks the order.
  assert.ok(plan.warnings.some((w) => /estimate/i.test(w)));
});

test('a curve that cannot be priced gives null estimates and a warning, not a failure', async () => {
  const plan = await prepareSell(
    { token: TOKEN },
    deps({
      curvePricing: async () => {
        throw new Error('execution reverted');
      },
    })
  );

  assert.equal(plan.wallets.length, 2, 'the sell is still prepared');
  assert.ok(plan.wallets.every((w) => w.estEthOut === null));
  assert.equal(plan.estEthOutTotal, null);
  assert.ok(plan.warnings.some((w) => /could not quote/i.test(w)));
});

test('amounts are human decimals, with base units alongside', async () => {
  const plan = await prepareSell(
    { token: TOKEN },
    deps({ balanceOf: async () => 25n * 10n ** 17n })
  );

  assert.equal(plan.wallets[0].tokens, '2.5');
  assert.equal(plan.wallets[0].tokensRaw, (25n * 10n ** 17n).toString());
  assert.equal(plan.totalTokens, '5.0');
  assert.equal(plan.symbol, 'AYE');
  assert.equal(plan.token, getAddress(TOKEN));
});

test('the plan is JSON — a stray BigInt would throw on the way out', async () => {
  const plan = await prepareSell({ token: TOKEN }, deps());
  assert.doesNotThrow(() => JSON.stringify(plan));
  assert.equal(typeof plan.chainId, 'string');
  assert.equal(typeof plan.fees.maxFeePerGas, 'string');
  assert.equal(typeof plan.approveGas, 'string');
});

test('the gas reserve covers both transactions, not just the sell', async () => {
  // A wallet that can pay for the sell but not the approval must not be signed:
  // a broadcast approval that cannot be mined leaves the sell stuck behind it.
  const fees = { type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
  const justUnder = fees.maxFeePerGas * (APPROVE_GAS + SELL_GAS) - 1n;
  const plan = await prepareSell(
    { token: TOKEN },
    deps({
      fees,
      provider: fakeProvider({ balances: { [getAddress(W1.address)]: justUnder } }),
    })
  );

  assert.deepEqual(plan.wallets.map((w) => w.walletId), ['w2']);
});
