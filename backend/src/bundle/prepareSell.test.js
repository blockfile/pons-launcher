'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ZeroAddress, getAddress, parseEther, Interface } = require('ethers');

const { prepareSell, APPROVE_GAS, SELL_GAS } = require('./prepareSell');

const DEV = '0x1ada673a00000000000000000000000000000000';
const STRANGER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURVE = '0xca11a000000000000000000000000000000000a1';

const W1 = { id: 'w1', address: '0x1111111111111111111111111111111111111111', role: 'bundle' };
const W2 = { id: 'w2', address: '0x2222222222222222222222222222222222222222', role: 'bundle' };

const erc20Iface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const curveIface = new Interface([
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
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
    curveState: async () => ({ graduated: false, readyToGraduate: false }),
    curvePricing: async () => PRICING,
    tokenMeta: async () => ({ symbol: 'AYE', decimals: 18 }),
    balanceOf: async () => 10n ** 24n,
    chainId: 4663,
    ...over,
  };
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

test('a token the factory has never heard of is refused', async () => {
  await assert.rejects(
    () =>
      prepareSell(
        { token: TOKEN },
        deps({ describeToken: async () => ({ token: getAddress(TOKEN), exists: false }) })
      ),
    /is not a pons v2 launch/
  );
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
