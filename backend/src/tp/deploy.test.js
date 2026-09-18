'use strict';

// The dapp.rhbond.xyz deploy config, checked as data. There is no nginx on a dev
// box, so `nginx -t` only runs on the server; this test pins what nginx -t cannot
// see anyway: that the PUBLIC host is fenced to the dApp and /api/tp/*, that the
// SSE location does not buffer, that the security headers survive into every
// location, and that the password-protected console blocks were left alone.
//
// No escape sequences on purpose (memory: write-tool-escapes): control characters
// are built with String.fromCharCode.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CONF = path.join(REPO, 'deploy', 'nginx-rhbond.conf');
const ENV_EXAMPLE = path.join(REPO, 'backend', '.env.example');
const README = path.join(REPO, 'README.md');

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const BACKSLASH = String.fromCharCode(92);
const WS = new Set([' ', LF, CR, TAB]);

const CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// ── a minimal nginx config reader: words, quoted strings, { } ; and # comments ──
function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (WS.has(ch)) {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== LF) i++;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === ';') {
      out.push({ t: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let v = '';
      i++;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === BACKSLASH) {
          v += text[i + 1];
          i += 2;
          continue;
        }
        v += text[i];
        i++;
      }
      if (i >= text.length) throw new Error('unterminated quoted string in nginx config');
      i++;
      out.push({ t: 'word', v });
      continue;
    }
    let v = '';
    while (i < text.length && !WS.has(text[i]) && !'{};'.includes(text[i]) && text[i] !== '"' && text[i] !== "'") {
      v += text[i];
      i++;
    }
    out.push({ t: 'word', v });
  }
  return out;
}

function parse(tokens) {
  let i = 0;
  function block(closing) {
    const out = [];
    for (;;) {
      const tok = tokens[i];
      if (!tok) {
        if (closing) throw new Error('unbalanced braces: a block is never closed');
        return out;
      }
      if (tok.t === '}') {
        if (!closing) throw new Error('unbalanced braces: a stray }');
        i++;
        return out;
      }
      if (tok.t !== 'word') throw new Error(`unexpected "${tok.t}" where a directive name belongs`);
      const name = tok.v;
      const args = [];
      i++;
      for (;;) {
        const t = tokens[i];
        if (!t) throw new Error(`directive ${name} is never terminated`);
        if (t.t === 'word') {
          args.push(t.v);
          i++;
          continue;
        }
        if (t.t === ';') {
          i++;
          out.push({ name, args });
          break;
        }
        if (t.t === '{') {
          i++;
          out.push({ name, args, block: block(true) });
          break;
        }
        throw new Error(`directive ${name} runs into a stray }`);
      }
    }
  }
  return block(false);
}

const raw = fs.readFileSync(CONF, 'utf8');
const tree = parse(tokenize(raw));
const servers = tree.filter((d) => d.name === 'server');

const direct = (blk, name) => blk.filter((d) => d.name === name).map((d) => d.args);
const names = (srv) => direct(srv.block, 'server_name').flat();
const listens = (srv) => direct(srv.block, 'listen');
const everything = (blk) => blk.flatMap((d) => [d, ...(d.block ? everything(d.block) : [])]);
const serverFor = (host, port) =>
  servers.filter((s) => names(s).includes(host) && listens(s).some((a) => a[0] === port || a[0] === `[::]:${port}`));
const location = (srv, ...args) =>
  srv.block.find((d) => d.name === 'location' && JSON.stringify(d.args) === JSON.stringify(args));
const headers = (blk) => new Map(direct(blk, 'proxy_set_header').map((a) => [a[0], a.slice(1)]));

const [dapp] = serverFor('dapp.rhbond.xyz', '443');

test('there is exactly one HTTPS server block for dapp.rhbond.xyz, and one port-80 redirect', () => {
  assert.equal(serverFor('dapp.rhbond.xyz', '443').length, 1);
  const plain = serverFor('dapp.rhbond.xyz', '80');
  assert.equal(plain.length, 1);
  assert.deepEqual(direct(plain[0].block, 'return'), [['301', 'https://$host$request_uri']]);
});

test('the dApp block is public: no basic auth anywhere inside it', () => {
  const all = everything(dapp.block).map((d) => d.name);
  assert.ok(!all.includes('auth_basic'), 'auth_basic must not appear in the dapp block');
  assert.ok(!all.includes('auth_basic_user_file'), 'auth_basic_user_file must not appear in the dapp block');
});

test('it listens on 443 with TLS and HTTP/2 on IPv4 and IPv6, on the rhbond.xyz certificate', () => {
  const l = listens(dapp).map((a) => a.join(' '));
  assert.ok(l.includes('443 ssl http2'), `listen lines: ${l.join(' | ')}`);
  assert.ok(l.includes('[::]:443 ssl http2'), `listen lines: ${l.join(' | ')}`);
  assert.deepEqual(direct(dapp.block, 'ssl_certificate'), [['/etc/letsencrypt/live/rhbond.xyz/fullchain.pem']]);
  assert.deepEqual(direct(dapp.block, 'ssl_certificate_key'), [['/etc/letsencrypt/live/rhbond.xyz/privkey.pem']]);
});

test('the security headers are set once, at server level, with always', () => {
  const h = new Map(direct(dapp.block, 'add_header').map((a) => [a[0], a.slice(1)]));
  assert.deepEqual(h.get('Content-Security-Policy'), [CSP, 'always']);
  assert.equal(require('./hostGate').DAPP_CSP, CSP, 'the host gate sends the same policy as nginx');
  assert.deepEqual(h.get('Strict-Transport-Security'), ['max-age=31536000', 'always']);
  assert.deepEqual(h.get('X-Frame-Options'), ['DENY', 'always']);
  assert.deepEqual(h.get('X-Content-Type-Options'), ['nosniff', 'always']);
  assert.deepEqual(h.get('Referrer-Policy'), ['no-referrer', 'always']);
  // An add_header inside a location REPLACES the server-level set there.
  for (const loc of dapp.block.filter((d) => d.name === 'location')) {
    assert.equal(direct(loc.block, 'add_header').length, 0, `add_header inside location ${loc.args.join(' ')}`);
  }
});

test('every proxying location forwards the same, non-spoofable client headers', () => {
  const proxied = dapp.block.filter((d) => d.name === 'location' && direct(d.block, 'proxy_pass').length);
  assert.equal(proxied.length, 3, 'stream, /api/tp/ and / are the only proxied locations');
  for (const loc of proxied) {
    const where = loc.args.join(' ');
    assert.deepEqual(direct(loc.block, 'proxy_pass'), [['http://127.0.0.1:3100']], where);
    assert.deepEqual(direct(loc.block, 'proxy_http_version'), [['1.1']], where);
    const h = headers(loc.block);
    assert.deepEqual(h.get('Host'), ['$host'], where);
    assert.deepEqual(h.get('X-Real-IP'), ['$remote_addr'], where);
    assert.deepEqual(h.get('X-Forwarded-For'), ['$remote_addr'], where);
    assert.deepEqual(h.get('X-Forwarded-Proto'), ['$scheme'], where);
    assert.deepEqual(h.get('X-Forwarded-Host'), ['$host'], where);
  }
});

test('the stream location streams: no buffering, no cache, no gzip, a 1 h read timeout', () => {
  const s = location(dapp, '^~', '/api/tp/stream');
  assert.ok(s, 'location ^~ /api/tp/stream');
  assert.deepEqual(direct(s.block, 'proxy_buffering'), [['off']]);
  assert.deepEqual(direct(s.block, 'proxy_cache'), [['off']]);
  assert.deepEqual(direct(s.block, 'gzip'), [['off']]);
  assert.deepEqual(direct(s.block, 'proxy_read_timeout'), [['1h']]);
  assert.deepEqual(headers(s.block).get('Connection'), ['']);
  assert.deepEqual(direct(s.block, 'limit_req'), [['zone=tp', 'burst=20', 'nodelay']]);
});

test('the page and its assets are gzipped at level 6, the level the size budget is measured at', () => {
  assert.deepEqual(direct(dapp.block, 'gzip'), [['on']]);
  assert.deepEqual(direct(dapp.block, 'gzip_comp_level'), [['6']]);
  const types = direct(dapp.block, 'gzip_types').flat();
  // express.static (send 0.19 / mime 1.6) labels .js application/javascript.
  for (const t of ['application/javascript', 'text/css']) assert.ok(types.includes(t), `gzip_types lacks ${t}`);
});

test('/api/tp/ is rate limited; every other /api path is a 404, in any letter case', () => {
  const tp = location(dapp, '^~', '/api/tp/');
  assert.ok(tp, 'location ^~ /api/tp/');
  assert.deepEqual(direct(tp.block, 'limit_req'), [['zone=tp', 'burst=40', 'nodelay']]);
  assert.deepEqual(direct(dapp.block, 'limit_req_status'), [['429']]);

  const api = location(dapp, '/api/');
  assert.ok(api, 'location /api/');
  assert.deepEqual(direct(api.block, 'return'), [['404', '{"error":"not found"}']]);
  assert.equal(direct(api.block, 'proxy_pass').length, 0);

  const anyCase = location(dapp, '~*', '^/api(/|$)');
  assert.ok(anyCase, 'location ~* ^/api(/|$) — Express routes case-insensitively, nginx prefixes do not');
  assert.deepEqual(direct(anyCase.block, 'return'), [['404', '{"error":"not found"}']]);

  assert.ok(location(dapp, '/'), 'location / serves the dApp page and /dapp/assets');
});

test('the rate-limit zone lives at http level (conf.d), documented here but not defined here', () => {
  assert.equal(everything(tree).filter((d) => d.name === 'limit_req_zone').length, 0);
  const documented = raw
    .split(LF)
    .some((l) => l.trim() === '#   limit_req_zone $binary_remote_addr zone=tp:10m rate=10r/s;');
  assert.ok(documented, 'the conf.d line is written out in a comment');
});

test('the password-protected console blocks are unchanged in the parts that matter', () => {
  for (const host of ['rhbond.xyz', 'api.rhbond.xyz']) {
    const [srv] = serverFor(host, '443');
    assert.ok(srv, `${host} 443 block`);
    assert.ok(direct(srv.block, 'auth_basic').length === 1, `${host} keeps auth_basic`);
    const loc = location(srv, '/');
    assert.deepEqual(direct(loc.block, 'proxy_read_timeout'), [['180s']], `${host} keeps its 180s timeout`);
  }
});

test('the certbot comment names all four hostnames on the one certificate', () => {
  const line = raw.split(LF).find((l) => l.includes('sudo certbot --nginx'));
  assert.ok(line, 'certbot comment line');
  assert.ok(line.includes('--cert-name rhbond.xyz'), line);
  for (const d of ['rhbond.xyz', 'www.rhbond.xyz', 'api.rhbond.xyz', 'dapp.rhbond.xyz']) {
    assert.ok(line.includes(`-d ${d}`), `${d} in: ${line}`);
  }
});

test('backend/.env.example documents the three dApp settings', () => {
  const lines = fs.readFileSync(ENV_EXAMPLE, 'utf8').split(LF).map((l) => l.trimEnd());
  assert.ok(lines.includes('DAPP_HOST=dapp.rhbond.xyz'));
  assert.ok(lines.includes('TP_MAX_TOKENS=30'));
  assert.ok(lines.includes('TP_SEQUENCER_URL='));
});

test('README has the Take-profit dApp deploy section with the exact commands', () => {
  const text = fs.readFileSync(README, 'utf8');
  assert.ok(text.includes('## Take-profit dApp'));
  for (const cmd of [
    'npm ci',
    'npm run build',
    'pm2 restart pons-launcher',
    '/etc/nginx/conf.d/tp-limits.conf',
    'sudo nginx -t && sudo systemctl reload nginx',
    'sudo certbot --nginx --cert-name rhbond.xyz -d rhbond.xyz -d www.rhbond.xyz -d api.rhbond.xyz -d dapp.rhbond.xyz',
  ]) {
    assert.ok(text.includes(cmd), `README is missing: ${cmd}`);
  }
});
