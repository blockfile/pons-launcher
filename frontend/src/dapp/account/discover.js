/**
 * Which browser wallets are installed: EIP-6963 discovery, with the legacy
 * window.ethereum as a fallback (spec Addendum A). No WalletConnect: it needs
 * third-party connections the page's CSP forbids.
 *
 *   listen   'eip6963:announceProvider' (detail {info: {uuid, name, icon, rdns}, provider})
 *   ask      dispatch Event('eip6963:requestProvider')
 *   fallback nothing announced within legacyAfterMs and window.ethereum has
 *            request() -> one entry 'Browser wallet'
 *
 * An announcement is attacker-shaped data (any extension can send one): a
 * provider without request() is dropped; the name is cut to 40 characters and
 * rendered as React text only; the icon is kept only as a data: image URI
 * (png, jpeg, gif, webp or svg+xml) and must be drawn with <img> only (EIP-6963:
 * an SVG in an <img> cannot run script). The list handed to React never carries
 * the provider object: provider(id) returns it to the account module alone.
 */
const ANNOUNCE = 'eip6963:announceProvider';
const REQUEST = 'eip6963:requestProvider';
const ICON_RE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/;
const MAX_ICON_CHARS = 200000;

/**
 * @param {{target?: EventTarget & {ethereum?: object}, legacyAfterMs?: number,
 *   setTimeout?: Function, clearTimeout?: Function}} [deps]
 * @returns {{start(): void, stop(): void, get(): Array<{id: string, name: string, icon: string|null, rdns: string}>,
 *   provider(id: string): object|null, subscribe(fn: () => void): () => void}}
 */
export function createDiscovery({
  target = globalThis.window,
  legacyAfterMs = 300,
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearT = (id) => globalThis.clearTimeout(id),
} = {}) {
  const found = new Map(); // id -> {id, name, icon, rdns, provider}
  let legacy = null;
  let list = [];
  let timer = null;
  let started = false;
  const subs = new Set();

  function publish() {
    const entries = found.size ? [...found.values()] : legacy ? [legacy] : [];
    list = entries.map(({ id, name, icon, rdns }) => ({ id, name, icon, rdns }));
    for (const fn of [...subs]) {
      try {
        fn();
      } catch {
        // a UI listener's bug must not stop discovery
      }
    }
  }

  function onAnnounce(event) {
    const detail = event && event.detail;
    if (!detail || typeof detail !== 'object') return;
    const { info, provider } = detail;
    if (!info || typeof info !== 'object' || !provider || typeof provider.request !== 'function') return;
    if (typeof info.uuid !== 'string' || !info.uuid || info.uuid.length > 100) return;
    const rawName = typeof info.name === 'string' ? info.name.trim().slice(0, 40) : '';
    const icon = typeof info.icon === 'string' && info.icon.length <= MAX_ICON_CHARS && ICON_RE.test(info.icon) ? info.icon : null;
    const rdns = typeof info.rdns === 'string' ? info.rdns.slice(0, 100) : '';
    const id = `eip6963:${info.uuid}`;
    found.set(id, { id, name: rawName || 'Browser wallet', icon, rdns, provider });
    publish();
  }

  function start() {
    if (started || !target || typeof target.addEventListener !== 'function') return;
    started = true;
    target.addEventListener(ANNOUNCE, onAnnounce);
    try {
      target.dispatchEvent(new Event(REQUEST));
    } catch {
      // no Event constructor: only the fallback can find a wallet
    }
    timer = setT(() => {
      timer = null;
      const eth = target.ethereum;
      if (!found.size && eth && typeof eth.request === 'function') {
        legacy = { id: 'injected', name: 'Browser wallet', icon: null, rdns: '', provider: eth };
        publish();
      }
    }, legacyAfterMs);
  }

  function stop() {
    if (!started) return;
    started = false;
    target.removeEventListener(ANNOUNCE, onAnnounce);
    if (timer !== null) clearT(timer);
    timer = null;
  }

  return {
    start,
    stop,
    get: () => list,
    provider(id) {
      const hit = found.get(id) || (legacy && legacy.id === id ? legacy : null);
      return hit ? hit.provider : null;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
