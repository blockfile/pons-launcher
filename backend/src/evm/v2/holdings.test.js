'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Interface, ZeroAddress, getAddress } = require('ethers');

const { FACTORY_V2_ABI } = require('./abi');
const holdings = require('./holdings');

const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const DEV = '0x1ada673a00000000000000000000000000000000';
const STRANGER = '0x9999999999999999999999999999999999999999';

const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DUST = '0xdddddddddddddddddddddddddddddddddddddddd';
const CURVE_A = '0xca11a000000000000000000000000000000000a1';
const CURVE_B = '0xca11b000000000000000000000000000000000b1';

const iface = new Interface(FACTORY_V2_ABI);

function launchLog({ token, curve, deployer, blockNumber }) {
  const { topics, data } = iface.encodeEventLog('TokenLaunched', [
    token,
    curve,
    deployer,
    ZeroAddress,
    0,
    0n,
  ]);
  return { address: FACTORY, topics, data, blockNumber };
}

/** A node that answers getLogs from a fixed set and records what it was asked. */
function fakeNode({ logs = [], head = 250, rejectWiderThan = Infinity } = {}) {
  const ranges = [];
  return {
    ranges,
    async getBlockNumber() {
      return head;
    },
    async getLogs({ fromBlock, toBlock, topics }) {
      ranges.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1 > rejectWiderThan) {
        throw new Error('query returned more than 10000 results');
      }
      const wanted = topics[3];
      return logs.filter(
        (l) =>
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock &&
          (!wanted || l.topics[3] === wanted)
      );
    },
  };
}

const WALLETS = [
  { id: 'w1', address: '0x1111111111111111111111111111111111111111' },
  { id: 'w2', address: '0x2222222222222222222222222222222222222222' },
];

// Everything findSellable reads off the chain, as plain fakes.
function sellableDeps(over = {}) {
  return {
    launchedByDeployer: async () => ({
      launches: [
        { token: getAddress(TOKEN_A), curve: getAddress(CURVE_A), blockNumber: 200 },
        { token: getAddress(TOKEN_B), curve: getAddress(CURVE_B), blockNumber: 100 },
      ],
      scannedFrom: 0,
      complete: true,
    }),
    describeToken: async (token) => ({
      token: getAddress(token),
      curve: getAddress(token === getAddress(TOKEN_B) ? CURVE_B : CURVE_A),
      deployer: getAddress(DEV),
      pairToken: ZeroAddress,
      phase: 1,
      exists: true,
    }),
    curveState: async () => ({ graduated: false, readyToGraduate: false }),
    tokenMeta: async (token) => ({
      symbol: token === getAddress(TOKEN_B) ? 'BEE' : 'AYE',
      decimals: 18,
    }),
    balanceOf: async () => 10n ** 18n,
    ...over,
  };
}

// ── enumerating a dev wallet's launches ────────────────────────────────────

test('the deployer scan walks backwards in windows and stops at genesis', async () => {
  const node = fakeNode({
    head: 250,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 210 })],
  });

  const out = await holdings.launchedByDeployer(DEV, {
    provider: node,
    factoryAddress: FACTORY,
    window: 100,
    maxWindows: 10,
  });

  assert.deepEqual(node.ranges, [
    [151, 250],
    [51, 150],
    [0, 50],
  ]);
  assert.equal(out.complete, true);
  assert.equal(out.scannedFrom, 0);
  assert.deepEqual(
    out.launches.map((l) => l.token),
    [getAddress(TOKEN_A)]
  );
});

test('one dev wallet with several launches gets all of them, newest first', async () => {
  const node = fakeNode({
    head: 250,
    logs: [
      launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 240 }),
      launchLog({ token: TOKEN_B, curve: CURVE_B, deployer: DEV, blockNumber: 30 }),
    ],
  });

  const out = await holdings.launchedByDeployer(DEV, {
    provider: node,
    factoryAddress: FACTORY,
    window: 100,
    maxWindows: 10,
  });

  assert.deepEqual(
    out.launches.map((l) => l.token),
    [getAddress(TOKEN_A), getAddress(TOKEN_B)]
  );
  assert.equal(out.launches[0].curve, getAddress(CURVE_A));
});

test('another wallet launches are not returned — the filter is on the indexed deployer', async () => {
  const node = fakeNode({
    head: 100,
    logs: [
      launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 50 }),
      launchLog({ token: DUST, curve: CURVE_B, deployer: STRANGER, blockNumber: 60 }),
    ],
  });

  const out = await holdings.launchedByDeployer(DEV, {
    provider: node,
    factoryAddress: FACTORY,
    window: 1000,
    maxWindows: 10,
  });

  assert.deepEqual(
    out.launches.map((l) => l.token),
    [getAddress(TOKEN_A)]
  );
});

test('a window the RPC refuses is split rather than abandoned', async () => {
  // The node rejects any query matching too much; the scan has to narrow it.
  const node = fakeNode({
    head: 199,
    rejectWiderThan: 50,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 7 })],
  });

  const out = await holdings.launchedByDeployer(DEV, {
    provider: node,
    factoryAddress: FACTORY,
    window: 200,
    maxWindows: 2,
  });

  assert.deepEqual(
    out.launches.map((l) => l.token),
    [getAddress(TOKEN_A)]
  );
  assert.ok(node.ranges.length > 1, 'the refused range must have been split');
});

test('a scan that runs out of windows says so instead of implying it saw everything', async () => {
  const node = fakeNode({ head: 1000, logs: [] });
  const out = await holdings.launchedByDeployer(DEV, {
    provider: node,
    factoryAddress: FACTORY,
    window: 100,
    maxWindows: 2,
  });

  assert.equal(out.complete, false);
  assert.equal(out.scannedFrom, 801);
});

// ── selection: launched-by-dev INTERSECT held-by-bundle ────────────────────

test('a token held by a bundle wallet but not launched by the dev is never offered', async () => {
  // The dusting case, and the whole reason selection is not balance-driven.
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      balanceOf: async (token) => (token === getAddress(DUST) ? 10n ** 24n : 10n ** 18n),
    })
  );

  assert.equal(
    out.tokens.some((t) => t.token === getAddress(DUST)),
    false
  );
  assert.deepEqual(
    out.tokens.map((t) => t.token).sort(),
    [getAddress(TOKEN_A), getAddress(TOKEN_B)].sort()
  );
});

test('a launched token with no bundle balance is not offered', async () => {
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      balanceOf: async (token) => (token === getAddress(TOKEN_B) ? 0n : 5n * 10n ** 18n),
    })
  );

  assert.deepEqual(
    out.tokens.map((t) => t.token),
    [getAddress(TOKEN_A)]
  );
  assert.equal(out.tokens[0].wallets, 2, 'wallets is the count of holders');
  assert.equal(out.tokens[0].totalTokens, '10.0', 'amounts are human decimals, not base units');
  assert.equal(out.tokens[0].totalTokensRaw, (10n * 10n ** 18n).toString());
  assert.equal(out.tokens[0].holders[0].tokens, '5.0');
});

test('a token from local history that the factory says someone else launched is refused', async () => {
  // History is a local file. If it ever names a token this dev did not launch,
  // the factory's own record decides — not the file.
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [DUST] },
    sellableDeps({
      describeToken: async (token) =>
        token === getAddress(DUST)
          ? {
              token: getAddress(DUST),
              curve: getAddress(CURVE_B),
              deployer: getAddress(STRANGER),
              pairToken: ZeroAddress,
              phase: 1,
              exists: true,
            }
          : {
              token: getAddress(token),
              curve: getAddress(token === getAddress(TOKEN_B) ? CURVE_B : CURVE_A),
              deployer: getAddress(DEV),
              pairToken: ZeroAddress,
              phase: 1,
              exists: true,
            },
    })
  );

  assert.equal(
    out.tokens.some((t) => t.token === getAddress(DUST)),
    false
  );
});

test('a token from local history that the dev did launch is offered even if the log scan missed it', async () => {
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [DUST] },
    sellableDeps({
      launchedByDeployer: async () => ({ launches: [], scannedFrom: 900, complete: false }),
      describeToken: async (token) => ({
        token: getAddress(token),
        curve: getAddress(CURVE_A),
        deployer: getAddress(DEV),
        pairToken: ZeroAddress,
        phase: 1,
        exists: true,
      }),
    })
  );

  assert.deepEqual(
    out.tokens.map((t) => t.token),
    [getAddress(DUST)]
  );
  // A partial scan has to be said out loud, or a missing token looks like a
  // sold-out one.
  assert.ok(out.warnings.some((w) => /only scanned back to block 900/.test(w)));
});

test('graduation is read once per token and reported on the row', async () => {
  let reads = 0;
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      curveState: async (curve) => {
        reads += 1;
        return { graduated: curve === getAddress(CURVE_B), readyToGraduate: true };
      },
    })
  );

  assert.equal(reads, 2, 'once per token, not once per wallet');
  const a = out.tokens.find((t) => t.token === getAddress(TOKEN_A));
  const b = out.tokens.find((t) => t.token === getAddress(TOKEN_B));
  assert.equal(a.graduated, false);
  assert.equal(a.route, 'curve');
  assert.equal(b.graduated, true);
  assert.equal(b.route, 'uniswap-v4');
});

test('the list carries no BigInt — it is JSON on the way out', async () => {
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps()
  );
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('a token whose factory record does not exist is dropped, not guessed at', async () => {
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      describeToken: async (token) =>
        token === getAddress(TOKEN_A)
          ? { token: getAddress(TOKEN_A), exists: false }
          : {
              token: getAddress(token),
              curve: getAddress(CURVE_B),
              deployer: getAddress(DEV),
              pairToken: ZeroAddress,
              phase: 1,
              exists: true,
            },
    })
  );

  assert.deepEqual(
    out.tokens.map((t) => t.token),
    [getAddress(TOKEN_B)]
  );
});

// ── quoting a sell ─────────────────────────────────────────────────────────
// The fixtures below are not invented. Each is a real curve, read at a real
// block, with the expected answer taken from the chain's own `sell` run as an
// eth_call with the allowance overridden — so these assert that our arithmetic
// reproduces the contract to the wei, not that it matches a second guess.

test('quoteSellOut reproduces a live curve exactly (fee only)', () => {
  // curve 0x50C44eDe188Cb9cb1d7737e3aA43f8a21582b532
  const out = holdings.quoteSellOut({
    tokensIn: 10n ** 24n,
    quoteReserve: 1729500000000000000n,
    tokenReserve: 971379011274934952298352125n,
    feeBps: 100,
    creatorTaxBps: 0,
  });
  assert.equal(out, 1760841174219754n);
});

test('quoteSellOut reproduces a live curve exactly with a creator tax', () => {
  // curve 0x17BdcC79180d0739f30E368Bc774bf8b4fBed645, creatorTaxBps 500.
  // Both the curve fee and the creator tax come off the OUTPUT, not the input —
  // taking them off the input is out by ~1% and was ruled out on chain.
  const out = holdings.quoteSellOut({
    tokensIn: 13607411696583671105964099n,
    quoteReserve: 1733231602046542370n,
    tokenReserve: 969287657815788585229084419n,
    feeBps: 100,
    creatorTaxBps: 500,
  });
  assert.equal(out, 22555518797241172n);
});

test('quoteSellOut is zero for zero tokens and never negative', () => {
  const args = {
    quoteReserve: 1729500000000000000n,
    tokenReserve: 971379011274934952298352125n,
    feeBps: 100,
    creatorTaxBps: 0,
  };
  assert.equal(holdings.quoteSellOut({ ...args, tokensIn: 0n }), 0n);
  assert.equal(holdings.quoteSellOut({ ...args, tokenReserve: 0n, tokensIn: 0n }), 0n);
});

test('price impact is real — selling twice as much does not pay twice as much', () => {
  const args = {
    quoteReserve: 1729500000000000000n,
    tokenReserve: 971379011274934952298352125n,
    feeBps: 100,
    creatorTaxBps: 0,
  };
  const one = holdings.quoteSellOut({ ...args, tokensIn: 10n ** 24n });
  const two = holdings.quoteSellOut({ ...args, tokensIn: 2n * 10n ** 24n });
  assert.ok(two < one * 2n, 'a bigger sell must fill worse per token');
});
