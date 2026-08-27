'use strict';

// Unit tests for the letscash (CashCat) v5 read/build client.
//
// Everything here is offline: the pure encode/decode surface is exercised
// directly, and the chain-reading functions are driven by a FAKE runner — a
// duck-typed `{ call }` object that answers each view from an in-memory menu,
// exactly as ethers' Contract would drive a real provider. No RPC, no network.
//
// The load-bearing assertions are pinned to REAL on-chain data (the CRYINGCAT
// launch, tx 0x07a68f9a…): buildLaunchTx must reproduce that transaction's
// calldata byte-for-byte, and computePoolId must reproduce its emitted PoolId.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, ZeroAddress } = require('ethers');

const F = require('./factory');
const { FACTORY_IFACE } = F;

// ── Real CRYINGCAT launch inputs, decoded from tx 0x07a68f9a… ────────────────
const CRYINGCAT = {
  params: {
    name: 'Crying Cat',
    symbol: 'CryingCat',
    logo: 'ipfs://bafkreifoa47mlbxww46r4n5brg2qn4xga2ukflumjpqaxbsljnrnlpr7tu',
    description: 'The Cat Behind CashCat',
    metadataURI: 'ipfs://bafkreid7qymji7l4bkde6f6o4fo7dtulz5l3qu7bttylattakip2xejone',
    socials: { telegram: '', twitter: 'https://x.com/CryingCat__RH', discord: '', website: '', extra: '' },
    creator: '0xb0095c3E6aC1A4F936Df3914E8cC46783B9b5287',
  },
  configId: 16n,
  firstBuyIn: 100000000000000000n, // 0.1 ETH
  firstBuyMinOut: 0n,
  salt: '0x00000000000000000000000000000000000000009ece7da6b3f895a8fed5c264',
  launchFeeWei: 500000000000000n, // 0.0005 ETH
  // The exact calldata this transaction carried on-chain.
  calldata:
    '0x75154d7000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000016345785d8a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009ece7da6b3f895a8fed5c26400000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000b0095c3e6ac1a4f936df3914e8cc46783b9b5287000000000000000000000000000000000000000000000000000000000000000a437279696e6720436174000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009437279696e6743617400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042697066733a2f2f6261666b726569666f6134376d6c62787777343672346e3562726732716e3478676132756b666c756d6a7071617862736c6a6e726e6c707237747500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000165468652043617420426568696e642043617368436174000000000000000000000000000000000000000000000000000000000000000000000000000000000042697066733a2f2f6261666b726569643771796d6a69376c34626b64653666366f34666f376474756c7a356c33717537627474796c617474616b69703278656a6f6e6500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001b68747470733a2f2f782e636f6d2f437279696e674361745f5f52480000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  token: '0x4F0d7ea112547Af5dAD59959d98B6A8ee3355Bcc',
  hook: '0xEfe669814e5Eec33406Bd50ffa8331618D076aEc',
  poolId: '0x9712563efdedc1a39b0baa30135b21167b2277fd9c694f8057f5ab8b5d18d4b0',
};

const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');

// ───────────────────────────── buildLaunchTx ────────────────────────────────

test('buildLaunchTx uses the launch selector and to = factory', () => {
  const tx = F.buildLaunchTx({
    params: CRYINGCAT.params,
    configId: 1000n,
    firstBuyIn: 1n,
    salt: CRYINGCAT.salt,
    launchFeeWei: 500000000000000n,
  });
  assert.equal(tx.data.slice(0, 10), '0x75154d70');
  assert.equal(tx.data.slice(0, 10), F.LAUNCH_SELECTOR);
  assert.equal(tx.to, getAddress(require('../../config').letscash.factory));
});

test('value = launchFee + firstBuyIn for a native (ETH) launch', () => {
  const fee = 500000000000000n;
  const firstBuyIn = 100000000000000000n;
  const tx = F.buildLaunchTx({
    params: CRYINGCAT.params,
    configId: 1000n,
    firstBuyIn,
    salt: CRYINGCAT.salt,
    launchFeeWei: fee,
    // quote defaults to the ETH sentinel
  });
  assert.equal(tx.value, fee + firstBuyIn);
  assert.equal(tx.value, 100500000000000000n);
  assert.equal(tx.firstBuyFromAllowance, false);
});

test('value = launchFee ONLY for an ERC-20 (USDG) launch; first buy comes from allowance', () => {
  const fee = 500000000000000n;
  const tx = F.buildLaunchTx({
    params: CRYINGCAT.params,
    configId: 1008n,
    firstBuyIn: 250000n, // USDG has 6 decimals; pulled via transferFrom, not value
    salt: CRYINGCAT.salt,
    launchFeeWei: fee,
    quote: USDG,
  });
  assert.equal(tx.value, fee, 'ERC-20 first buy must not ride along in value');
  assert.equal(tx.firstBuyFromAllowance, true);
});

test('the launch tuple round-trips through the encoding', () => {
  const tx = F.buildLaunchTx({
    params: CRYINGCAT.params,
    configId: 42n,
    firstBuyIn: 7n,
    firstBuyMinOut: 3n,
    salt: CRYINGCAT.salt,
    launchFeeWei: 500000000000000n,
  });
  const decoded = FACTORY_IFACE.decodeFunctionData('launch', tx.data);
  const [p, configId, firstBuyIn, firstBuyMinOut, salt] = decoded;
  assert.equal(p[0], CRYINGCAT.params.name);
  assert.equal(p[1], CRYINGCAT.params.symbol);
  assert.equal(p[2], CRYINGCAT.params.logo);
  assert.equal(p[3], CRYINGCAT.params.description);
  assert.equal(p[4], CRYINGCAT.params.metadataURI);
  // socials tuple: [telegram, twitter, discord, website, extra]
  assert.equal(p[5][1], CRYINGCAT.params.socials.twitter);
  assert.equal(getAddress(p[6]), getAddress(CRYINGCAT.params.creator));
  assert.equal(configId, 42n);
  assert.equal(firstBuyIn, 7n);
  assert.equal(firstBuyMinOut, 3n);
  assert.equal(salt, CRYINGCAT.salt);
});

test('buildLaunchTx reproduces the real CRYINGCAT calldata byte-for-byte', () => {
  const tx = F.buildLaunchTx({
    params: CRYINGCAT.params,
    configId: CRYINGCAT.configId,
    firstBuyIn: CRYINGCAT.firstBuyIn,
    firstBuyMinOut: CRYINGCAT.firstBuyMinOut,
    salt: CRYINGCAT.salt,
    launchFeeWei: CRYINGCAT.launchFeeWei,
  });
  assert.equal(tx.data.toLowerCase(), CRYINGCAT.calldata.toLowerCase());
  // and the value the transaction actually carried
  assert.equal(tx.value, 100500000000000000n);
});

test('buildLaunchTx rejects a creator that is not the sender (CreatorMustBeSender)', () => {
  assert.throws(
    () =>
      F.buildLaunchTx({
        params: CRYINGCAT.params, // creator = 0xb009…
        configId: 1000n,
        salt: CRYINGCAT.salt,
        launchFeeWei: 1n,
        sender: '0x000000000000000000000000000000000000dEaD',
      }),
    /CreatorMustBeSender/
  );
});

test('buildLaunchTx requires salt and launchFeeWei', () => {
  assert.throws(() => F.buildLaunchTx({ params: CRYINGCAT.params, configId: 1n, launchFeeWei: 1n }), /salt is required/);
  assert.throws(() => F.buildLaunchTx({ params: CRYINGCAT.params, configId: 1n, salt: CRYINGCAT.salt }), /launchFeeWei is required/);
});

// ────────────────────────── vanity + pool helpers ───────────────────────────

test('hasVanitySuffix matches the impl _hasVanitySuffix', () => {
  assert.equal(F.hasVanitySuffix(CRYINGCAT.token), true); // …3355Bcc
  assert.equal(F.hasVanitySuffix('0x1F3DB2F825E4792a4294ec59AE1fC670C4E278cc'), true);
  assert.equal(F.hasVanitySuffix('0xE563D294b56f418BF3D7d5C0c8f7cA296E3e35Bc'), false); // ends 0xBc
  assert.equal(F.hasVanitySuffix(USDG), false);
});

test('computePoolId reproduces the emitted CRYINGCAT PoolId', () => {
  const poolId = F.computePoolId({
    quote: ZeroAddress, // ETH pool
    token: CRYINGCAT.token,
    hook: CRYINGCAT.hook,
    tickSpacing: 200,
    fee: 0,
  });
  assert.equal(poolId, CRYINGCAT.poolId);
});

// ─────────────────────────────── decodeConfig ───────────────────────────────

test('decodeConfig maps fee pips to tax label and mode', () => {
  const base = {
    moduleSetId: 0n,
    quote: ZeroAddress,
    supply: 1000000000000000000000000000n,
    tickSpacing: 200n,
    startTick: 204200n,
    creatorFeeBps: 7000n,
    feeRate: 10000n, // 1%
    enabled: true,
    selfBurn: false,
    exists: true,
  };
  const c = F.decodeConfig(1000, base);
  assert.equal(c.taxRateBps, 100);
  assert.equal(c.taxPercent, 1);
  assert.equal(c.taxLabel, '1%');
  assert.equal(c.mode, 'creator');
  assert.equal(c.quoteSymbol, 'ETH');
  assert.equal(c.quoteIsNative, true);

  const three = F.decodeConfig(1002, { ...base, feeRate: 30000n });
  assert.equal(three.taxLabel, '3%');
  const ten = F.decodeConfig(1006, { ...base, feeRate: 100000n });
  assert.equal(ten.taxLabel, '10%');
  const burn = F.decodeConfig(1001, { ...base, selfBurn: true });
  assert.equal(burn.mode, 'selfburn');
  const usdg = F.decodeConfig(1008, { ...base, quote: USDG });
  assert.equal(usdg.quoteSymbol, 'USDG');
  assert.equal(usdg.quoteIsNative, false);
});

// ───────────────── getConfigs / approvedQuote via a fake runner ──────────────

// A tiny in-memory menu: two ETH configs (creator + selfburn) and one USDG.
function fakeMenu() {
  const first = 1000n;
  const next = 1003n;
  const menu = {
    1000: { moduleSetId: 0n, quote: ZeroAddress, supply: 10n ** 27n, tickSpacing: 200n, startTick: 204200n, creatorFeeBps: 7000n, feeRate: 10000n, enabled: true, selfBurn: false, exists: true },
    1001: { moduleSetId: 0n, quote: ZeroAddress, supply: 10n ** 27n, tickSpacing: 200n, startTick: 204200n, creatorFeeBps: 7000n, feeRate: 10000n, enabled: true, selfBurn: true, exists: true },
    1002: { moduleSetId: 0n, quote: USDG, supply: 10n ** 27n, tickSpacing: 200n, startTick: 398400n, creatorFeeBps: 9000n, feeRate: 30000n, enabled: true, selfBurn: false, exists: true },
  };
  const tupleOf = (c) => [c.moduleSetId, c.quote, c.supply, c.tickSpacing, c.startTick, c.creatorFeeBps, c.feeRate, c.enabled, c.selfBurn, c.exists];

  return {
    call: async (tx) => {
      const sel = tx.data.slice(0, 10);
      const fn = (name) => sel === FACTORY_IFACE.getFunction(name).selector;
      if (fn('launchEnabled')) return FACTORY_IFACE.encodeFunctionResult('launchEnabled', [true]);
      if (fn('launchFee')) return FACTORY_IFACE.encodeFunctionResult('launchFee', [500000000000000n]);
      if (fn('firstConfigId')) return FACTORY_IFACE.encodeFunctionResult('firstConfigId', [first]);
      if (fn('nextConfigId')) return FACTORY_IFACE.encodeFunctionResult('nextConfigId', [next]);
      if (fn('getLaunchConfig')) {
        const [id] = FACTORY_IFACE.decodeFunctionData('getLaunchConfig', tx.data);
        return FACTORY_IFACE.encodeFunctionResult('getLaunchConfig', [tupleOf(menu[Number(id)])]);
      }
      if (fn('approvedQuote')) {
        const [addr] = FACTORY_IFACE.decodeFunctionData('approvedQuote', tx.data);
        // USDG approved; anything else (incl. the 0x0 sentinel) false — exactly
        // the live behaviour the ETH gotcha is about.
        const ok = getAddress(addr).toLowerCase() === USDG.toLowerCase();
        return FACTORY_IFACE.encodeFunctionResult('approvedQuote', [ok]);
      }
      throw new Error(`fake runner: unhandled selector ${sel}`);
    },
  };
}

test('getConfigs enumerates [firstConfigId, nextConfigId) and decodes the menu', async () => {
  const out = await F.getConfigs({ runner: fakeMenu() });
  assert.equal(out.launchEnabled, true);
  assert.equal(out.launchFeeWei, '500000000000000');
  assert.equal(out.firstConfigId, 1000);
  assert.equal(out.nextConfigId, 1003);
  assert.equal(out.count, 3);
  assert.deepEqual(out.configs.map((c) => c.configId), [1000, 1001, 1002]);
  assert.equal(out.configs[0].mode, 'creator');
  assert.equal(out.configs[1].mode, 'selfburn');
  assert.equal(out.configs[2].quoteSymbol, 'USDG');
  assert.equal(out.configs[2].taxLabel, '3%');
});

test('getConfigs reports ETH as approved despite the mapping, and USDG from the mapping', async () => {
  const out = await F.getConfigs({ runner: fakeMenu() });
  const bySym = new Map(out.approvedQuotes.map((q) => [q.symbol, q]));
  // Native ETH: always approved even though approvedQuote(0x0) is false.
  assert.equal(bySym.get('ETH').approved, true);
  assert.equal(bySym.get('ETH').native, true);
  assert.match(bySym.get('ETH').note, /sentinel/);
  // USDG: from the mapping, which said true.
  assert.equal(bySym.get('USDG').approved, true);
  assert.equal(getAddress(bySym.get('USDG').address), USDG);
});

test('approvedQuote short-circuits the native sentinel to true', async () => {
  // No runner needed for the native path — it never touches the chain.
  assert.equal(await F.approvedQuote(ZeroAddress), true);
});

// ──────────────────────────────── mineSalt ──────────────────────────────────

test('mineSalt returns { salt, token } on a hit', async () => {
  const wantSalt = '0x00000000000000000000000000000000000000000000000000000000000000de';
  const wantToken = '0x1F3DB2F825E4792a4294ec59AE1fC670C4E278cc';
  const runner = {
    call: async (tx) => {
      assert.equal(tx.data.slice(0, 10), FACTORY_IFACE.getFunction('mineSalt').selector);
      return FACTORY_IFACE.encodeFunctionResult('mineSalt', [wantSalt, wantToken]);
    },
  };
  const hit = await F.mineSalt(
    { params: CRYINGCAT.params, configId: 1000n, sender: CRYINGCAT.params.creator, start: 1n, rounds: 4000 },
    { runner }
  );
  assert.equal(hit.salt, wantSalt);
  assert.equal(hit.token, getAddress(wantToken));
});

test('mineSalt maps a SaltNotFound revert to null', async () => {
  const runner = {
    call: async () => {
      // The impl's SaltNotFound() selector, in the slot ethers reads revert data from.
      const err = new Error('execution reverted');
      err.data = '0x09525cf0';
      throw err;
    },
  };
  const miss = await F.mineSalt(
    { params: CRYINGCAT.params, configId: 1000n, sender: CRYINGCAT.params.creator, start: 1n, rounds: 10 },
    { runner }
  );
  assert.equal(miss, null);
});

// ─────────────────────────── simulate / explain ─────────────────────────────

test('simulateLaunch decodes the launch return (token, poolId) on success', async () => {
  const token = CRYINGCAT.token;
  const poolId = CRYINGCAT.poolId;
  const runner = {
    call: async (tx) => {
      assert.equal(tx.data.slice(0, 10), F.LAUNCH_SELECTOR);
      return FACTORY_IFACE.encodeFunctionResult('launch', [token, poolId]);
    },
  };
  const txFields = F.buildLaunchTx({
    params: CRYINGCAT.params,
    configId: 1000n,
    firstBuyIn: 1n,
    salt: CRYINGCAT.salt,
    launchFeeWei: 500000000000000n,
  });
  const sim = await F.simulateLaunch(txFields, CRYINGCAT.params.creator, { runner });
  assert.equal(sim.ok, true);
  assert.equal(sim.token, getAddress(token));
  assert.equal(sim.poolId, poolId);
});

test('simulateLaunch surfaces a named revert reason instead of throwing', async () => {
  const runner = {
    call: async () => {
      const err = new Error('execution reverted');
      err.data = '0x52ed1fd7'; // CreatorMustBeSender()
      throw err;
    },
  };
  const txFields = F.buildLaunchTx({
    params: CRYINGCAT.params,
    configId: 1000n,
    salt: CRYINGCAT.salt,
    launchFeeWei: 1n,
  });
  const sim = await F.simulateLaunch(txFields, CRYINGCAT.params.creator, { runner });
  assert.equal(sim.ok, false);
  assert.match(sim.reason, /CreatorMustBeSender/);
});

test('explainRevert names factory custom errors', () => {
  assert.match(F.explainRevert({ data: '0xebc5d1d1' }), /VanityAddressRequired/);
  assert.match(F.explainRevert({ data: '0x199f5f57' }), /QuoteNotApproved/);
});

// ─────────────────────────── parseLaunchReceipt ──────────────────────────────

// Build a synthetic receipt with a TokenLaunched (factory) + Initialize (V4).
function fakeReceipt() {
  const factoryAddr = getAddress(require('../../config').letscash.factory);
  const poolManagerAddr = getAddress(require('../../config').letscash.poolManager);

  const tl = FACTORY_IFACE.encodeEventLog('TokenLaunched', [
    CRYINGCAT.token,
    CRYINGCAT.params.creator,
    CRYINGCAT.poolId,
    16n,
    CRYINGCAT.firstBuyIn,
    68057245261861571047346184n, // real firstBuyOut
    CRYINGCAT.hook,
    CRYINGCAT.params.creator,
  ]);
  const init = F.POOL_MANAGER_IFACE.encodeEventLog('Initialize', [
    CRYINGCAT.poolId,
    ZeroAddress,
    CRYINGCAT.token,
    0,
    200,
    CRYINGCAT.hook,
    2151813121295408910812139624586144n,
    204200,
  ]);
  return {
    logs: [
      { address: factoryAddr, topics: tl.topics, data: tl.data },
      { address: poolManagerAddr, topics: init.topics, data: init.data },
    ],
  };
}

test('parseLaunchReceipt pulls token, poolId and first-buy from TokenLaunched + Initialize', () => {
  const parsed = F.parseLaunchReceipt(fakeReceipt());
  assert.equal(parsed.token, getAddress(CRYINGCAT.token));
  assert.equal(parsed.poolId, CRYINGCAT.poolId);
  assert.equal(parsed.creator, getAddress(CRYINGCAT.params.creator));
  assert.equal(parsed.configId, 16);
  assert.equal(parsed.firstBuyIn, '100000000000000000');
  assert.equal(parsed.firstBuyOut, '68057245261861571047346184');
  assert.equal(parsed.hook, getAddress(CRYINGCAT.hook));
  // V4 pool details from Initialize, cross-checked.
  assert.equal(parsed.pool.currency0, ZeroAddress);
  assert.equal(parsed.pool.currency1, getAddress(CRYINGCAT.token));
  assert.equal(parsed.pool.tickSpacing, 200);
  assert.equal(parsed.pool.tick, 204200);
  assert.equal(parsed.poolIdMismatch, false);
});

test('parseLaunchReceipt returns null when there is no TokenLaunched', () => {
  assert.equal(F.parseLaunchReceipt({ logs: [] }), null);
  assert.equal(F.parseLaunchReceipt({}), null);
});

test('parseLaunchReceipt ignores an unrelated same-topic log', () => {
  // A log whose topic0 collides is skipped by the try/catch rather than crashing.
  const junk = { address: ZeroAddress, topics: [F.TOKEN_LAUNCHED_TOPIC, '0x' + '00'.repeat(32)], data: '0x' };
  const r = fakeReceipt();
  r.logs.push(junk);
  const parsed = F.parseLaunchReceipt(r);
  assert.equal(parsed.token, getAddress(CRYINGCAT.token)); // still found the real one
});

// ── FAST provenance: proxyImplementation + verifyProvenanceByCode (getCode guard) ──

const factoryMod = require('./factory');
const config = require('../../config');

test('proxyImplementation extracts the impl from a canonical EIP-1167 clone', () => {
  const impl = '0xd6Da7f07eE822C8538C901217b37D1e7d86c76E5';
  const code = '0x363d3d373d3d3d363d73' + impl.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';
  assert.equal(factoryMod.proxyImplementation(code), getAddress(impl));
});

test('proxyImplementation returns null for non-proxy code, wrong length, and non-strings', () => {
  assert.equal(factoryMod.proxyImplementation('0x60806040523480156100'), null);
  assert.equal(factoryMod.proxyImplementation('0x'), null);
  assert.equal(factoryMod.proxyImplementation('0x363d3d373d3d3d363d7300'), null); // too short
  assert.equal(factoryMod.proxyImplementation(null), null);
  assert.equal(factoryMod.proxyImplementation(undefined), null);
});

test('verifyProvenanceByCode ACCEPTS a clone of the config tokenMaster', async () => {
  const impl = config.letscash.tokenMasters[0]; // the seeded, verified-live tokenMaster
  const code = '0x363d3d373d3d3d363d73' + impl.replace(/^0x/, '').toLowerCase() + '5af43d82803e903d91602b57fd5bf3';
  const out = await factoryMod.verifyProvenanceByCode('0x1111111111111111111111111111111111111111', {
    provider: { getCode: async () => code },
  });
  assert.equal(out.ok, true);
  assert.equal(out.impl, getAddress(impl));
});

test('verifyProvenanceByCode REJECTS a non-proxy decoy in one getCode', async () => {
  const out = await factoryMod.verifyProvenanceByCode('0x1111111111111111111111111111111111111111', {
    provider: { getCode: async () => '0x6080604052348015610010' }, // ordinary contract bytecode
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /EIP-1167/);
});

test('verifyProvenanceByCode REJECTS a proxy to an UNKNOWN implementation (refresh cannot rescue it)', async () => {
  const impl = '0x9999999999999999999999999999999999999999';
  const code = '0x363d3d373d3d3d363d73' + impl.slice(2) + '5af43d82803e903d91602b57fd5bf3';
  const out = await factoryMod.verifyProvenanceByCode('0x1111111111111111111111111111111111111111', {
    // getCode returns the proxy; the module-set refresh has no working factory here and is swallowed.
    provider: { getCode: async () => code, call: async () => { throw new Error('no factory in this test'); } },
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not a letscash tokenMaster/);
});
