'use strict';

// Token logos are pinned through ponsfamily's own IPFS uploader rather than a
// pinning account of our own. The tokens are deployed on their launchpad and
// rendered on their site, so the ipfs:// URI that goes on chain should be the
// same kind their /launchpad/create form produces.

const config = require('../config');

// Mirrors their client exactly. Their error copy mentions GIF; their accepted
// set does not include it, and the set is what the worker enforces.
const ACCEPTED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);
const MAX_BYTES = 5 * 1024 * 1024;
const IPFS_URI = /^ipfs:\/\/[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * The guards their form applies before spending a round trip. Returns the
 * normalised MIME type; throws with copy meant for the operator.
 */
function assertUploadable(mime, size) {
  const type = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!ACCEPTED.has(type)) throw new Error('Use a PNG, JPEG or WebP image.');
  if (!size) throw new Error('The image is empty.');
  if (size > MAX_BYTES) throw new Error('Images must be smaller than 5 MB.');
  return type;
}

/** ipfs://<cid> → a browser-loadable URL, for the console preview only. */
function gatewayUrl(uri) {
  return config.ipfsGatewayUrl + String(uri).replace(/^ipfs:\/\//, '');
}

/**
 * Pin one image and return its ipfs:// URI. That string is what goes on chain
 * as TokenParams.logo, so a malformed response must never be passed through —
 * a bad logo is baked into the CREATE2 preimage and cannot be edited later.
 */
async function uploadImage(buffer, mime) {
  const type = assertUploadable(mime, buffer ? buffer.length : 0);

  const form = new FormData();
  form.append('image', new Blob([buffer], { type }), `logo.${ACCEPTED.get(type)}`);

  let res;
  try {
    res = await fetch(config.ipfsUploadUrl, { method: 'POST', body: form });
  } catch (err) {
    throw new Error(`pons IPFS uploader unreachable: ${err.message}`);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`pons IPFS upload failed: ${(json && json.error) || res.status}`);
  }
  const uri = json && typeof json.uri === 'string' ? json.uri : '';
  if (!IPFS_URI.test(uri)) {
    throw new Error('pons IPFS upload returned no usable ipfs:// uri');
  }

  return { uri, gatewayUrl: gatewayUrl(uri) };
}

module.exports = { assertUploadable, uploadImage, gatewayUrl, ACCEPTED, MAX_BYTES };
