'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.PONS_IPFS_UPLOAD_URL = 'https://worker.test/public/ipfs/image';
process.env.IPFS_GATEWAY_URL = 'https://gateway.test/ipfs/';

const { assertUploadable, uploadImage } = require('./upload');

/** Swap global fetch for one call, capturing what the module sent. */
async function withFetch(respond, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const responds = (body, status = 200) => () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('assertUploadable accepts exactly the three types pons accepts', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(assertUploadable(t, 10), t);
  }
  assert.equal(assertUploadable('IMAGE/PNG; charset=binary', 10), 'image/png');
});

test('assertUploadable rejects gif, non-images, empty and oversize', () => {
  assert.throws(() => assertUploadable('image/gif', 10), /PNG, JPEG or WebP/);
  assert.throws(() => assertUploadable('text/html', 10), /PNG, JPEG or WebP/);
  assert.throws(() => assertUploadable('image/png', 0), /empty/);
  assert.throws(() => assertUploadable('image/png', 5 * 1024 * 1024 + 1), /smaller than 5 MB/);
});

test('uploadImage posts the bytes as multipart "image" and returns uri + gateway url', async () => {
  await withFetch(responds({ uri: 'ipfs://bafkreiabc123' }), async (calls) => {
    const out = await uploadImage(png, 'image/png');
    assert.deepEqual(out, {
      uri: 'ipfs://bafkreiabc123',
      gatewayUrl: 'https://gateway.test/ipfs/bafkreiabc123',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://worker.test/public/ipfs/image');
    assert.equal(calls[0].init.method, 'POST');
    const sent = calls[0].init.body.get('image');
    assert.equal(sent.type, 'image/png');
    assert.equal(sent.size, png.length);
  });
});

test('uploadImage surfaces the worker own error text', async () => {
  await withFetch(responds({ error: 'moderation rejected' }, 422), async () => {
    await assert.rejects(() => uploadImage(png, 'image/png'), /moderation rejected/);
  });
});

test('uploadImage refuses a 200 that carries no usable ipfs uri', async () => {
  await withFetch(responds({ uri: 'https://evil.example/x.png' }), async () => {
    await assert.rejects(() => uploadImage(png, 'image/png'), /ipfs/);
  });
});

test('uploadImage reports an unreachable worker as such', async () => {
  await withFetch(
    () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
    async () => {
      await assert.rejects(() => uploadImage(png, 'image/png'), /unreachable/);
    }
  );
});
