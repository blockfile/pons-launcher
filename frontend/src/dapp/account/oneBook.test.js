// Addendum C: each wallet's starting size (the 100 % of its %-left bar) lives in
// ONE book, ui/positions.js (made once, in ui/deps.js, as realDeps.positions), and
// reaches the account over ONE protocol: the page hub. The book emits
// 'positions:save'; the sync (account/vaultSync.js) emits 'account:positions' and
// 'account:locked'. The plan once built two books that never met, so every saved
// copy carried positions {} and every refresh reset the bars to 100 %. These checks
// keep a second book, or a second channel, from coming back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(DAPP, rel), 'utf8');
const rel = (file) => path.relative(DAPP, file).split(path.sep).join('/');

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/[.](js|jsx)$/.test(e.name) && !/[.]test[.]js$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The code without its comments (block, then line), so a comment naming an event is not a use. */
const code = (text) => text.replace(/[/][*][^]*?[*][/]/g, '').replace(/(^|[^:])[/][/].*$/gm, '$1');

test('there is no second positions book: account/positions.js is gone and only ui/deps.js makes a book', () => {
  assert.equal(fs.existsSync(path.join(DAPP, 'account', 'positions.js')), false);
  const makers = sources(DAPP)
    .filter((file) => /createPositionBook[(]/.test(code(fs.readFileSync(file, 'utf8'))))
    .map(rel)
    .filter((r) => r !== 'ui/positions.js');
  assert.deepEqual(makers, ['ui/deps.js']);
  const importers = sources(DAPP)
    .filter((file) => /account[/]positions[.]js/.test(fs.readFileSync(file, 'utf8')))
    .map(rel);
  assert.deepEqual(importers, []);
});

test('only the book and the sync speak the positions protocol', () => {
  const speakers = sources(DAPP)
    .filter((file) => /'(account:positions|account:locked|positions:save)'/.test(code(fs.readFileSync(file, 'utf8'))))
    .map(rel)
    .sort();
  assert.deepEqual(speakers, ['account/vaultSync.js', 'ui/positions.js']);
});

test('App connects the one book and the sync to the same page hub', () => {
  const app = code(read('ui/App.jsx'));
  assert.match(app, /const book = realDeps[.]positions;/);
  assert.match(app, /book[.]connect[(]hub[)]/);
  const call = app.match(/createVaultSync[(][{][^}]*[}][)]/);
  assert.ok(call, 'App starts the sync');
  assert.match(call[0], /[{ ,]hub[,} ]/, 'the sync gets the page hub');
  // A bare `positions` in App is never the book (Task 34's per-token map once
  // shadowed an imported book there, and Lock threw on it).
  assert.doesNotMatch(app, /(^|[^.A-Za-z0-9_])positions[.]clear[(]/m);
});
