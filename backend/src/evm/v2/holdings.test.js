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

test('the whole chain is asked for in one call — the deployer topic is indexed', async () => {
  // Measured against the live node: one open-range query is 2.2s, the windowed
  // walk is 76s. The walk exists for a node that refuses this, nothing else.
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

  assert.deepEqual(node.ranges, [[0, 250]], 'one call, not a walk');
  assert.equal(out.complete, true);
  assert.equal(out.scannedFrom, 0);
  assert.deepEqual(
    out.launches.map((l) => l.token),
    [getAddress(TOKEN_A)]
  );
});

test('a node that refuses the open range gets a backwards walk instead', async () => {
  const node = fakeNode({
    head: 250,
    rejectWiderThan: 100,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 210 })],
  });

  const out = await holdings.launchedByDeployer(DEV, {
    provider: node,
    factoryAddress: FACTORY,
    window: 100,
    maxWindows: 10,
  });

  assert.deepEqual(node.ranges, [
    [0, 250], // refused
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
  const node = fakeNode({ head: 1000, logs: [], rejectWiderThan: 100 });
  const out = await holdings.launchedByDeployer(DEV, {
    provider: node,
    factoryAddress: FACTORY,
    window: 100,
    maxWindows: 2,
  });

  assert.equal(out.complete, false);
  assert.equal(out.scannedFrom, 801);
  assert.ok(/truncated/.test(out.warning) && /801-1000/.test(out.warning));
});

test('the walk stops on its own clock, and returns what it found', async () => {
  // THE PRODUCTION HANG. This node refuses anything wider than a window, so the
  // whole-chain call fails and the walk runs — and the real chain is 28.7M
  // blocks, which at this window is thousands of sequential round trips. The
  // wall clock is what stops it. Without it, this test would issue maxWindows
  // requests and the real thing never returned at all.
  let clock = 0;
  const node = fakeNode({
    head: 1_000_000,
    rejectWiderThan: 10_000,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 999_000 })],
  });
  const slow = {
    ...node,
    async getLogs(f) {
      clock += 3000; // every round trip costs three seconds
      return node.getLogs(f);
    },
  };

  const out = await holdings.launchedByDeployer(DEV, {
    provider: slow,
    factoryAddress: FACTORY,
    window: 10_000,
    maxWindows: 2870, // what reaching block 0 would actually take
    scanBudgetMs: 10_000,
    now: () => clock,
  });

  // Found in the first window, so it comes back — truncated is not empty.
  assert.deepEqual(
    out.launches.map((l) => l.token),
    [getAddress(TOKEN_A)]
  );
  assert.equal(out.complete, false);
  assert.ok(/truncated/.test(out.warning), 'the operator has to be told the list is partial');
  assert.ok(node.ranges.length <= 6, `gave up early, issued ${node.ranges.length} requests`);
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

test('a token from local history that the dev did launch is offered without any log scan', async () => {
  // History first: the file already names the token, so there is nothing to
  // enumerate. The scan below would fail the test if it were reached.
  let scans = 0;
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [DUST] },
    sellableDeps({
      launchedByDeployer: async () => {
        scans += 1;
        return { launches: [], scannedFrom: 900, scannedTo: 1000, complete: false };
      },
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
  assert.equal(scans, 0, 'history answered it — the chain must not have been enumerated');
  assert.equal(out.scan.ran, false);
  assert.deepEqual(out.warnings, []);
});

test('a partial scan is said out loud, with the blocks it actually covered', async () => {
  // A missing token has to look different from a sold-out one, or the operator
  // reads "nothing to sell" and believes it.
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      launchedByDeployer: async () => ({
        launches: [],
        scannedFrom: 900,
        scannedTo: 1000,
        complete: false,
      }),
    })
  );

  assert.deepEqual(out.tokens, []);
  assert.ok(out.warnings.some((w) => /truncated/.test(w) && /900-1000/.test(w)));
});

test('a truncated scan returns what it found, plus the warning — it never hangs', async () => {
  // The production failure was the opposite: no answer at all. Whatever the
  // scan managed to see must come back, labelled.
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      launchedByDeployer: async () => ({
        launches: [{ token: getAddress(TOKEN_A), curve: getAddress(CURVE_A), blockNumber: 990 }],
        scannedFrom: 900,
        scannedTo: 1000,
        complete: false,
        warning: 'the launch scan was truncated and only covered blocks 900-1000 — older launches',
      }),
    })
  );

  assert.deepEqual(
    out.tokens.map((t) => t.token),
    [getAddress(TOKEN_A)],
    'a truncated list beats no list'
  );
  assert.equal(out.scan.complete, false);
  assert.ok(out.warnings.some((w) => /truncated/.test(w)));
});

test('a scan that never answers is abandoned, not waited on', async () => {
  // This is the production hang, reproduced: the scan simply never resolves.
  // The route has to come back anyway.
  const started = Date.now();
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      launchedByDeployer: () => new Promise(() => {}),
      scanBudgetMs: 20,
    })
  );

  assert.deepEqual(out.tokens, []);
  assert.ok(Date.now() - started < 2000, 'it must give up in its own budget, not eventually');
  assert.ok(out.warnings.some((w) => /did not answer/.test(w)));
});

test('a scan that throws costs the list its extras, not the request', async () => {
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    sellableDeps({
      launchedByDeployer: async () => {
        throw new Error('rate limited');
      },
    })
  );

  assert.deepEqual(out.tokens, []);
  assert.ok(out.warnings.some((w) => /the launch scan failed \(rate limited\)/.test(w)));
});

test('a history entry the factory attributes to another wallet is excluded even with no scan', async () => {
  // The dusting rule applied to the local file: history says where to look, the
  // factory says what is true. TOKEN_A keeps the list non-empty so the fallback
  // scan never runs and the exclusion is the only thing under test.
  let scans = 0;
  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [DUST, TOKEN_A] },
    sellableDeps({
      launchedByDeployer: async () => {
        scans += 1;
        return { launches: [], scannedFrom: 0, scannedTo: 250, complete: true };
      },
      describeToken: async (token) => ({
        token: getAddress(token),
        curve: getAddress(CURVE_A),
        // The file names DUST; the factory says a stranger launched it.
        deployer: getAddress(token === getAddress(DUST) ? STRANGER : DEV),
        pairToken: ZeroAddress,
        phase: 1,
        exists: true,
      }),
    })
  );

  assert.equal(scans, 0);
  assert.deepEqual(
    out.tokens.map((t) => t.token),
    [getAddress(TOKEN_A)]
  );
  assert.ok(out.warnings.some((w) => /launched it — not offered/.test(w)));
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

// ── the batched path ───────────────────────────────────────────────────────
// Everything above injects per-token readers, which bypasses the multicall the
// real thing uses. These drive that path end to end, through a node that
// actually decodes aggregate3 — otherwise the code that runs in production is
// the only code with no test.

const MULTICALL_IFACE = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
]);
const ERC20_IFACE = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const CURVE_IFACE = new Interface([
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
]);
const sel = (ifc, name) => ifc.getFunction(name).selector;

const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';

/**
 * A node that answers getLogs and a real aggregate3, from a small world model.
 * `revertOn` names selectors a given target refuses, to exercise allowFailure.
 */
function multicallNode({ head = 250, logs = [], world = {}, revertOn = () => false } = {}) {
  const state = { calls: 0, logCalls: 0 };
  const node = {
    get calls() {
      return state.calls;
    },
    get logCalls() {
      return state.logCalls;
    },
    async getBlockNumber() {
      return head;
    },
    async getLogs({ fromBlock, toBlock, topics }) {
      state.logCalls += 1;
      const wanted = topics[3];
      return logs.filter(
        (l) =>
          l.blockNumber >= fromBlock && l.blockNumber <= toBlock && (!wanted || l.topics[3] === wanted)
      );
    },
    async call({ data }) {
      state.calls += 1;
      const [batch] = MULTICALL_IFACE.decodeFunctionData('aggregate3', data);
      const results = batch.map(([target, _allow, callData]) => {
        const s = callData.slice(0, 10);
        const key = getAddress(target);
        if (revertOn(key, s)) return [false, '0x'];

        // getLaunchedToken is asked of the FACTORY, so the record is looked up
        // by the token in the arguments rather than by the call's target.
        if (s === iface.getFunction('getLaunchedToken').selector) {
          const [asked] = iface.decodeFunctionData('getLaunchedToken', callData);
          const rec = world[getAddress(asked)]?.record;
          return rec ? [true, iface.encodeFunctionResult('getLaunchedToken', [rec])] : [false, '0x'];
        }

        const entry = world[key];
        if (!entry) return [false, '0x'];

        if (s === sel(ERC20_IFACE, 'symbol')) {
          return [true, ERC20_IFACE.encodeFunctionResult('symbol', [entry.symbol])];
        }
        if (s === sel(ERC20_IFACE, 'decimals')) {
          return [true, ERC20_IFACE.encodeFunctionResult('decimals', [entry.decimals])];
        }
        if (s === sel(ERC20_IFACE, 'balanceOf')) {
          const [who] = ERC20_IFACE.decodeFunctionData('balanceOf', callData);
          return [
            true,
            ERC20_IFACE.encodeFunctionResult('balanceOf', [
              (entry.balances || {})[getAddress(who)] ?? 0n,
            ]),
          ];
        }
        if (s === sel(CURVE_IFACE, 'graduated')) {
          return [true, CURVE_IFACE.encodeFunctionResult('graduated', [!!entry.graduated])];
        }
        if (s === sel(CURVE_IFACE, 'readyToGraduate')) {
          return [true, CURVE_IFACE.encodeFunctionResult('readyToGraduate', [!!entry.ready])];
        }
        return [false, '0x'];
      });
      return MULTICALL_IFACE.encodeFunctionResult('aggregate3', [results]);
    },
  };
  return node;
}

/** The 15-field LaunchedToken struct, positionally. */
const launchedRecord = ({ token, curve, deployer, exists = true }) => [
  getAddress(token),
  getAddress(curve),
  getAddress(deployer),
  getAddress(deployer),
  ZeroAddress,
  0n,
  3000,
  60,
  0,
  false,
  1,
  0n,
  0n,
  0n,
  exists,
];

test('the multicall path lists the dev own launches and decodes every field', async () => {
  const node = multicallNode({
    head: 250,
    logs: [
      launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 200 }),
      launchLog({ token: TOKEN_B, curve: CURVE_B, deployer: DEV, blockNumber: 100 }),
    ],
    world: {
      [getAddress(TOKEN_A)]: {
        symbol: 'AYE',
        decimals: 18,
        balances: { [getAddress(WALLETS[0].address)]: 3n * 10n ** 18n },
        record: launchedRecord({ token: TOKEN_A, curve: CURVE_A, deployer: DEV }),
      },
      [getAddress(TOKEN_B)]: {
        symbol: 'BEE',
        decimals: 6,
        balances: { [getAddress(WALLETS[1].address)]: 1_500_000n },
        record: launchedRecord({ token: TOKEN_B, curve: CURVE_B, deployer: DEV }),
      },
      [getAddress(CURVE_A)]: { graduated: false, ready: false },
      [getAddress(CURVE_B)]: { graduated: true, ready: true },
    },
  });

  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    { provider: node, factoryAddress: FACTORY, multicallAddress: MULTICALL }
  );

  assert.equal(out.tokens.length, 2);
  const a = out.tokens.find((t) => t.token === getAddress(TOKEN_A));
  const b = out.tokens.find((t) => t.token === getAddress(TOKEN_B));

  assert.equal(a.symbol, 'AYE');
  assert.equal(a.totalTokens, '3.0');
  assert.equal(a.wallets, 1);
  assert.equal(a.route, 'curve');
  // Decimals are read, not assumed — a 6-decimal token rendered as 18 is off by
  // twelve orders of magnitude.
  assert.equal(b.decimals, 6);
  assert.equal(b.totalTokens, '1.5');
  assert.equal(b.route, 'uniswap-v4');
  assert.equal(b.graduated, true);

  // Two requests for two tokens across two wallets: one for the factory
  // records, one for everything else.
  assert.equal(node.calls, 2);
});

test('the history-first path makes no log call at all', async () => {
  // The fix for the production hang, end to end through the real reader: a
  // token in this user's launch history is listed without eth_getLogs ever
  // being issued. The node below has the logs; nothing should ask for them.
  const node = multicallNode({
    head: 28_700_000,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 28_699_000 })],
    world: {
      [getAddress(TOKEN_A)]: {
        symbol: 'AYE',
        decimals: 18,
        balances: { [getAddress(WALLETS[0].address)]: 3n * 10n ** 18n },
        record: launchedRecord({ token: TOKEN_A, curve: CURVE_A, deployer: DEV }),
      },
      [getAddress(CURVE_A)]: { graduated: false, ready: false },
    },
  });

  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [TOKEN_A] },
    { provider: node, factoryAddress: FACTORY, multicallAddress: MULTICALL }
  );

  assert.equal(node.logCalls, 0, 'history had the answer — the chain must not be enumerated');
  assert.deepEqual(
    out.tokens.map((t) => t.token),
    [getAddress(TOKEN_A)]
  );
  // Two multicalls and nothing else: the factory records, then metadata,
  // curve state and every balance.
  assert.equal(node.calls, 2);
  assert.equal(out.scan.ran, false);
});

test('the log scan still runs when the history file has nothing to offer', async () => {
  const node = multicallNode({
    head: 250,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 200 })],
    world: {
      [getAddress(TOKEN_A)]: {
        symbol: 'AYE',
        decimals: 18,
        balances: { [getAddress(WALLETS[0].address)]: 3n * 10n ** 18n },
        record: launchedRecord({ token: TOKEN_A, curve: CURVE_A, deployer: DEV }),
      },
      [getAddress(CURVE_A)]: { graduated: false, ready: false },
    },
  });

  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    { provider: node, factoryAddress: FACTORY, multicallAddress: MULTICALL }
  );

  assert.ok(node.logCalls > 0, 'a launch made outside this console is still reachable');
  assert.deepEqual(
    out.tokens.map((t) => t.token),
    [getAddress(TOKEN_A)]
  );
});

test('the multicall path drops a token the factory attributes to someone else', async () => {
  const node = multicallNode({
    head: 250,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 200 })],
    world: {
      [getAddress(TOKEN_A)]: {
        symbol: 'AYE',
        decimals: 18,
        balances: { [getAddress(WALLETS[0].address)]: 3n * 10n ** 18n },
        // The event said DEV; the factory record says otherwise. The record wins.
        record: launchedRecord({ token: TOKEN_A, curve: CURVE_A, deployer: STRANGER }),
      },
      [getAddress(CURVE_A)]: { graduated: false, ready: false },
    },
  });

  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    { provider: node, factoryAddress: FACTORY, multicallAddress: MULTICALL }
  );

  assert.equal(out.tokens.length, 0);
  assert.ok(out.warnings.some((w) => /launched it — not offered/.test(w)));
});

test('a token that reverts on symbol() is still sellable', async () => {
  // allowFailure is on for a reason: a hostile or unusual ERC-20 that refuses a
  // metadata call costs itself a label, not the operator their exit.
  const node = multicallNode({
    head: 250,
    logs: [launchLog({ token: TOKEN_A, curve: CURVE_A, deployer: DEV, blockNumber: 200 })],
    world: {
      [getAddress(TOKEN_A)]: {
        symbol: 'AYE',
        decimals: 18,
        balances: { [getAddress(WALLETS[0].address)]: 3n * 10n ** 18n },
        record: launchedRecord({ token: TOKEN_A, curve: CURVE_A, deployer: DEV }),
      },
      [getAddress(CURVE_A)]: { graduated: false, ready: false },
    },
    revertOn: (target, s) => target === getAddress(TOKEN_A) && s === sel(ERC20_IFACE, 'symbol'),
  });

  const out = await holdings.findSellable(
    { deployer: DEV, wallets: WALLETS, knownTokens: [] },
    { provider: node, factoryAddress: FACTORY, multicallAddress: MULTICALL }
  );

  assert.equal(out.tokens.length, 1);
  assert.equal(out.tokens[0].symbol, '???');
  assert.equal(out.tokens[0].totalTokens, '3.0');
});

test('tokenHoldings reads every wallet in one request', async () => {
  const node = multicallNode({
    world: {
      [getAddress(TOKEN_A)]: {
        symbol: 'AYE',
        decimals: 18,
        balances: {
          [getAddress(WALLETS[0].address)]: 7n,
          [getAddress(WALLETS[1].address)]: 0n,
        },
      },
    },
  });

  const held = await holdings.tokenHoldings(TOKEN_A, WALLETS, {
    provider: node,
    multicallAddress: MULTICALL,
  });

  assert.deepEqual(
    held.map((h) => [h.walletId, h.balance]),
    [
      ['w1', 7n],
      ['w2', 0n],
    ]
  );
  assert.equal(node.calls, 1, 'twenty wallets must not be twenty round trips');
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
