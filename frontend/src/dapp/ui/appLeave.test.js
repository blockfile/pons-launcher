import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fund safety (Task 32). leaveAccount takes the account's wallets (their keys)
// out of the tab. On a token-quoted venue a landed sell is followed by a
// pair -> ETH swap this tab signs: a Lock, Disconnect or Switch that takes the
// keys first strands the proceeds in the pair token. Every way in must go
// through leaveWhenQuiet, which holds new sells, waits for the tab's signing
// (ui/leaveGate.js) and asks before it strands anything.

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const src = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8').split(CR + LF).join(LF);

/** One of App's useCallbacks: from its `const` to the `);` (two-space indent) that closes it. */
function callbackSource(name) {
  const start = src.indexOf(`  const ${name} = useCallback(`);
  assert.ok(start >= 0, `App.jsx has no ${name} callback`);
  const end = src.indexOf(LF + '  );', start);
  assert.ok(end > start, `${name} is not closed`);
  return src.slice(start, end);
}

test('Lock, Disconnect and Switch go through leaveWhenQuiet, and nothing else calls leaveAccount', () => {
  const actions = callbackSource('onAccountAction');
  assert.match(actions, /id === 'lock'\) await leaveWhenQuiet\('lock'\)/);
  assert.match(actions, /id === 'disconnect'\) await leaveWhenQuiet\('disconnect'\)/);
  assert.match(actions, /await leaveWhenQuiet\('switch'\)\) await connectFlow\(/);
  assert.match(actions, /id === 'leave-cancel'/);
  const rest = src.split(callbackSource('leaveWhenQuiet')).join('');
  assert.doesNotMatch(rest, /leaveAccount\(/, 'every call of leaveAccount is inside leaveWhenQuiet');
});

test('leaveWhenQuiet holds the sells, waits, asks, then leaves; the sells come back whatever happens', () => {
  const body = callbackSource('leaveWhenQuiet');
  let at = -1;
  for (const step of ['holdSells(pausedReason(how))', 'waitForQuiet(', 'leaveWarning(how, read()', 'window.confirm(warning)', 'await leaveAccount(next)']) {
    const i = body.indexOf(step, at + 1);
    assert.ok(i > at, `${step} is in its place`);
    at = i;
  }
  assert.match(body, /finally \{[^]*holdSells\(null\)[^]*setLeaving\(null\)/);
  assert.match(body, /status !== 'unlocked'\) return leaveAccount\(next\)/, 'a locked account takes no key away: straight through');
  assert.match(src, /<AccountBar [^>]*leaving=\{leaving\}/);
});
