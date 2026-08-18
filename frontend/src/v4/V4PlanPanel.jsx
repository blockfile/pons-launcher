import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import { plural } from './roles.js';

const MINUTE_MS = 60_000;

/**
 * What the form shows before the server has answered.
 *
 * THESE NUMBERS ARE NOT THE DEFAULTS. The defaults live in v4/plan.js and
 * arrive as `planDefaults` on GET /v4/wallets, which the console already
 * fetches on mount; `seed()` below overwrites every one of these the moment
 * they land, and the server would use its own values regardless of what this
 * file said.
 *
 * They were a real second copy once, and they drifted the first time plan.js
 * changed: the backend planned 3-day campaigns while this form still opened on
 * 20, so the number an operator read was not the number that would have run.
 * What is left here is placeholder text with a shape, kept only so the fields
 * are not blank for the one frame before the fetch returns.
 */
const PLACEHOLDER = {
  name: '',
  days: 3,
  perDayMin: 10,
  perDayMax: 30,
  amountMinEth: '0.0031',
  amountMaxEth: '0.0089',
  // Minutes, not milliseconds. The backend's field is gapMinMs and nobody sizes
  // a three-week schedule in milliseconds; the conversion happens at the door.
  gapMinMin: 20,
  gapMaxMin: 240,
};

/** The server's DEFAULTS, in the shape this form edits. */
function fromServer(d) {
  return {
    days: d.days,
    perDayMin: d.perDayMin,
    perDayMax: d.perDayMax,
    amountMinEth: d.amountMinEth,
    amountMaxEth: d.amountMaxEth,
    gapMinMin: Math.round(d.gapMinMs / MINUTE_MS),
    gapMaxMin: Math.round(d.gapMaxMs / MINUTE_MS),
  };
}

/** wei string -> ETH, for the two figures the cost breakdown subtracts. */
function weiToEth(wei) {
  return Number(BigInt(wei || 0)) / 1e18;
}

/**
 * Step 3 — the plan, and the one button on this tab that spends anything.
 *
 * PREVIEW AND START ARE TWO CALLS AND THAT IS THE POINT. The preview returns
 * the schedule AND the seed that produced it; start posts that same seed and
 * those same params back, and the server REGENERATES the plan from them rather
 * than trusting a transfer list a browser has had its hands on. Same seed and
 * same params reproduce the same plan byte for byte, so what was read here is
 * provably what starts.
 *
 * Which is why editing any field throws the preview away. A preview is a plan
 * for a particular set of numbers; leaving it on screen beside changed ones
 * would show a schedule and start a different one.
 */
export default function V4PlanPanel({ step, masters, seeds, campaigns, planDefaults, reload, report }) {
  const [form, setForm] = useState(PLACEHOLDER);
  const [master, setMaster] = useState('');
  const [preview, setPreview] = useState(null);
  // The server's own words when it refuses. Kept in state rather than left to
  // the toast — see the notice below for why it has to survive on screen.
  const [refusal, setRefusal] = useState('');
  const [busy, setBusy] = useState('');
  const [arming, setArming] = useState(false);
  const [batching, setBatching] = useState(false);
  // How many seed wallets each funder feeds in a batch. Every campaign gets the
  // same count so one set of params describes all of them — see divideSeeds in
  // routes/v4.js for why an uneven split refuses half the batch.
  const [seedsPer, setSeedsPer] = useState(2);
  // Which funders a batch will use. null means "every free one" — the state an
  // operator who never opens the list should get, rather than an empty
  // selection they have to fill in before the button does anything.
  const [picked, setPicked] = useState(null);

  // Seed the form from the server's DEFAULTS once, on the first fetch that
  // carries them. ONCE is the whole of it: the wallet list is polled, and
  // re-seeding on every poll would overwrite whatever an operator had typed —
  // silently, mid-sentence, every sixty seconds.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !planDefaults) return;
    seeded.current = true;
    setForm((f) => ({ ...f, ...fromServer(planDefaults) }));
  }, [planDefaults]);

  // Every field goes through here, so nothing can change a number without
  // invalidating the plan drawn from the old one.
  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setPreview(null);
  };

  const params = () => ({
    days: Number(form.days),
    perDayMin: Number(form.perDayMin),
    perDayMax: Number(form.perDayMax),
    amountMinEth: String(form.amountMinEth).trim(),
    amountMaxEth: String(form.amountMaxEth).trim(),
    gapMinMs: Math.round(Number(form.gapMinMin) * MINUTE_MS),
    gapMaxMs: Math.round(Number(form.gapMaxMin) * MINUTE_MS),
  });

  async function act(what, fn) {
    setBusy(what);
    try {
      const out = await fn();
      report(out);
      return out;
    } catch (err) {
      report(`ERROR: ${err.message}`);
      throw err;
    } finally {
      setBusy('');
    }
  }

  /**
   * The wallets this campaign would cover: the ones no other campaign holds.
   *
   * Sent explicitly rather than left to the route's default, which is EVERY
   * seed wallet in the keystore. After the first campaign that default includes
   * wallets already spoken for, and the start would be refused for claiming
   * them — a wallet funded twice has two funding edges, which is the one thing
   * this whole strategy exists to avoid. Previewing the free ones means the
   * plan on screen is the plan that can actually start.
   *
   * The list must never be sent empty: an empty walletIds falls back to that
   * same all-wallets default, so Preview is disabled instead.
   */
  const freeIds = seeds.filter((w) => !w.claimed).map((w) => w.id);
  const claimed = seeds.length - freeIds.length;
  const free = freeIds.length;
  // Counted over the wallets THIS campaign would cover, because that is what
  // the gate checks — a claimed wallet's backup is last campaign's problem.
  const unprotected = seeds.filter((w) => !w.claimed && !w.backedUp).length;
  const chosen = masters.find((w) => w.id === master) || null;
  // Funders not already running something. The batch route filters the same
  // way — a busy funder is not an error, it just is not available.
  const busyFunders = new Set(
    campaigns.filter((c) => c.status === 'running').map((c) => c.masterWalletId)
  );
  const freeFunders = masters.filter((w) => !busyFunders.has(w.id));
  // The chosen ones, or all of them. Intersected with what is actually free, so
  // a funder that started a campaign since the list was opened drops out rather
  // than being sent to a route that would refuse it.
  const chosenFunders = picked
    ? freeFunders.filter((w) => picked.includes(w.id))
    : freeFunders;
  const batchCampaigns = Math.min(
    chosenFunders.length,
    Math.floor(free / Math.max(1, Math.round(Number(seedsPer) || 0)))
  );
  /**
   * Whether ONE campaign of `seedsPer` wallets fits the schedule above.
   *
   * The same arithmetic plan.feasible does on the server: a campaign's floor is
   * days x perDayMin and its ceiling is days x perDayMax. Checked here because
   * the batch's own numbers are set in this dialog while days and per-day live
   * on the form behind it — so the combination that fails is one no single
   * field looks wrong in. Five wallets over three days at ten a day minimum is
   * refused by every campaign in the batch, and without this the operator finds
   * that out from eight identical errors after pressing the button.
   */
  const perFunder = Math.max(1, Math.round(Number(seedsPer) || 0));
  const batchFloor = Number(form.days) * Number(form.perDayMin);
  const batchCeiling = Number(form.days) * Number(form.perDayMax);
  const batchFits = perFunder >= batchFloor && perFunder <= batchCeiling;

  const toggle = (id) =>
    setPicked((cur) => {
      const base = cur ?? freeFunders.map((w) => w.id);
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  const ready = Boolean(form.name.trim() && master && preview?.feasible?.ok);
  const cost = preview?.cost || null;
  const overhead = cost ? weiToEth(cost.totalWei) - weiToEth(cost.depositsWei) : 0;

  return (
    <Step {...step}>
      <p className="lede">
        How slowly the wallets are fed. Every dice is rolled once, here: which wallets land on which
        day, how much each one gets to six decimals, and how long to wait between sends. The
        schedule is written out in full before anything is sent, which is what makes a three-week
        job survive a restart.
      </p>

      <div className="grid">
        <label className="half">
          campaign name
          <input value={form.name} onChange={set('name')} placeholder="e.g. august seasoning" />
        </label>
        {/* Only the single-campaign path reads this. "Start on all N funders"
            picks the free funders itself and ignores the dropdown entirely —
            which is not something a form can be expected to imply, so the
            label says it whenever a batch is actually available. */}
        <label className="half">
          funding wallet{freeFunders.length > 1 ? ' — for one campaign only' : ''}
          <select
            value={master}
            onChange={(e) => {
              setMaster(e.target.value);
              setRefusal('');
            }}
          >
            <option value="">choose one…</option>
            {masters.map((w) => (
              <option key={w.id} value={w.id}>
                {w.address}
                {w.balanceEth == null ? '' : ` — ${Number(w.balanceEth).toFixed(4)} ETH`}
                {w.inCampaign ? ' (busy)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="half">
          days
          <input type="number" min="1" max="90" value={form.days} onChange={set('days')} />
        </label>
        <label>
          per day, min
          <input type="number" min="1" max="200" value={form.perDayMin} onChange={set('perDayMin')} />
        </label>
        <label>
          per day, max
          <input type="number" min="1" max="200" value={form.perDayMax} onChange={set('perDayMax')} />
        </label>

        <label>
          amount min (ETH)
          <input inputMode="decimal" value={form.amountMinEth} onChange={set('amountMinEth')} />
        </label>
        <label>
          amount max (ETH)
          <input inputMode="decimal" value={form.amountMaxEth} onChange={set('amountMaxEth')} />
        </label>
        <label>
          gap min (minutes)
          <input type="number" min="1" max="1440" value={form.gapMinMin} onChange={set('gapMinMin')} />
        </label>
        <label>
          gap max (minutes)
          <input type="number" min="1" max="1440" value={form.gapMaxMin} onChange={set('gapMaxMin')} />
        </label>
      </div>

      <p className="hint">
        The daily count is the column a filter would group by, so it wins over the gap: at thirty
        wallets in a day the gaps must average under 48 minutes and the top of a four-hour range
        simply will not be drawn. Amounts are quoted to six decimals so no two wallets share a
        figure and none of them are round.
      </p>

      <div className="row">
        <Busy
          busy={busy === 'preview'}
          className="ghost"
          disabled={free === 0}
          onClick={async () => {
            try {
              setPreview(
                await act('preview', () =>
                  api('/v4/campaigns/preview', 'POST', { params: params(), walletIds: freeIds })
                )
              );
              setRefusal('');
            } catch {
              // act() has already reported it. Drop the stale plan rather than
              // leave a schedule on screen that the current numbers no longer
              // produce.
              setPreview(null);
            }
          }}
        >
          Preview
        </Busy>
        {/* ONE PRESS FOR EVERY FUNDER, because a campaign is one funder feeding
            its own wallets — two sharing a funder would collide on its nonce —
            and that rule left an operator holding twenty funders setting up
            twenty campaigns by hand. Which made the split that FILLS twenty
            funders only half a feature.
            FIRST AND PRIMARY when it is available: with twenty funders this is
            the ordinary action, and the single start below is the exception. */}
        {freeFunders.length > 1 && (
          <Busy busy={busy === 'batch'} disabled={free === 0} onClick={() => setBatching(true)}>
            Start on {chosenFunders.length === freeFunders.length ? 'all ' : ''}
            {chosenFunders.length} funder{chosenFunders.length === 1 ? '' : 's'}
          </Busy>
        )}
        {/* Demoted to the ghost once a batch exists. Styled as the primary it
            read as the thing to press, and the funding-wallet dropdown it needs
            then read as a required field on a form where it is optional. It
            stays because a single campaign on a chosen wallet is how a trial
            run is done — one funder, a few wallets, before committing twenty. */}
        <Busy
          busy={busy === 'start'}
          className={freeFunders.length > 1 ? 'ghost' : ''}
          disabled={!ready}
          onClick={() => setArming(true)}
        >
          Start one campaign
        </Busy>
        {/* Says what the batch does NOT need. The dropdown above it is the
            only control on this form the batch ignores, and an operator
            staring at "choose one…" has no way to know that. */}
        {freeFunders.length > 1 && free > 0 && (
          <span className="hint">no funding wallet needed — it uses every free one</span>
        )}
        <span className="spacer" />
        <span className="hint">
          {seeds.length === 0
            ? 'generate seed wallets in step 2 first'
            : free === 0
              ? 'every seed wallet is already claimed by a campaign — generate more in step 2'
              : `${plural(free, 'free seed wallet')}${claimed ? ` · ${claimed} already claimed` : ''}`}
        </span>
      </div>

      {/* The gate, before it is reached. The verbatim refusal below is what
          matters when it is reached anyway. */}
      {unprotected > 0 && (
        <div className="notice warn">
          <h3>{plural(unprotected, 'seed wallet')} without a key backup</h3>
          <p>
            A campaign will be refused until every wallet in its plan is on record. Download the
            backup in step 2 — it takes one click, and these keys have no other copy.
          </p>
        </div>
      )}

      {/*
        THE SERVER'S OWN WORDS, NEVER REPLACED WITH "COULD NOT START".

        The backup gate NAMES the wallets whose keys are not on record, and that
        list is the entire value of the refusal: it is what the operator has to
        act on, and there is nowhere else to get it. The same is true of every
        other refusal this route makes — the funding wallet that is short says
        by how much, the infeasible plan says which way to move which number,
        the claimed wallets say which campaign already holds them. A generic
        failure message would throw all of it away and leave a tab that says no
        without saying what to do.

        A toast is not enough either. It disappears, and this message is a list
        of forty-two-character ids to be worked through.
      */}
      {refusal && (
        <div className="notice danger">
          <h3>The campaign was refused</h3>
          <p style={{ overflowWrap: 'anywhere' }}>{refusal}</p>
        </div>
      )}

      {preview && !preview.feasible?.ok && (
        <div className="notice warn">
          <h3>This plan does not fit</h3>
          <p>{preview.feasible?.reason}</p>
        </div>
      )}

      {preview?.feasible?.ok && (
        <>
          <div className="stats">
            <div className="stat">
              <span>Wallets</span>
              <b>{preview.walletIds.length}</b>
            </div>
            <div className="stat">
              <span>Days</span>
              <b>{preview.params.days}</b>
            </div>
            <div className="stat">
              <span>Reaching the wallets</span>
              <b>{Number(preview.totalEth).toFixed(4)}</b>
            </div>
            <div className="stat">
              <span>Cost to the funding wallet</span>
              <b>{cost ? Number(cost.totalEth).toFixed(4) : '—'}</b>
            </div>
          </div>

          {/* Not the sum of the amounts, and the difference is the whole reason
              this figure is drawn separately: an EXACT_OUTPUT Relay order
              charges its fee on the sender's side and every deposit costs gas,
              so a campaign budgeted on the bare sum runs dry near the end —
              when the wallets that go unfunded are the ones with the least time
              left to season. */}
          {cost && (
            <p className="hint">
              Relay fees and gas add about {overhead.toFixed(4)} ETH on top of the{' '}
              {Number(preview.totalEth).toFixed(4)} ETH that reaches the wallets. The funding wallet
              is checked against the total before the campaign is allowed to start.
            </p>
          )}

          <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Wallets</th>
                  <th className="num">ETH</th>
                </tr>
              </thead>
              <tbody>
                {preview.byDay.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td className="num">{d.count}</td>
                    <td className="num">{Number(d.totalEth).toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal
        open={arming}
        title="Start this campaign?"
        danger
        question="It sends real ETH to every wallet in the plan, over the next few weeks."
        onCancel={() => setArming(false)}
        confirmLabel="Start it"
        onConfirm={async () => {
          setArming(false);
          setRefusal('');
          try {
            await act('start', () =>
              api('/v4/campaigns', 'POST', {
                name: form.name.trim(),
                masterWalletId: master,
                // The seed and params the PREVIEW returned, not the form's own.
                // The server regenerates the plan from these, so posting back
                // exactly what it handed over is what makes the campaign that
                // starts the campaign that was read.
                seed: preview.seed,
                params: preview.params,
                walletIds: preview.walletIds,
              })
            );
            setRefusal('');
            setPreview(null);
            setForm((f) => ({ ...f, name: '' }));
            await reload();
          } catch (err) {
            setRefusal(err.message);
          }
        }}
      >
        <p>
          Once started it runs unattended, across restarts, until every wallet has been funded or
          given up on. It can be paused and resumed; cancelling is final.
        </p>
        <Fact label="Name">{form.name.trim()}</Fact>
        <Fact label="Funding wallet" mono>
          {chosen?.address}
        </Fact>
        <Fact label="Wallets">{preview ? plural(preview.walletIds.length, 'wallet') : '—'}</Fact>
        <Fact label="Over">{preview ? plural(preview.params.days, 'day') : '—'}</Fact>
        <Fact label="Costs about">{cost ? `${Number(cost.totalEth).toFixed(4)} ETH` : '—'}</Fact>
        {campaigns.some((c) => c.status === 'running') && (
          <Fact label="Already running">
            {plural(campaigns.filter((c) => c.status === 'running').length, 'campaign')}
          </Fact>
        )}
      </Modal>

      {/* One campaign per funder, created in one call. Every one goes through
          the same guards and the same regenerated plan as a single start — the
          route loops, it does not take a shortcut. A funder short of ETH is
          refused on its own and the rest still start, which is the whole reason
          the expensive checks are per funder. */}
      <Modal
        open={batching}
        title={`Start ${batchCampaigns} campaign${batchCampaigns === 1 ? '' : 's'}, one per funding wallet?`}
        question={
          batchCampaigns < 1
            ? `Not enough unclaimed seed wallets — ${free} free, and ${seedsPer} each means a funder cannot be filled. Generate more in step 2.`
            : !batchFits
              ? `${perFunder} wallet(s) per funder does not fit ${form.days} day(s) at ${form.perDayMin}–${form.perDayMax} a day: each campaign must hold between ${batchFloor} and ${batchCeiling}. Every campaign in this batch would be refused. Change per-day to 1–${Math.max(1, perFunder)} on the form behind this, or change the count above.`
              : `${batchCampaigns * perFunder} seed wallets will be divided evenly across ${batchCampaigns} funder(s), ${perFunder} each, on the schedule above. Each funder is checked for its own balance — one short of ETH is refused on its own and the others still start.`
        }
        confirmLabel={`Start ${batchCampaigns} campaigns`}
        confirmDisabled={batchCampaigns < 1 || !batchFits}
        onConfirm={async () => {
          setBatching(false);
          await act('batch', async () => {
            const out = await api('/v4/campaigns/batch', 'POST', {
              params: params(),
              seedsPerFunder: Math.max(1, Math.round(Number(seedsPer) || 0)),
              name: form.name.trim() || undefined,
              // Sent only when a subset was actually chosen. Omitted, the route
              // takes every free funder — which is the same answer, but reached
              // by the server reading the live list rather than by this tab
              // sending one it may have read a minute ago.
              funderIds: picked ? chosenFunders.map((w) => w.id) : undefined,
            });
            setPreview(null);
            const refused = out.failed.length
              ? ` ${out.failed.length} refused: ${out.failed[0].error}`
              : '';
            return `Started ${out.started.length} campaign(s).${refused}`;
          });
        }}
        onCancel={() => setBatching(false)}
      >
        <label className="modal-type">
          Seed wallets per funder
          <input
            data-autofocus
            type="number"
            min="1"
            value={seedsPer}
            onChange={(e) => setSeedsPer(e.target.value)}
          />
        </label>
        <Fact label="Unclaimed seeds">{free}</Fact>
        <Fact label="Days each">{form.days}</Fact>
        <Fact label="Per day">
          {form.perDayMin}–{form.perDayMax}
        </Fact>
        <Fact label="Each campaign holds">
          {batchFits ? `${perFunder} wallet(s)` : `${batchFloor}–${batchCeiling} required`}
        </Fact>

        {/* Every free funder, tickable. All on by default — an operator who
            never opens this list wants all of them, and an empty selection
            they have to fill in before anything happens is the wrong default
            for the button they just pressed. Unticking is for the case that
            actually comes up: holding one funder back, or skipping one that is
            short of ETH. */}
        <div className="row" style={{ marginTop: 12 }}>
          <b>Funding wallets</b>
          <span className="spacer" />
          <button className="link" onClick={() => setPicked(freeFunders.map((w) => w.id))}>
            all
          </button>
          <button className="link" onClick={() => setPicked([])}>
            none
          </button>
        </div>
        <div className="table-scroll" style={{ maxHeight: 220 }}>
          <table>
            <tbody>
              {freeFunders.map((w) => {
                const on = chosenFunders.some((x) => x.id === w.id);
                return (
                  <tr key={w.id}>
                    <td style={{ width: 32 }}>
                      <input type="checkbox" checked={on} onChange={() => toggle(w.id)} />
                    </td>
                    <td>
                      <span className="mono">{w.address.slice(0, 14)}…</span>
                    </td>
                    <td className="num">
                      {w.balanceEth == null ? (
                        <span className="hint">unreadable</span>
                      ) : (
                        `${Number(w.balanceEth).toFixed(6)} ETH`
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Modal>
    </Step>
  );
}
