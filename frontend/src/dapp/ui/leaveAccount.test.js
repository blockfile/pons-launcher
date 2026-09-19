import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leaveAccountTab, LEAVE_STEPS } from './leaveAccount.js';

// ── a fake page: an account, a sync and the four tab steps, all recorded in order ──
function harness({ status = 'unlocked', flush = { ok: true, rev: 3, code: '', error: '' }, confirm = true, throwsAt = {} } = {}) {
  const log = [];
  const asked = [];
  let current = {
    async flush() {
      log.push('flush');
      if (flush instanceof Error) throw flush;
      return flush;
    },
    stop() {
      log.push('stop');
      if (throwsAt.stop) throw throwsAt.stop;
    },
  };
  const account = {
    state: { status },
    get: () => account.state,
    async lock() {
      log.push('lock');
      if (throwsAt.lock) throw throwsAt.lock;
      account.state = { status: 'locked' };
    },
    async disconnect() {
      log.push('disconnect');
      account.state = { status: 'out' };
    },
  };
  const step = (name) => () => {
    log.push(name);
    if (throwsAt[name]) throw throwsAt[name];
  };
  const deps = {
    account,
    getSync: () => current,
    dropSync: (s) => {
      log.push('dropSync');
      if (current === s) current = null;
    },
    confirm: (text) => {
      asked.push(text);
      return confirm;
    },
    clearWallets: step('clearWallets'),
    dropRows: step('dropRows'),
    syncOwnAddrs: step('syncOwnAddrs'),
    forgetPositions: step('forgetPositions'),
  };
  return { deps, log, asked, account, sync: () => current };
}

const TAB = ['clearWallets', 'dropRows', 'syncOwnAddrs', 'forgetPositions'];

test('the tab steps run in this order: keys, rows, count, positions', () => {
  assert.deepEqual(LEAVE_STEPS, TAB);
  assert.ok(Object.isFrozen(LEAVE_STEPS));
});

test('Lock of an unlocked tab: save, stop the sync, lock, then the tab empties', async () => {
  const h = harness();
  const out = await leaveAccountTab('lock', h.deps);
  assert.deepEqual(out, { left: true, errors: [] });
  assert.deepEqual(h.log, ['flush', 'stop', 'dropSync', 'lock', ...TAB]);
  assert.equal(h.sync(), null, 'the page no longer holds the stopped sync');
  assert.deepEqual(h.asked, [], 'a saved copy asks nothing');
  assert.equal(h.account.state.status, 'locked');
});

test('Disconnect signs out instead of locking; the tab empties the same way', async () => {
  const h = harness();
  const out = await leaveAccountTab('disconnect', h.deps);
  assert.deepEqual(out, { left: true, errors: [] });
  assert.deepEqual(h.log, ['flush', 'stop', 'dropSync', 'disconnect', ...TAB]);
});

test('the sync is stopped before any wallet leaves: a running sync would save the emptied tab over the account copy', async () => {
  const h = harness();
  let stopped = false;
  let removedWhileSyncing = false;
  h.deps.getSync = () => ({ flush: async () => ({ ok: true, rev: 1 }), stop: () => (stopped = true) });
  h.deps.clearWallets = () => {
    if (!stopped) removedWhileSyncing = true;
  };
  h.deps.forgetPositions = () => {
    if (!stopped) removedWhileSyncing = true;
  };
  await leaveAccountTab('lock', h.deps);
  assert.equal(removedWhileSyncing, false);
});

test('an unsaved change asks first; "no" changes nothing at all', async () => {
  const h = harness({ flush: { ok: false, rev: 2, code: 'offline', error: 'the server did not answer' }, confirm: false });
  const out = await leaveAccountTab('lock', h.deps);
  assert.deepEqual(out, { left: false, errors: [] });
  assert.deepEqual(h.log, ['flush']);
  assert.match(h.asked[0], /not saved to your account \(the server did not answer\)/);
  assert.notEqual(h.sync(), null, 'the sync keeps running');
  assert.equal(h.account.state.status, 'unlocked');
});

test('"yes" to an unsaved change goes ahead; a flush that throws counts as unsaved', async () => {
  const h = harness({ flush: new Error('socket hang up'), confirm: true });
  const out = await leaveAccountTab('lock', h.deps);
  assert.deepEqual(out, { left: true, errors: [] });
  assert.match(h.asked[0], /socket hang up/);
  assert.deepEqual(h.log, ['flush', 'stop', 'dropSync', 'lock', ...TAB]);
});

test('a tab that was never unlocked keeps its wallets: only the account locks', async () => {
  const h = harness({ status: 'locked' });
  h.deps.getSync = () => null;
  const out = await leaveAccountTab('lock', h.deps);
  assert.deepEqual(out, { left: true, errors: [] });
  assert.deepEqual(h.log, ['lock']);
});

test('a tab step that throws does not stop the others: no row outlives its key, and the error comes back', async () => {
  for (const name of TAB) {
    const boom = new TypeError(`${name} failed`);
    const h = harness({ throwsAt: { [name]: boom } });
    const out = await leaveAccountTab('lock', h.deps);
    assert.equal(out.left, true, name);
    assert.deepEqual(out.errors, [boom], name);
    assert.deepEqual(h.log.slice(-4), TAB, name);
  }
});

test("the 03 + 04 collision: a per-token map (no clear()) where the book was expected still leaves the tab empty", async () => {
  // What App's `positions` became when Part 04's per-token useMemo shadowed Part 03's import.
  const perToken = { ['0x' + 'a'.repeat(40)]: { hwm: '1000', seenAt: 1 } };
  const h = harness();
  h.deps.forgetPositions = () => perToken.clear();
  const out = await leaveAccountTab('disconnect', h.deps);
  assert.equal(out.left, true);
  assert.equal(out.errors.length, 1);
  assert.ok(out.errors[0] instanceof TypeError);
  for (const name of ['clearWallets', 'dropRows', 'syncOwnAddrs']) assert.ok(h.log.includes(name), name);
});

test('a lock that fails still empties the tab (the account already dropped its key)', async () => {
  const blocked = new Error('IndexedDB blocked');
  const h = harness({ throwsAt: { lock: blocked } });
  const out = await leaveAccountTab('lock', h.deps);
  assert.deepEqual(out, { left: true, errors: [blocked] });
  assert.deepEqual(h.log.slice(-4), TAB);
});

test('a sync that cannot be stopped removes nothing and locks nothing', async () => {
  const stuck = new Error('stuck');
  const h = harness({ throwsAt: { stop: stuck } });
  const out = await leaveAccountTab('lock', h.deps);
  assert.deepEqual(out, { left: false, errors: [stuck] });
  assert.deepEqual(h.log, ['flush', 'stop']);
  assert.equal(h.account.state.status, 'unlocked');
});

// ── App.jsx: the wiring, read as source (App is JSX; node runs no JSX) ──

const APP = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const NL = String.fromCharCode(10);
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The source without comments; a `//` right after ':' (a URL in a string) is kept. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(NL)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join(NL);
}

/** Every local name an import statement binds. */
function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^import\s+([^'";]+?)\s+from\s+['"][^'"]+['"]/gm)) {
    let clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const local = part.trim().split(/\s+as\s+/).pop().trim();
        if (IDENT.test(local)) names.add(local);
      }
      clause = clause.replace(braces[0], '');
    }
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) {
      names.add(ns[1]);
      clause = clause.replace(ns[0], '');
    }
    for (const part of clause.split(',')) if (IDENT.test(part.trim())) names.add(part.trim());
  }
  return names;
}

/** Every name a const / let / var / function / class declaration binds, destructuring included. */
function declaredNames(src) {
  const code = stripComments(src);
  const names = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+[[{]([^=]*?)[\]}]\s*=/g)) {
    for (const part of m[1].split(',')) {
      const local = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (IDENT.test(local)) names.add(local);
    }
  }
  return names;
}

test('App.jsx never declares a name it imports: leaveAccount reaches the real book, not a per-token map', () => {
  const imported = importedNames(APP);
  assert.ok(imported.has('clearWallets') && imported.has('leaveAccountTab'), 'the import scan works');
  const shadowed = [...imported].filter((n) => declaredNames(APP).has(n));
  assert.deepEqual(shadowed, []);
});

test("App's leaveAccount hands leaveAccountTab every piece it needs", () => {
  const at = APP.indexOf('leaveAccountTab(how, {');
  assert.ok(at > 0, 'App calls leaveAccountTab(how, {...})');
  const call = APP.slice(at, APP.indexOf('});', at));
  for (const key of ['account', 'getSync', 'dropSync', 'confirm', ...TAB]) {
    assert.match(call, new RegExp(`(^|[\\s,{])${key}(:|,|\\s*$)`, 'm'), key);
  }
});
