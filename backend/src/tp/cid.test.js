'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { parseCid, cidFromLogoUri } = require('./cid');

// Real pons logo CIDs (token.getTokenInfo().logo, sampled 2026-09-19).
const RAW = 'bafkreif2nctwv7yv2iuqzw3jfrpe6iq6ko4vqxe7valfgejqtaox26pms4';
const DAGPB_V1 = 'bafybeidvrpifzshr62snyuyepzjdj466huvmicxocnhrz4ayozto7dwmsq';
const V0 = 'QmPmVbpMQzDW5kA84Q3N7hRyuz43xTf329DGNP8W1xULGQ';

/** An independent RFC 4648 base32 encoder (lower case, unpadded) for building test CIDs. */
function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const cidV1 = (codec, digest, hash = 0x12) => 'b' + base32([0x01, codec, hash, 0x20, ...digest]);

test('parseCid: the three real CID kinds decode to a 32-byte sha2-256 digest', () => {
  const raw = parseCid(RAW);
  assert.equal(raw.version, 1);
  assert.equal(raw.codec, 'raw');
  assert.equal(raw.digest.length, 32);
  assert.equal(raw.cid, RAW);
  const pb = parseCid(DAGPB_V1);
  assert.equal(pb.version, 1);
  assert.equal(pb.codec, 'dag-pb');
  const v0 = parseCid(V0);
  assert.equal(v0.version, 0);
  assert.equal(v0.codec, 'dag-pb');
  assert.equal(v0.digest.length, 32);
});

test('parseCid: a raw CID built from bytes carries exactly their sha256', () => {
  const bytes = crypto.randomBytes(100);
  const digest = crypto.createHash('sha256').update(bytes).digest();
  const cid = cidV1(0x55, digest);
  assert.match(cid, /^bafkrei/, 'the familiar prefix of a raw sha2-256 CIDv1');
  assert.ok(parseCid(cid).digest.equals(digest));
});

test('parseCid: every other codec, hash, base, length or spelling is refused', () => {
  const digest = crypto.randomBytes(32);
  const bad = [
    cidV1(0x71, digest), // dag-cbor
    cidV1(0x55, digest, 0x13), // sha2-512 code with a 32-byte length
    RAW.toUpperCase(),
    'B' + RAW.slice(1),
    RAW.slice(0, -1),
    RAW + 'a',
    RAW.slice(0, -1) + 'z', // non-zero leftover bits: not the canonical spelling
    'z' + RAW.slice(1), // base58btc multibase
    V0.slice(0, -1),
    V0.slice(0, -1) + '0', // '0' is not base58
    'Qm' + 'l'.repeat(44), // 'l' is not base58
    '',
    null,
    42,
    { cid: RAW },
  ];
  for (const value of bad) assert.equal(parseCid(value), null, String(value));
});

test('cidFromLogoUri: ipfs://, gateway URLs and bare CIDs yield the CID; the host is dropped', () => {
  const cases = [
    ['ipfs://' + RAW, RAW],
    ['  ipfs://' + V0 + '  ', V0],
    ['IPFS://' + RAW, RAW],
    ['ipfs://ipfs/' + RAW, RAW],
    ['ipfs://' + RAW + '/', RAW],
    ['https://ipfs.io/ipfs/' + V0, V0],
    ['https://gateway.pinata.cloud/ipfs/' + DAGPB_V1, DAGPB_V1],
    ['https://ipfs.filebase.io/ipfs/' + V0 + '/', V0],
    ['https://dct7n28vyz94d.cloudfront.net/ipfs/' + V0 + '?img-width=256', V0],
    ['http://evil.example/ipfs/' + RAW + '#x', RAW],
    [DAGPB_V1, DAGPB_V1],
  ];
  for (const [input, want] of cases) assert.equal(cidFromLogoUri(input), want, input);
});

test('cidFromLogoUri: everything else is no logo', () => {
  const cases = [
    'https://img.koyen.fun/pons_7635048945_1789821037.jpg',
    'https://pbs.twimg.com/media/HSlF-uIaUAEn4ca.png',
    'https://46-225-60-163.sslip.io/meta/ed948881338b712f0ab59540201614e3c061c8f9fb8e840c406d8936d2e09bfb.webp',
    'https://ipfs.io/ipfs/' + DAGPB_V1 + '/logo.png', // a file inside a directory CID
    'https://ipfs.io/ipns/example.com',
    'https://ipfs.io/ipfs/',
    'ipfs://' + RAW + '/logo.png',
    'ipfs://not-a-cid',
    'data:image/png;base64,iVBORw0KGgo=',
    'javascript:alert(1)',
    'ftp://host/ipfs/' + RAW,
    'ipfs://' + RAW + '/'.repeat(300),
    '',
    '   ',
    null,
    undefined,
    7,
  ];
  for (const input of cases) assert.equal(cidFromLogoUri(input), null, String(input));
});
