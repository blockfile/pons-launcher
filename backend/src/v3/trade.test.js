'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const trade = require('./trade');

const WALLET = { id: 'main', role: 'v3main', address: '0x1111111111111111111111111111111111111111' };
const CURVE = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const FEES = { type: 2, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1n };

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

/**
 * A curve, an ERC-20, a keystore and a provider, all fake.
 *
 * `balances` is walked forward by the fake sends, so a balance delta measured
 * by the module under test is measuring something that actually moved.
 */
function harness({
  ethBalances = { [WALLET.address]: parseEther('10') },
  tokenBalances = { [WALLET.address]: TOKENS(1000) },
  sellRevert = false,
  gasUsed = 100_000n,
} = {}) {
  const sent = [];
  const receipts = new Map();
  const eth = { ...ethBalances };
  const tok = { ...tokenBalances };

  function receiptFor(hash, ok = true) {
    return { status: ok ? 1 : 0, blockNumber: 4242, gasUsed, effectiveGasPrice: 1_000_000_000n, hash };
  }

  const deps = {
    rpc: {
      getBalance: async (a) => eth[a] ?? 0n,
      getTransactionCount: async () => 11,
    },
    keystore: {
      signer: () => ({
        sendTransaction: async (tx) => {
          const hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}`;
          sent.push({ ...tx, hash });
          const gasFee = gasUsed * 1_000_000_000n;

          if (tx.__kind === 'buy') {
            eth[WALLET.address] -= tx.value + gasFee;
            tok[WALLET.address] = (tok[WALLET.address] ?? 0n) + TOKENS(500);
            receipts.set(hash, receiptFor(hash));
          } else if (tx.__kind === 'sell') {
            if (!sellRevert) {
              eth[WALLET.address] += parseEther('1');
              tok[WALLET.address] -= tx.__tokensIn;
            }
            eth[WALLET.address] -= gasFee;
            receipts.set(hash, receiptFor(hash, !sellRevert));
          } else {
            eth[WALLET.address] -= gasFee;
            receipts.set(hash, receiptFor(hash));
          }
          return { hash };
        },
      }),
    },
    // populateTransaction stamps __kind so the fake signer above can model the
    // effect of each call; real ethers never sees these fields.
    curve: () => ({
      buy: {
        populateTransaction: async (amountIn, minOut, recipient, overrides) => ({
          to: CURVE,
          data: '0xbuy',
          value: overrides.value,
          __kind: 'buy',
          __args: { amountIn, minOut, recipient },
        }),
      },
      sell: {
        populateTransaction: async (tokensIn, minOut, recipient) => ({
          to: CURVE,
          data: '0xsell',
          __kind: 'sell',
          __tokensIn: tokensIn,
          __args: { tokensIn, minOut, recipient },
        }),
      },
      token: async () => TOKEN,
      isNativeQuote: async () => true,
      getReserves: async () => [parseEther('40'), TOKENS(800_000_000)],
      feeBps: async () => 100n,
      creatorTaxBps: async () => 100n,
      graduated: async () => false,
      readyToGraduate: async () => false,
      currentSnipeTaxBps: async () => 500n,
      snipeTaxSeconds: async () => 300n,
    }),
    erc20: () => ({
      balanceOf: async (a) => tok[a] ?? 0n,
      approve: {
        populateTransaction: async (spender, amount) => ({
          to: TOKEN,
          data: '0xapprove',
          __kind: 'approve',
          __args: { spender, amount },
        }),
      },
    }),
    waitForReceiptFn: async (_rpc, hash) => receipts.get(hash) || null,
    fees: FEES,
    dryRun: false,
  };

  return { deps, sent, eth, tok };
}

test('a buy sends amountIn as value and asks for no minimum out', async () => {
  const h = harness();
  await trade.buy({ wallet: WALLET, curveAddress: CURVE, amountWei: parseEther('1') }, h.deps);
  const [tx] = h.sent;
  assert.equal(tx.value, parseEther('1'));
  assert.equal(tx.__args.amountIn, parseEther('1'));
  assert.equal(tx.__args.minOut, 0n, 'no slippage floor, by decision');
  assert.equal(tx.__args.recipient, WALLET.address, 'the buyer receives its own tokens');
});

test('a buy reports the tokens it actually received, as a balance delta', async () => {
  const h = harness();
  const out = await trade.buy({ wallet: WALLET, curveAddress: CURVE, amountWei: parseEther('1') }, h.deps);
  assert.equal(out.status, 'confirmed');
  assert.equal(out.tokensOut, TOKENS(500));
  assert.equal(out.blockNumber, 4242);
});

test('a buy trims its value to fit gas when the balance is tight', async () => {
  // The wallet can afford the gas plus 0.5 ETH of buy, but was ASKED to buy 1 ETH — a fee
  // tick since the caller sized it. The buy must shrink to fit rather than fail to broadcast
  // ("insufficient funds for intrinsic transaction cost").
  const maxGas = BigInt(require('../config').buyGasLimit) * FEES.maxFeePerGas;
  const balance = maxGas + parseEther('0.5');
  const h = harness({ ethBalances: { [WALLET.address]: balance } });
  await trade.buy({ wallet: WALLET, curveAddress: CURVE, amountWei: parseEther('1') }, h.deps);
  const [tx] = h.sent;
  assert.equal(tx.value, balance - maxGas, 'the buy value is trimmed to balance minus its own gas');
  assert.ok(tx.value < parseEther('1'), 'it spent less than asked so value + gas fits the balance');
});

test('a buy that cannot even cover its own gas throws before broadcasting', async () => {
  const maxGas = BigInt(require('../config').buyGasLimit) * FEES.maxFeePerGas;
  const h = harness({ ethBalances: { [WALLET.address]: maxGas - 1n } });
  await assert.rejects(
    trade.buy({ wallet: WALLET, curveAddress: CURVE, amountWei: parseEther('1') }, h.deps),
    /does not cover the buy's own gas/
  );
  assert.equal(h.sent.length, 0, 'nothing was broadcast');
});

test('a sell signs approve and sell at consecutive nonces from the same wallet', async () => {
  const h = harness();
  await trade.sell({ wallet: WALLET, curveAddress: CURVE, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  const [approve, sell] = h.sent;
  assert.equal(approve.__kind, 'approve');
  assert.equal(sell.__kind, 'sell');
  assert.equal(approve.nonce, 11);
  assert.equal(sell.nonce, 12, 'the sequencer runs a wallets transactions in nonce order');
});

test('the approval is for exactly the tokens being sold, never unlimited', async () => {
  const h = harness();
  await trade.sell({ wallet: WALLET, curveAddress: CURVE, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  const [approve] = h.sent;
  assert.equal(approve.__args.amount, TOKENS(100));
  assert.equal(approve.__args.spender, CURVE);
});

test('a sell asks for no minimum out and pays itself', async () => {
  const h = harness();
  await trade.sell({ wallet: WALLET, curveAddress: CURVE, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  const [, sell] = h.sent;
  assert.equal(sell.__args.minOut, 0n);
  assert.equal(sell.__args.recipient, WALLET.address);
});

test('ethReceived is the balance delta with gas added back', async () => {
  // The curve pays 1 ETH and the two transactions burn gas. A naive delta would
  // under-report by the gas; the proceeds are what the curve paid.
  const h = harness();
  const out = await trade.sell(
    { wallet: WALLET, curveAddress: CURVE, token: TOKEN, tokensIn: TOKENS(100) },
    h.deps
  );
  assert.equal(out.status, 'confirmed');
  assert.equal(out.ethReceived, parseEther('1'));
});

test('a reverted sell reports reverted and claims no proceeds', async () => {
  const h = harness({ sellRevert: true });
  const out = await trade.sell(
    { wallet: WALLET, curveAddress: CURVE, token: TOKEN, tokensIn: TOKENS(100) },
    h.deps
  );
  assert.equal(out.status, 'reverted');
  assert.equal(out.ethReceived, 0n, 'a revert that cost gas must never look like income');
});

test('selling more than the wallet holds is refused before anything is signed', async () => {
  const h = harness({ tokenBalances: { [WALLET.address]: TOKENS(50) } });
  await assert.rejects(
    () => trade.sell({ wallet: WALLET, curveAddress: CURVE, token: TOKEN, tokensIn: TOKENS(100) }, h.deps),
    /holds/
  );
  assert.equal(h.sent.length, 0);
});

test('readCurve reports what the engine needs to size and to refuse', async () => {
  const h = harness();
  const out = await trade.readCurve(CURVE, h.deps);
  assert.equal(out.token, TOKEN);
  assert.equal(out.quoteReserve, parseEther('40'));
  assert.equal(out.tokenReserve, TOKENS(800_000_000));
  assert.equal(out.feeBps, 100);
  assert.equal(out.creatorTaxBps, 100);
  assert.equal(out.graduated, false);
  assert.equal(out.readyToGraduate, false);
  assert.equal(out.isNativeQuote, true);
});

test('snipeTax reports what a recipient would pay right now, and for how long', async () => {
  // V3 buys after the launch, so its wallets are NOT on the exemption list the
  // launch declared. If the opening window is still open they pay this.
  const h = harness();
  const out = await trade.snipeTax(CURVE, WALLET.address, h.deps);
  assert.equal(out.bps, 500);
  assert.equal(out.windowSeconds, 300);
});

test('a dry run broadcasts nothing', async () => {
  const h = harness();
  h.deps.dryRun = true;
  const buy = await trade.buy({ wallet: WALLET, curveAddress: CURVE, amountWei: parseEther('1') }, h.deps);
  const sell = await trade.sell(
    { wallet: WALLET, curveAddress: CURVE, token: TOKEN, tokensIn: TOKENS(100) },
    h.deps
  );
  assert.equal(buy.simulated, true);
  assert.equal(sell.simulated, true);
  assert.equal(h.sent.length, 0);
});

test('tokenBalance reads through the injected erc20', async () => {
  const h = harness();
  assert.equal(await trade.tokenBalance(TOKEN, WALLET.address, h.deps), TOKENS(1000));
});
