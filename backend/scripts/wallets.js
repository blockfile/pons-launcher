'use strict';

// What is in the keystore, and which of it is idle — addresses and balances only.
//
// The console shows this per tab; this is the same thing from the box, for the
// moments when you are already in a shell and need to pick a wallet for a script
// (npm run inclusion, a rescue, a check after a launch). It exists because the
// alternative was a twelve-line `node -e` pasted into a terminal, and one of those
// printed an RPC endpoint with its key in it.
//
//   npm run wallets                     every user, every wallet with a balance
//   npm run wallets -- --user ivan      one user
//   npm run wallets -- --all            include wallets holding nothing
//   npm run wallets -- --role bundle    one role (v1 bundle, v4master, v4seed, …)
//   npm run wallets -- --idle           only wallets with nothing in flight
//
// NEVER PRINTS A KEY. It reads the keystore's public view (keystore.list(), which
// cannot return key material) and asks the chain for balances. Nothing is signed
// and nothing is broadcast.

const { formatEther } = require('ethers');

const users = require('../src/users/users');
const { keystoreFor } = require('../src/wallets/keystore');
const { provider } = require('../src/evm/provider');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

// Balances and nonces for many wallets at once. Sequential would be a round trip
// per wallet on a keystore that can hold hundreds; the RPC degrades under wide
// concurrency (evm/v2/holdings.js:76-108), so this stays in small batches.
async function readAll(addresses, size = 8) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += size) {
    const batch = addresses.slice(i, i + size);
    const rows = await Promise.all(
      batch.map(async (address) => {
        try {
          const [balance, latest, pending] = await Promise.all([
            provider.getBalance(address),
            provider.getTransactionCount(address, 'latest'),
            provider.getTransactionCount(address, 'pending'),
          ]);
          return [address, { balance, latest, pending }];
        } catch (err) {
          return [address, { error: err.shortMessage || err.message }];
        }
      })
    );
    for (const [address, row] of rows) out.set(address, row);
  }
  return out;
}

async function main() {
  const wanted = arg('user', null);
  const role = arg('role', null);
  const showEmpty = flag('all');
  const idleOnly = flag('idle');

  const ids = users.enabled() ? users.list().map((u) => u.id) : ['default'];
  const chosen = wanted ? ids.filter((id) => id === wanted) : ids;
  if (wanted && !chosen.length) {
    console.error(`no user "${wanted}". Users: ${ids.join(', ') || '(none)'}`);
    process.exit(1);
  }
  if (!users.enabled()) console.log('(single-user keystore)');

  let grandTotal = 0n;
  for (const id of chosen) {
    let wallets = keystoreFor(id).list();
    if (role) wallets = wallets.filter((w) => String(w.role) === role);
    const state = await readAll(wallets.map((w) => w.address));

    const rows = wallets
      .map((w) => ({ ...w, ...(state.get(w.address) || {}) }))
      .filter((w) => showEmpty || (w.balance && w.balance > 0n))
      .filter((w) => !idleOnly || (w.pending !== undefined && w.pending === w.latest));

    const total = rows.reduce((sum, w) => sum + (w.balance || 0n), 0n);
    grandTotal += total;

    console.log(
      `\n${id} — ${rows.length} of ${wallets.length} wallet(s)` +
        `${role ? ` with role ${role}` : ''}${showEmpty ? '' : ' holding ETH'}, ${formatEther(total)} ETH in total`
    );
    if (!rows.length) continue;
    console.log('  role        address                                      balance         state  label');
    for (const w of rows) {
      const state_ = w.error ? 'ERR' : w.pending === w.latest ? 'idle' : `BUSY +${w.pending - w.latest}`;
      console.log(
        `  ${String(w.role || '').padEnd(11)} ${w.address}  ${formatEther(w.balance || 0n).padStart(14)}` +
          `  ${state_.padEnd(7)} ${w.label || ''}`
      );
    }
  }
  if (chosen.length > 1) console.log(`\nall users: ${formatEther(grandTotal)} ETH`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
