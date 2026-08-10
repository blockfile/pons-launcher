import { useEffect, useRef } from 'react';
import Step from './Step.jsx';
import { pct } from './Share.jsx';

// A plan or a launch result, read at a glance before the raw JSON. Warnings are
// pulled out of the payload and shown first: buried in 200 lines of JSON, a cap
// breach is invisible, and a cap breach is the difference between a wallet
// buying and a wallet burning gas for nothing.
//
// It sits between the launch and the sell because that is where it falls in the
// order of work — you launch, you read this, and only later do you decide to
// exit. But it carries an unnumbered node: it is the console's answer, not a
// step, and a number here would make the sequence read as seven things.
export default function ResultPanel({ step, output, reveal = 0 }) {
  const plan = output && typeof output === 'object' ? output : null;
  const inner = plan?.plan || plan; // /launch nests the plan; /preflight does not
  const result = plan?.result;
  const warnings = Array.isArray(inner?.warnings) ? inner.warnings : [];
  const buys = Array.isArray(inner?.buys) ? inner.buys : [];
  const overCap = buys.filter((b) => b.capExceeded);

  // Only a launch or a plan has something to summarise. Funding, sweeping,
  // generating and importing return plain payloads — an array of transfers, a
  // list of new wallets — and hiding those behind a closed disclosure made a
  // successful action look like nothing had happened at all.
  const summarised = Boolean(result || inner?.token);

  // Every button that does something is far above this panel — a fund click at
  // the top of the page put its answer a screen and a half below the fold, so
  // a real error read as "nothing happened". Bring the answer to the operator.
  //
  // Keyed on `reveal`, NOT on `output`. This panel sits at the bottom of a long
  // page, so scrolling to it moves the operator away from whatever they were
  // doing; that is right for a launch and wrong for a delete, where the answer
  // is the row that just disappeared and the next click is in the same table.
  // A caller that wants the outcome recorded but not chased passes
  // report(x, { reveal: false }) and this effect never runs.
  const box = useRef(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    box.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }, [reveal]);

  return (
    <div ref={box}>
    <Step {...step}>
      {!plan && <pre>{String(output ?? '')}</pre>}

      {plan && (
        <>
          {result && (
            <div className="stats">
              <div className="stat">
                <span>Token</span>
                <b>{(result.token || '—').slice(0, 10)}…</b>
              </div>
              <div className={`stat ${result.launch?.status === 'confirmed' ? 'ok' : 'bad'}`}>
                <span>Launch</span>
                <b>{result.launch?.status || '—'}</b>
              </div>
              <div className="stat ok">
                <span>Buys confirmed</span>
                <b>
                  {result.buys?.filter((b) => b.status === 'confirmed').length ?? 0}/
                  {result.buys?.length ?? 0}
                </b>
              </div>
              <div className={`stat ${result.sameBlock ? 'ok' : ''}`}>
                <span>In launch block</span>
                <b>{result.sameBlock ?? 0}</b>
              </div>
            </div>
          )}

          {!result && inner?.token && (
            <div className="stats">
              <div className="stat">
                <span>Token will be</span>
                <b>{inner.token.slice(0, 10)}…</b>
              </div>
              <div className="stat">
                <span>Bundle wallets</span>
                <b>{buys.length}</b>
              </div>
              <div className="stat">
                <span>Total buy</span>
                <b>{inner.totalBuyEth} </b>
              </div>
              <div className="stat">
                <span>Dev buy</span>
                <b>{inner.launch?.devBuyEth}</b>
              </div>
              {/* The same figure the wallet table drew while these amounts were
                  typed — the plan carries it because preflight recomputes it
                  from the amounts it actually signed, which is the first point
                  an "all − gas" wallet has a real number. */}
              {inner.share && (
                <div className="stat">
                  <span>{inner.share.exact ? 'Supply share' : 'Supply share (est)'}</span>
                  <b>
                    {inner.share.exact ? '' : '≈'}
                    {pct(inner.share.bundle.bps)}
                  </b>
                </div>
              )}
            </div>
          )}

          {overCap.length > 0 && (
            <div className="notice danger">
              <h3>These buys will revert</h3>
              <ul>
                {/* This figure is the pool's OPENING price, which is the
                    yardstick the cap was checked against — deliberately above
                    the range the wallet table draws beside each row, because a
                    cap breach reverts and the flag has to err early. Saying
                    which one it is stops the two reading as a contradiction. */}
                {overCap.map((b) => (
                  <li key={b.walletId}>
                    {b.address} — {b.amountEth} ETH ≈ {(b.estShareBps / 100).toFixed(2)}% of supply
                    at the opening price, over the cap. Lower the amount.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="notice warn">
              <h3>Check before launching</h3>
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <details style={{ marginTop: 12 }} open={!summarised}>
            <summary className="hint" style={{ cursor: 'pointer' }}>
              {summarised ? 'full response' : `response · ${Array.isArray(plan) ? `${plan.length} item${plan.length === 1 ? '' : 's'}` : 'details'}`}
            </summary>
            <pre style={{ marginTop: 8 }}>{JSON.stringify(plan, null, 2)}</pre>
          </details>
        </>
      )}
    </Step>
    </div>
  );
}
