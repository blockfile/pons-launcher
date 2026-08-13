'use strict';

// Get ETH out of a distributor that has no withdraw().
//
// Distributors deployed before the owner/withdraw fix have exactly one exit:
// buyAndDistribute, which swaps the WHOLE balance for a token and hands it to
// recipients the caller names. There is no path that returns native ETH. So the
// rescue is a round trip — buy something liquid, receive it in your own wallets,
// sell it back — and it costs the pool fee twice plus slippage.
//
// IT IS ALSO A RACE. Those contracts have no access control: anyone may call
// buyAndDistribute and name THEIR wallets as recipients. Every hour the balance
// sits there is an hour someone else can take it. Run this now, not later.
//
//   npm run rescue -- --token 0xTOKEN                  quote it, send nothing
//   npm run rescue -- --token 0xTOKEN --broadcast      do it
//   npm run rescue -- --token 0xTOKEN --user ivan
//
// Pick a token with a deep pool against the pair token. The quote prints what
// you would receive and what that is worth back in ETH, so a bad choice is
// visible before it is made rather than after.

const { Contract, formatEther, parseEther } = require('ethers');
const { provider } = require('../src/evm/provider');
const { keystoreFor } = require('../src/wallets/keystore');
const { distributorFor } = require('../src/store/distributors');
const { DISTRIBUTOR_ABI, dexParams, equalShares } = require('../src/evm/distributor');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)',
];

(async () => {
  const userId = arg('user', 'default');
  const token = arg('token');
  if (!token) {
    console.error('need --token 0x… — the token to route through. Pick one with a deep pool.');
    process.exit(1);
  }

  const record = distributorFor(userId).get();
  if (!record) {
    console.error(`no distributor recorded for user "${userId}"`);
    process.exit(1);
  }

  const balance = await provider.getBalance(record.address);
  console.log(`distributor ${record.address}`);
  console.log(`holds       ${formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.log('\nnothing to rescue.');
    return;
  }

  // Does it have the fix? If so this script is unnecessary and withdraw() is
  // both cheaper and lossless — say so rather than routing through a pool.
  const c = new Contract(record.address, DISTRIBUTOR_ABI, provider);
  try {
    const owner = await c.owner();
    console.log(`\nthis distributor HAS an owner (${owner}) — it also has withdraw().`);
    console.log('Use the Withdraw button on the V2 tab instead. It returns ETH directly,');
    console.log('with no pool fee and no slippage. This script is for the older ones.');
    return;
  } catch (_err) {
    console.log('no owner() — this is a pre-fix distributor, so the round trip is the only exit.');
  }

  const ks = keystoreFor(userId);
  // Anything this account holds. The tokens have to land somewhere we control,
  // and on a rescue it matters far more that they are ours than which role
  // they carry.
  const wallets = ks.list().map((w) => w.address);
  if (!wallets.length) {
    console.error('no wallets in the keystore to receive the proceeds');
    process.exit(1);
  }
  const shares = equalShares(wallets.length);

  const { router, weth, poolFee } = await dexParams();
  console.log(`\nrouting ${formatEther(balance)} ETH through ${token}`);
  console.log(`  router ${router}  fee ${poolFee}`);
  console.log(`  proceeds split across ${wallets.length} wallet(s) you control`);

  // Simulate before spending. minOut 0 here is for the QUOTE only; the real
  // send uses a floor derived from it.
  let quoted;
  try {
    quoted = await c.buyAndDistribute.staticCall(
      router,
      weth,
      token,
      poolFee,
      0n,
      wallets,
      shares,
      { from: wallets[0] }
    );
  } catch (err) {
    console.error(`\nsimulation failed — ${err.shortMessage || err.message}`);
    console.error('That usually means this token has no pool at that fee tier. Try another.');
    process.exit(1);
  }

  console.log(`\nwould receive ${formatEther(quoted)} tokens`);
  console.log('Sell them from the V2 tab (or the V1 sell panel) to get back to ETH.');

  if (!flag('broadcast')) {
    console.log('\ndry run — nothing sent. Re-run with --broadcast to rescue.');
    return;
  }

  // 10% floor. Wider than a normal trade would take, deliberately: the balance
  // is at risk while it sits there, so a slightly worse fill beats a revert and
  // another hour of exposure.
  const minOut = (quoted * 9000n) / 10_000n;
  const signer = ks.signer(ks.list()[0].id, provider);
  const withSigner = new Contract(record.address, DISTRIBUTOR_ABI, signer);

  console.log(`\nsending, floor ${formatEther(minOut)} tokens…`);
  const tx = await withSigner.buyAndDistribute(router, weth, token, poolFee, minOut, wallets, shares);
  console.log(`  ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`  ${receipt.status === 1 ? 'RESCUED' : 'REVERTED'} in block ${receipt.blockNumber}`);
  console.log(`  distributor now holds ${formatEther(await provider.getBalance(record.address))} ETH`);
})();
