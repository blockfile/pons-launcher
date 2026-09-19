import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscovery } from './discover.js';

const SVG_ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

function timers() {
  const q = [];
  return {
    setTimeout: (fn, ms) => {
      q.push({ fn, ms });
      return q.length;
    },
    clearTimeout: (id) => {
      if (q[id - 1]) q[id - 1].fn = null;
    },
    fire() {
      for (const t of q.splice(0)) if (t.fn) t.fn();
    },
  };
}

/** A window stand-in: an EventTarget whose wallets answer every requestProvider. */
function page(wallets = [], { ethereum } = {}) {
  const target = new EventTarget();
  target.ethereum = ethereum;
  target.requests = 0;
  target.addEventListener('eip6963:requestProvider', () => {
    target.requests += 1;
    for (const detail of wallets) target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze(detail) }));
  });
  return target;
}

const provider = () => ({ request: async () => [] });

test('announced wallets are listed by uuid, without their provider objects; the provider is reachable by id', () => {
  const p1 = provider();
  const target = page([
    { info: { uuid: 'u-1', name: 'MetaMask', icon: SVG_ICON, rdns: 'io.metamask' }, provider: p1 },
    { info: { uuid: 'u-2', name: 'Rabby Wallet', icon: 'data:image/png;base64,AAAA', rdns: 'io.rabby' }, provider: provider() },
  ]);
  const t = timers();
  const d = createDiscovery({ target, ...t });
  let changes = 0;
  d.subscribe(() => {
    changes += 1;
  });
  d.start();
  assert.equal(target.requests, 1, 'asked once');
  assert.deepEqual(d.get(), [
    { id: 'eip6963:u-1', name: 'MetaMask', icon: SVG_ICON, rdns: 'io.metamask' },
    { id: 'eip6963:u-2', name: 'Rabby Wallet', icon: 'data:image/png;base64,AAAA', rdns: 'io.rabby' },
  ]);
  assert.equal(changes, 2);
  assert.equal(d.provider('eip6963:u-1'), p1);
  assert.equal(d.provider('eip6963:nope'), null);
  for (const w of d.get()) assert.ok(!('provider' in w));
  // the same uuid announced again replaces, never duplicates
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  assert.equal(d.get().length, 2);
  t.fire();
  assert.equal(d.get().length, 2, 'no legacy entry once a wallet announced');
});

test('a hostile announcement is dropped or cleaned: no request(), no uuid, a remote icon, a long name', () => {
  const target = page([
    { info: { uuid: 'a', name: 'NoRequest' }, provider: {} },
    { info: { name: 'NoUuid' }, provider: provider() },
    { info: { uuid: 'b', name: 'x'.repeat(200), icon: 'https://evil.example/i.png' }, provider: provider() },
    { info: { uuid: 'c', name: '   ', icon: 'javascript:alert(1)' }, provider: provider() },
    null,
  ]);
  const d = createDiscovery({ target, ...timers() });
  d.start();
  assert.deepEqual(d.get(), [
    { id: 'eip6963:b', name: 'x'.repeat(40), icon: null, rdns: '' },
    { id: 'eip6963:c', name: 'Browser wallet', icon: null, rdns: '' },
  ]);
});

test('nothing announced within the wait: window.ethereum is offered as "Browser wallet"', () => {
  const eth = provider();
  const target = page([], { ethereum: eth });
  const t = timers();
  const d = createDiscovery({ target, ...t });
  d.start();
  assert.deepEqual(d.get(), []);
  t.fire();
  assert.deepEqual(d.get(), [{ id: 'injected', name: 'Browser wallet', icon: null, rdns: '' }]);
  assert.equal(d.provider('injected'), eth);
});

test('no wallet at all: an empty list; stop() removes the listener', () => {
  const target = page([]);
  const t = timers();
  const d = createDiscovery({ target, ...t });
  d.start();
  t.fire();
  assert.deepEqual(d.get(), []);
  d.stop();
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'late', name: 'Late' }, provider: provider() } }));
  assert.deepEqual(d.get(), []);
});
