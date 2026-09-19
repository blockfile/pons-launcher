'use strict';

// IPFS content identifiers for the take-profit dApp's token logos (spec Addendum v2 D).
//
// A pons token stores its logo as free text (token.getTokenInfo().logo). The dApp shows a
// logo ONLY when that text names an IPFS CID, and then fetches the CID itself from fixed
// IPFS gateways (logo.js) — never from a host the text names: that host is chosen by
// whoever launched the token (SSRF). This module turns the text into a CID, or null.
//
// Accepted CIDs — every form seen on 428 sampled pons logos (2026-09-19):
//   CIDv0  'Qm' + 44 base58btc characters: the sha2-256 multihash of a dag-pb node
//   CIDv1  'b' + 58 base32 characters (RFC 4648 alphabet, lower case, no padding):
//          0x01 | codec (0x55 raw, 0x70 dag-pb) | 0x12 0x20 | 32-byte sha2-256 digest
// Any other codec, hash, multibase or length is refused. A raw-codec CID (bafkrei...)
// is the sha2-256 of the file itself, which lets logo.js verify what a gateway sends.
//
// Accepted logo texts:
//   ipfs://<cid>              73% of samples ('ipfs://ipfs/<cid>' and a trailing '/' too)
//   https://host/ipfs/<cid>   a gateway URL (5%): ONLY the CID is kept, the host is
//                             never contacted; a query or fragment is ignored, a path
//                             AFTER the CID (a file inside a directory) is refused
//   <cid>                     a bare CID (one sample)
// Everything else is not a CID. The 21% of samples on other https hosts are fetched
// instead through the SSRF-safe GET (tokenInfo.js -> safeFetch.js; spec section E
// decision 19); any other text is no logo.
//
// No escape sequences in this source (memory: write-tool-escapes).

const { decodeBase58, toBeArray } = require('ethers');

const MAX_URI = 300;
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{58}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const CODECS = Object.freeze({ 0x55: 'raw', 0x70: 'dag-pb' });
const SHA2_256 = 0x12;
const DIGEST_LEN = 0x20;

/** RFC 4648 base32 (lower case, unpadded) -> bytes, or null. Non-zero leftover bits are refused. */
function base32Decode(text) {
  const out = [];
  let value = 0;
  let bits = 0;
  for (const ch of text) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
    value &= (1 << bits) - 1;
  }
  return value === 0 ? Uint8Array.from(out) : null;
}

/**
 * A CID string -> {cid, version, codec, digest} or null. `digest` is the 32-byte
 * sha2-256 digest (a Buffer); `codec` is 'raw' or 'dag-pb'.
 */
function parseCid(value) {
  if (typeof value !== 'string') return null;
  if (CID_V0.test(value)) {
    let bytes;
    try {
      bytes = toBeArray(decodeBase58(value));
    } catch {
      return null;
    }
    if (bytes.length !== 34 || bytes[0] !== SHA2_256 || bytes[1] !== DIGEST_LEN) return null;
    return { cid: value, version: 0, codec: 'dag-pb', digest: Buffer.from(bytes.subarray(2)) };
  }
  if (CID_V1.test(value)) {
    const bytes = base32Decode(value.slice(1));
    if (!bytes || bytes.length !== 36) return null;
    if (bytes[0] !== 0x01 || bytes[2] !== SHA2_256 || bytes[3] !== DIGEST_LEN) return null;
    const codec = CODECS[bytes[1]];
    if (!codec) return null;
    return { cid: value, version: 1, codec, digest: Buffer.from(bytes.subarray(4)) };
  }
  return null;
}

const cidOrNull = (text) => {
  const parsed = parseCid(text);
  return parsed ? parsed.cid : null;
};

/** A token's logo text -> the IPFS CID it names, or null (see the header). */
function cidFromLogoUri(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URI) return null;

  if (s.slice(0, 7).toLowerCase() === 'ipfs://') {
    let rest = s.slice(7);
    if (rest.slice(0, 5).toLowerCase() === 'ipfs/') rest = rest.slice(5);
    if (rest.endsWith('/')) rest = rest.slice(0, -1);
    return cidOrNull(rest);
  }

  if (/^https?:[/][/]/i.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    const parts = url.pathname.split('/'); // '/ipfs/<cid>' -> ['', 'ipfs', '<cid>']
    const at = parts.indexOf('ipfs');
    if (at < 0 || at + 1 >= parts.length) return null;
    if (parts.slice(at + 2).some((p) => p !== '')) return null; // a file inside a directory
    return cidOrNull(parts[at + 1]);
  }

  return cidOrNull(s);
}

module.exports = { parseCid, cidFromLogoUri, MAX_URI };
