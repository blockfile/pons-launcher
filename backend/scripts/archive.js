'use strict';

// The archive of deleted wallets — a shell job, deliberately, like user.js.
//
// A delete moves the wallet's key into an archive beside the keystore instead
// of dropping it (see src/wallets/keystore.js). Reading that archive, restoring
// from it and purging it used to be three HTTP routes; they are these three
// commands now, and there are no routes at all.
//
// The reason is what the archive is FOR. It is the recovery path for a wallet
// gone wrong — a mis-click, a key handed to the wrong person, a compromise — so
// it must not be reachable with the credential such a compromise is most likely
// to yield. Whoever holds the API key can already delete wallets. If they could
// also read the archive they would know what else exists; if they could restore
// they could put a revoked key back into the live keystore; and if they could
// purge, a mistaken or malicious delete becomes permanent and the archive would
// have bought nothing. Getting to this file means getting to the server, and
// anyone on the server already holds the keystore itself.
//
// NO COMMAND HERE PRINTS KEY MATERIAL. `list` reads the metadata view the
// keystore exposes (address, label, role, dates) and there is no flag that
// turns it into a key viewer. The way to a plaintext key is unchanged: restore
// the wallet, then export it deliberately from the console.

const config = require('../src/config');
const keystore = require('../src/wallets/keystore');
const { activityFor } = require('../src/store/activity');
const users = require('../src/users/users');

function usage() {
  console.log(`
usage:
  npm run archive:list                          what has been deleted, newest first
  npm run archive:list -- --user <name>         …for that user's archive
  npm run archive:restore -- <id>               put one back in the live keystore
  npm run archive:purge -- <id> --confirm       destroy its key, for good

  <id>        the id from archive:list
  --user      read this user's archive, if user:add has been run
  --confirm   required by purge, and by nothing else

  KEYSTORE_PASSPHRASE must be set (backend/.env), as for every other
  keystore consumer.

examples:
  npm run archive:list -- --user alice
  npm run archive:restore -- 6f1c2b7e-... --user alice
  npm run archive:purge -- 6f1c2b7e-... --user alice --confirm
`);
}

/** Flags that take the next argument, so `--user alice` is not read as an id. */
const VALUED = ['--user'];

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.includes(a)) {
      // A flag that runs off the end, or that would swallow the next flag
      // ("--user --confirm"), has no value. Recorded as `true` so main() can
      // refuse it: silently reading the DEFAULT archive because --user came
      // through empty is how the wrong user's wallets get restored or purged.
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) flags[a.slice(2)] = true;
      else flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { positional, flags };
}

/**
 * The archive to operate on. Without --user this is the 'default' keystore,
 * exactly as deploy-contract.js resolves its dev wallet.
 */
function archiveOf(userId) {
  return userId ? keystore.keystoreFor(userId) : keystore;
}

/**
 * The "pass --user" line, when there is a user to pass it.
 *
 * On a deployment where `user:add --adopt` has run, the wallets were renamed
 * under the user who adopted them and the archive travelled with them, so the
 * default file is empty or absent. "Nothing archived" would be a plain lie on a
 * machine that visibly has an archive — the same trap deploy-contract.js avoids
 * when it reports a missing dev wallet.
 */
function elsewhere(userId) {
  if (userId) return '';
  const names = users.enabled() ? users.list().map((u) => u.id) : [];
  return names.length
    ? `\nthis archive may belong to a user — pass --user ${names.join(' | ')}`
    : '';
}

/** Local time, with the raw ISO kept: these are timestamps to reason about. */
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
};

function list(userId) {
  const entries = archiveOf(userId).archived();
  if (!entries.length) {
    console.log(`nothing archived for ${userId || 'default'}${elsewhere(userId)}`);
    return;
  }

  console.log(`\n${entries.length} archived wallet(s) for ${userId || 'default'}, newest first:\n`);
  for (const e of entries) {
    console.log(`  ${e.id}  ${e.address}  ${String(e.role || '').padEnd(6)}  ${e.label || ''}`);
    console.log(`  ${' '.repeat(36)}  deleted ${when(e.deletedAt)}`);
  }

  // The cap is stated on every listing, not buried in the README, because it is
  // the one thing on this screen that can destroy a key without anyone asking:
  // at the cap, the next delete evicts the last line here. See MAX_ARCHIVED.
  const left = keystore.MAX_ARCHIVED - entries.length;
  console.log(
    `\nthe archive keeps ${keystore.MAX_ARCHIVED} per user. ` +
      (left > 0
        ? `${left} more delete(s) before the oldest is evicted and its key destroyed.`
        : 'IT IS FULL — the next delete destroys the oldest key above.')
  );
  console.log('restore one with:  npm run archive:restore -- <id>' + (userId ? ` --user ${userId}` : ''));
}

/**
 * Put one back in the live keystore.
 *
 * Every refusal the old route had is still enforced, because none of them ever
 * lived in the route: a duplicate address, a second dev wallet, and an archived
 * key that no longer derives the address it is filed under are all checked by
 * keystore.restore(). Moving the surface could not lose them.
 */
function restore(userId, id) {
  let back;
  try {
    back = archiveOf(userId).restore(id);
  } catch (err) {
    if (/no archived wallet/.test(err.message)) throw new Error(err.message + elsewhere(userId));
    throw err;
  }

  activityFor(userId || 'default').record(
    'wallets',
    `restored wallet ${back.address} from the archive`,
    { address: back.address, role: back.role, via: 'archive:restore' }
  );
  console.log(`\nrestored ${back.address} (${back.role}) — back in the keystore as ${back.id}`);
  console.log('a running server reads the keystore per request; no restart needed.');
}

/**
 * Destroy an archived key for good.
 *
 * Deleting has to be able to mean deleting, so this exists — and it is the one
 * command here that cannot be undone, which is why it takes --confirm on top of
 * being a shell command on the server.
 */
function purge(userId, id, confirmed) {
  const ks = archiveOf(userId);
  if (!confirmed) {
    // Named before it is refused: the operator should be able to check they are
    // about to end the right wallet without first getting past the guard.
    const target = ks.archived().find((e) => e.id === id);
    throw new Error(
      `purging destroys the private key permanently — re-run with --confirm` +
        (target ? `\nthis would destroy the key for ${target.address} (${target.role})` : '')
    );
  }

  let out;
  try {
    out = ks.purge(id);
  } catch (err) {
    if (/no archived wallet/.test(err.message)) throw new Error(err.message + elsewhere(userId));
    throw err;
  }

  console.warn(`[pons-launcher] ARCHIVED KEY PURGED for wallet ${out.address}`);
  activityFor(userId || 'default').record(
    'wallets',
    `purged wallet ${out.address} — its key is destroyed`,
    { address: out.address, via: 'archive:purge' }
  );
  console.log(`\npurged ${out.address} — its key is gone. Only a downloaded backup holds it now.`);
}

function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, id] = positional;
  const userId = typeof flags.user === 'string' ? flags.user : undefined;

  if (!command || !['list', 'restore', 'purge'].includes(command)) {
    usage();
    process.exit(command ? 1 : 0);
  }
  if (flags.user === true) throw new Error('--user needs a name — e.g. --user alice');

  // Checked up front and for every command, not only for the one that
  // decrypts. A listing or a purge issued against a store this process cannot
  // open is not an operation worth allowing: the operator would be reading, and
  // destroying, entries whose keys may not even be recoverable.
  if (!config.keystorePassphrase) {
    throw new Error(
      'KEYSTORE_PASSPHRASE is not set — set it in backend/.env, as for every other keystore consumer'
    );
  }

  if (command === 'list') return list(userId);
  if (!id) throw new Error(`${command} needs an id — run npm run archive:list to see them`);
  if (command === 'restore') return restore(userId, id);
  return purge(userId, id, flags.confirm === true);
}

try {
  main();
} catch (err) {
  console.error(`\nerror: ${err.message}`);
  process.exit(1);
}
