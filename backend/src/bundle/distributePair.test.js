'use strict';

// distributePair moves the pair token (SPCX) from one launcher wallet to the
// bundle wallets so they can pre-sign an untaxed pair buy. It moves real money,
// so these assert the safety properties:
//   - it transfers exactly the requested amounts, to launcher-owned wallets only;
//   - the source's nonces stay gap-free even when one transfer fails;
//   - it refuses BEFORE signing when the source cannot cover the tokens or gas,
//     or when a recipient is unknown / is the source itself;
//   - one transfer's failure never aborts the others;
//   - a dry run signs and broadcasts nothing.
//
// Nothing here touches a chain: provider, keystore, fees, decimals, symbol,
// balance and receipt are all injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, Interface, parseUnits } = require('ethers');
const { distributePair } = require('./distributePair');

const IFACE = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

const DEV = getAddress('0x' + 'de'.repeat(20));
const WA = getAddress('0x' + 'aa'.repeat(20));
const WB = getAddress('0x' + 'bb'.repeat(20));
const WC = getAddress('0x' + 'cc'.repeat(20));
const SPCX = getAddress('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa');

const wallets = [
  { id: 'dev', address: DEV, role: 'dev' },
  { id: 'a', address: WA, role: 'bundle' },
  { id: 'b', address: WB, role: 'bundle' },
  { id: 'c', address: WC, role: 'bundle' },
];

function fakeKeystore(signed) {
  return {
    list: () => wallets,
    devWallet: () => wallets[0],
    bundleWallets: () => wallets.slice(1), // a, b, c
    signer: (id) => ({
      async signTransaction(tx) {
        signed.push({ id, tx });
        return `SIGNED:${id}:${tx.nonce}`;
      },
    }),
  };
}

function fakeProvider({ native = 10n ** 18n, order = [], failAttempt = null, nonceStart = 5 } = {}) {
  let nonce = nonceStart;
  let attempts = 0;
  return {
    order,
    async getBalance() {
      return native;
    },
    async getTransactionCount() {
      return nonce; // 'pending'
    },
    async broadcastTransaction(raw) {
      attempts += 1;
      if (failAttempt && attempts === failAttempt) throw new Error('broadcast rejected');
      order.push(raw);
      nonce += 1; // a landed tx consumes the nonce; a failed broadcast does not
      return { hash: `hash:${raw}` };
    },
  };
}

const baseDeps = (over = {}) => ({
  getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
  // Authoritative decimals come from the factory economics, not the ERC-20 read.
  pairEconomics: async () => ({ decimals: 18 }),
  getSymbol: async () => 'SPCX',
  readTokenBalance: async () => 1000n * 10n ** 18n, // source holds plenty
  waitForReceipt: async () => ({ status: 1, blockNumber: 10 }),
  ...over,
});

const decodeTransfer = (tx) => {
  const [to, amount] = IFACE.decodeFunctionData('transfer', tx.data);
  return { to: getAddress(to), amount };
};

test('transfers exactly the requested amounts to each wallet, from the source, confirmed', async () => {
  const signed = [];
  const rpc = fakeProvider();
  const res = await distributePair(
    {
      pairToken: SPCX,
      transfers: [
        { walletId: 'a', amount: '10' },
        { walletId: 'b', amount: '6' },
        { walletId: 'c', amount: '4' },
      ],
    },
    baseDeps({ provider: rpc, keystore: fakeKeystore(signed) })
  );

  assert.equal(res.confirmed, 3);
  assert.equal(res.failed, 0);
  assert.equal(res.source.address, DEV);
  assert.equal(res.totalAmount, '20.0');

  // Each transfer carries the right recipient and amount, all from the dev signer.
  assert.equal(signed.length, 3);
  assert.ok(signed.every((s) => s.id === 'dev'), 'every transfer is signed by the source wallet');
  assert.ok(signed.every((s) => getAddress(s.tx.to) === SPCX), 'every transfer targets the pair token');
  const byRecipient = {};
  for (const s of signed) {
    const { to, amount } = decodeTransfer(s.tx);
    byRecipient[to] = amount;
  }
  assert.equal(byRecipient[WA], parseUnits('10', 18));
  assert.equal(byRecipient[WB], parseUnits('6', 18));
  assert.equal(byRecipient[WC], parseUnits('4', 18));
});

test('the source nonces are consecutive and gap-free', async () => {
  const signed = [];
  const rpc = fakeProvider({ nonceStart: 5 });
  await distributePair(
    { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '1' }, { walletId: 'b', amount: '1' }, { walletId: 'c', amount: '1' }] },
    baseDeps({ provider: rpc, keystore: fakeKeystore(signed) })
  );
  assert.deepEqual(signed.map((s) => s.tx.nonce), [5, 6, 7]);
});

test('a failed transfer does not abort the others, and leaves NO nonce gap', async () => {
  const signed = [];
  // The 2nd broadcast (wallet B) will not go out.
  const rpc = fakeProvider({ failAttempt: 2 });
  const res = await distributePair(
    { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '1' }, { walletId: 'b', amount: '1' }, { walletId: 'c', amount: '1' }] },
    baseDeps({ provider: rpc, keystore: fakeKeystore(signed) })
  );

  const a = res.transfers.find((t) => t.walletId === 'a');
  const b = res.transfers.find((t) => t.walletId === 'b');
  const c = res.transfers.find((t) => t.walletId === 'c');
  assert.equal(a.status, 'confirmed');
  assert.equal(b.status, 'failed');
  assert.equal(c.status, 'confirmed');
  // B failed to broadcast, so it did not consume nonce 6 — C reuses it, no gap.
  assert.equal(a.nonce, 5);
  assert.equal(c.nonce, 6, 'the failed transfer left no gap; the next reused its nonce');
  assert.equal(res.confirmed, 2);
  assert.equal(res.failed, 1);
});

test('refuses an unknown recipient wallet before anything is signed', async () => {
  const signed = [];
  await assert.rejects(
    () =>
      distributePair(
        { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '1' }, { walletId: 'ghost', amount: '1' }] },
        baseDeps({ provider: fakeProvider(), keystore: fakeKeystore(signed) })
      ),
    /ghost is not a v1 bundle wallet/
  );
  assert.equal(signed.length, 0, 'nothing is signed when a recipient is unknown');
});

test('refuses a recipient that is a launcher wallet but NOT a bundle wallet (e.g. the dev wallet)', async () => {
  const signed = [];
  // 'dev' is a real, keystore-owned wallet, but not a bundle wallet — SPCX sent
  // there would strand and mis-size the launch, so it must be refused.
  await assert.rejects(
    () =>
      distributePair(
        { pairToken: SPCX, transfers: [{ walletId: 'dev', amount: '1' }] },
        baseDeps({ provider: fakeProvider(), keystore: fakeKeystore(signed) })
      ),
    /dev is not a v1 bundle wallet/
  );
  assert.equal(signed.length, 0);
});

test('refuses a duplicate walletId rather than over-distributing to it', async () => {
  const signed = [];
  await assert.rejects(
    () =>
      distributePair(
        { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '5' }, { walletId: 'a', amount: '5' }] },
        baseDeps({ provider: fakeProvider(), keystore: fakeKeystore(signed) })
      ),
    /wallet a is listed twice/
  );
  assert.equal(signed.length, 0);
});

test('refuses to send to the source wallet itself', async () => {
  const signed = [];
  // Source a bundle wallet and try to send to it — the self-send guard fires.
  await assert.rejects(
    () =>
      distributePair(
        { pairToken: SPCX, sourceWalletId: 'a', transfers: [{ walletId: 'a', amount: '1' }] },
        baseDeps({ provider: fakeProvider(), keystore: fakeKeystore(signed) })
      ),
    /source wallet itself/
  );
  assert.equal(signed.length, 0);
});

test('refuses a non-positive amount', async () => {
  const signed = [];
  await assert.rejects(
    () =>
      distributePair(
        { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '0' }] },
        baseDeps({ provider: fakeProvider(), keystore: fakeKeystore(signed) })
      ),
    /non-positive amount/
  );
  assert.equal(signed.length, 0);
});

test('refuses up front when the source holds too little of the pair token', async () => {
  const signed = [];
  await assert.rejects(
    () =>
      distributePair(
        { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '10' }, { walletId: 'b', amount: '10' }] },
        baseDeps({
          provider: fakeProvider(),
          keystore: fakeKeystore(signed),
          readTokenBalance: async () => 5n * 10n ** 18n, // only 5, needs 20
        })
      ),
    /needs 20\.0 SPCX to distribute/
  );
  assert.equal(signed.length, 0, 'nothing is signed when the source is short of the token');
});

test('refuses up front when the source cannot pay the transfer gas', async () => {
  const signed = [];
  await assert.rejects(
    () =>
      distributePair(
        { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '1' }, { walletId: 'b', amount: '1' }] },
        baseDeps({
          provider: fakeProvider({ native: 1n }), // basically no ETH for gas
          keystore: fakeKeystore(signed),
        })
      ),
    /needs about .* ETH/
  );
  assert.equal(signed.length, 0);
});

test('a dry run validates and prices but signs and broadcasts nothing', async () => {
  const signed = [];
  const rpc = fakeProvider();
  const res = await distributePair(
    { pairToken: SPCX, dryRun: true, transfers: [{ walletId: 'a', amount: '10' }, { walletId: 'b', amount: '6' }] },
    baseDeps({ provider: rpc, keystore: fakeKeystore(signed) })
  );
  assert.equal(res.dryRun, true);
  assert.equal(res.totalAmount, '16.0');
  assert.ok(res.transfers.every((t) => t.status === 'planned'));
  assert.equal(signed.length, 0, 'a dry run signs nothing');
  assert.equal(rpc.order.length, 0, 'a dry run broadcasts nothing');
});

test('amounts are parsed at the pair token decimals, not always 18', async () => {
  const signed = [];
  const res = await distributePair(
    { pairToken: SPCX, transfers: [{ walletId: 'a', amount: '10' }] },
    baseDeps({
      provider: fakeProvider(),
      keystore: fakeKeystore(signed),
      pairEconomics: async () => ({ decimals: 6 }), // a 6-decimal pair token
      getSymbol: async () => 'USDG',
      readTokenBalance: async () => 1000n * 10n ** 6n,
    })
  );
  const { amount } = decodeTransfer(signed[0].tx);
  assert.equal(amount, parseUnits('10', 6), '10 tokens at 6 decimals = 10_000_000');
  assert.equal(res.decimals, 6);
});
