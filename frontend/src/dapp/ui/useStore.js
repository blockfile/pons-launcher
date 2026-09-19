import { useSyncExternalStore } from 'react';

/**
 * Read a small external store ({get(), subscribe(fn)}: account/account.js,
 * account/discover.js) in React. get() must return the same object until the
 * store changes — both stores replace their snapshot on every change.
 */
export function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
