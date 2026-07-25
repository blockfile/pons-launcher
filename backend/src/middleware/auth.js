'use strict';

const config = require('../config');

/**
 * Gate for every mutating route. A blank API_KEY leaves the console open, which
 * is fine on a laptop and not fine on the server — config.assertLiveReady()
 * refuses to start a live deployment without one.
 */
function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  const provided = req.get('x-api-key') || req.query.key;
  if (provided === config.apiKey) return next();
  return res.status(401).json({ error: 'invalid or missing API key' });
}

module.exports = { requireApiKey };
