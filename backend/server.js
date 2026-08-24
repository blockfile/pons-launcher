'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const config = require('./src/config');
const factory = require('./src/evm/factory');
const users = require('./src/users/users');
const { identify } = require('./src/middleware/auth');
const walletRoutes = require('./src/routes/wallets');
const launchRoutes = require('./src/routes/launch');
// The v2 bundler lives on its own router. It shares the factory and the
// keystore with v1 and nothing else — see routes/distributor.js for why the
// two strategies are kept apart rather than merged.
const distributorRoutes = require('./src/routes/distributor');
// V3, the Relay chain. Its own router, its own modules under src/v3, and no
// edit to v1's or v2's money paths anywhere — unmounting this line removes the
// whole strategy. See src/v3/roles.js for why it does not share variants.js.
const v3Routes = require('./src/routes/v3');
const v4Routes = require('./src/routes/v4');
// Holder-fee sharing: re-point a launched v2 token's creator fee at a per-token
// distributor so it pays the holders. Its own router, sharing only the factory
// and the keystore — see src/routes/holderFees.js. Unrelated to distributorRoutes
// above, which is the launcher's own bundle distributor.
const holderFeeRoutes = require('./src/routes/holderFees');
const v4Runner = require('./src/v4/runner');
const { rpcMessage } = require('./src/evm/errors');

const app = express();

app.use(express.json({ limit: '1mb' }));

// In production the built React console is served from here, so the whole app
// is one origin behind one nginx block. In development the Vite server on
// :5173 proxies /api back to this process and dist/ does not exist yet.
const dist = path.join(__dirname, '..', 'frontend', 'dist');
const hasBuild = fs.existsSync(path.join(dist, 'index.html'));
if (hasBuild) app.use(express.static(dist));

app.get('/api/health', (req, res) => {
  const user = users.enabled() ? users.findByKey(req.get('x-api-key') || req.query.key) : null;
  // Who the /api routes below would resolve this same request to — in a
  // single-tenant deployment that is the frozen default user, which `user`
  // above deliberately reports as null. The admin bit has to be computed from
  // the same id the routes will use, or the console offers a control the
  // backend then ignores.
  const callerId = users.enabled() ? user?.id : 'default';
  res.json({
    name: 'pons-launcher',
    dryRun: config.dryRun,
    chainId: config.chainId,
    factory: config.factoryAddress,
    explorer: config.explorerUrl,
    apiKeyRequired: users.enabled() || Boolean(config.apiKey),
    multiUser: users.enabled(),
    user: user ? user.name : null,
    // Whether this caller may read other users' activity logs. Granted only by
    // ADMIN_USERS in the environment — never by anything the API can write.
    // The console uses it to decide whether the selector exists at all; the
    // routes check it again for themselves, because a client-side flag is a
    // hint, not a permission.
    admin: users.isAdmin(callerId),
  });
});

app.use('/api', identify);
app.use('/api', walletRoutes);
app.use('/api', launchRoutes);
app.use('/api', distributorRoutes);
app.use('/api', v3Routes);
app.use('/api', v4Routes);
app.use('/api', holderFeeRoutes);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  if (hasBuild) return res.sendFile(path.join(dist, 'index.html'));
  return res
    .status(404)
    .json({ error: 'no frontend build — run `npm run build`, or use the Vite dev server on :5173' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[pons-launcher] request error:', err.message);
  res.status(400).json({ error: rpcMessage(err) });
});

let server;

async function main() {
  if (!config.dryRun) config.assertLiveReady();

  // Factory deployments rotate — five are verified on this chain. Refuse to
  // start against a dead one rather than failing confusingly mid-launch.
  try {
    const info = await factory.validate();
    console.log(
      `[pons-launcher] factory ${config.factoryAddress} ok — launchFee ${info.launchFee} wei, ` +
        `${info.launchConfigs} launch configs, ${info.dexConfigs} dex configs`
    );
  } catch (err) {
    console.error(`[pons-launcher] FACTORY CHECK FAILED: ${err.message}`);
    if (!config.dryRun) throw err;
    console.error('[pons-launcher] continuing anyway because DRY_RUN=true');
  }

  // A seasoning campaign outlives this process. Every other job in this codebase
  // dies on restart, which is fine for a run measured in minutes and is not fine
  // for one measured in weeks — so V4's campaigns are read back off disk and
  // re-armed here. Transfers that came due while the process was gone are
  // re-slotted forward, never fired as a burst.
  try {
    const { resumed, parked } = v4Runner.resumeAll();
    if (resumed.length || parked.length) {
      console.log(
        `[v4] resumed ${resumed.length} seasoning campaign(s)` +
          (parked.length
            ? `, parked ${parked.length} (funding wallet already claimed by another campaign — not funding)`
            : '')
      );
    }
  } catch (err) {
    console.error('[v4] could not resume campaigns:', err.message);
  }

  server = app.listen(config.port, config.host, () => {
    console.log(`[pons-launcher] listening on http://${config.host}:${config.port}`);
    console.log(`[pons-launcher] dryRun=${config.dryRun} chainId=${config.chainId}`);
    if (config.dryRun) console.log('[pons-launcher] DRY_RUN — nothing will be broadcast');
    if (!config.apiKey) console.warn('[pons-launcher] WARNING: API_KEY is not set — mutating routes are open');
  });
}

function shutdown(signal) {
  console.log(`\n[pons-launcher] ${signal} received, shutting down`);
  if (server) server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  main().catch((err) => {
    console.error('[pons-launcher] failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = app;
