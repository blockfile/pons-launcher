import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Sequence from '../components/Sequence.jsx';
import ResultPanel from '../components/ResultPanel.jsx';
import { plural } from './roles.js';
import V4FundingPanel from './V4FundingPanel.jsx';
import V4SeedPanel from './V4SeedPanel.jsx';
import V4PlanPanel from './V4PlanPanel.jsx';
import V4CampaignsPanel from './V4CampaignsPanel.jsx';

/**
 * The V4 tab, whole.
 *
 * It owns all of its own state and shares none with the v1/v2/v3 consoles. App
 * renders one or the other; this component holds V4's wallets and its running
 * campaigns, and nothing it does can change what another tab is drawing.
 *
 * FOUR PANELS AND NO LAUNCH. V4 does not launch, does not buy and does not
 * sell. It funds fresh wallets slowly enough that nothing about them reads as a
 * batch, and then it stops. What the wallets are used for afterwards happens
 * elsewhere.
 */

/** Statuses that mean a funding wallet is still spoken for. */
const ACTIVE = new Set(['running', 'paused', 'halted']);

/**
 * Everything about a campaign that changes when it does something.
 *
 * Used to decide whether the full campaign — transfers and all — is worth
 * re-reading. See loadCampaigns.
 */
function signature(c) {
  return `${c.status}:${c.sent}:${c.pending}:${c.abandoned}:${c.consecutiveFailures}`;
}

export default function V4Console({ health, credential, report, output, reportedAt }) {
  const [wallets, setWallets] = useState({ masters: [], seeds: [], planDefaults: null });
  const [campaigns, setCampaigns] = useState([]);
  // campaignId -> the whole campaign, transfers included. See loadCampaigns for
  // when this is refreshed and why it is not on the poll.
  const [details, setDetails] = useState({});
  const fetched = useRef(new Map());

  const explorer = health?.explorer || '';

  /**
   * `report`, held still.
   *
   * App rebuilds its `report` closure on every render, so a loader that closed
   * over it directly would change identity on every render — and the mount
   * effect below, which lists the loaders, would re-fire with it. That is
   * merely wasteful most of the time and a request loop in the one case that
   * matters: a failing read reports, the report re-renders App, the new
   * `report` re-creates the loader, the effect re-fires, and the read fails
   * again. On a tab meant to be left open for weeks, a loop like that runs
   * unattended. The ref keeps the loaders stable and still reports through
   * whatever `report` currently is.
   */
  const say = useRef(report);
  say.current = report;

  const loadWallets = useCallback(async () => {
    try {
      const out = await api('/v4/wallets');
      setWallets({
        masters: out.masters || [],
        seeds: out.seeds || [],
        // The plan form's starting numbers, from v4/plan.js rather than a copy
        // in the console — see the note above PLACEHOLDER in V4PlanPanel.
        planDefaults: out.planDefaults || null,
      });
    } catch (err) {
      say.current(`ERROR: ${err.message}`);
    }
  }, []);

  /**
   * The campaign summaries, and the full campaigns behind whichever of them has
   * moved since the last read.
   *
   * GET /v4/campaigns is a summary: counts, status, when the next transfer is
   * due. Three things this console draws are not in it — when the LAST transfer
   * actually went, which campaign holds a given seed wallet, and the per-day
   * schedule — and all three come out of the full campaign, which carries every
   * transfer and is therefore the expensive read.
   *
   * So it is fetched by CHANGE rather than by clock. A campaign whose counts,
   * status and failure tally are all where they were has nothing new in its
   * transfer list, so the cached copy is still exactly right; a campaign that
   * has sent something is re-read once. In practice that is about one fetch per
   * campaign per hour, against a fifteen-second poll — the summary is what
   * ticks, and the list of four hundred transfers is not.
   *
   * A failed detail read drops its signature so the next poll tries again.
   */
  const loadCampaigns = useCallback(async () => {
    let list;
    try {
      list = await api('/v4/campaigns');
    } catch {
      // The panel shows its own state and the next poll will answer. A toast on
      // every failed background read of a tab left open for weeks is noise.
      return;
    }
    setCampaigns(list);

    for (const c of list) {
      const sig = signature(c);
      if (fetched.current.get(c.id) === sig) continue;
      fetched.current.set(c.id, sig);
      try {
        const full = await api(`/v4/campaigns/${c.id}`);
        setDetails((d) => ({ ...d, [c.id]: full }));
      } catch {
        fetched.current.delete(c.id);
      }
    }
  }, []);

  useEffect(() => {
    if (!credential) return undefined;
    // A different credential is a different account. The cached campaigns
    // belong to the last one, and the seed-wallet table is drawn from them —
    // left in place, the new account's wallets would be labelled with the old
    // account's campaign names.
    fetched.current.clear();
    setDetails({});
    loadWallets();
    loadCampaigns();
    return undefined;
  }, [credential, loadWallets, loadCampaigns]);

  const running = campaigns.some((c) => c.status === 'running');

  // FIFTEEN SECONDS, AND ONLY WHILE SOMETHING IS RUNNING. A campaign sends
  // roughly once an hour and this tab may be left open for weeks — V3's
  // two-second poll is right for a run that lasts minutes and would be a
  // quarter of a million pointless requests here. When nothing is running
  // nothing is going to change on its own, so the poll stops entirely.
  useEffect(() => {
    if (!credential || !running) return undefined;
    const t = setInterval(loadCampaigns, 15_000);
    return () => clearInterval(t);
  }, [credential, running, loadCampaigns]);

  // The wallets move too — the funding wallet's balance falls with every send —
  // but a minute is fast enough for a figure that changes hourly, and this read
  // costs an RPC call per funding wallet.
  useEffect(() => {
    if (!credential || !running) return undefined;
    const t = setInterval(loadWallets, 60_000);
    return () => clearInterval(t);
  }, [credential, running, loadWallets]);

  /**
   * Which campaign holds each funding wallet.
   *
   * A wallet outlives the campaigns that used it, so the one worth naming is
   * the one still holding it — running, paused or halted — and the most recent
   * otherwise. The route's own `inCampaign` flag says only that some campaign
   * does; this says which.
   */
  const campaignFor = useMemo(() => {
    const map = {};
    for (const c of campaigns) {
      const held = map[c.masterWalletId];
      const better =
        !held ||
        (ACTIVE.has(c.status) && !ACTIVE.has(held.status)) ||
        (!ACTIVE.has(held.status) && c.createdAt > held.createdAt);
      if (better) map[c.masterWalletId] = c;
    }
    return map;
  }, [campaigns]);

  /**
   * What each seed wallet's campaign has to say about it: the amount, the day,
   * whether it has landed and when.
   *
   * A seed wallet is funded exactly once, so at most one transfer anywhere ever
   * names it — no campaign may claim a wallet another already holds, which is
   * the invariant that makes this a plain map rather than a list.
   */
  const seedFacts = useMemo(() => {
    const map = {};
    for (const c of campaigns) {
      for (const t of details[c.id]?.transfers || []) {
        map[t.walletId] = {
          campaign: c.name,
          day: t.day,
          amountEth: t.amountEth,
          status: t.status,
          sentAt: t.sentAt,
          dueAt: t.dueAt,
        };
      }
    }
    return map;
  }, [campaigns, details]);

  /** When each campaign last actually sent something. The staleness readout. */
  const lastSent = useMemo(() => {
    const map = {};
    for (const [id, full] of Object.entries(details)) {
      let latest = null;
      // ISO-8601 in UTC, so a string compare is a time compare.
      for (const t of full.transfers || []) if (t.sentAt && (!latest || t.sentAt > latest)) latest = t.sentAt;
      map[id] = latest;
    }
    return map;
  }, [details]);

  const masters = wallets.masters;
  const seeds = wallets.seeds;
  const unprotected = seeds.filter((w) => !w.backedUp).length;

  /**
   * The order of work, and where in it the operator is standing.
   *
   * Same rules the v1/v2/v3 sequences use: exactly one step is `now` — the
   * first that is not done and whose predecessor is — and `later` is a
   * statement about order, never a permission. Nothing below is disabled by it.
   *
   * Step 2 is not done merely because wallets exist. The backup is what makes
   * funding them survivable, and a sequence that ticked the step off before the
   * keys were on record would be teaching the wrong order.
   */
  const steps = useMemo(() => {
    const plan = [
      {
        key: 'funding',
        n: 1,
        title: 'Create a funding wallet',
        done: masters.length > 0,
        detail: masters.length
          ? `${plural(masters.length, 'wallet')} · one campaign each at a time`
          : 'pays for the campaign and does nothing else',
      },
      {
        key: 'seeds',
        n: 2,
        title: 'Generate seed wallets',
        done: seeds.length > 0 && unprotected === 0,
        detail: !seeds.length
          ? 'the fresh wallets a campaign feeds'
          : unprotected
            ? `${plural(seeds.length, 'wallet')} · ${unprotected} with no key backup`
            : `${plural(seeds.length, 'wallet')} · every key backed up`,
      },
      {
        key: 'plan',
        n: 3,
        title: 'Plan the campaign',
        done: campaigns.length > 0,
        detail: campaigns.length
          ? `${plural(campaigns.length, 'campaign')} planned`
          : 'how many days, how many a day, how much each',
      },
      {
        key: 'run',
        n: 4,
        title: 'Watch it run',
        done: campaigns.some((c) => c.status === 'complete'),
        detail: running
          ? `${plural(campaigns.filter((c) => c.status === 'running').length, 'campaign')} running`
          : 'weeks, unattended, across restarts',
      },
    ];

    let previousRequired = null;
    let claimed = false;
    return plan.map((s) => {
      const waitsOn = s.needs ?? previousRequired;
      const blocked = waitsOn != null && !plan[waitsOn - 1].done;
      previousRequired = s.done ? null : s.n;

      let state = 'later';
      if (s.done) state = 'done';
      else if (!blocked && !claimed) {
        state = 'now';
        claimed = true;
      }

      return {
        ...s,
        id: `v4-step-${s.n}`,
        state,
        chip: state === 'done' ? 'done' : state === 'now' ? 'now' : 'later',
        wait:
          state === 'later' && blocked
            ? `Waits on step ${waitsOn} — ${plan[waitsOn - 1].title.toLowerCase()} first.`
            : null,
      };
    });
  }, [masters, seeds, unprotected, campaigns, running]);

  const step = (key) => steps.find((s) => s.key === key) || null;

  return (
    <div className="sequence">
      <Sequence
        steps={steps}
        notice={
          !health
            ? 'Connecting to the server…'
            : !credential
              ? 'Paste the API key in the top bar — without it the console can neither read nor spend.'
              : null
        }
      />

      <V4FundingPanel
        step={step('funding')}
        wallets={masters}
        // Only so the export dialog can state the whole file's contents. The
        // backup is all of V4 whichever step it is taken from, and a dialog
        // that counted just the funders would imply a smaller scope than the
        // file it produces.
        seeds={seeds}
        campaignFor={campaignFor}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />

      <V4SeedPanel
        step={step('seeds')}
        wallets={seeds}
        // The backup route exports BOTH V4 roles, so the export dialog has to
        // count both. See `exported` in the panel.
        masters={masters}
        facts={seedFacts}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />

      <V4PlanPanel
        step={step('plan')}
        masters={masters}
        seeds={seeds}
        campaigns={campaigns}
        planDefaults={wallets.planDefaults}
        reload={async () => {
          await loadCampaigns();
          await loadWallets();
        }}
        report={report}
      />

      {/* The console's answer, between the plan and the campaigns because that
          is where it falls — the last thing a button here returned. Unnumbered:
          a readout, not a fifth step. */}
      <ResultPanel
        step={{
          id: 'v4-readout',
          title: 'Result',
          state: 'readout',
          chip: reportedAt ? `updated ${reportedAt}` : null,
          railDone: step('plan')?.state === 'done',
        }}
        output={output}
      />

      <V4CampaignsPanel
        step={{ ...step('run'), last: true }}
        campaigns={campaigns}
        details={details}
        lastSent={lastSent}
        explorer={explorer}
        reload={loadCampaigns}
        report={report}
      />
    </div>
  );
}
