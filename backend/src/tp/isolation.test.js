'use strict';

// THE KEYSTORE FIREWALL. The dApp's backend is public and key-less: src/tp/** and
// routes/tp.js must never reach the console's keystore, its users, its auth middleware
// or another tab's route module — directly or through anything they load. Code they
// need from other tabs is COPIED into src/tp (tab-isolation rule), so the only
// backend/src modules they may load are the shared infra every tab already uses.
//
// Three checks: a static scan of every require() in the dApp's own files (deny list +
// allow list), and a runtime check of the whole transitive require graph in a child
// process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { builtinModules } = require('module');

const SRC = path.resolve(__dirname, '..'); // backend/src
const TP_DIR = __dirname; // backend/src/tp
const ROUTE_FILE = path.join(SRC, 'routes', 'tp.js');

// Shared infra the dApp may load (Global Constraints of the plan).
const SHARED_OK = new Set(
  ['config.js', path.join('evm', 'provider.js'), 'ethPrice.js'].map((p) => path.join(SRC, p))
);
const PACKAGES_OK = new Set(['ethers', 'express']);
const DENY = [
  path.join(SRC, 'wallets') + path.sep,
  path.join(SRC, 'users') + path.sep,
  path.join(SRC, 'middleware', 'auth.js'),
  path.join(SRC, 'routes') + path.sep,
];

function dappFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
    }
  })(TP_DIR);
  out.push(ROUTE_FILE);
  return out;
}

const REQUIRE_LITERAL = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
const REQUIRE_ANY = /\brequire\s*\(/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/g;

function resolveSpec(spec, fromFile) {
  if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return `${base}.js`; // unresolved: judged by where it would be
  }
  return spec;
}

/** Every problem with one file's source. Exported shape for the self-test below. */
function scanSource(source, fromFile) {
  const problems = [];
  const literals = [...source.matchAll(REQUIRE_LITERAL)];
  const all = source.match(REQUIRE_ANY) || [];
  if (all.length !== literals.length) problems.push('a require() whose argument is not a string literal');
  if (DYNAMIC_IMPORT.test(source)) problems.push('a dynamic import()');
  DYNAMIC_IMPORT.lastIndex = 0;

  for (const m of literals) {
    const spec = m[2];
    if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
    if (!spec.startsWith('.')) {
      if (!PACKAGES_OK.has(spec)) problems.push(`package "${spec}" is not allowed`);
      continue;
    }
    const target = resolveSpec(spec, fromFile);
    const denied = DENY.some((d) => (d.endsWith(path.sep) ? target.startsWith(d) : target === d));
    if (denied && target !== ROUTE_FILE) {
      problems.push(`"${spec}" reaches ${path.relative(SRC, target)} (DENIED)`);
      continue;
    }
    const inTp = target.startsWith(TP_DIR + path.sep);
    if (!inTp && !SHARED_OK.has(target) && target !== ROUTE_FILE) {
      problems.push(`"${spec}" reaches ${path.relative(SRC, target)} (not tp, not shared infra)`);
    }
  }
  return problems;
}

test('the scanner itself catches what it must (self-test)', () => {
  const from = path.join(TP_DIR, 'fake.js');
  assert.match(scanSource("require('../wallets/keystore')", from).join(), /DENIED/);
  assert.match(scanSource("require('../users/users')", from).join(), /DENIED/);
  assert.match(scanSource("require('../middleware/auth')", from).join(), /DENIED/);
  assert.match(scanSource("require('../routes/wallets')", from).join(), /DENIED/);
  assert.match(scanSource("require('../evm/v3/poolswap')", from).join(), /not tp, not shared/);
  assert.match(scanSource("require('../v4/store')", from).join(), /not tp, not shared/);
  assert.match(scanSource("require('dotenv')", from).join(), /not allowed/);
  assert.match(scanSource('const m = "../wallets/keystore"; require(m)', from).join(), /not a string literal/);
  assert.match(scanSource("import('../wallets/keystore.js')", from).join(), /dynamic import/);
  assert.deepEqual(scanSource("require('./errors'); require('../config'); require('ethers'); require('node:fs')", from), []);
  assert.deepEqual(scanSource("require('../evm/provider'); require('../ethPrice'); require('https')", from), []);
});

test('routes/tp.js exists and is scanned', () => {
  assert.ok(fs.existsSync(ROUTE_FILE), 'backend/src/routes/tp.js must exist');
  assert.ok(dappFiles().includes(ROUTE_FILE));
});

test('no dApp file requires the keystore, users, auth, another route or another tab', () => {
  const report = [];
  for (const file of dappFiles()) {
    for (const problem of scanSource(fs.readFileSync(file, 'utf8'), file)) {
      report.push(`${path.relative(SRC, file)}: ${problem}`);
    }
  }
  assert.deepEqual(report, []);
});

test('the transitive require graph stays inside tp + shared infra', () => {
  const entries = dappFiles();
  const script =
    'const entries = JSON.parse(process.argv[1]);' +
    'for (const e of entries) require(e);' +
    'process.stdout.write(JSON.stringify(Object.keys(require.cache)));' +
    'process.exit(0);';
  const out = spawnSync(process.execPath, ['-e', script, JSON.stringify(entries)], {
    cwd: path.resolve(SRC, '..'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(out.status, 0, `child failed: ${out.stderr}`);
  const loaded = JSON.parse(out.stdout);
  const leaks = loaded.filter(
    (f) =>
      f.startsWith(SRC + path.sep) &&
      !f.startsWith(TP_DIR + path.sep) &&
      f !== ROUTE_FILE &&
      !SHARED_OK.has(f)
  );
  assert.deepEqual(leaks.map((f) => path.relative(SRC, f)), []);
});
