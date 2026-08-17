'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The guarantee: after persist(), no partially-written file is ever visible at
// the keystore path. We prove it by asserting the temp file is gone and the
// real file parses — a plain writeFileSync of a large object can leave the
// second untrue if the process dies, and leaves no temp file at all.
//
// Those black-box checks alone cannot fail against the OLD, non-atomic
// persist() when nothing actually crashes mid-write: a plain
// writeFileSync(file, ...) never creates a `.tmp` file either, so "no debris"
// passes trivially, and the resulting bytes at rest are identical either way.
// So this test also spies on fs.writeFileSync/fs.renameSync to assert the
// MECHANISM directly — persist() must never write straight onto the live
// path, and must rename a `.tmp` sibling onto it. That is what genuinely
// distinguishes the two implementations without needing to simulate a crash.
test('persist writes through a temp file and leaves no debris', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  process.env.KEYSTORE_PASSPHRASE = 'test-passphrase';
  process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./keystore')];
  const { keystoreFor } = require('./keystore');

  const file = process.env.KEYSTORE_PATH;

  // Default mock implementation calls through to the real fs method, so
  // behaviour is unchanged — this only records what persist() actually calls.
  const writeSpy = t.mock.method(fs, 'writeFileSync');
  const renameSpy = t.mock.method(fs, 'renameSync');

  const ks = keystoreFor('default');
  ks.generate(2, { role: 'bundle' });

  assert.equal(fs.existsSync(file), true, 'keystore file exists');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'temp file was renamed away');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));

  // Windows/NTFS does not honour POSIX permission bits — writeFileSync's mode
  // option and chmodSync only toggle the read-only DOS attribute, so
  // fs.statSync().mode reports 0o666 for a writable file regardless of what
  // mode was requested, on BOTH the old and the new persist(). Verified
  // directly against this filesystem outside of this implementation change.
  // The mode is still asserted on POSIX platforms, where it is meaningful.
  if (process.platform !== 'win32') {
    const stat = fs.statSync(file);
    assert.equal(stat.mode & 0o777, 0o600, 'still 0600');
  }

  // The real proof: persist() must never call writeFileSync with the live
  // keystore path, and must renameSync a `.tmp` sibling onto it.
  const wroteDirectlyToFile = writeSpy.mock.calls.some((c) => c.arguments[0] === file);
  assert.equal(wroteDirectlyToFile, false, 'persist() must never write straight onto the live keystore path');

  const renamedTmpOntoFile = renameSpy.mock.calls.some(
    (c) => c.arguments[0] === `${file}.tmp` && c.arguments[1] === file
  );
  assert.equal(renamedTmpOntoFile, true, 'persist() must rename a .tmp sibling onto the live keystore path');
});
