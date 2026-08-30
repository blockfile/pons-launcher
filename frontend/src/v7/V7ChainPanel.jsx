import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { plural } from './roles.js';

// What each cycle state says on screen. The engine's own strings, spelled out:
// a stall is only useful if it names the step it stalled on.
const STATE_LABEL = {
  pending: 'waiting',
  selling: 'selling',
  transferring: 'transferring',
  'waiting-fill': 'waiting for the fill',
  buying: 'buying',
  done: 'done',
  failed: 'failed',
};

const DEFAULT_INTERVAL_MS = 7000;
const DEFAULT_VARIANCE_PCT = 30;
// Mirrors backend/src/v7/trade.js DEFAULT_BUY_SLIPPAGE_BPS. On the predictable flap
// curve 0 is allowed (a strictly-guaranteed buy); the backend caps well under 5000.
const DEFAULT_BUY_SLIPPAGE_BPS = 1500;

const money = (v) => (v == null ? null : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function V7ChainPanel({
  step,
  wallets,
  job,
  token,
  setToken,
  explorer,
  reload,
  reloadWallets,
  report,
}) {
  const [busy, setBusy] = useState('');
  const [bigBuy, setBigBuy] = useState('');
  const [intervalMs, setIntervalMs] = useState(DEFAULT_INTERVAL_MS);
  const [jitterPct, setJitterPct] = useState(0);
  const [variancePct, setVariancePct] = useState(DEFAULT_VARIANCE_PCT);
  const [buySlippageBps, setBuySlippageBps] = useState(DEFAULT_BUY_SLIPPAGE_BPS);
  const [plan, setPlan] = useState(null);
  const [arming, setArming] = useState(false);

  const body = () => ({
    token: token.trim(),
    bigBuyEth: bigBuy.trim(),
    // Every bundle wallet, in table order. There is no per-wallet amount: the
    // run divides the position across them as it goes.
    targets: wallets.map((w) => ({ walletId: w.id })),
    intervalMs: Number(intervalMs),
    jitterPct: Number(jitterPct),
    variancePct: Number(variancePct),
    // The flap curve permits a 0bps floor (a strictly-guaranteed buy); the prior
    // venue forced a positive one, so this input did not exist there.
    buySlippageBps: Number(buySlippageBps),
  });

  async function act(what, fn) {
    setBusy(what);
    try {
      const out = await fn();
      report(out);
      await reload();
      await reloadWallets();
      return out;
    } catch (err) {
      report(`ERROR: ${err.message}`);
      throw err;
    } finally {
      setBusy('');
    }
  }

  const running = Boolean(job?.running);
  const resumable = job && (job.status === 'stopped' || job.status === 'failed');
  const ready = token.trim() && Number(bigBuy) > 0 && wallets.length > 0;
  const link = (hash) => (explorer && hash ? `${explorer}/tx/${hash}` : '');
  // 0..100 toward graduation, clamped for the bar's width.
  const gradPct =
    plan?.graduation != null
      ? Math.max(0, Math.min(100, Number(plan.graduation.pctSold) || 0))
      : 0;

  return (
    <Step {...step}>
      <p className="lede">
        One big buy from the main wallet, then a cycle per wallet: sell a slice of the position, move
        the proceeds through Relay, and buy with what arrives. Every{' '}
        {(Number(intervalMs) / 1000).toFixed(1)}s until the position is gone.
      </p>

      <div className="row">
        <input
          type="text"
          placeholder="token address the chain trades"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
          disabled={running}
        />
      </div>

      <div className="row">
        <label>
          big buy (ETH)
          <input
            type="text"
            inputMode="decimal"
            value={bigBuy}
            onChange={(e) => setBigBuy(e.target.value)}
            style={{ width: 120 }}
            disabled={running}
          />
        </label>
        <label>
          interval (ms)
          <input
            type="number"
            min="3000"
            max="600000"
            step="500"
            value={intervalMs}
            onChange={(e) => setIntervalMs(e.target.value)}
            style={{ width: 120 }}
            disabled={running}
          />
        </label>
        <label>
          jitter (%)
          <input
            type="number"
            min="0"
            max="50"
            value={jitterPct}
            onChange={(e) => setJitterPct(e.target.value)}
            style={{ width: 90 }}
            disabled={running}
          />
        </label>
        <label>
          size variance (%)
          <input
            type="number"
            min="0"
            max="90"
            value={variancePct}
            onChange={(e) => setVariancePct(e.target.value)}
            style={{ width: 90 }}
            disabled={running}
          />
        </label>
        <label>
          buy slippage (bps)
          <input
            type="number"
            min="0"
            max="5000"
            step="50"
            value={buySlippageBps}
            onChange={(e) => setBuySlippageBps(e.target.value)}
            style={{ width: 110 }}
            disabled={running}
          />
        </label>
        <span className="spacer" />
        <Busy
          busy={busy === 'plan'}
          className="btn-primary"
          disabled={!ready || running}
          onClick={() =>
            act('plan', async () => {
              const out = await api('/v7/chain/plan', 'POST', body());
              setPlan(out);
              return out;
            })
          }
        >
          Preview
        </Busy>
      </div>

      <p className="hint">
        <b>Jitter</b> spreads the time between buys; <b>size variance</b> spreads how big each one is.
        {Number(variancePct) === 0 && ' At 0% every buy is the same size, which is a pattern in itself.'}
        {Number(jitterPct) === 0 &&
          ` Buys land exactly ${(Number(intervalMs) / 1000).toFixed(1)}s apart at the moment.`}
        {' '}
        <b>Buy slippage</b> floors every buy: {Number(buySlippageBps) === 0
          ? '0 bps is a strictly-guaranteed buy — it takes whatever price it gets, allowed on the predictable flap curve.'
          : `${buySlippageBps}bps rejects a buy that would fill worse than that.`}{' '}
        The sells never carry a floor.
      </p>

      {plan && !running && (
        <div className="notice">
          {plan.graduationRisk ? (
            <p className="warn">
              <b>This big buy would graduate the curve.</b> It would buy so large a share of the tokens left
              before graduation that it could saturate — or graduate — the token mid-run
              {plan.graduation ? (
                <> (the curve is {Number(plan.graduation.pctSold).toFixed(1)}% sold, with only{' '}
                {plan.graduation.headroomTokens} tokens of headroom left)</>
              ) : null}
              . A graduation moves the token onto a V2 pair V7 does not trade, stranding the whole position in
              tokens the chain can no longer sell back. The run is blocked. Reduce the big buy, or pick a token
              further from graduation.
            </p>
          ) : (
            <>
              <div className="row">
                <span className="hint">
                  trading the <b>{plan.venue}</b> bonding curve
                </span>
              </div>
              <div className="row">
                <span>
                  position after the big buy: <b>{Number(plan.position.eth).toFixed(4)} ETH</b>
                  {plan.position.usd && <> ({money(plan.position.usd)})</>}
                </span>
                <span className="spacer" />
                <span className="hint">
                  {plural(plan.walletCount, 'cycle')} · about {duration(plan.estimatedRunMs)}
                </span>
              </div>
              <div className="row">
                <span>
                  each wallet buys with roughly{' '}
                  <b>
                    {plan.slice.meanUsd
                      ? money(plan.slice.meanUsd)
                      : `${Number(plan.slice.meanEth).toFixed(5)} ETH`}
                  </b>
                  {Number(variancePct) > 0 && (
                    <>
                      {' '}
                      — varying between{' '}
                      {plan.slice.lowUsd
                        ? `${money(plan.slice.lowUsd)} and ${money(plan.slice.highUsd)}`
                        : `${Number(plan.slice.lowEth).toFixed(5)} and ${Number(plan.slice.highEth).toFixed(5)} ETH`}
                    </>
                  )}
                </span>
              </div>
              {plan.graduation && (
                <div style={{ marginTop: 10 }}>
                  <div className="row">
                    <span className="hint">
                      {Number(plan.graduation.pctSold).toFixed(1)}% to graduation
                    </span>
                    <span className="spacer" />
                    <span className="hint">{plan.graduation.headroomTokens} tokens of headroom</span>
                  </div>
                  {/* A count is drawn as discrete lit cells, not as a smooth
                      bar: .meter is one rule in styles.css driven by --n and
                      --k, so this is a class and a style attribute rather than
                      the inline-styled bar (and the last literal border-radius
                      in the console) that used to sit here. Same role, same
                      aria-value trio, same figure. */}
                  <div
                    className="meter"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(gradPct)}
                    style={{ '--n': 20, '--k': Math.max(0, Math.min(20, Math.round(gradPct / 5))) }}
                  />
                  <p className="hint">
                    As each cycle re-buys less than it sells (fees), circulating supply drifts <b>DOWN</b> —
                    away from graduation, not toward it.
                  </p>
                </div>
              )}
            </>
          )}
          {(plan.graduationRisk ? plan.warnings.slice(1) : plan.warnings).map((w) => (
            <p className="hint" key={w}>
              {w}
            </p>
          ))}
        </div>
      )}

      <div className="row">
        <Busy busy={busy === 'start'} disabled={!ready || running || plan?.graduationRisk} onClick={() => setArming(true)}>
          Start the chain
        </Busy>
        <button
          className="ghost"
          disabled={!running}
          onClick={() => act('stop', () => api('/v7/chain/stop', 'POST'))}
        >
          Stop
        </button>
        <button
          className="ghost"
          disabled={!resumable}
          onClick={() => act('resume', () => api('/v7/chain/resume', 'POST'))}
        >
          Resume
        </button>
        <span className="spacer" />
        {job && job.status !== 'idle' && (
          <span className="hint">
            {job.status} · {job.completed}/{job.total} bought
            {job.venue ? ` · ${job.venue} curve` : ''}
          </span>
        )}
      </div>

      {job?.failure && (
        <p className="warn">
          Halted while <b>{STATE_LABEL[job.failure.step] || job.failure.step}</b>
          {job.failure.address ? ' for ' : ''}
          {job.failure.address && <Address value={job.failure.address} />} — {job.failure.error}.
          Nothing after it ran; Resume picks up at that step.
        </p>
      )}

      {job?.cycles?.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Wallet</th>
                <th>State</th>
                <th className="num">Sold for</th>
                <th className="num">Bought with</th>
                <th>Sell</th>
                <th>Buy tx</th>
              </tr>
            </thead>
            <tbody>
              {job.cycles.map((c) => (
                <tr key={c.index} className={c.state === 'failed' ? 'is-bad' : ''}>
                  <td>{c.kind === 'big-buy' ? '—' : c.index}</td>
                  <td>
                    {c.kind === 'big-buy' ? (
                      <b>big buy</b>
                    ) : (
                      <Address
                        value={c.address}
                        href={explorer ? `${explorer}/address/${c.address}` : ''}
                      />
                    )}
                  </td>
                  <td>
                    {STATE_LABEL[c.state] || c.state}
                    {c.finalSlice && c.kind === 'cycle' && <span className="hint"> · remainder</span>}
                  </td>
                  <td className="num">{c.ethRaised ? Number(c.ethRaised).toFixed(5) : '—'}</td>
                  <td className="num">{c.buyEth ? Number(c.buyEth).toFixed(5) : '—'}</td>
                  <td>
                    {c.sellHash ? (
                      <a href={link(c.sellHash)} target="_blank" rel="noreferrer">
                        tx
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {c.buyHash ? (
                      <a href={link(c.buyHash)} target="_blank" rel="noreferrer">
                        tx
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {job.cycles.some((c) => c.error) && (
            <p className="hint">{job.cycles.find((c) => c.error)?.error}</p>
          )}
        </div>
      )}

      <Modal
        open={arming}
        title="Start the chain?"
        danger
        question="This sells and re-buys the whole position. The sells take whatever price they get; the buys carry your slippage floor."
        onCancel={() => setArming(false)}
        confirmLabel="Start it"
        onConfirm={async () => {
          await act('start', () => api('/v7/chain/start', 'POST', { ...body(), confirm: true }));
          setArming(false);
        }}
      >
        <p>
          The main wallet buys, then sells a slice per cycle to fund each wallet through Relay. The sells
          carry no floor — each exits at whatever price it gets — while the buys carry your{' '}
          {Number(buySlippageBps) === 0
            ? '0bps floor (strictly-guaranteed to land on the predictable flap curve)'
            : `${buySlippageBps}bps floor`}
          . A failure at any step halts the run and keeps everything else untouched.
        </p>
        <Fact label="Token" mono>
          {token}
        </Fact>
        {plan?.venue && <Fact label="Venue">{plan.venue} bonding curve</Fact>}
        <Fact label="Big buy">
          {bigBuy} ETH{plan?.bigBuyUsd ? ` (${money(plan.bigBuyUsd)})` : ''}
        </Fact>
        <Fact label="Cycles">{plural(wallets.length, 'wallet')}</Fact>
        {plan && (
          <Fact label="Each buys about">
            {plan.slice.meanUsd ? money(plan.slice.meanUsd) : `${Number(plan.slice.meanEth).toFixed(5)} ETH`}
            {Number(variancePct) > 0 ? ` ± ${variancePct}%` : ''}
          </Fact>
        )}
        <Fact label="Cadence">
          {(Number(intervalMs) / 1000).toFixed(1)}s
          {Number(jitterPct) > 0 ? ` ± ${jitterPct}%` : ' exactly'}
        </Fact>
        <Fact label="Buy slippage">
          {Number(buySlippageBps) === 0 ? '0 bps — strictly-guaranteed buy' : `${buySlippageBps} bps`}
        </Fact>
        {plan && <Fact label="Takes about">{duration(plan.estimatedRunMs)}</Fact>}
        {plan?.graduation && (
          <Fact label="To graduation">
            {Number(plan.graduation.pctSold).toFixed(1)}% · {plan.graduation.headroomTokens} tokens headroom
          </Fact>
        )}
      </Modal>
    </Step>
  );
}
