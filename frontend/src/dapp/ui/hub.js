/**
 * A tiny in-page event hub. High-frequency stream data (bars, trades, marks)
 * travels through it to the components that draw it — Chart, TradesFeed, the
 * live value lines — instead of through React state in App, so a burst of
 * trades never re-renders the sell panel.
 */
export function createHub() {
  const map = new Map();
  return {
    on(name, fn) {
      let set = map.get(name);
      if (!set) {
        set = new Set();
        map.set(name, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    emit(name, data) {
      const set = map.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(data);
        } catch (e) {
          // A drawing bug in one listener must not stop the stream reaching the others.
          console.error(`hub listener for "${name}" failed:`, e && e.message ? e.message : e);
        }
      }
    },
  };
}
