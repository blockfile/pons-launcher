import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { LuChevronDown, LuChevronUp, LuCalendarDays } from 'react-icons/lu';
import { IconAction } from './IconButton.jsx';
import { ago, clock, eth, plural } from './roles.js';

// Which notice a status paints itself as. Halted is vermilion because it is the
// one state that needs a hand put on it — three failures in a row is a systemic
// fault, not bad luck, and the campaign has stopped sending. Paused is amber:
// deliberate, reversible, and nothing is wrong. Everything else is plain.
const TONE = { halted: 'danger', paused: 'warn' };

/**
 * Step 4 — the campaigns, several at once, for as long as they take.
 *
 * A CAMPAIGN THAT HAS STOPPED MUST NOT LOOK LIKE ONE THAT IS MERELY QUIET, and
 * that is the whole design of this panel. Sends land about once an hour across
 * three weeks, so counters barely move by the minute: "128 sent" reads exactly
 * the same whether the last one left six minutes ago or six days ago. Nobody
 * notices a number that stopped changing over three weeks — they notice it in
 * hindsight, after the schedule has run out.
 *
 * So every card carries "last sent 34m ago · next due 15:12" beside the counts,
 * and it keeps ticking on a clock of its own rather than on the poll: a stopped
 * campaign is not polled (see V4Console — polling follows `running`), and a
 * frozen "34m ago" on a campaign that halted yesterday would be the exact lie
 * this readout exists to prevent. Two more tells sit next to it — a next-due
 * time already in the past, and a running campaign with no timer armed, which
 * is a runner that has stopped re-arming rather than a campaign that is waiting.
 */
export default function V4CampaignsPanel({ step, campaigns, details, lastSent, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [cancelling, setCancelling] = useState(null);
  const [open, setOpen] = useState({});
  // Which cards are expanded. Absent means folded — EXCEPT for a campaign that
  // has halted, which opens itself: that one is not a scanning problem, and a
  // stopped campaign hiding its own counts behind a click is the failure this
  // panel is built to prevent, reintroduced by the thing that tidied it.
  const [card, setCard] = useState({});
  const cardOpen = (c) => card[c.id] ?? c.status === 'halted';
  // A clock, not a poll. It costs one state write every fifteen seconds and
  // nothing on the network, and it is what keeps "34m ago" honest after the
  // campaign it describes has stopped being fetched.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // Rolled up from the summaries, which carry their own counts — no transfer
  // list needed, so these are right on first paint rather than filling in as
  // details arrive.
  const halted = campaigns.filter((c) => c.status === 'halted').length;
  const totalSent = campaigns.reduce((n, c) => n + (c.sent || 0), 0);
  const totalPlanned = campaigns.reduce((n, c) => n + (c.total || 0), 0);

  if (!campaigns.length) {
    return (
      <Step {...step}>
        <p className="lede">
          Every campaign this account has run, and what each one is doing right now.
        </p>
        <div className="notice">
          <h3>Nothing running</h3>
          <p>
            Plan one in step 3. It will keep going here across restarts — the schedule is on disk,
            not in a browser tab, so this page can be closed and the sends carry on without it.
          </p>
        </div>
      </Step>
    );
  }

  return (
    <Step {...step}>
      <p className="lede">
        Every campaign this account has run, and what each one is doing right now. Closing this tab
        changes nothing: the schedule lives on the server and survives a restart.
      </p>

      {/* THE ANSWER BEFORE THE DETAIL. A batch makes twenty campaigns, and
          twenty cards is a page nobody reads to the end of — so the question
          this step exists to answer, "is anything wrong", is stated once here
          and the cards below are for the one that is. Halted is drawn even at
          zero: an operator who has learnt to look for it needs to see that it
          was looked for and was none, not to wonder whether it is missing. */}
      {campaigns.length > 1 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="hint">
            <b>{campaigns.length}</b> campaigns
          </span>
          {['running', 'complete', 'paused', 'cancelled'].map((s) => {
            const n = campaigns.filter((c) => c.status === s).length;
            return n ? (
              <span className="hint" key={s}>
                · <b>{n}</b> {s}
              </span>
            ) : null;
          })}
          <span className={halted > 0 ? 'crux' : 'hint'}>
            · <b>{halted}</b> halted
          </span>
          <span className="spacer" />
          <span className="hint">
            <b>{totalSent}</b> of <b>{totalPlanned}</b> wallets funded
          </span>
        </div>
      )}

      {/* Capped, for the same reason the wallet tables are: twenty cards pushes
          everything below this step off the page. Tall enough for two at a
          time, which is what reading one and comparing it to its neighbour
          takes. */}
      <div className="scroll-y" style={{ maxHeight: 620, overflowY: 'auto' }}>
      {campaigns.map((c) => {
        const full = details[c.id];
        const transfers = full?.transfers || [];
        const days = c.params?.days ?? full?.params?.days ?? null;
        // The day the runner is actually working on, which is the day of the
        // next transfer still waiting — not elapsed time. A campaign paused for
        // a week is not on day twelve of its own schedule.
        const nextDay = transfers.reduce(
          (min, t) => (t.status === 'pending' && (min == null || t.day < min) ? t.day : min),
          null
        );
        // UNKNOWN AND FINISHED ARE NOT THE SAME ANSWER. Reducing over a
        // transfer list that has not loaded yields null exactly as a campaign
        // with nothing left to send does, and `nextDay ?? days` would then
        // report a campaign on day one as "day 20 of 20" — a finished campaign,
        // drawn from the absence of the data that would have said otherwise.
        const day = full ? (nextDay ?? days) : null;
        const attempts = transfers.reduce((n, t) => n + (t.attempts?.length || 0), 0);
        const sentAt = lastSent[c.id];
        const overdue = c.status === 'running' && c.nextDueAt != null && c.nextDueAt < now;
        const stalled = c.status === 'running' && !c.armed && !c.inFlight;

        return (
          <div className={`notice ${TONE[c.status] || ''}`.trim()} key={c.id}>
            <h3>
              {c.name}
              {/* A split pays FUNDING wallets, not seeds, and takes an
                  afternoon rather than weeks. Unlabelled it reads as a very
                  short seasoning run that funded the wrong things — and the
                  reason it does not claim its targets would look like a bug. */}
              {c.kind === 'split' && <span className="hint">· split</span>}
              <span className="hint">
                {c.status}
                {c.inFlight ? ' · sending' : ''}
              </span>
              <span className="spacer" />
              {days && (
                <span className="hint">
                  day {day ?? '—'} of {days}
                </span>
              )}
            </h3>

            {/* The staleness line. Counts are below it, deliberately: they say
                how far along the campaign is, and this says whether it is still
                moving. */}
            <p className={stalled || overdue ? 'crux' : ''}>
              {/* "nothing sent yet" is a CLAIM, and it may only be made from the
                  transfer list. lastSent is undefined both when the campaign
                  has sent nothing and when its schedule has not been read —
                  indistinguishable states, and asserting the first from the
                  second puts "nothing sent yet" directly above a Sent 128/400
                  tile. Usually that window is one request wide; the case that
                  matters is a detail read failing while nothing is running,
                  because polling is off and nothing retries until the operator
                  acts. That is precisely the stopped campaign this line exists
                  to expose, so it is the one place it must not guess. */}
              {!full ? (
                'last send not read yet'
              ) : sentAt ? (
                <>
                  last sent <b className="is-next">{ago(sentAt, now)}</b>
                </>
              ) : (
                'nothing sent yet'
              )}
              {/* COLOUR BY WHAT THE FACT MEANS, not to decorate. Three states
                  and three readings: sky for the ordinary answer (it is moving,
                  here is when next), vermilion for the two that need a hand —
                  a due time already past, and a running campaign with no timer,
                  which is a runner that has stopped re-arming rather than one
                  that is waiting. Anything grey is prose around them. */}
              {c.status === 'running' && c.nextDueIso && (
                <>
                  {' · '}
                  <b className={overdue ? 'is-bad' : 'is-next'}>
                    {overdue
                      ? `overdue since ${clock(c.nextDueIso, now)}`
                      : `next due ${clock(c.nextDueIso, now)}`}
                  </b>
                </>
              )}
              {c.status === 'running' && !c.nextDueIso && <> · nothing left to send</>}
              {c.status !== 'running' && <> · {c.status}, nothing scheduled</>}
              {stalled && (
                <>
                  {' · '}
                  <b className="is-bad">no timer armed</b>
                </>
              )}
            </p>

            {/* A halt or pause reason is NEVER folded away. It is the sentence
                that says why a campaign stopped, and hiding it behind a click
                would make a stopped campaign look like a quiet one on the very
                readout built to keep those apart. */}
            {(c.haltReason || c.pauseReason) && (
              <p style={{ overflowWrap: 'anywhere' }}>{c.haltReason || c.pauseReason}</p>
            )}

            {/* Everything below is folded by default. Twenty campaigns is a
                list to scan, not twenty things to read: the title and the
                staleness line above answer "is this one fine", and the counts,
                the controls and the schedule are what you open when the answer
                is no. A campaign that has halted opens itself, because that one
                is not a scanning problem. */}
            <IconAction
              icon={cardOpen(c) ? LuChevronUp : LuChevronDown}
              onClick={() => setCard((st) => ({ ...st, [c.id]: !cardOpen(c) }))}
            >
              {cardOpen(c) ? 'Less' : `${c.sent} of ${c.total} sent · details`}
            </IconAction>

            {cardOpen(c) && (
              <>
            <div className="stats" style={{ marginTop: 12 }}>
              <div className="stat ok">
                <span>Sent</span>
                <b>
                  {c.sent}
                  <span className="stat-of"> / {c.total}</span>
                </b>
              </div>
              <div className="stat">
                <span>Waiting</span>
                <b>{c.pending}</b>
              </div>
              <div className={`stat ${attempts ? 'bad' : ''}`}>
                <span>Failed sends</span>
                <b>
                  {full ? attempts : '—'}
                  {c.consecutiveFailures > 0 && (
                    <span className="stat-of"> · {c.consecutiveFailures} in a row</span>
                  )}
                </b>
              </div>
              <div className={`stat ${c.abandoned ? 'bad' : ''}`}>
                <span>Abandoned</span>
                <b>{c.abandoned}</b>
              </div>
            </div>

            <div className="row">
              <Busy
                busy={busy === `pause:${c.id}`}
                className="ghost"
                disabled={c.status !== 'running'}
                onClick={() => act(`pause:${c.id}`, () => api(`/v4/campaigns/${c.id}/pause`, 'POST'))}
              >
                Pause
              </Busy>
              <Busy
                busy={busy === `resume:${c.id}`}
                className="ghost"
                disabled={c.status !== 'paused' && c.status !== 'halted'}
                onClick={() => act(`resume:${c.id}`, () => api(`/v4/campaigns/${c.id}/resume`, 'POST'))}
              >
                Resume
              </Busy>
              <button
                className="ghost danger"
                disabled={c.status === 'cancelled' || c.status === 'complete'}
                onClick={() => setCancelling(c)}
              >
                Cancel
              </button>
              <span className="spacer" />
              <IconAction
                icon={LuCalendarDays}
                onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}
                disabled={!full}
              >
                {open[c.id] ? 'Hide the schedule' : 'The schedule'}
              </IconAction>
            </div>

            {open[c.id] && full && (
              <div style={{ marginTop: 12 }}>
                {(full.byDay || []).map((d) => {
                  const rows = transfers.filter((t) => t.day === d.day);
                  const sent = rows.filter((t) => t.status === 'sent').length;
                  return (
                    <details className="disperse-panel" key={d.day} style={{ marginTop: 6 }}>
                      <summary>
                        Day {d.day}{' '}
                        <span className="hint">
                          — {plural(d.count, 'wallet')} · {Number(d.totalEth).toFixed(6)} ETH ·{' '}
                          {sent}/{d.count} sent
                        </span>
                      </summary>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Wallet</th>
                              <th className="num">Amount</th>
                              <th>Due</th>
                              <th>Status</th>
                              <th>Tx</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((t) => (
                              <tr key={t.id}>
                                <td>
                                  <Address
                                    value={t.address}
                                    href={explorer ? `${explorer}/address/${t.address}` : ''}
                                  />
                                </td>
                                <td className="num">{eth(t.amountEth)}</td>
                                <td>{clock(new Date(t.dueAt).toISOString(), now)}</td>
                                <td>
                                  {t.status === 'sent' ? (
                                    <>
                                      sent <span className="hint">{ago(t.sentAt, now)}</span>
                                    </>
                                  ) : t.status === 'abandoned' ? (
                                    <span className="bal short">
                                      abandoned after {plural(t.attempts?.length || 0, 'try', 'tries')}
                                    </span>
                                  ) : t.attempts?.length ? (
                                    <>
                                      waiting{' '}
                                      <span className="hint">
                                        · {plural(t.attempts.length, 'failed try', 'failed tries')}
                                      </span>
                                    </>
                                  ) : (
                                    'waiting'
                                  )}
                                </td>
                                <td>
                                  {t.hash ? (
                                    <a
                                      href={explorer ? `${explorer}/tx/${t.hash}` : ''}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
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
                        {/* The last thing that went wrong on this day, in full.
                            An attempt count says a transfer is in trouble; only
                            the error says whether it is this wallet or Relay. */}
                        {rows.some((t) => t.attempts?.length) && (
                          <p className="hint" style={{ overflowWrap: 'anywhere' }}>
                            {rows
                              .flatMap((t) => t.attempts || [])
                              // Chronological, not table order. A transfer that
                              // failed is re-slotted forward, so an early row
                              // can fail after a later one — taking the last
                              // row's last attempt would name a stale error as
                              // the most recent thing that went wrong. Safe to
                              // sort in place: flatMap already made a new array.
                              .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
                              .slice(-1)
                              .map((a) => `last failure: ${a.error}`)}
                          </p>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
              </>
            )}
          </div>
        );
      })}
      </div>

      <Modal
        open={Boolean(cancelling)}
        title="Cancel this campaign?"
        danger
        question="Every wallet it has not reached yet stays unfunded."
        onCancel={() => setCancelling(null)}
        confirmLabel="Cancel it"
        onConfirm={async () => {
          const c = cancelling;
          setCancelling(null);
          await act(`cancel:${c.id}`, () => api(`/v4/campaigns/${c.id}/cancel`, 'POST'));
        }}
      >
        <p>
          Cancelling is one-way — a cancelled campaign cannot be resumed, because restarting it
          would re-fund wallets against a schedule already decided against. Pause instead if the
          plan is right and the moment is wrong.
        </p>
        {cancelling && (
          <>
            <Fact label="Campaign">{cancelling.name}</Fact>
            <Fact label="Funded so far">
              {cancelling.sent} of {cancelling.total}
            </Fact>
            <Fact label="Left unsent">{plural(cancelling.pending, 'wallet')}</Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
