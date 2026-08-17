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

export default function V3ChainPanel({
  step,
  wallets,
  rows,
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
  const [plan, setPlan] = useState(null);
  const [arming, setArming] = useState(false);

  const targets = wallets
    .filter((w) => Number(rows[w.id]?.buyEth) > 0)
    .map((w) => ({ walletId: w.id, buyEth: String(rows[w.id].buyEth) }));

  const body = () => ({
    token: token.trim(),
    bigBuyEth: bigBuy.trim(),
    targets,
    intervalMs: Number(intervalMs),
    jitterPct: Number(jitterPct),
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
  const ready = token.trim() && Number(bigBuy) > 0 && targets.length > 0;
  const link = (hash) => (explorer && hash ? `${explorer}/tx/${hash}` : '');

  return (
    <Step {...step}>
      <p className="lede">
        One big buy from the main wallet, then a cycle per wallet: sell enough to fund the next one,
        move it through Relay, and buy. Every {(Number(intervalMs) / 1000).toFixed(1)}s.
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
        <span className="spacer" />
        <Busy
          busy={busy === 'plan'}
          className="ghost"
          disabled={!ready || running}
          onClick={() =>
            act('plan', async () => {
              const out = await api('/v3/chain/plan', 'POST', body());
              setPlan(out);
              return out;
            })
          }
        >
          Preview
        </Busy>
      </div>

      {/* Exactly 7.000s between every buy is a machine-readable signature. The
          field defaults to off because the operator, not this panel, decides
          whether a given run wants to look human. */}
      {Number(jitterPct) === 0 && (
        <p className="hint">
          Jitter is off, so every buy lands exactly {(Number(intervalMs) / 1000).toFixed(1)}s apart —
          a regular figure on a chart. Set a percentage to spread them.
        </p>
      )}

      {plan && !running && (
        <div className="notice">
          <div className="row">
            <b>{plan.firstCycle.tokens}</b> tokens sold in cycle 1 to raise{' '}
            <b>{plan.firstCycle.raiseEth} ETH</b>
            <span className="spacer" />
            <span className="hint">
              {plural(plan.targets.length, 'cycle')} · {plan.totalBuyEth} ETH of buying
            </span>
          </div>
          {plan.snipeTax.bps > 0 && (
            <p className="warn">
              The opening snipe tax is live at <b>{plan.snipeTax.bps} bps</b> and these wallets are
              not exempt — they were unknown when the launch declared its exemption list. Every buy
              in this run pays it. The window is {plan.snipeTax.windowSeconds}s from the launch.
            </p>
          )}
          {plan.warnings.map((w) => (
            <p className="hint" key={w}>
              {w}
            </p>
          ))}
        </div>
      )}

      <div className="row">
        <Busy busy={busy === 'start'} disabled={!ready || running} onClick={() => setArming(true)}>
          Start the chain
        </Busy>
        <button
          className="ghost"
          disabled={!running}
          onClick={() => act('stop', () => api('/v3/chain/stop', 'POST'))}
        >
          Stop
        </button>
        <button
          className="ghost"
          disabled={!resumable}
          onClick={() => act('resume', () => api('/v3/chain/resume', 'POST'))}
        >
          Resume
        </button>
        <span className="spacer" />
        {job && job.status !== 'idle' && (
          <span className="hint">
            {job.status} · {job.completed}/{job.total} bought
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
                <th className="num">Buy</th>
                <th>State</th>
                <th className="num">Sold for</th>
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
                  <td className="num">{c.buyEth ?? '—'}</td>
                  <td>{STATE_LABEL[c.state] || c.state}</td>
                  <td className="num">{c.ethRaised ?? '—'}</td>
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
            <p className="hint">
              {job.cycles.find((c) => c.error)?.error}
            </p>
          )}
        </div>
      )}

      <Modal
        open={arming}
        title="Start the chain?"
        danger
        question="This sells and re-buys the whole position, with no slippage floor anywhere in it."
        onCancel={() => setArming(false)}
        confirmLabel="Start it"
        onConfirm={async () => {
          await act('start', () => api('/v3/chain/start', 'POST', { ...body(), confirm: true }));
          setArming(false);
        }}
      >
        <p>
          The main wallet buys, then sells a slice per cycle to fund each wallet through Relay. There
          is no minimum on any trade — every sell and every buy takes whatever price it gets. A
          failure at any step halts the run and keeps everything else untouched.
        </p>
        <Fact label="Token" mono>
          {token}
        </Fact>
        <Fact label="Big buy">{bigBuy} ETH</Fact>
        <Fact label="Cycles">{plural(targets.length, 'wallet')}</Fact>
        <Fact label="Cadence">
          {(Number(intervalMs) / 1000).toFixed(1)}s{Number(jitterPct) > 0 ? ` ± ${jitterPct}%` : ' exactly'}
        </Fact>
        {plan?.snipeTax?.bps > 0 && (
          <Fact label="Opening tax">{plan.snipeTax.bps} bps — these wallets are not exempt</Fact>
        )}
      </Modal>
    </Step>
  );
}
