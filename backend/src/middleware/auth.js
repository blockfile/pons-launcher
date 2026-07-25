'use strict';

const config = require('../config');
const users = require('../users/users');

// A deployment with no users.json is single-tenant: every request is this one
// user, reading the original keystore path. Frozen because Task 4 hangs a
// keystore choice off req.user.id — a handler mutating it would corrupt every
// later request sharing this same object, not just its own.
const DEFAULT_USER = Object.freeze({ id: 'default', name: 'default' });

function presentedKey(req) {
  return req.get('x-api-key') || req.query.key;
}

/**
 * Attach the caller. Mounted on every /api route, because in multi-user mode
 * even a read has to know whose wallets it is reading — an unscoped GET would
 * leak the whole point of the feature.
 *
 * Once users exist, config.API_KEY is ignored entirely. Two competing notions
 * of "the key" is a way to have one of them be wrong.
 */
function identify(req, res, next) {
  if (!users.enabled()) {
    req.user = { ...DEFAULT_USER };
    return next();
  }
  const user = users.findByKey(presentedKey(req));
  if (!user) return res.status(401).json({ error: 'invalid or missing API key' });
  req.user = { id: user.id, name: user.name };
  return next();
}

/**
 * Gate for mutating routes in single-tenant mode. In multi-user mode identify
 * has already refused anyone without a valid key, so this is a no-op.
 */
function requireApiKey(req, res, next) {
  if (users.enabled()) return next();
  if (!config.apiKey) return next();
  if (presentedKey(req) === config.apiKey) return next();
  return res.status(401).json({ error: 'invalid or missing API key' });
}

module.exports = { identify, requireApiKey, DEFAULT_USER };
