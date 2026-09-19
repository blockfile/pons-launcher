import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
  buildBody,
  parseSse,
  openStream,
  getToken,
  postWallets,
  getFees,
  postQuote,
  postPairQuote,
  broadcast,
  sidFor,
  logoPath,
} from './api.js';

// No escape sequences in this file on purpose (memory: write-tool-escapes).
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const TOKEN = '0xd8865aa9052a5e2f59641bb613ca84ec9377b101';
const PAIR = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';

async function signedTx() {
  const w = Wallet.createRandom();
  return w.signTransaction({
    to: TOKEN,
    data: '0x095ea7b3' + '00'.repeat(64),
    value: 0n,
    nonce: 0,
    gasLimit: 100000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 0n,
    chainId: 4663,
    type: 2,
  });
}

/** A fetch that records calls and answers from a queue of (init) => response factories. */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next(init);
  };
  fn.calls = calls;
  return fn;
}

const jsonAnswer = (status, body) => () => ({
  ok: status >= 200 && status < 300,
  status,
  body: null,
  json: async () => body,
});

/** An SSE response whose body enqueues `chunks` then closes (or stays open until aborted). */
const sseAnswer = (chunks, { keepOpen = false } = {}) => (init) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      if (!keepOpen) controller.close();
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'));
          } catch {
            // already closed
          }
        });
      }
    },
  });
  return { ok: true, status: 200, body, json: async () => null };
};

function fakeTimers() {
  const queue = [];
  let id = 0;
  return {
    queue,
    setTimeout: (fn, ms) => {
      id += 1;
      queue.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (x) => {
      const i = queue.findIndex((t) => t.id === x);
      if (i >= 0) queue.splice(i, 1);
    },
    runNext() {
      const t = queue.shift();
      t.fn();
      return t;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, max = 200) {
  for (let i = 0; i < max; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('condition never became true');
}

// ── buildBody ────────────────────────────────────────────────────────────────

test('buildBody sends exactly the allowlisted fields for each kind', async () => {
  const a = Wallet.createRandom().address;
  assert.equal(
    buildBody('wallets', { token: TOKEN, addresses: [a] }),
    JSON.stringify({ token: TOKEN, addresses: [a.toLowerCase()] })
  );
  assert.equal(
    buildBody('quote', { token: TOKEN, sells: [{ address: a, amount: 5n }] }),
    JSON.stringify({ token: TOKEN, sells: [{ address: a.toLowerCase(), amount: '5' }] })
  );
  assert.equal(
    buildBody('pairQuote', { pairToken: PAIR, amount: '123' }),
    JSON.stringify({ pairToken: PAIR, amount: '123' })
  );
  const raw = await signedTx();
  assert.equal(buildBody('broadcast', { token: TOKEN, txs: [raw] }), JSON.stringify({ token: TOKEN, txs: [raw] }));
});

test('a quote may carry `ahead` — the tokens still in flight, a whole amount — and leaves it out when absent', async () => {
  const a = Wallet.createRandom().address;
  const sells = [{ address: a, amount: '7' }];
  const want = [{ address: a.toLowerCase(), amount: '7' }];
  assert.equal(buildBody('quote', { token: TOKEN, sells, ahead: 500n }), JSON.stringify({ token: TOKEN, sells: want, ahead: '500' }));
  assert.equal(buildBody('quote', { token: TOKEN, sells, ahead: undefined }), JSON.stringify({ token: TOKEN, sells: want }));
  for (const bad of ['-1', '0', '1.5', 7, 'x']) assert.throws(() => buildBody('quote', { token: TOKEN, sells, ahead: bad }), /ahead/, String(bad));
  const fetch = fakeFetch([jsonAnswer(200, { quotes: [] }), jsonAnswer(200, { quotes: [] })]);
  await postQuote(TOKEN, sells, { fetch, ahead: '500' });
  await postQuote(TOKEN, sells, { fetch });
  assert.equal(fetch.calls[0].init.body, JSON.stringify({ token: TOKEN, sells: want, ahead: '500' }));
  assert.equal(fetch.calls[1].init.body, JSON.stringify({ token: TOKEN, sells: want }));
});

test('buildBody refuses an unknown kind and any field outside the allowlist, without echoing it', () => {
  const secretName = Wallet.createRandom().privateKey;
  assert.throws(() => buildBody('export', { token: TOKEN }), /unknown request kind/);
  let err;
  try {
    buildBody('wallets', { token: TOKEN, addresses: [TOKEN], [secretName]: 1 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'an extra field must throw');
  assert.equal(err.cause.code, 'bad_request');
  assert.ok(!err.message.includes(secretName.slice(2)), 'the message never echoes the field');
  assert.throws(() => buildBody('quote', { token: TOKEN, sells: [{ address: TOKEN, amount: '1', privateKey: 'x' }] }), /not allowed/);
  assert.throws(() => buildBody('broadcast', { token: TOKEN, txs: [], extra: 1 }), /not allowed/);
});

test('no body can carry a private key, in any field or form', () => {
  const key = Wallet.createRandom().privateKey; // 0x + 64 hex, generated here, never stored
  const bare = key.slice(2);
  const attempts = [
    ['wallets', { token: key, addresses: [TOKEN] }],
    ['wallets', { token: TOKEN, addresses: [key] }],
    ['wallets', { token: TOKEN, addresses: [bare] }],
    ['quote', { token: TOKEN, sells: [{ address: key, amount: '1' }] }],
    ['quote', { token: TOKEN, sells: [{ address: TOKEN, amount: bare }] }],
    ['quote', { token: TOKEN, sells: [{ address: TOKEN, amount: BigInt(key).toString() }] }],
    ['pairQuote', { pairToken: key, amount: '1' }],
    ['pairQuote', { pairToken: PAIR, amount: BigInt(key) }],
    ['broadcast', { token: TOKEN, txs: [key] }],
    ['broadcast', { token: TOKEN, txs: ['0x02' + bare] }],
  ];
  for (const [kind, fields] of attempts) {
    let err;
    try {
      buildBody(kind, fields);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `${kind} must refuse a key-shaped value`);
    assert.ok(!err.message.includes(bare), 'the error never echoes the key');
  }
});

test('broadcast accepts only signed type-2 transactions, at most 100', async () => {
  const raw = await signedTx();
  assert.throws(() => buildBody('broadcast', { token: TOKEN, txs: [] }), /non-empty/);
  assert.throws(() => buildBody('broadcast', { token: TOKEN, txs: Array(101).fill(raw) }), /more than 100/);
  assert.throws(() => buildBody('broadcast', { token: TOKEN, txs: ['0xf86c' + raw.slice(6)] }), /signed type-2/);
  assert.throws(() => buildBody('broadcast', { token: TOKEN, txs: [raw + '0'] }), /signed type-2/);
  assert.equal(JSON.parse(buildBody('broadcast', { token: TOKEN, txs: Array(100).fill(raw) })).txs.length, 100);
});

test('amounts are positive whole base units below 2^128', () => {
  assert.throws(() => buildBody('pairQuote', { pairToken: PAIR, amount: '0' }), /out of range/);
  assert.throws(() => buildBody('pairQuote', { pairToken: PAIR, amount: '1.5' }), /whole number/);
  assert.throws(() => buildBody('pairQuote', { pairToken: PAIR, amount: -1n }), /out of range/);
  assert.throws(() => buildBody('pairQuote', { pairToken: PAIR, amount: 12 }), /whole number/);
  assert.throws(() => buildBody('pairQuote', { pairToken: PAIR, amount: (1n << 128n).toString() }), /out of range/);
  assert.equal(JSON.parse(buildBody('pairQuote', { pairToken: PAIR, amount: 10n ** 27n })).amount, '1000000000000000000000000000');
});

// ── fetch wrappers ───────────────────────────────────────────────────────────

test('each wrapper calls its route with its method and allowlisted body', async () => {
  const a = Wallet.createRandom().address;
  const raw = await signedTx();
  const fetch = fakeFetch([
    jsonAnswer(200, { venue: { kind: 'curve' }, mark: {} }),
    jsonAnswer(200, { wallets: [] }),
    jsonAnswer(200, { maxFeePerGas: '1' }),
    jsonAnswer(200, { quotes: [] }),
    jsonAnswer(200, { amountOut: '1' }),
    jsonAnswer(200, { results: [] }),
  ]);
  assert.deepEqual(await getToken(TOKEN, { fetch }), { venue: { kind: 'curve' }, mark: {} });
  await postWallets(TOKEN, [a], { fetch });
  await getFees({ fetch });
  await postQuote(TOKEN, [{ address: a, amount: '7' }], { fetch });
  await postPairQuote(PAIR, '9', { fetch });
  await broadcast(TOKEN, [raw], { fetch });
  const seen = fetch.calls.map((c) => [c.init.method, c.url, c.init.body]);
  assert.deepEqual(seen, [
    ['GET', `/api/tp/token/${TOKEN}`, undefined],
    ['POST', '/api/tp/wallets', JSON.stringify({ token: TOKEN, addresses: [a.toLowerCase()] })],
    ['GET', '/api/tp/fees', undefined],
    ['POST', '/api/tp/quote', JSON.stringify({ token: TOKEN, sells: [{ address: a.toLowerCase(), amount: '7' }] })],
    ['POST', '/api/tp/quote/pair', JSON.stringify({ pairToken: PAIR, amount: '9' })],
    ['POST', '/api/tp/broadcast', JSON.stringify({ token: TOKEN, txs: [raw], sid: sidFor(TOKEN) })],
  ]);
  assert.equal(fetch.calls[1].init.headers['content-type'], 'application/json');
  assert.equal(fetch.calls[0].init.credentials, 'same-origin');
});

test('a JSON refusal becomes Error(message, {cause: {code}})', async () => {
  const fetch = fakeFetch([
    jsonAnswer(400, { error: 'not a pons token', code: 'not_pons' }),
    () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }),
    () => { throw new TypeError('Failed to fetch'); },
  ]);
  await assert.rejects(getToken(TOKEN, { fetch }), (e) => e.message === 'not a pons token' && e.cause.code === 'not_pons' && e.cause.status === 400);
  await assert.rejects(getFees({ fetch }), (e) => e.message === 'request failed (502)' && e.cause.code === 'http_502');
  await assert.rejects(getFees({ fetch }), (e) => e.cause.code === 'network');
});

test('bad input is refused before anything reaches the network', async () => {
  const fetch = fakeFetch([]);
  const key = Wallet.createRandom().privateKey;
  await assert.rejects(async () => getToken('not-an-address', { fetch }), (e) => e.cause.code === 'bad_address');
  await assert.rejects(async () => getToken(key, { fetch }), (e) => e.cause.code === 'bad_address');
  await assert.rejects(async () => postWallets(TOKEN, [key], { fetch }));
  await assert.rejects(async () => broadcast(TOKEN, [key], { fetch }));
  assert.equal(fetch.calls.length, 0);
});

test('a wrapper refuses bad input as a rejected promise, never a synchronous throw', async () => {
  // Callers chain .then(ok, fail) (the session's broadcast, the pair-price effect);
  // a synchronous throw would skip `fail` and escape the caller.
  const fetch = fakeFetch([]);
  const key = Wallet.createRandom().privateKey;
  const calls = [
    () => getToken('not-an-address', { fetch }),
    () => postWallets(TOKEN, [], { fetch }),
    () => postQuote(TOKEN, [{ address: TOKEN, amount: '0' }], { fetch }),
    () => postPairQuote('nope', '1', { fetch }),
    () => broadcast(TOKEN, [key], { fetch }),
  ];
  for (const call of calls) {
    let p;
    assert.doesNotThrow(() => {
      p = call();
    });
    assert.ok(p instanceof Promise);
    await assert.rejects(p, (e) => typeof e.cause.code === 'string');
  }
  assert.equal(fetch.calls.length, 0);
});

// ── parseSse ─────────────────────────────────────────────────────────────────

test('parseSse joins an event split across chunks, mid-line and mid-JSON', () => {
  const state = {};
  assert.deepEqual(parseSse('event: snap', state), []);
  assert.deepEqual(parseSse('shot' + LF + 'data: {"venue":{"ki', state), []);
  assert.deepEqual(parseSse('nd":"curve"}}' + LF, state), []);
  assert.deepEqual(parseSse(LF, state), [{ event: 'snapshot', data: { venue: { kind: 'curve' } } }]);
});

test('parseSse returns every event in one chunk, skips comments, passes ping', () => {
  const state = {};
  const chunk = [
    ': connected',
    'event: trades',
    'data: [1,2]',
    '',
    'event: ping',
    'data: {}',
    '',
    'data:{"x":1}',
    '',
    '',
  ].join(LF);
  assert.deepEqual(parseSse(chunk, state), [
    { event: 'trades', data: [1, 2] },
    { event: 'ping', data: {} },
    { event: 'message', data: { x: 1 } },
  ]);
});

test('parseSse handles CRLF, a CRLF split across chunks, and multi-line data', () => {
  const state = {};
  assert.deepEqual(parseSse('event: trades' + CR, state), []);
  // The LF completing that CRLF arrives first in the next chunk; it must not
  // read as a blank line (which would dispatch early and lose the event name).
  assert.deepEqual(parseSse(LF + 'data: [1]' + CR + LF + CR + LF, state), [{ event: 'trades', data: [1] }]);
  const s2 = {};
  assert.deepEqual(parseSse('event: mark' + LF + 'data: {"a":' + LF + 'data: 1}' + LF + LF, s2), [{ event: 'mark', data: { a: 1 } }]);
});

test('parseSse drops an event whose data is not JSON, and counts it', () => {
  const state = {};
  assert.deepEqual(parseSse('event: bar' + LF + 'data: {oops' + LF + LF + 'event: bar' + LF + 'data: {"ok":true}' + LF + LF, state), [
    { event: 'bar', data: { ok: true } },
  ]);
  assert.equal(state.dropped, 1);
});

// ── openStream ───────────────────────────────────────────────────────────────

test('openStream delivers events across chunks in order; close() aborts and stops', async () => {
  const fetch = fakeFetch([
    sseAnswer(
      ['event: snapshot' + LF + 'data: {"venue":{"kind":"cur', 've"}}' + LF + LF + ': ping' + LF, 'event: trades' + LF + 'data: [1,2]' + LF + LF],
      { keepOpen: true }
    ),
  ]);
  const timers = fakeTimers();
  const events = [];
  const close = openStream(TOKEN, 15, (name, data) => events.push([name, data]), { fetch, ...timers, idleMs: 0 });
  await until(() => events.length >= 3);
  assert.deepEqual(events, [
    ['stream:open', {}],
    ['snapshot', { venue: { kind: 'curve' } }],
    ['trades', [1, 2]],
  ]);
  const { url, init } = fetch.calls[0];
  assert.equal(url, `/api/tp/stream?token=${TOKEN}&interval=15&sid=${sidFor(TOKEN)}`);
  assert.equal(init.headers.accept, 'text/event-stream');
  close();
  assert.equal(init.signal.aborted, true);
  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(timers.queue.length, 0, 'no reconnect after close');
  assert.equal(events.length, 3);
});

test('openStream reconnects with backoff, and a delivered event resets the backoff', async () => {
  const fetch = fakeFetch([
    sseAnswer([]), // connects, then the server closes at once
    () => {
      throw new TypeError('Failed to fetch');
    },
    sseAnswer(['event: snapshot' + LF + 'data: {"n":1}' + LF + LF]), // one event, then closes
  ]);
  const timers = fakeTimers();
  const events = [];
  openStream(TOKEN, 1, (name, data) => events.push([name, data]), { fetch, ...timers, idleMs: 0, backoffMs: [100, 200, 400] });
  await until(() => timers.queue.length === 1);
  assert.equal(timers.queue[0].ms, 100);
  timers.runNext();
  await until(() => timers.queue.length === 1);
  assert.equal(timers.queue[0].ms, 200, 'the second failure waits longer');
  timers.runNext();
  await until(() => timers.queue.length === 1);
  assert.equal(timers.queue[0].ms, 100, 'the snapshot proved the link, so the backoff restarts');
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(
    events.filter(([n]) => n === 'stream:retry').map(([, d]) => d),
    [
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 },
      { attempt: 1, delayMs: 100 },
    ]
  );
  assert.ok(events.some(([n, d]) => n === 'snapshot' && d.n === 1));
});

test('a 4xx refusal is final; 429 and 5xx are retried', async () => {
  const timers = fakeTimers();
  const events = [];
  const fetch = fakeFetch([jsonAnswer(400, { error: 'not a pons token', code: 'not_pons' })]);
  openStream(TOKEN, 60, (name, data) => events.push([name, data]), { fetch, ...timers, idleMs: 0 });
  await until(() => events.length === 1);
  assert.deepEqual(events[0], ['stream:error', { message: 'not a pons token', code: 'not_pons', status: 400 }]);
  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(timers.queue.length, 0);
  assert.equal(fetch.calls.length, 1);

  const t2 = fakeTimers();
  const ev2 = [];
  const f2 = fakeFetch([jsonAnswer(429, { error: 'too many streams', code: 'too_many' }), jsonAnswer(503, {})]);
  openStream(TOKEN, 60, (name, data) => ev2.push([name, data]), { fetch: f2, ...t2, idleMs: 0, backoffMs: [10] });
  await until(() => t2.queue.length === 1);
  t2.runNext();
  await until(() => t2.queue.length === 1 && f2.calls.length === 2);
  assert.deepEqual(ev2.map(([n]) => n), ['stream:retry', 'stream:retry']);
});

test('the idle watchdog drops a silent connection and reconnects', async () => {
  const timers = fakeTimers();
  const events = [];
  const fetch = fakeFetch([sseAnswer([], { keepOpen: true }), sseAnswer([], { keepOpen: true })]);
  openStream(TOKEN, 1, (name, data) => events.push([name, data]), { fetch, ...timers, idleMs: 1000, backoffMs: [50] });
  await until(() => timers.queue.length === 1);
  assert.equal(timers.queue[0].ms, 1000, 'the watchdog is armed');
  timers.runNext(); // 45 s of silence, compressed
  await until(() => timers.queue.some((t) => t.ms === 50));
  assert.equal(fetch.calls[0].init.signal.aborted, true);
  timers.runNext();
  await until(() => fetch.calls.length === 2);
});

test('a multi-byte character split across byte chunks decodes intact', async () => {
  const bytes = new TextEncoder().encode('event: snapshot' + LF + 'data: {"name":"caf' + String.fromCharCode(233) + '"}' + LF + LF);
  const cut = bytes.indexOf(0xc3) + 1; // split inside the 2-byte e-acute
  const fetch = fakeFetch([sseAnswer([bytes.slice(0, cut), bytes.slice(cut)], { keepOpen: true })]);
  const events = [];
  const close = openStream(TOKEN, 1, (name, data) => events.push([name, data]), { fetch, ...fakeTimers(), idleMs: 0 });
  await until(() => events.length === 2);
  assert.equal(events[1][1].name, 'caf' + String.fromCharCode(233));
  close();
});

test('openStream refuses a bad token or interval up front', () => {
  assert.throws(() => openStream('nope', 1, () => {}), /not an address/);
  assert.throws(() => openStream(TOKEN, 7, () => {}), /interval/);
});

// ── the stream id (sid): receipts reach only the stream that names it ────────

test('a token gets ONE sid, fixed before any stream opens: broadcasts, the first stream and every reconnect carry it', async () => {
  const T = '0x' + 'e'.repeat(40);
  const raw = await signedTx();
  const sid = sidFor(T);
  assert.match(sid, /^[0-9a-f]{32}$/);
  assert.equal(sidFor(T.toUpperCase().replace('0X', '0x')), sid, 'the same token, whatever its case');
  assert.notEqual(sidFor('0x' + 'd'.repeat(40)), sid, 'another token has its own sid');

  // An approval signed on load can go out before any stream is open.
  const f1 = fakeFetch([jsonAnswer(200, { results: [] })]);
  await broadcast(T, [raw], { fetch: f1 });
  assert.equal(JSON.parse(f1.calls[0].init.body).sid, sid);

  const fetch = fakeFetch([sseAnswer([]), sseAnswer([], { keepOpen: true }), sseAnswer([], { keepOpen: true })]);
  const timers = fakeTimers();
  const close = openStream(T, 1, () => {}, { fetch, ...timers, idleMs: 0, backoffMs: [10] });
  await until(() => timers.queue.length === 1);
  timers.runNext(); // the server closed: reconnect
  await until(() => fetch.calls.length === 2);
  const close2 = openStream(T, 60, () => {}, { fetch, ...fakeTimers(), idleMs: 0 }); // a timeframe switch
  await until(() => fetch.calls.length === 3);
  for (const c of fetch.calls) assert.ok(c.url.endsWith(`&sid=${sid}`), c.url);
  close();
  close2();
});

test("a snapshot's well-formed sid is adopted for the token; a malformed one is ignored", async () => {
  const T = '0x' + 'c'.repeat(40);
  const mine = sidFor(T);
  const theirs = 'ab'.repeat(16);
  const fetch = fakeFetch([
    sseAnswer(['event: snapshot' + LF + 'data: {"sid":"NOT-A-SID"}' + LF + LF]),
    sseAnswer(['event: snapshot' + LF + `data: {"sid":"${theirs}"}` + LF + LF]),
    sseAnswer([], { keepOpen: true }),
  ]);
  const timers = fakeTimers();
  const events = [];
  const close = openStream(T, 1, (n) => events.push(n), { fetch, ...timers, idleMs: 0, backoffMs: [10] });
  await until(() => timers.queue.length === 1);
  assert.equal(sidFor(T), mine, 'a malformed sid is not stored');
  timers.runNext();
  await until(() => timers.queue.length === 1);
  assert.equal(sidFor(T), theirs);
  timers.runNext();
  await until(() => fetch.calls.length === 3);
  assert.ok(fetch.calls[2].url.endsWith(`&sid=${theirs}`));
  close();
});

test('a broadcast body refuses a malformed sid, without echoing it', async () => {
  const raw = await signedTx();
  for (const bad of ['nope', 'AB'.repeat(16), 'ab'.repeat(17), 7]) {
    let err;
    try {
      buildBody('broadcast', { token: TOKEN, txs: [raw], sid: bad });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `sid ${bad} must be refused`);
    assert.equal(err.cause.code, 'bad_request');
  }
  const sid = 'ab'.repeat(16);
  assert.equal(buildBody('broadcast', { token: TOKEN, txs: [raw], sid }), JSON.stringify({ token: TOKEN, txs: [raw], sid }));
});

test("a 409 'migrating' (a graduation in progress) is retried, never final", async () => {
  const timers = fakeTimers();
  const events = [];
  const fetch = fakeFetch([jsonAnswer(409, { error: 'mid-migration — try again shortly', code: 'migrating' }), sseAnswer([], { keepOpen: true })]);
  const close = openStream(TOKEN, 1, (name, data) => events.push([name, data]), { fetch, ...timers, idleMs: 0, backoffMs: [10] });
  await until(() => timers.queue.length === 1);
  assert.deepEqual(events.map(([n]) => n), ['stream:retry']);
  timers.runNext();
  await until(() => fetch.calls.length === 2);
  close();
});

// ── Task 35: the token header's logo route ────────────────────────────────────

test("logoPath is this origin's logo route for an address, and null for anything else", () => {
  assert.equal(logoPath(TOKEN.toUpperCase().replace('0X', '0x')), `/api/tp/logo/${TOKEN}`);
  assert.equal(logoPath('javascript:alert(1)'), null);
  assert.equal(logoPath(`${TOKEN}/../../wallets`), null);
  assert.equal(logoPath(Wallet.createRandom().privateKey), null);
  assert.equal(logoPath(null), null);
});
