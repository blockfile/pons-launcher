'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther, getAddress } = require('ethers');

const config = require('../config');
const trade = require('./trade');

// V7 trades a flap BONDING CURVE via the fixed launcher (config.flap.launcher). It wraps
// evm/v7/curve.js (injected as deps.curve), NOT a swap/factory pair — so the fakes below
// stand in for the curve client, the keystore signer, the receipt waiter and the balance
// reader. This is the flap analog of v3/trade.test.js's harness, with the venue swapped
// and the sell reduced to TWO txs (approve + swapExactInput), no Permit2 leg.

const WALLET = { id: 'v7main', role: 'v7main', address: '0x1111111111111111111111111111111111111111' };
const TOKEN = '0x3333333333333333333333333333333333333333';
const IMPL = '0x4444444444444444444444444444444444444444';
const NOT_WNATIVE = '0x00000000000000000000000000000000000000ab';
const FEES = { type: 2, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1n };
const LAUNCHER = getAddress(config.flap.launcher);
const WNATIVE = getAddress(config.flap.wnative);

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

// ── readCurve: the provenance + native-binding + state guard (replaces v6's readPool) ──
//
// readCurve caches the immutable provenance/binding ONLY when no curve/rpc is injected;
// every test injects both, so the guard runs live each call and never touches the cache.

function readDeps({
  prov = { ok: true, impl: IMPL },
  quoteToken = WNATIVE,
  state = 0,
  circulatingSupply = TOKENS(600_000_000),
  dexSupplyThresh = TOKENS(800_000_000),
} = {}) {
  return {
    rpc: {},
    curve: {
      verifyProvenanceByCode: async () => prov,
      quoteTokenOf: async () => quoteToken,
      tokenState: async () => state,
      tokenCurve: async () => ({ circulatingSupply, dexSupplyThresh }),
    },
  };
}

test('readCurve ACCEPTS a genuine native-quoted state-0 clone and reports the curve params', async () => {
  const out = await trade.readCurve({ token: TOKEN }, readDeps());
  assert.equal(out.token, getAddress(TOKEN));
  assert.equal(out.venue, LAUNCHER, 'the fixed flap launcher is the venue — there is no per-token pool');
  assert.equal(out.quote, 'eth');
  assert.equal(out.state, 0);
  assert.equal(out.circulatingSupply, TOKENS(600_000_000));
  assert.equal(out.dexSupplyThresh, TOKENS(800_000_000));
  assert.equal(out.headroomTokens, TOKENS(200_000_000), 'headroom = dexSupplyThresh - circulatingSupply');
});

test('readCurve REJECTS a non-clone (provenance fails) before any approve is trusted', async () => {
  await assert.rejects(
    () => trade.readCurve({ token: TOKEN }, readDeps({ prov: { ok: false, reason: 'not an EIP-1167 clone' } })),
    /not a flap launch/
  );
});

test('readCurve REJECTS a token whose quoteToken is not WNATIVE (the relay chain must stay native)', async () => {
  await assert.rejects(
    () => trade.readCurve({ token: TOKEN }, readDeps({ quoteToken: getAddress(NOT_WNATIVE) })),
    /not WNATIVE/
  );
});

test('readCurve REJECTS a graduated token (state != BondingCurve)', async () => {
  await assert.rejects(
    () => trade.readCurve({ token: TOKEN }, readDeps({ state: 2 })),
    /BondingCurve/
  );
});

test('readPool is an ALIAS of readCurve so engine/exit/routes cloned from v6 bind unchanged', () => {
  assert.equal(trade.readPool, trade.readCurve);
});

// ── assertTradable: the cheap mid-run graduation re-check ────────────────────────────

test('assertTradable returns the state number for a token still on the state-0 curve', async () => {
  const state = await trade.assertTradable(TOKEN, { rpc: {}, curve: { tokenState: async () => 0 } });
  assert.equal(state, 0);
});

test('assertTradable THROWS when the token graduated mid-run (state != 0) so the engine halts-and-keeps-state', async () => {
  await assert.rejects(
    () => trade.assertTradable(TOKEN, { rpc: {}, curve: { tokenState: async () => 1 } }),
    /BondingCurve/
  );
});

// ── buy / sell: signing, native-value calldata, and balance-delta measurement ─────────
//
// `eth` / `tok` are walked forward by the fake signer, so a delta the module measures is
// measuring something that actually moved. The fake curve client returns tagged calldata
// ('0xbuy' / '0xsell' / '0xapprove') the signer keys the effect off of.

function harness({
  ethBalances = { [WALLET.address]: parseEther('10') },
  tokenBalances = { [WALLET.address]: TOKENS(1_000_000) },
  buyTokensOut = TOKENS(500),
  sellProceeds = parseEther('1'),
  sellRevert = false,
  quoteBuyOut = TOKENS(1000),
  quoteSellOut = parseEther('1'),
  gasUsed = 100_000n,
  gasPrice = 1_000_000_000n,
  startNonce = 11,
} = {}) {
  const sent = [];
  const receipts = new Map();
  const eth = { ...ethBalances };
  const tok = { ...tokenBalances };
  const built = {};
  const gasFee = gasUsed * gasPrice;

  const receiptFor = (hash, ok = true) => ({
    status: ok ? 1 : 0,
    blockNumber: 4242,
    gasUsed,
    effectiveGasPrice: gasPrice,
    hash,
  });

  const deps = {
    rpc: {
      getBalance: async () => eth[WALLET.address] ?? 0n,
      getTransactionCount: async () => startNonce,
    },
    keystore: {
      signer: () => ({
        sendTransaction: async (tx) => {
          const hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}`;
          sent.push({ ...tx, hash });
          if (tx.data === '0xbuy') {
            eth[WALLET.address] -= tx.value + gasFee;
            tok[WALLET.address] = (tok[WALLET.address] ?? 0n) + buyTokensOut;
            receipts.set(hash, receiptFor(hash));
          } else if (tx.data === '0xsell') {
            if (!sellRevert) eth[WALLET.address] += sellProceeds;
            eth[WALLET.address] -= gasFee;
            receipts.set(hash, receiptFor(hash, !sellRevert));
          } else {
            // '0xapprove' — costs gas, moves nothing.
            eth[WALLET.address] -= gasFee;
            receipts.set(hash, receiptFor(hash));
          }
          return { hash };
        },
      }),
    },
    // The injected flap curve client (evm/v7/curve.js). It NEVER signs — it prices and
    // builds calldata; the tag on `data` lets the fake signer model each leg's effect.
    curve: {
      quoteBuy: async () => quoteBuyOut,
      quoteSell: async () => quoteSellOut,
      buildBuyTx: (args) => {
        built.buy = args;
        return { to: LAUNCHER, data: '0xbuy', value: BigInt(args.amountInWei) };
      },
      buildSellTx: (args) => {
        built.sell = args;
        return { to: LAUNCHER, data: '0xsell', value: 0n };
      },
      buildApproveTx: (args) => {
        built.approve = args;
        return { to: getAddress(TOKEN), data: '0xapprove', value: 0n };
      },
    },
    readTokenBalance: async (_token, owner) => tok[getAddress(owner)] ?? 0n,
    waitForReceiptFn: async (_rpc, hash) => receipts.get(hash) || null,
    fees: FEES,
    dryRun: false,
  };

  return { deps, sent, eth, tok, built };
}

test('a buy sends amountWei in as msg.value and floors minOut by the slippage', async () => {
  const h = harness();
  await trade.buy({ wallet: WALLET, token: TOKEN, amountWei: parseEther('1'), slippageBps: 1500 }, h.deps);
  const [tx] = h.sent;
  assert.equal(tx.value, parseEther('1'), 'the native spend rides in as value');
  assert.equal(tx.nonce, 11);
  // expectedOut 1000, 1500 bps => 85% floor.
  assert.equal(h.built.buy.minOut, (TOKENS(1000) * 8500n) / 10_000n);
});

test('a buy PERMITS slippageBps 0 — a strictly-guaranteed buy on the predictable curve (v6 forbade it)', async () => {
  const h = harness();
  const out = await trade.buy({ wallet: WALLET, token: TOKEN, amountWei: parseEther('1'), slippageBps: 0 }, h.deps);
  assert.equal(h.built.buy.minOut, 0n, 'a zero floor is allowed on the flap curve');
  assert.equal(out.minOut, 0n);
});

test('a buy reports the tokens it actually received, as a balance delta', async () => {
  const h = harness();
  const out = await trade.buy({ wallet: WALLET, token: TOKEN, amountWei: parseEther('1'), slippageBps: 0 }, h.deps);
  assert.equal(out.status, 'confirmed');
  assert.equal(out.tokensOut, TOKENS(500));
  assert.equal(out.expectedOut, TOKENS(1000));
  assert.equal(out.blockNumber, 4242);
});

test('a buy refuses a curve quote that returns nothing rather than sign a buy that gets zero', async () => {
  const h = harness({ quoteBuyOut: 0n });
  await assert.rejects(
    () => trade.buy({ wallet: WALLET, token: TOKEN, amountWei: parseEther('1') }, h.deps),
    /refusing a buy/
  );
  assert.equal(h.sent.length, 0);
});

test('a buy refuses a non-positive amount', async () => {
  const h = harness();
  await assert.rejects(() => trade.buy({ wallet: WALLET, token: TOKEN, amountWei: 0n }, h.deps), /positive amount/);
});

test('a sell signs approve@n then swapExactInput@n+1 from the same wallet (two txs, no Permit2 leg)', async () => {
  const h = harness({ startNonce: 20 });
  const out = await trade.sell({ wallet: WALLET, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  assert.equal(h.sent.length, 2, 'exactly two txs: approve + swapExactInput');
  const [approve, sellTx] = h.sent;
  assert.equal(approve.data, '0xapprove');
  assert.equal(sellTx.data, '0xsell');
  assert.equal(approve.nonce, 20);
  assert.equal(sellTx.nonce, 21, 'the sequencer runs a wallets txs in nonce order');
  assert.deepEqual(out.approveHashes, [approve.hash], 'one approve hash, not two');
  assert.equal(out.sellHash, sellTx.hash);
});

test('the approval is for exactly the tokens being sold, never unlimited', async () => {
  const h = harness();
  await trade.sell({ wallet: WALLET, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  assert.equal(h.built.approve.amount, TOKENS(100));
  assert.equal(h.built.approve.token, getAddress(TOKEN));
});

test('ethReceived is the native balance delta with BOTH txs gas added back', async () => {
  // The curve pays 1 ETH; the approve and the sell each burn gas. A naive delta
  // under-reports by TWO gas fees — the proceeds are what the curve actually paid.
  const h = harness();
  const out = await trade.sell({ wallet: WALLET, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  assert.equal(out.status, 'confirmed');
  assert.equal(out.ethReceived, parseEther('1'), 'both the approve gas and the sell gas are added back');
  assert.equal(out.tokensIn, TOKENS(100));
});

test('a reverted sell reports reverted and claims no proceeds', async () => {
  const h = harness({ sellRevert: true });
  const out = await trade.sell({ wallet: WALLET, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  assert.equal(out.status, 'reverted');
  assert.equal(out.ethReceived, 0n, 'a revert that cost gas must never look like income');
});

test('selling more than the wallet holds is refused before anything is signed', async () => {
  const h = harness({ tokenBalances: { [WALLET.address]: TOKENS(50) } });
  await assert.rejects(
    () => trade.sell({ wallet: WALLET, token: TOKEN, tokensIn: TOKENS(100) }, h.deps),
    /holds/
  );
  assert.equal(h.sent.length, 0, 'the held-check runs before any tx is signed');
});

test('a dry run broadcasts nothing on either leg', async () => {
  const h = harness();
  h.deps.dryRun = true;
  const buy = await trade.buy({ wallet: WALLET, token: TOKEN, amountWei: parseEther('1') }, h.deps);
  const sell = await trade.sell({ wallet: WALLET, token: TOKEN, tokensIn: TOKENS(100) }, h.deps);
  assert.equal(buy.simulated, true);
  assert.equal(sell.simulated, true);
  assert.equal(h.sent.length, 0);
});

test('tokenBalance reads through the injected readTokenBalance', async () => {
  const h = harness();
  assert.equal(await trade.tokenBalance(TOKEN, WALLET.address, h.deps), TOKENS(1_000_000));
});
