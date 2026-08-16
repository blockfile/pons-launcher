const test = require('node:test');
const assert = require('node:assert/strict');

const { roles, devWalletFor, bundleWalletsFor, DEFAULT_VARIANT } = require('./variants');

// A keystore stand-in. Only the four accessors the money paths reach for.
function fakeKeystore(wallets) {
  return {
    devWallet() {
      const dev = wallets.find((w) => w.role === 'dev');
      if (!dev) throw new Error('no dev wallet in the keystore — generate or import one first');
      return dev;
    },
    bundleWallets: () => wallets.filter((w) => w.role === 'bundle'),
    walletWithRole: (role) => wallets.find((w) => w.role === role) || null,
    walletsWithRole: (role) => wallets.filter((w) => w.role === role),
  };
}

const POPULATED = [
  { id: 'a', role: 'dev', address: '0xV1DEV' },
  { id: 'b', role: 'bundle', address: '0xV1B1' },
  { id: 'c', role: 'bundle', address: '0xV1B2' },
  { id: 'd', role: 'v2dev', address: '0xV2DEV' },
  { id: 'e', role: 'v2bundle', address: '0xV2B1' },
];

test('the default variant is v1, so an unchanged caller is unchanged', () => {
  assert.equal(DEFAULT_VARIANT, 'v1');
  assert.deepEqual(roles(), { dev: 'dev', bundle: 'bundle' });
  assert.deepEqual(roles('v1'), { dev: 'dev', bundle: 'bundle' });
});

test('omitting the variant resolves exactly what the hardcoded accessors returned', () => {
  const ks = fakeKeystore(POPULATED);
  assert.equal(devWalletFor(ks).address, ks.devWallet().address);
  assert.deepEqual(bundleWalletsFor(ks), ks.bundleWallets());
});

// The whole point of the separation: neither launcher can reach the other's
// money. If this ever fails, a v2 run is about to spend v1's funded wallets.
test('v2 never resolves a v1 wallet, and v1 never resolves a v2 wallet', () => {
  const ks = fakeKeystore(POPULATED);

  assert.equal(devWalletFor(ks, 'v1').address, '0xV1DEV');
  assert.equal(devWalletFor(ks, 'v2').address, '0xV2DEV');

  const v1 = bundleWalletsFor(ks, 'v1').map((w) => w.address);
  const v2 = bundleWalletsFor(ks, 'v2').map((w) => w.address);
  assert.deepEqual(v1, ['0xV1B1', '0xV1B2']);
  assert.deepEqual(v2, ['0xV2B1']);
  assert.equal(v1.some((a) => v2.includes(a)), false, 'the two sets must not overlap');
});

test('an unknown variant throws rather than falling back to v1', () => {
  const ks = fakeKeystore(POPULATED);
  // Falling back would point a mistyped v2 request at v1's funded wallets,
  // which is the one outcome the roles exist to prevent.
  assert.throws(() => roles('v3'), /unknown launcher variant "v3"/);
  assert.throws(() => devWalletFor(ks, 'typo'), /unknown launcher variant/);
  assert.throws(() => bundleWalletsFor(ks, 'typo'), /unknown launcher variant/);
});

test('a missing v2 dev wallet names the role it is missing', () => {
  const ks = fakeKeystore([{ id: 'a', role: 'dev', address: '0xV1DEV' }]);
  assert.throws(() => devWalletFor(ks, 'v2'), /no v2dev wallet in the keystore/);
  // v1 keeps its original wording — operators have been reading it for months.
  const empty = fakeKeystore([]);
  assert.throws(() => devWalletFor(empty, 'v1'), /no dev wallet in the keystore/);
});

test('a variant with no bundle wallets is empty, not an error', () => {
  const ks = fakeKeystore([{ id: 'd', role: 'v2dev', address: '0xV2DEV' }]);
  assert.deepEqual(bundleWalletsFor(ks, 'v2'), []);
});
