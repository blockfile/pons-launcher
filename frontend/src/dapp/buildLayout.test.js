// Where the two builds put their files. The server's host gate (backend/src/tp/hostGate.js)
// serves the dApp host /dapp/assets/* and answers 404 for /assets/* — the console page's
// bundle, which must never be public on the password-less dApp host. That only holds if
// the dApp build keeps ALL its files (JS, CSS, fonts) under dist/dapp/assets and the
// console build keeps its own under dist/assets.
import test from 'node:test';
import assert from 'node:assert/strict';
import consoleConfig from '../../vite.config.js';
import dappConfig from '../../vite.dapp.config.js';

test('the dApp build emits its assets under dist/dapp/assets, the console build under dist/assets', () => {
  assert.equal(dappConfig.build.outDir, 'dist');
  assert.equal(dappConfig.build.assetsDir, 'dapp/assets');
  assert.equal(dappConfig.build.emptyOutDir, false, 'the dApp build adds to the console build');
  assert.equal(consoleConfig.build.outDir, 'dist');
  assert.equal(consoleConfig.build.assetsDir ?? 'assets', 'assets');
  assert.equal(consoleConfig.build.emptyOutDir, true);
});
