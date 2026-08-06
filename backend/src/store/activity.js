'use strict';

// A per-user record of everything that moved money or keys.
//
// Launches already have their own store (history.js) because a launch has a
// large, launch-shaped payload worth keeping in full. Everything else — funding
// runs, sweeps, contract deployments, wallets appearing and leaving, key
// exports — left no trace at all once the browser tab was closed. A funding run
// that half-failed was reconstructable only from the console log, which is not
// per user and rotates.
//
// Same isolation rule as the keystore and the history: a user sees their own
// and nobody else's. Whoever can read another user's activity can see their
// addresses and amounts, so the default is still that nobody can.
//
// THE ONE EXCEPTION IS THE ADMIN VIEW, and it is deliberately narrow (viewFor,
// at the bottom of this file):
//
//   * Admin is granted by ADMIN_USERS in the environment and by nothing else.
//     No route grants it, so a stolen key cannot promote itself into one. See
//     config.adminUsers.
//   * It is read-only, and it is only this log. Wallets, keys and launch
//     history remain isolated with no exception at all.
//   * A non-admin who asks for someone else's log is not refused — the request
//     is answered with their OWN log, because a 403 would confirm that admins
//     exist and let a caller map who they are.
//   * The admin's own log records every log they open. Someone who can read
//     everyone invisibly is worse than someone whose looking is itself on the
//     record; if a second operator is ever added, that record is what makes
//     this arrangement checkable by them. Nothing is written into the log that
//     was read — that view was not its owner's action.
//
// PRIVATE KEYS ARE NEVER WRITTEN HERE. An export is recorded as the fact that
// an export happened, with a count. Anything else would turn an audit trail
// into a second copy of the keystore, in plaintext.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const users = require('../users/users');

const DEFAULT_ID = 'default';
const instances = new Map();

// Old entries are dropped rather than kept forever. This is an operational log,
// not an accounting record, and an unbounded file gets read and rewritten on
// every single action.
const MAX_ENTRIES = 500;

/** Where a user's activity log lives. */
function pathFor(userId) {
  const dir = path.dirname(config.historyPath);
  // userId is validated at creation (users.slug). The admin view is the only
  // path on which one arrives from a request, and viewFor resolves that string
  // against the real user list before it ever reaches this function — an id
  // nobody has is answered empty rather than turned into a filename, so
  // ?user=../../etc/passwd cannot escape this directory.
  return userId === DEFAULT_ID
    ? path.join(dir, 'activity.json')
    : path.join(dir, `activity.${userId}.json`);
}

function build(userId) {
  const file = pathFor(userId);

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      // Missing is the normal first-run state, and a corrupt log must never
      // fail the action it is only observing.
      return [];
    }
  }

  function persist(entries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2));
  }

  /**
   * Append one entry.
   *
   * Never throws. This is called from inside routes that have already done the
   * real work — a transfer is on chain whether or not we managed to write a
   * line about it, and failing the response at that point would tell the
   * operator their funding failed when it did not.
   *
   * @param {string} kind fund | sweep | sell | deploy | wallets | export | admin
   * @param {string} summary one line, already human-readable
   * @param {object} [detail] anything structured worth keeping. No key material.
   */
  function record(kind, summary, detail = {}) {
    try {
      const entry = { at: new Date().toISOString(), kind, summary, ...detail };
      const entries = load();
      entries.unshift(entry);
      persist(entries);
      return entry;
    } catch (err) {
      console.error(`[pons-launcher] could not write activity log: ${err.message}`);
      return null;
    }
  }

  function list({ limit = 100, kind = null } = {}) {
    const all = load();
    const filtered = kind ? all.filter((e) => e.kind === kind) : all;
    return filtered.slice(0, limit);
  }

  return { record, list, _path: () => file };
}

function activityFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

// An admin opening a panel re-reads the log on every filter click and every
// reload, and each read writes a line into the admin's own capped log. Left
// alone, an afternoon of looking would push a month of funding and exports off
// the end of the admin's own record — the audit trail eating itself. So a
// repeat view of the SAME user within this window does not write a second line.
// The window is short on purpose: it collapses one sitting, not one day.
const ADMIN_VIEW_COALESCE_MS = 60_000;

/** Record, in the admin's own log, that they opened someone else's. */
function recordAdminView(adminId, viewedId) {
  const log = activityFor(adminId);
  const [newest] = log.list({ limit: 1 });
  if (
    newest &&
    newest.kind === 'admin' &&
    newest.viewed === viewedId &&
    Date.now() - Date.parse(newest.at) < ADMIN_VIEW_COALESCE_MS
  ) {
    return null;
  }
  return log.record('admin', `viewed ${viewedId}'s activity`, { viewed: viewedId });
}

/**
 * Read a log on behalf of a caller — the whole admin exception, in one place.
 *
 * @param {string} callerId whoever is authenticated. Never the requested id.
 * @param {object} [opts]
 * @param {string} [opts.user] the id asked for, straight off the query string
 *   and therefore untrusted. IGNORED unless the caller is an admin.
 * @returns {{viewed: string, own: boolean, unknown: boolean, entries: object[]}}
 */
function viewFor(callerId, { user: requested = null, limit = 100, kind = null } = {}) {
  const own = () => ({
    viewed: callerId,
    own: true,
    unknown: false,
    entries: activityFor(callerId).list({ limit, kind }),
  });

  // Express turns ?user=a&user=b into an array, so this is not always a string.
  const wanted = typeof requested === 'string' ? requested.trim().toLowerCase() : '';

  // For everyone else the parameter simply is not there. Not a 403: refusing
  // would answer the question "does this deployment have admins, and am I
  // one?", which is exactly what someone holding a stolen key wants to know.
  if (!wanted || !users.isAdmin(callerId) || wanted === callerId) return own();

  // An admin may name a user who exists, and that is the whole vocabulary.
  // A typo, a deleted user, or a traversal attempt are all the same answer:
  // an empty log, no file touched, nothing recorded.
  if (!users.list().some((u) => u.id === wanted)) {
    return { viewed: wanted, own: false, unknown: true, entries: [] };
  }

  recordAdminView(callerId, wanted);
  return {
    viewed: wanted,
    own: false,
    unknown: false,
    entries: activityFor(wanted).list({ limit, kind }),
  };
}

/**
 * Condense a funding or sweep result into something worth reading back.
 * Keeps per-wallet outcomes — which is the whole point, since the failures are
 * what you come back for — but drops nothing else into the file.
 */
function summariseTransfers(results) {
  const rows = Array.isArray(results) ? results : results?.results || [];
  const failed = rows.filter((r) => r.error).length;
  const sent = rows.filter((r) => r.hash || r.eth?.hash || r.tokens?.hash).length;
  return { wallets: rows.length, sent, failed, results: rows };
}

module.exports = {
  activityFor,
  viewFor,
  pathFor,
  summariseTransfers,
  MAX_ENTRIES,
  ADMIN_VIEW_COALESCE_MS,
  _reset: () => instances.clear(),
};
