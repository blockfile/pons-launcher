'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — the letscash.fun (CashCat) LAUNCH money path.
//
// This is the file that turns a chosen config + a first-buy amount into a REAL,
// SIGNED `launch(...)` transaction and then broadcasts it. It is a fund path, so
// it is built on the same discipline as the pons v2 launcher (bundle/prepareV2 +
// bundle/fireV2), which is the model this mirrors:
//
//   prepareLaunch()  — reads the live factory, mines the vanity salt, builds the
//                      launch calldata, SIMULATES it as a hard fail-safe, and
//                      only then signs it at the launcher's pending nonce.
//                      BROADCASTS NOTHING. The signed tx rides home in the plan.
//   fireLaunch()     — broadcasts that one pre-signed launch, does a bounded
//                      fire-time revert re-check first, awaits the receipt, and
//                      reads the token / pool / hook back OUT of the receipt.
//
// WHY THIS SHAPE (sign-at-preflight, broadcast-at-fire):
//   * Nothing is signed until the launch has proven it will not revert. A launch
//     that cannot `eth_call` cleanly is never signed — no fee is risked. (pons v2
//     learned this the hard way: a launch allowed through when it would revert
//     stranded 1.798 ETH. See bundle/prepareV2.js.)
//   * At fire time the critical path is just a broadcast, not key derivation.
//
// WHY v5 IS SIMPLER THAN v2 AND CANNOT STRAND THE WAY v2 COULD:
//   letscash has NO snipe-tax exemption and NO separate pre-signed bundle buys.
//   The bundler's edge is the ATOMIC firstBuyIn — a buy that executes INSIDE the
//   launch transaction, after the pool is seeded, before the pool is tradeable by
//   anyone else. There is nothing to race and nothing to strand: a reverted v5
//   launch simply created no token and ran nothing else, so this file has no
//   equivalent of fireV2's "buys may have paid into a curve that never existed"
//   warning. The fan-out to the v5bundle wallets is a LATER phase (token→token
//   transfers are untaxed); it is not part of the launch.
//
// The read/build/decode primitives all live in evm/v5/factory.js and are already
// verified byte-for-byte against a real CRYINGCAT launch — this module only
// orchestrates them, signs, and broadcasts.
// ─────────────────────────────────────────────────────────────────────────────

const { parseEther, parseUnits, formatEther, formatUnits, getAddress, ZeroAddress, Interface, Transaction } = require('ethers');
const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { keystoreFor } = require('../wallets/keystore');
const { getDecimals } = require('../evm/erc20');
const factoryModule = require('../evm/v5/factory');
const v5roles = require('./roles');

// balanceOf/allowance/approve for a USDG-quoted first buy. erc20.js exposes only
// read+transfer, so the approval fragment lives here with the launch.
const quoteErc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// Same +25% headroom the pons launcher uses, so a launch is not the transaction
// left behind when the base fee ticks up between preflight and broadcast.
const FEE_BUMP_PCT = 25;

// A USDG first buy needs the launcher to approve the factory to pull it. Generous;
// unused gas is refunded.
const APPROVE_GAS = 90_000n;

// Vanity-salt search bounds. mineSalt runs the whole search inside ONE eth_call
// (bounded by `rounds`), so a call is one round trip covering `rounds` tries. The
// "cc" stamp lands with p ≈ 1/1024 per try on an ETH quote, so 5000 rounds hits
// ~99.2% of the time; we retry with `start` advanced a few times to cover a node
// that truncates the search under the timeout. All three are overridable per call.
const DEFAULT_SALT_ROUNDS = 5000;
const DEFAULT_SALT_ATTEMPTS = 3;
const DEFAULT_SALT_TIMEOUT_MS = 15000;

// The token is a clone of CONSTANT init code, so its address depends only on
// (launcher, salt) — name/symbol do NOT move it. Starting the vanity search from a
// fixed 0 made a given launcher re-mine the SAME first "cc" salt (hence the same
// address) on every launch; the second launch's CREATE2 then hit already-deployed
// code and reverted FailedDeployment. So the search starts from a RANDOM offset
// (a different address each run), and the loop additionally skips any mined
// address that already has code. Randomness only picks WHERE to search; it never
// weakens the "cc"/undeployed requirements the launch itself enforces.
function randomSaltStart() {
  return BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

// The fire-time revert re-check is HARD-CAPPED: one eth_call, and if the node
// does not answer in time we PROCEED (preflight already validated this exact tx).
// It aborts ONLY on a definitive revert. Mirrors bundle/fireV2's RECHECK_MS.
const RECHECK_MS = 250;

/**
 * Strip the fields signTransaction rejects and pin the pieces it needs. The
 * launch tx from buildLaunchTx carries `{to,data,value,quote,firstBuyFromAllowance}`;
 * only to/data/value are signable, plus the nonce/gas/chainId/fees we add here.
 */
function toSignable(txFields, { nonce, gasLimit, fees, chainId }) {
  return {
    to: txFields.to,
    data: txFields.data,
    value: txFields.value,
    nonce,
    gasLimit,
    chainId,
    ...fees,
  };
}

/** BigInt fees → strings, so the plan survives JSON.stringify (which throws on a BigInt). */
function stringifyFees(fees) {
  return Object.fromEntries(
    Object.entries(fees).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
  );
}

/**
 * THE FAIL-SAFE gas estimate. estimateGas is a real revert check: if the launch
 * would revert, this throws with the factory's own error name and NOTHING is
 * signed. simulateLaunch (below, in prepareLaunch) is the primary gate; this is
 * the second, and it also yields the gas limit to sign with (+20% headroom).
 */
async function estimateLaunchGasOrThrow(txFields, from, { provider: p, explain }) {
  try {
    const est = await p.estimateGas({
      to: txFields.to,
      data: txFields.data,
      value: txFields.value,
      from: getAddress(from),
    });
    return (est * 12n) / 10n;
  } catch (err) {
    throw new Error(
      `the launch would revert, so nothing was signed: ${explain(err)}. ` +
        'Fix this before launching — the fee is only at risk once a launch is broadcast.'
    );
  }
}

/**
 * Build + sign a letscash launch WITHOUT broadcasting anything.
 *
 * @param {object} input
 * @param {object} input.params          { name, symbol, logo, description, metadataURI?, socials? }.
 *                                        params.creator is IGNORED and overwritten with the launcher.
 * @param {number|bigint} input.configId a live config id (1000-1063; see getConfigs).
 * @param {string|number} [input.firstBuyEth] the ATOMIC first buy, in ETH (the guaranteed-first entry).
 * @param {string} [input.quote]         optional sanity assertion against the config's own quote.
 * @param {number} [input.slippageBps]   accepted for API symmetry; see firstBuyMinOut below.
 * @param {string} [input.firstBuyMinOut] explicit wei floor override (default 0 — see below).
 * @param {string} [input.salt]          a pre-mined vanity salt; omit to mine one here.
 * @param {object} [deps]                injected for tests: { keystore, roles, factory, provider, runner, getFees }.
 * @returns {Promise<object>} a plan whose `launch.raw` is the signed launch tx. Broadcast NOTHING.
 */
async function prepareLaunch(input, deps = {}) {
  // Everything the chain-touching work goes through is injectable, so the
  // "signs nothing until it simulates" guarantee can be exercised end to end
  // with no RPC. Defaults are the real modules — production behaviour unchanged.
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const f = deps.factory || factoryModule;
  const prov = deps.provider || provider;
  const runner = deps.runner || prov; // what the factory's read/build calls use
  const getFeesFn = deps.getFees || getFees;
  const decimalsOf = deps.getDecimals || getDecimals; // for a USDG first buy's units
  const readQuoteBalance =
    deps.readQuoteBalance ||
    (async (t, o) =>
      quoteErc20Iface.decodeFunctionResult(
        'balanceOf',
        await prov.call({ to: t, data: quoteErc20Iface.encodeFunctionData('balanceOf', [o]) })
      )[0]);
  const readQuoteAllowance =
    deps.readQuoteAllowance ||
    (async (t, o, s) =>
      quoteErc20Iface.decodeFunctionResult(
        'allowance',
        await prov.call({ to: t, data: quoteErc20Iface.encodeFunctionData('allowance', [o, s]) })
      )[0]);

  const { params, configId } = input;
  if (params == null || !params.name || !params.symbol) {
    throw new Error('params.name and params.symbol are required');
  }
  if (configId == null) throw new Error('configId is required (see GET /v5/config → configs, ids 1000-1063)');

  // ── the launcher ───────────────────────────────────────────────────────────
  // The v5dev wallet is the ONLY thing that can sign this — one launch, one
  // position, one payer (a singleton; see v5/roles.js). It must exist first.
  const dev = roles.dev(ks);
  if (!dev) {
    throw new Error(
      'no v5dev launcher wallet exists — generate one first (POST /v5/wallets/generate with role "v5dev")'
    );
  }

  const warnings = [];

  // ── params, with creator FORCED to the launcher ────────────────────────────
  // The factory reverts CreatorMustBeSender unless params.creator == msg.sender.
  // The launcher is msg.sender, so creator MUST be its address — any value the
  // caller supplied is overwritten, never trusted. (buildLaunchTx re-checks this
  // against `sender` below, so a regression here reverts before it can sign.)
  const fullParams = {
    name: String(params.name).trim(),
    symbol: String(params.symbol).trim(),
    logo: (params.logo != null ? String(params.logo) : '').trim(),
    description: (params.description != null ? String(params.description) : '').trim(),
    metadataURI: (params.metadataURI != null ? String(params.metadataURI) : '').trim(),
    socials: {
      telegram: (params.socials?.telegram || '').trim(),
      twitter: (params.socials?.twitter || '').trim(),
      discord: (params.socials?.discord || '').trim(),
      website: (params.socials?.website || '').trim(),
      extra: (params.socials?.extra || '').trim(),
    },
    creator: getAddress(dev.address),
  };

  // ── the live menu + fee ────────────────────────────────────────────────────
  const cfgs = await f.getConfigs({ runner });
  if (!cfgs.launchEnabled) throw new Error('letscash launches are paused right now (launchEnabled = false)');
  const cfg = cfgs.configs.find((c) => c.configId === Number(configId));
  if (!cfg) {
    throw new Error(
      `no launch config ${configId} on the live menu (${cfgs.firstConfigId}-${cfgs.nextConfigId - 1})`
    );
  }
  if (!cfg.enabled) throw new Error(`launch config ${configId} is disabled`);
  const launchFee = BigInt(cfgs.launchFeeWei);

  // ── the quote asset is fixed BY THE CONFIG, not chosen per launch ──────────
  // Deriving it from the config (never from input) is what keeps the value maths
  // correct: a config quoted in USDG that we treated as ETH would push the first
  // buy into msg.value and revert IncorrectValue. If the caller named a quote it
  // is honoured only as an assertion against the config's own.
  const quoteAddr = getAddress(cfg.quoteAsset);
  const native = Boolean(cfg.quoteIsNative);
  if (input.quote != null) {
    const q = String(input.quote).toLowerCase();
    const wanted =
      q === 'eth' || q === 'native' || input.quote === ZeroAddress ? ZeroAddress : getAddress(input.quote);
    if (getAddress(wanted) !== quoteAddr) {
      throw new Error(
        `config ${configId} is quoted in ${cfg.quoteSymbol} (${quoteAddr}), not ${wanted} — ` +
          'pick a config whose quote you actually want'
      );
    }
  }

  // ── the atomic first buy ───────────────────────────────────────────────────
  // Denominated in the CONFIG'S QUOTE units: an ETH-quoted config takes ETH (18
  // dec, ridden in msg.value), a USDG-quoted config takes USDG (6 dec, PULLED from
  // the launcher by the factory via transferFrom — so it must be approved first,
  // handled below). The amount comes from input.firstBuy (or the legacy
  // firstBuyEth alias) as a decimal string in those units, never wei.
  const quoteDecimals = native ? 18 : Number(await decimalsOf(quoteAddr));
  // On a USDG config the amount is in USDG units, so it must come via `firstBuy`,
  // NOT the legacy `firstBuyEth` alias — a caller passing firstBuyEth:"5" on a USDG
  // config would otherwise silently buy 5 USDG, not 5-ETH-worth. Refuse the
  // ambiguous field rather than mis-denominate.
  if (!native && input.firstBuy == null && Number(String(input.firstBuyEth ?? '').trim() || 0) > 0) {
    throw new Error(
      `config ${configId} is quoted in ${cfg.quoteSymbol} — pass the first buy as \`firstBuy\` in ` +
        `${cfg.quoteSymbol} units, not \`firstBuyEth\``
    );
  }
  // Blank/empty means no first buy (0), not a parse error.
  const firstBuyAmountStr = String(input.firstBuy ?? input.firstBuyEth ?? 0).trim() || '0';
  const firstBuyIn = parseUnits(firstBuyAmountStr, quoteDecimals);

  // A USDG first buy is PULLED from the launcher by the factory (transferFrom), so
  // the launcher must both HOLD the USDG and have APPROVED the factory to pull it.
  // That approval is a SEPARATE, one-time operator action (approveQuoteForLaunch /
  // the Approve button), deliberately NOT folded into this signed launch: keeping
  // the allowance on-chain BEFORE preflight is exactly what lets simulateLaunch —
  // the "never sign a doomed launch" fail-safe — eth_call the real launch and pass
  // (the factory's transferFrom would revert against an unapproved launcher). So we
  // verify balance + allowance here and refuse with a clear instruction, rather
  // than sign a launch that would revert.
  if (!native && firstBuyIn > 0n) {
    const [held, allowed] = await Promise.all([
      readQuoteBalance(quoteAddr, dev.address),
      readQuoteAllowance(quoteAddr, dev.address, config.letscash.factory),
    ]);
    if (held < firstBuyIn) {
      throw new Error(
        `the launcher holds ${formatUnits(held, quoteDecimals)} ${cfg.quoteSymbol} but the first buy ` +
          `needs ${firstBuyAmountStr} — fund the launcher with ${cfg.quoteSymbol} first`
      );
    }
    if (allowed < firstBuyIn) {
      throw new Error(
        `the launcher has not approved the factory to pull ${firstBuyAmountStr} ${cfg.quoteSymbol} — ` +
          'approve it first (POST /v5/launch/approve, or the Approve button), then launch'
      );
    }
  }

  // ── firstBuyMinOut: DEFAULT 0, and that is the SAFE choice here ─────────────
  // letscash's hook rejects partial fills, so a first buy that cannot clear its
  // minOut reverts FirstBuySlippage and burns the launch. We have no pre-launch
  // quote to size a floor from anyway: the pool does not exist until this very
  // transaction creates it, and simulateLaunch returns only (token, poolId), not
  // the first-buy output. Crucially a floor is UNNECESSARY: the first buy runs
  // INSIDE the launch, after the pool is seeded and before anyone else can trade
  // it, so nothing can front-run, sandwich, or move the price against it — a 0
  // floor cannot be exploited on this buy. So default 0; honour an explicit
  // override if a caller genuinely has a trusted estimate.
  let firstBuyMinOut = 0n;
  if (input.firstBuyMinOut != null) {
    firstBuyMinOut = BigInt(input.firstBuyMinOut);
  } else if (Number(input.slippageBps || 0) > 0) {
    warnings.push(
      'slippageBps was supplied but there is no pre-launch quote source for the atomic first buy, ' +
        'so firstBuyMinOut stays 0 — this is safe: the first buy executes inside the launch, before ' +
        'the pool is tradeable, so it cannot be front-run or sandwiched, and a non-zero floor would ' +
        'only risk reverting a legitimate launch.'
    );
  }

  // ── the vanity "cc" salt ───────────────────────────────────────────────────
  // A launch reverts VanityAddressRequired unless the token address ends in "cc"
  // (and, for a non-native quote, the quote sorts below the token). mineSalt finds
  // a salt that satisfies both; an un-mined salt makes the launch calldata revert.
  let salt = input.salt || null;
  let minedToken = null;
  if (salt == null) {
    const rounds = Number(input.saltRounds || DEFAULT_SALT_ROUNDS);
    const attempts = Number(input.saltAttempts || DEFAULT_SALT_ATTEMPTS);
    const timeoutMs = Number(input.saltTimeoutMs || DEFAULT_SALT_TIMEOUT_MS);
    // Random start (see randomSaltStart) so a repeat launch by the same launcher
    // does not re-mine the same already-deployed "cc" address.
    let start = input.saltStart != null ? BigInt(input.saltStart) : randomSaltStart();
    // Read code at a candidate address to skip one that is already deployed. Falls
    // back to "undeployed" when no getCode is available (offline tests inject a
    // provider without it), which cannot mask a real collision on-chain.
    const codeOf = deps.getCode || (typeof prov.getCode === 'function' ? (a) => prov.getCode(a) : async () => '0x');
    let scans = 0;
    const maxScans = attempts + 6; // headroom so already-deployed skips don't eat the miss budget
    while (salt == null && scans < maxScans) {
      scans += 1;
      const hit = await f.mineSalt(
        { params: fullParams, configId, sender: dev.address, start, rounds, timeoutMs },
        { runner }
      );
      if (!hit) {
        start += BigInt(rounds); // a miss — widen past the window already tried
        continue;
      }
      // Skip an already-deployed vanity address: CREATE2 to code that already
      // exists reverts FailedDeployment (0xb06ebf3d). Advance past this salt and
      // keep mining for a fresh one.
      let existing = '0x';
      try {
        existing = await codeOf(getAddress(hit.token));
      } catch (_err) {
        // A getCode blip is not a reason to reject a valid mint — treat as unused.
      }
      if (existing && existing !== '0x') {
        start = BigInt(hit.salt) + 1n;
        continue;
      }
      salt = hit.salt;
      minedToken = getAddress(hit.token);
    }
    if (salt == null) {
      throw new Error(
        `could not mine an UNUSED vanity "cc" salt in ${maxScans} × ${rounds} rounds — the search is ` +
          'probabilistic (~1/1024 per try) and skips already-deployed addresses. Simply retry, or widen saltRounds.'
      );
    }
  }

  // The predicted token address for this salt. mineSalt already returned it; a
  // caller-supplied salt is resolved with predictToken.
  let token = minedToken;
  if (token == null) {
    token = await f.predictToken({ params: fullParams, configId, sender: dev.address, salt }, { runner });
  }
  // A caller-supplied salt that does NOT stamp "cc" would revert the launch — say
  // so up front with a clear message rather than as a raw selector out of simulate.
  if (input.salt && !f.hasVanitySuffix(token)) {
    throw new Error(
      `the supplied salt yields ${token}, which lacks the required "cc" stamp — the launch would ` +
        'revert VanityAddressRequired. Omit `salt` to mine a valid one.'
    );
  }

  // ── build → SIMULATE (the primary fail-safe) → sign ────────────────────────
  const txFields = f.buildLaunchTx({
    params: fullParams,
    configId,
    firstBuyIn,
    firstBuyMinOut,
    salt,
    launchFeeWei: launchFee,
    quote: quoteAddr,
    // Passing sender makes buildLaunchTx re-assert creator == sender, so a
    // creator regression reverts HERE, before any chain work.
    sender: dev.address,
  });
  const value = txFields.value; // native: fee + firstBuyIn; non-native: fee only

  // The launch, run as a static call by the factory itself. Free, and derived by
  // the contract rather than by our reconstruction of it — so it is real evidence
  // both that the launch will not revert AND that the token/pool we are about to
  // persist for the Sell/Bundle steps are the ones the launch will actually make.
  const sim = await f.simulateLaunch(txFields, dev.address, { runner });
  if (!sim.ok) {
    throw new Error(
      `the launch would revert, so nothing was signed: ${sim.reason}. ` +
        'Fix this before launching — no fee is spent when the launch cannot simulate.'
    );
  }
  // Cross-check: the address the factory would create must equal what we
  // predicted/mined. If they disagree, whatever we persist points at the wrong
  // token and the later Sell/Bundle would trade the wrong pool. Refuse to sign.
  if (getAddress(sim.token) !== getAddress(token)) {
    throw new Error(
      `address prediction disagrees with the factory — predicted ${token}, the launch would create ` +
        `${sim.token}. Refusing to sign against a token the Sell/Bundle steps would not find.`
    );
  }
  token = getAddress(sim.token); // the factory's answer is authoritative
  const poolId = sim.poolId;

  // ── fees, gas, and "can the launcher actually pay for this?" ───────────────
  const fees = await getFeesFn(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);
  const gasLimit = await estimateLaunchGasOrThrow(txFields, dev.address, {
    provider: prov,
    explain: f.explainRevert,
  });
  const needed = value + gasCost(fees, gasLimit);
  const balance = await prov.getBalance(dev.address);
  if (balance < needed) {
    // value = fee + firstBuyIn for native, fee only for USDG (its first buy is
    // pulled as USDG, not ridden in msg.value), so the ETH first-buy portion is
    // value − fee: firstBuyIn for ETH, 0 for USDG. Report it honestly.
    const ethFirstBuy = value - launchFee;
    throw new Error(
      `v5dev ${dev.address} holds ${formatEther(balance)} ETH but the launch needs ` +
        `${formatEther(needed)} (fee ${formatEther(launchFee)} + ETH first buy ${formatEther(ethFirstBuy)} + gas)`
    );
  }

  // ── the SETTLED-nonce gate (the restart-proof half of the double-launch guard) ─
  // The route's in-memory pendingLaunches marker parks a launch whose receipt
  // never arrived, but that marker dies on a process restart — leaving a window
  // where a launch broadcast before the restart is still in the mempool at nonce
  // N, yet a fresh launch would read 'pending' as N+1 and sign a SECOND launch
  // against the same wallet (two fees + two first-buys). The chain is the durable
  // source of truth: if the launcher's next-pending nonce is ahead of its
  // confirmed (latest) nonce, it has an unconfirmed tx in flight, and we refuse to
  // sign another launch until it settles. This needs no persistence and survives a
  // restart — the same guard prepareBundle uses on the shared wallet.
  const [pendingNonce, latestNonce] = await Promise.all([
    prov.getTransactionCount(dev.address, 'pending'),
    prov.getTransactionCount(dev.address, 'latest'),
  ]);
  if (pendingNonce > latestNonce) {
    throw new Error(
      `the launcher has ${pendingNonce - latestNonce} transaction(s) still in flight — wait for the ` +
        'previous launch to confirm, reconcile it via /v5/launch/resolve, or — if it is genuinely stuck ' +
        '(neither mining nor dropping) — replace it via /v5/launcher/cancel, before launching again, so a ' +
        'second launch cannot spend a second fee + first buy at the next nonce'
    );
  }

  // ── SIGN, at the launcher's pending nonce. Broadcast NOTHING. ──────────────
  const nonce = pendingNonce;
  const signer = ks.signer(dev.id, prov);
  const raw = await signer.signTransaction(toSignable(txFields, { nonce, gasLimit, fees, chainId }));

  return {
    protocol: 'v5',
    mode: 'presigned',
    dryRun: config.dryRun,
    token, // predicted; the RECEIPT is authoritative for the per-pool hook at fire time
    poolId,
    configId: Number(configId),
    quote: quoteAddr,
    quoteSymbol: cfg.quoteSymbol,
    quoteIsNative: native,
    configMode: cfg.mode, // 'creator' | 'selfburn'
    supply: cfg.supply,
    taxLabel: cfg.taxLabel,
    salt,
    params: fullParams,
    firstBuyMinOut: firstBuyMinOut.toString(),
    launchFeeEth: formatEther(launchFee),
    // The first buy in the CONFIG'S quote units (ETH or USDG), the authoritative
    // figure. firstBuyEth stays for the native case / back-compat and is the ETH
    // that actually rides in msg.value (0 for a USDG launch — its buy is pulled as
    // USDG, not sent as ETH).
    firstBuyAmount: formatUnits(firstBuyIn, quoteDecimals),
    firstBuyQuote: cfg.quoteSymbol,
    launch: {
      walletId: dev.id,
      address: dev.address,
      raw, // SIGNED — the routes strip this before the plan ever leaves the server
      nonce,
      valueEth: formatEther(value),
      firstBuyEth: formatEther(value - launchFee),
      firstBuyAmount: formatUnits(firstBuyIn, quoteDecimals),
      gas: gasLimit.toString(),
    },
    // The preview the preflight route returns alongside the public plan.
    simulate: { ok: true, token, poolId },
    fees: stringifyFees(fees),
    chainId: chainId.toString(),
    warnings,
  };
}

// ── fire-time revert re-check helpers (compact copies of fireV2's, kept local so
//    v5's whole money path is auditable in one file — see the tab-isolation rule) ─

/**
 * Is a failed estimate a DEFINITIVE revert (abort) or a transient blip (proceed)?
 * ethers marks an execution revert CALL_EXCEPTION — including a bare revert() with
 * no data — and revert data can hide in several slots depending on node/path, so
 * both signals are checked and the gate errs toward catching a revert.
 */
function isDefiniteRevert(err) {
  if (err && err.code === 'CALL_EXCEPTION') return true;
  const data =
    err?.data ||
    err?.info?.error?.data ||
    err?.error?.data ||
    err?.revert?.data ||
    (typeof err?.value === 'string' && err.value.startsWith('0x') ? err.value : null);
  return typeof data === 'string' && data.startsWith('0x') && data.length >= 10;
}

/**
 * One bounded eth_call re-validating the launch just before broadcast. Aborts
 * ONLY on a definitive revert; a timeout, a transient error, or a provider that
 * cannot estimate all PROCEED — preflight already validated this exact tx, and
 * the launch must not be held hostage to a slow RPC.
 */
async function recheckLaunch(rpc, tx, explain, { timeoutMs = RECHECK_MS } = {}) {
  if (typeof rpc.estimateGas !== 'function') return { ok: true, skipped: true };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: true, timedOut: true }), timeoutMs);
  });
  const check = rpc
    .estimateGas(tx)
    .then(() => ({ ok: true }))
    .catch((err) => (isDefiniteRevert(err) ? { ok: false, reason: explain(err) } : { ok: true, transient: true }));
  const result = await Promise.race([check, timeout]);
  clearTimeout(timer);
  return result;
}

/**
 * Broadcast the pre-signed launch, then read the token / pool / hook back OUT of
 * the mined receipt.
 *
 * @param {object} plan  the plan from prepareLaunch (its launch.raw is signed).
 * @param {object} [deps] injected for tests: { provider, factory, waitForReceipt, warmPool, dryRun, skipRecheck }.
 * @returns {Promise<object>} { token, poolId, hook, firstBuyOut, launch:{hash,status,blockNumber}, ... }
 */
async function fireLaunch(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;
  const f = deps.factory || factoryModule;
  const parseReceipt = deps.parseLaunchReceipt || f.parseLaunchReceipt;
  const explain = deps.explainRevert || f.explainRevert;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const warm = deps.warmPool || warmPool;

  // A dry run reports where the launch WOULD land without touching the chain. The
  // per-pool hook is unknowable without a real receipt, so it is null here.
  if (dryRun) {
    return {
      simulated: true,
      protocol: 'v5',
      token: plan.token,
      poolId: plan.poolId ?? null,
      hook: null,
      firstBuyOut: null,
      launch: { address: plan.launch?.address, hash: null, status: 'simulated', blockNumber: null },
    };
  }

  if (!plan.launch?.raw) throw new Error('plan has no signed launch — re-run preflight');

  // Warm one socket before the broadcast — a cold TLS handshake in the way costs
  // more than the send itself. One is enough: v5 fires a single launch, no burst.
  await warm(1, rpc);

  // The bounded fire-time re-check. Catches state that drifted since preflight
  // (config disabled, fee changed, salt taken) and aborts only on a definitive
  // revert. Unlike v2 there are no pre-signed buys behind this, so a doomed launch
  // would merely waste gas — but there is no reason to send one.
  if (!deps.skipRecheck) {
    let tx = null;
    try {
      const p = Transaction.from(plan.launch.raw);
      tx = { to: p.to, data: p.data, value: p.value, from: p.from };
    } catch (_err) {
      // Unparseable raw — skip the re-check; preflight estimated this same tx.
    }
    if (tx) {
      const rc = await recheckLaunch(rpc, tx, explain, { timeoutMs: deps.recheckMs ?? RECHECK_MS });
      if (!rc.ok) {
        throw new Error(
          `the launch reverts as of now, so nothing was broadcast: ${rc.reason}. ` +
            'State changed since preflight — re-run preflight before launching.'
        );
      }
    }
  }

  // The broadcast hash is DETERMINISTIC from the signed bytes — compute it before
  // sending, so that even if broadcastTransaction throws with no response we still
  // know which tx may now be live.
  let signedHash = null;
  try {
    signedHash = Transaction.from(plan.launch.raw).hash;
  } catch (_err) {
    // Unparseable raw is caught by the no-raw guard above; leave null.
  }

  let resp;
  try {
    resp = await rpc.broadcastTransaction(plan.launch.raw);
  } catch (err) {
    // CRITICAL: broadcastTransaction can throw AFTER the node accepted the tx — a
    // timed-out / lost eth_sendRawTransaction response on a busy RPC. We cannot
    // know the tx did NOT land, so we must NOT let this throw past the caller's
    // in-flight park: a fresh launch would then sign at the next nonce and, if the
    // first did land, spend a second fee + first buy. Return a PENDING outcome
    // carrying the deterministic hash so the route parks the wallet exactly as a
    // receipt timeout does — resolvable via /v5/launch/resolve.
    return resultFromReceipt(null, plan, signedHash, {
      parseReceipt,
      pendingReason:
        `the broadcast response was lost (${explain(err)}) — the launch MAY be live in the mempool. ` +
        'Check the hash on the explorer and resolve it before retrying, so the same launch is not sent twice.',
    });
  }

  // The tx is now BROADCAST (resp.hash is live). Awaiting/parsing the receipt must
  // never throw PAST this point: if awaitReceipt or the parse fault (e.g. a provider
  // wiring fault), fireLaunch throwing here would make the route skip its pending-park
  // + activity record, losing the token/pool/hook pinning for a launch that may well
  // confirm — the settled-nonce gate still blocks a double-spend, but Sell/Bundle
  // could no longer find the token. Same guarantee as the lost-broadcast branch
  // above: on any fault return a 'pending' result carrying the live hash so the route
  // parks it and /v5/launch/resolve recovers it.
  try {
    const receipt = await awaitReceipt(rpc, resp.hash);
    return resultFromReceipt(receipt, plan, resp.hash, { parseReceipt });
  } catch (err) {
    return resultFromReceipt(null, plan, resp.hash, {
      parseReceipt,
      pendingReason:
        `the launch was broadcast but its receipt could not be read (${explain(err)}) — the tx MAY be ` +
        'live. Check the hash on the explorer and resolve it before retrying, so it is not sent twice.',
    });
  }
}

/**
 * Turn a mined (or absent) receipt into the launch result. Shared by fireLaunch
 * (right after broadcast) and reconcileLaunch (re-checking a stranded launch), so
 * the confirmed / reverted / pending / unparsed branches — and above all which
 * HOOK is authoritative — are decided in exactly ONE place.
 *
 * @param {object|null} receipt   the mined receipt, or null if it never appeared.
 * @param {{token?:string, poolId?:string}} planLike  the predicted token/pool, for
 *        the non-confirmed branches and the mismatch cross-check.
 * @param {string} hash           the broadcast tx hash.
 */
function resultFromReceipt(receipt, planLike, hash, { parseReceipt, pendingReason } = {}) {
  const planToken = planLike?.token ?? null;
  const planPoolId = planLike?.poolId ?? null;
  const status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
  const launch = { hash, status, blockNumber: receipt?.blockNumber ?? null };

  // A reverted (or still-pending) launch: report it and parse NOTHING. There is
  // no bundle that already went out — the first buy is atomic inside this very
  // transaction — so a revert strands nothing. Say that plainly rather than let a
  // caller infer success from silence. token/poolId stay the PREDICTED values only
  // as a breadcrumb for the explorer; the route must NOT persist them as real (a
  // reverted CREATE2 address has no code, a pending one may never mine).
  if (status !== 'confirmed') {
    return {
      protocol: 'v5',
      token: planToken,
      poolId: planPoolId,
      hook: null,
      firstBuyOut: null,
      launch,
      ...(status === 'reverted'
        ? {
            reverted:
              'the launch reverted — no token was created and nothing else ran. The fee is refunded ' +
              'on a revert (only gas is spent). Re-run preflight and launch again.',
          }
        : {
            pending:
              pendingReason ||
              'the launch receipt did not appear before the timeout — check the hash on the explorer ' +
                'before retrying, so the same launch is not sent twice.',
          }),
    };
  }

  // Confirmed. The RECEIPT is authoritative — above all for the HOOK, which is
  // per-pool: config.letscash.hook is only a default, and letscash pools live
  // under several hooks at once. Returning the receipt's hook is what lets the
  // later buy/sell target the exact pool this launch created.
  const parsed = parseReceipt(receipt);
  if (!parsed) {
    return {
      protocol: 'v5',
      // The token WAS cross-checked against simulateLaunch before signing and the
      // tx confirmed, so plan.token is correct here — but the authoritative hook
      // could not be read. hookResolved:false says so, so a reader never mistakes
      // the null hook for "ETH pool / use the config default".
      token: planToken,
      poolId: planPoolId,
      hook: null,
      hookResolved: false,
      firstBuyOut: null,
      launch,
      warning:
        'the launch confirmed but no TokenLaunched event was decoded — the token / pool / hook could ' +
        'not be read from the receipt. Inspect the transaction on the explorer.',
    };
  }

  const result = {
    protocol: 'v5',
    token: parsed.token,
    poolId: parsed.poolId,
    hook: parsed.hook, // AUTHORITATIVE per-pool hook — return it for buy/sell
    hookResolved: true,
    firstBuyIn: parsed.firstBuyIn,
    firstBuyOut: parsed.firstBuyOut,
    configId: parsed.configId,
    creator: parsed.creator,
    feeRecipient: parsed.feeRecipient,
    quote: parsed.quote,
    pool: parsed.pool,
    launch,
  };
  // The predicted token must match what actually launched; otherwise whatever we
  // persist for Sell/Bundle points at the wrong token. Flag it loudly.
  if (planToken && parsed.token.toLowerCase() !== String(planToken).toLowerCase()) {
    result.mismatch = `launch created token ${parsed.token}, but preflight predicted ${planToken}`;
  }
  if (parsed.poolIdMismatch) {
    // The receipt disagrees with ITSELF about which pool this launch seeded (the
    // TokenLaunched poolId ≠ the V4 Initialize poolId). Surface it as a machine-
    // readable flag, not only a human string, so the auto-bundle path can honor the
    // receipt's own suspicion and skip rather than sign buys against a pool the
    // receipt itself flags as untrustworthy. (No fund loss either way — the buys
    // carry a minOut floor — but "the receipt says suspect" means fire it by hand.)
    result.poolSuspect = true;
    result.warning =
      `the TokenLaunched poolId and the V4 Initialize poolId disagree ` +
      `(${parsed.poolId} vs ${parsed.pool?.poolId}) — treat the pool as suspect`;
  }
  return result;
}

/**
 * Reconcile a launch that fireLaunch left as status 'pending' (its receipt did not
 * appear before the timeout). Fetches the receipt for `hash` NOW and returns the
 * SAME shape fireLaunch would have — confirmed / reverted, or 'pending' again if it
 * still has not mined. This is the recovery path behind the per-wallet in-flight
 * guard in routes/v5.js: until it returns a definitive outcome, a fresh launch on
 * the same wallet stays refused, because broadcasting one now would sign at the
 * NEXT nonce and spend a second fee + first buy alongside the one still in flight.
 *
 * @param {{hash:string, token?:string, poolId?:string}} pending
 * @param {object} [deps] injected for tests: { provider, factory, parseLaunchReceipt }.
 */
async function reconcileLaunch(pending, deps = {}) {
  const rpc = deps.provider || provider;
  const f = deps.factory || factoryModule;
  const parseReceipt = deps.parseLaunchReceipt || f.parseLaunchReceipt;
  if (!pending || !pending.hash) throw new Error('reconcileLaunch: a launch hash is required');

  const receipt = await rpc.getTransactionReceipt(pending.hash);
  if (receipt) return resultFromReceipt(receipt, pending, pending.hash, { parseReceipt });

  // No receipt yet under THIS tx's hash — but is it still in the mempool, or is it
  // gone (evicted, or REPLACED by a /v5/launcher/cancel at the same nonce)? We
  // must read BOTH nonces, not just pending:
  //   • pending <= nonce  → this nonce holds nothing pending → the tx is gone.
  //   • latest  >  nonce  → a DIFFERENT tx already CONFIRMED at/after this nonce
  //     (a cancel/replacement mined it) → this tx can never mine → gone.
  // Reading only pending misses the replaced-and-mined case: after a cancel
  // confirms, pending advances to nonce+1, so `pending <= nonce` is false and the
  // launch would be reported 'pending' FOREVER — bricking the launcher, since the
  // documented cancel→resolve recovery ends exactly here. Report 'dropped' in both
  // cases so the guard clears. Only `latest <= nonce < pending` is genuinely still
  // in flight.
  if (pending.address != null && pending.nonce != null && typeof rpc.getTransactionCount === 'function') {
    const addr = getAddress(pending.address);
    const [pendingN, latestN] = await Promise.all([
      rpc.getTransactionCount(addr, 'pending'),
      rpc.getTransactionCount(addr, 'latest'),
    ]);
    const n = BigInt(pending.nonce);
    if (BigInt(latestN) > n || BigInt(pendingN) <= n) {
      return {
        protocol: 'v5',
        token: pending.token ?? null,
        poolId: pending.poolId ?? null,
        hook: null,
        firstBuyOut: null,
        launch: { hash: pending.hash, status: 'dropped', blockNumber: null },
        dropped:
          `the launch transaction is gone — it never mined and was dropped, evicted, or replaced ` +
          `(e.g. by a launcher cancel). Nonce ${pending.nonce} is free again, so it is safe to launch anew.`,
      };
    }
  }

  // Genuinely still in flight — keep the guard.
  return resultFromReceipt(null, pending, pending.hash, { parseReceipt });
}

/**
 * Read the launcher's quote (USDG) balance and its allowance to the factory, so
 * the console can tell whether a USDG first buy is fundable + approved before the
 * operator tries to launch. ETH needs neither, so a native quote answers trivially.
 */
async function quoteAllowanceStatus(input = {}, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const decimalsOf = deps.getDecimals || getDecimals;
  const readBal =
    deps.readQuoteBalance ||
    (async (t, o) =>
      quoteErc20Iface.decodeFunctionResult(
        'balanceOf',
        await prov.call({ to: t, data: quoteErc20Iface.encodeFunctionData('balanceOf', [o]) })
      )[0]);
  const readAllow =
    deps.readQuoteAllowance ||
    (async (t, o, s) =>
      quoteErc20Iface.decodeFunctionResult(
        'allowance',
        await prov.call({ to: t, data: quoteErc20Iface.encodeFunctionData('allowance', [o, s]) })
      )[0]);

  const dev = roles.dev(ks);
  if (!dev) throw new Error('no v5dev launcher wallet — generate one first');
  const quoteAddr = getAddress(
    input.quote && String(input.quote).toLowerCase() !== 'usdg' ? input.quote : config.letscash.usdg
  );
  const factoryAddr = getAddress(config.letscash.factory);
  const decimals = Number(await decimalsOf(quoteAddr));
  const [balance, allowance] = await Promise.all([
    readBal(quoteAddr, dev.address),
    readAllow(quoteAddr, dev.address, factoryAddr),
  ]);
  return {
    quote: quoteAddr,
    factory: factoryAddr,
    decimals,
    balance: formatUnits(balance, decimals),
    balanceRaw: balance.toString(),
    allowance: formatUnits(allowance, decimals),
    allowanceRaw: allowance.toString(),
  };
}

/**
 * Approve the letscash factory to pull the launcher's USDG for a first buy. A
 * one-time (or top-up) operator action, SEPARATE from the launch by design: the
 * allowance must exist ON-CHAIN before preflight so simulateLaunch can eth_call
 * the real launch (the factory's transferFrom reverts against an unapproved
 * launcher). Approves MAX by default (reusable); pass an amount to bound it.
 *
 * @param {{ amount?: string, quote?: string }} input  amount in whole quote units; omit for MAX.
 * @returns {Promise<object>} { hash, spender, quote, amount, status }
 */
async function approveQuoteForLaunch(input = {}, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const getFeesFn = deps.getFees || getFees;
  const decimalsOf = deps.getDecimals || getDecimals;
  const dryRun = deps.dryRun ?? config.dryRun;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;

  const dev = roles.dev(ks);
  if (!dev) throw new Error('no v5dev launcher wallet — generate one first');

  const quoteAddr = getAddress(
    input.quote && String(input.quote).toLowerCase() !== 'usdg' ? input.quote : config.letscash.usdg
  );
  if (quoteAddr === ZeroAddress) {
    throw new Error('ETH needs no approval — this action is for a USDG (ERC-20) first buy');
  }
  const factoryAddr = getAddress(config.letscash.factory);
  const decimals = Number(await decimalsOf(quoteAddr));
  const MAX_UINT256 = (1n << 256n) - 1n;
  const amountWei = input.amount != null ? parseUnits(String(input.amount), decimals) : MAX_UINT256;
  const amountLabel = input.amount != null ? String(input.amount) : 'MAX';

  const data = quoteErc20Iface.encodeFunctionData('approve', [factoryAddr, amountWei]);
  const fees = await getFeesFn(FEE_BUMP_PCT);
  const chainId = BigInt(config.chainId);

  if (dryRun) {
    return { simulated: true, spender: factoryAddr, quote: quoteAddr, amount: amountLabel, status: 'simulated', hash: null };
  }

  // Settled-nonce guard, like prepareLaunch: don't stack this approval behind a
  // launch/approve still in flight, where it could be stranded if that tx is
  // evicted. Cancel or settle the in-flight tx first.
  const [pendingNonce, latestNonce] = await Promise.all([
    prov.getTransactionCount(dev.address, 'pending'),
    prov.getTransactionCount(dev.address, 'latest'),
  ]);
  if (pendingNonce > latestNonce) {
    throw new Error(
      'the launcher has an unconfirmed tx in flight — wait for it to settle, or cancel it ' +
        '(POST /v5/launcher/cancel), before approving'
    );
  }
  const nonce = pendingNonce;
  const signer = ks.signer(dev.id, prov);
  const raw = await signer.signTransaction(
    toSignable({ to: quoteAddr, data, value: 0n }, { nonce, gasLimit: APPROVE_GAS, fees, chainId })
  );
  const resp = await prov.broadcastTransaction(raw);
  const receipt = await awaitReceipt(prov, resp.hash);
  const status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
  return { spender: factoryAddr, quote: quoteAddr, amount: amountLabel, hash: resp.hash, status };
}

module.exports = {
  prepareLaunch,
  fireLaunch,
  reconcileLaunch,
  approveQuoteForLaunch,
  quoteAllowanceStatus,
  // Exported for tests and reuse.
  resultFromReceipt,
  toSignable,
  estimateLaunchGasOrThrow,
  recheckLaunch,
  isDefiniteRevert,
  RECHECK_MS,
};
