/**
 * Lock, Disconnect and Switch (spec Addendum A): the account's wallets leave
 * this tab. App.jsx passes the real pieces; leaveAccount.test.js passes fakes.
 *
 * The order is the safety:
 *   1. Save what is not saved yet. If that fails the visitor decides, and "no"
 *      changes nothing at all.
 *   2. Stop the sync BEFORE anything is removed. A running sync hears the
 *      wallet store's 'clear' and would save the emptied tab over the account's
 *      copy. A sync that cannot be stopped therefore removes nothing.
 *   3. Lock (or disconnect) the account: its unlock key goes. If that throws,
 *      the tab still empties (the account drops the key before anything else).
 *   4. Only if the tab was unlocked, LEAVE_STEPS in order: the keys, the rows
 *      (App drops them through session.removeRows, never the session's reset:
 *      a sell in flight keeps counting until it settles), the wallet count, the
 *      positions. Each one runs even when one before it throws, so the tab never
 *      keeps a row whose key is gone. What threw comes back in `errors`.
 * A tab that was never unlocked keeps its wallets: the visitor imported them.
 *
 * It never rejects. AccountBar calls onAction without awaiting it, so a throw
 * here would be an unhandled rejection; App shows `errors` instead.
 */
export const LEAVE_STEPS = Object.freeze(['clearWallets', 'dropRows', 'syncOwnAddrs', 'forgetPositions']);

const messageOf = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e ?? 'failed'));

/**
 * @param {'lock'|'disconnect'} how
 * @param {{
 *   account: {get(): {status: string}, lock(): Promise<void>, disconnect(): Promise<void>},
 *   getSync(): ({flush(): Promise<{ok: boolean, error?: string}>, stop(): void} | null),
 *   dropSync(sync: object): void,
 *   confirm(text: string): boolean,
 *   clearWallets(): void,
 *   dropRows(): void,
 *   syncOwnAddrs(): void,
 *   forgetPositions(): void,
 * }} d
 * @returns {Promise<{left: boolean, errors: Error[]}>} left: false when nothing
 *   was removed (the visitor said no, or the sync would not stop).
 */
export async function leaveAccountTab(how, d) {
  const errors = [];
  const wasOpen = d.account.get().status === 'unlocked';
  const sync = d.getSync();
  if (sync) {
    let saved;
    try {
      saved = await sync.flush();
    } catch (e) {
      saved = { ok: false, error: messageOf(e) };
    }
    if (!saved || !saved.ok) {
      const why = (saved && saved.error) || 'not saved';
      if (!d.confirm(`Your latest changes are not saved to your account (${why}). Continue? The wallets leave this tab.`)) {
        return { left: false, errors };
      }
    }
    try {
      sync.stop();
    } catch (e) {
      errors.push(e);
      return { left: false, errors };
    }
    d.dropSync(sync);
  }
  try {
    if (how === 'disconnect') await d.account.disconnect();
    else await d.account.lock();
  } catch (e) {
    errors.push(e);
  }
  if (wasOpen) {
    for (const name of LEAVE_STEPS) {
      try {
        d[name]();
      } catch (e) {
        errors.push(e);
      }
    }
  }
  return { left: true, errors };
}
