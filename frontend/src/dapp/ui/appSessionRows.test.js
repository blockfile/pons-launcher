import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fund safety (Task 30). The account sync calls onSyncApplied whenever another
// device's change arrives, and Lock / Disconnect can come while sells are in
// flight. A reset of the selling session there forgets the sells in flight (the
// optimistic balances), the curve walk and the owed pair legs: the reload that
// follows offers tokens that are still being sold, and the next click sells
// them a second time. Both callbacks must drop rows through removeRows.

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

for (const name of ['onSyncApplied', 'leaveAccount']) {
  test(`${name} drops rows through session.removeRows and never resets the selling session`, () => {
    const body = callbackSource(name);
    assert.match(body, /\.removeRows\(/);
    assert.doesNotMatch(body, /\b(s|session|sessionRef\.current)\.reset\(/);
  });
}
