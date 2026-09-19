'use strict';

// The design spec records what the v2 build froze and what it accepts (Addendum v2,
// section E), so a later reader does not "fix" a deliberate choice and nobody edits
// the unlock message believing it is prose: its block must hash to the SHA-256 that
// frontend/src/dapp/account/messages.test.js pins for the code's own copy.
// No escape sequences (memory: write-tool-escapes).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SPEC = path.resolve(__dirname, '..', '..', '..', 'docs', 'superpowers', 'specs', '2026-09-19-tp-dapp-design.md');
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const FENCE = '```';
const UNLOCK_SHA256 = '2cd970a7db4e45e6e57b87fdd3ac142a34112bbd484c1a7ccac52da9f684a10f';

function sectionE() {
  const text = fs.readFileSync(SPEC, 'utf8').split(CR).join(''); // the working tree may be CRLF
  const at = text.indexOf(LF + '## E. ');
  assert.ok(at >= 0, 'the spec has Addendum v2 section E');
  return text.slice(at + 1);
}

test('section E carries the frozen unlock message byte for byte', () => {
  const e = sectionE();
  const open = `${FENCE}text unlock-message${LF}`;
  const from = e.indexOf(open);
  assert.ok(from >= 0, 'a text block marked unlock-message');
  const start = from + open.length;
  const body = e.slice(start, e.indexOf(`${LF}${FENCE}`, start));
  assert.equal(crypto.createHash('sha256').update(body, 'utf8').digest('hex'), UNLOCK_SHA256);
});

test('section E answers the nginx question, names the phishing risk and lists the decisions for sign-off', () => {
  const e = sectionE();
  for (const s of [
    'nginx basic auth unchanged',
    'Accepted risk: a phished unlock signature',
    'Ivan accepted this risk on 2026-09-19',
    'Frozen forever',
    'Decisions for sign-off',
    'Approved by Ivan on 2026-09-19',
  ]) {
    assert.ok(e.includes(s), `section E lacks: ${s}`);
  }
  const numbered = e.split(LF).filter((l) => /^[0-9]+[.] /.test(l)).map((l) => Number(l.split('.')[0]));
  assert.deepEqual(numbered, Array.from({ length: numbered.length }, (_, i) => i + 1), 'one numbered list, 1..n');
  assert.equal(numbered.length, 23, 'the 23 decisions Ivan approved');
});
