import { memo, useEffect, useState } from 'react';
import { LuCheck, LuPencil, LuX } from 'react-icons/lu';
import { useLiveMark } from './useLiveMark.js';
import { fmtPct, fmtPrice, fmtUnits, pctOfSupply, quoteDecimals, quoteSymbol, toNumber } from './format.js';
import { parsePct, parseSlippage } from './prefs.js';
import { hasPairLeg } from './sellMath.js';

/**
 * THE MONEY LAW (memory frontend-cell-and-caret), as this panel applies it:
 *   .spend  the preset chips — each spends on chain the instant it is pressed,
 *           no dialog: a 2px vermilion frame over the vermilion tint, drawn
 *           HOTTER and heavier than .ghost, never quieter
 *   .live   the 100 % chip — irreversible (it empties every ticked wallet):
 *           the vermilion block with the WHITE label
 *   .amber  the custom "Sell n%" button — the panel's ONE amber object
 * Nothing else in this panel is amber; the pencil and the slippage are quiet.
 */
function Position({ view, venue, hub, getMark }) {
  const mark = useLiveMark(hub, getMark);
  const price = mark && Number.isFinite(mark.price) ? mark.price : null;
  const tokens = view.totals.tokens;
  const value = price === null ? null : toNumber(tokens, venue.decimals) * price;
  return (
    <dl className="position">
      <div>
        <dt>Held · ticked wallets</dt>
        <dd className="num">
          {fmtUnits(tokens, venue.decimals, 2)} {venue.symbol}
        </dd>
      </div>
      <div>
        <dt>Value</dt>
        <dd className="num">{value === null ? '—' : `${fmtPrice(value)} ${quoteSymbol(venue)}`}</dd>
      </div>
      <div>
        <dt>% supply</dt>
        <dd className="num">{fmtPct(pctOfSupply(tokens, venue.totalSupply), 3)}</dd>
      </div>
    </dl>
  );
}

function blockedReason(view, fees) {
  if (!fees) return 'Gas price unavailable — retrying.';
  if (view.rows.length === 0) return 'Import the wallets that hold this token.';
  if (view.totals.ticked === 0) return 'Tick at least one wallet.';
  if (view.totals.arming > 0) return 'Approvals are landing — selling unlocks per wallet.';
  return 'No ticked wallet can sell: check approvals and ETH for gas.';
}

function previewText(pct, pv, venue) {
  if (pct === null) return 'Point at a chip to see what it sells.';
  if (!pv || pv.total === null) return `${pct}% — ${(pv && pv.reason) || 'no preview'}`;
  // Token-quoted curves AND token-quoted graduated pools pay out the pair token,
  // which the session then swaps to ETH (sellMath.hasPairLeg = plan.js pairLegGas's rule).
  const tail = hasPairLeg(venue) ? ', then swapped to ETH' : '';
  const skipped = pv.skipped ? ` · ${pv.skipped} skipped` : '';
  return `${pct}% ≈ ${fmtUnits(pv.total, quoteDecimals(venue), 4)} ${quoteSymbol(venue)}${tail} · ${pv.count} wallet${pv.count === 1 ? '' : 's'}${skipped}`;
}

function SellPanel({ view, venue, fees, presets, onPresets, slippage, onSlippage, onSell, preview, hub, getMark }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => presets.map(String));
  const [editError, setEditError] = useState('');
  const [custom, setCustom] = useState('');
  const [hoverPct, setHoverPct] = useState(null);
  const [slipText, setSlipText] = useState(String(slippage));
  useEffect(() => setSlipText(String(slippage)), [slippage]);

  const sellable = view.totals.sellable > 0 && !!fees;
  const customPct = parsePct(custom);
  const shownPct = hoverPct ?? customPct;
  const pv = shownPct !== null && sellable ? preview(shownPct) : null;

  function startEdit() {
    setDraft(presets.map(String));
    setEditError('');
    setEditing(true);
  }
  function saveEdit() {
    const clean = onPresets(draft);
    if (!clean) {
      setEditError('Each preset is a whole % from 1 to 100.');
      return;
    }
    setEditing(false);
  }
  function commitSlip() {
    const n = parseSlippage(slipText);
    if (n === null) setSlipText(String(slippage));
    else onSlippage(n);
  }

  return (
    <section className="pane sell" aria-labelledby="tp-sell-title">
      <div className="pane-title">
        <h2 id="tp-sell-title">Sell</h2>
        <span className="pane-note">one click sells now — no confirmation</span>
      </div>
      <Position view={view} venue={venue} hub={hub} getMark={getMark} />
      <div className="sell-bar" data-testid="sell-bar">
        <div className="chips" role="group" aria-label="Sell this percentage of every ticked wallet, now">
          {editing
            ? draft.map((d, i) => (
                <input
                  key={i}
                  className="chip-edit"
                  inputMode="numeric"
                  value={d}
                  aria-label={`Preset ${i + 1} (%)`}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? e.target.value : x)))}
                />
              ))
            : presets.map((p, i) => (
                <button
                  key={`${i}:${p}`}
                  type="button"
                  className={p === 100 ? 'chip live' : 'chip spend'}
                  data-testid={`chip-${p}`}
                  disabled={!sellable}
                  onClick={() => onSell(p)}
                  onPointerEnter={() => setHoverPct(p)}
                  onPointerLeave={() => setHoverPct(null)}
                  onFocus={() => setHoverPct(p)}
                  onBlur={() => setHoverPct(null)}
                  title={p === 100 ? 'Sells EVERYTHING in every ticked wallet, now.' : `Sells ${p}% of every ticked wallet, now.`}
                >
                  {p}%
                </button>
              ))}
          {editing ? (
            <>
              <button type="button" className="icon quiet" onClick={saveEdit} aria-label="Save presets" title="Save presets">
                <LuCheck aria-hidden="true" />
              </button>
              <button type="button" className="icon quiet" onClick={() => setEditing(false)} aria-label="Cancel editing" title="Cancel">
                <LuX aria-hidden="true" />
              </button>
            </>
          ) : (
            <button type="button" className="icon quiet" onClick={startEdit} aria-label="Edit presets" title="Edit presets">
              <LuPencil aria-hidden="true" />
            </button>
          )}
        </div>
        <form
          className="custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (customPct !== null && sellable) onSell(customPct);
          }}
        >
          <input
            className="custom-input"
            inputMode="numeric"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onFocus={() => setHoverPct(null)}
            placeholder="custom %"
            aria-label="Custom percentage, 1 to 100"
            data-testid="custom-pct"
          />
          <button type="submit" className="amber" disabled={customPct === null || !sellable} data-testid="custom-sell">
            Sell{customPct !== null ? ` ${customPct}%` : ''}
          </button>
        </form>
      </div>
      {editError && (
        <p className="refusal" role="alert">
          {editError}
        </p>
      )}
      <p className="preview num" aria-live="polite">
        {sellable ? previewText(shownPct, pv, venue) : blockedReason(view, fees)}
      </p>
      <div className="slip">
        <label htmlFor="tp-slip">Slippage</label>
        <input
          id="tp-slip"
          className="slip-input"
          inputMode="decimal"
          value={slipText}
          onChange={(e) => setSlipText(e.target.value)}
          onBlur={commitSlip}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-describedby="tp-slip-help"
          data-testid="slippage"
        />
        <span>%</span>
      </div>
      <p id="tp-slip-help" className="hint">
        A sell that would fill more than this below its quote reverts and keeps the tokens.
      </p>
    </section>
  );
}

export default memo(SellPanel);
