'use strict';

// User administration is a shell job, deliberately. There is no admin role, so
// there is no one the app could authorise to create users over HTTP — whoever
// can create users can create themselves.

const users = require('../src/users/users');

const [, , command, name, ...flags] = process.argv;

function usage() {
  console.log(`
usage:
  npm run user:add -- <name>            create a user and print their key once
  npm run user:add -- <name> --adopt    …and hand them the existing wallets
  npm run user:list                     names and creation dates
  npm run user:remove -- <name>         revoke a user (their keystore stays on disk)
`);
}

try {
  if (command === 'add') {
    const { user, key } = users.create(name);
    if (flags.includes('--adopt')) {
      const { adoptLegacy } = require('../src/wallets/keystore');
      const moved = adoptLegacy(user.id);
      console.log(moved ? `adopted the existing keystore as ${user.id}` : 'no existing keystore to adopt');
    }
    console.log(`\nuser:  ${user.name}`);
    console.log(`key:   ${key}`);
    console.log('\nThis key is shown once and is not stored anywhere. Save it now.\n');
  } else if (command === 'list') {
    const all = users.list();
    if (!all.length) return console.log('no users — this deployment is single-tenant');
    for (const u of all) console.log(`${u.id.padEnd(20)} created ${u.createdAt.slice(0, 10)}`);
  } else if (command === 'remove') {
    console.log(users.remove(name).removed + ' removed');
  } else {
    usage();
    process.exit(1);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
