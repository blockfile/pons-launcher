# Redesign pilot — report

**Status: complete.** `App.jsx` is reframed into the SOLARBA-chrome shell
(sidebar + top bar + content + status bar, with the live-mode vermilion
signature), and the two-primary (indigo/amber) split is applied to the V4 tab.
`npm run build` passes, the diff is presentation-only, and screenshots are saved.

## What changed (4 files)

| File | Change |
|------|--------|
| `frontend/src/App.jsx` | Reparented the render into `.app-shell` (sidebar / top bar / content / status bar). Added a `react-icons/lu` import and a presentational `TAB_TITLE` lookup. |
| `frontend/src/v4/V4FundingPanel.jsx` | `className="btn-primary"` on Create funding wallet, Import funding wallet, Preview split. |
| `frontend/src/v4/V4SeedPanel.jsx` | `className="btn-primary"` on Generate wallets. |
| `frontend/src/v4/V4PlanPanel.jsx` | Preview `className` ghost → `btn-primary`; `btn-primary` on the All / All-but-the-distributor / None pickers. |

Nothing else was touched. `V4Console.jsx`, `V4CampaignsPanel.jsx`,
`V4BackupControls.jsx`, `IconButton.jsx`, `roles.js`, `backup.js`, `styles.css`
and `shell.css` are unchanged. v1/v2/v3 are untouched (the fan-out phase).

## Build

```
npm run build --workspace frontend  →  ✓ built in ~0.3s, no new warnings
```

## Handler / prop / hook audit — presentation only

Every changed line is a `className`, a wrapper element, or moved JSX. Confirmed
by reading the full `git diff`:

- **Tab buttons** moved sidebar-side: `onClick={() => setTab('vN')}` and the
  `tab === 'vN'` active condition are byte-identical; only the class changed
  (`quiet`/`quiet is-on` → `side-item`/`side-item is-on`) and a lucide icon +
  the same text label were added as children.
- **API-key input + forget button** moved into `.topbar`: `type`, `placeholder`,
  `autoComplete`, `value`, both `onChange`/`onClick` handlers and the `needsKey`
  and `key &&` gates are unchanged.
- **Chips/mode-chip/status bar** read only values already in scope (`health`,
  `health.chainId`, `health.user`, `health.multiUser`, `live`). No new
  `useState`/`useEffect`/`useMemo`, no new `api()` call, no new fetch.
- **Panel render tree** (V3/V4 branch, `sequence` wrapper, records divider,
  `HistoryPanel`, `ActivityPanel`) is unchanged in identity, order and props —
  only its outer wrapper became `.content > main`.
- **V4 buttons**: each edit adds/swaps a `className` only; no `onClick`, `api()`,
  `disabled`, or `busy` expression was touched.

## The two-primary split as applied (V4)

Indigo `btn-primary` (forward, moves no money): Create funding wallet, Import
funding wallet, Generate wallets, Preview, Preview split, and the All/None
pickers.

Left amber (base button = "this one spends"), deliberately: **Start split**,
**Start on N funders**, **Start one campaign**. Left as-is for their existing
tier: Export / Download backup (ghost secondary), Pause / Resume (ghost
lifecycle), Cancel and the row/bulk deletes (vermilion destructive).

## Judgment calls & minor deviations (all presentation-only)

- **Import funding wallet → indigo.** Not in the brief's enumerated indigo list,
  but it creates a funding wallet and moves no money, so leaving it amber would
  have signalled "spends". Treated as a sibling of "Create funding wallet".
- **All/None pickers → indigo.** Applied to all three (All, All-but-the-
  distributor, None) as one picker cluster. They only appear inside the batch
  modal, so they are not in the saved screenshots.
- **Mode chip text shortened** to `live` / `dry run` / `connecting`. The full
  sentence (`live · spends real funds` / `dry run · broadcasts nothing`) is
  preserved verbatim in the status bar, which the brief names as its priority.
  The three-way `!health`/`live` branch is identical — only the displayed
  strings differ. The chain/user readout became chips (`signed in as` → a chip
  labelled `signed in`).
- **Sidebar section heading is "Consoles"** above the nav, rather than the
  brief's optional "Records" heading below it — the History/Activity panels stay
  in the content area, so a "Records" label in the sidebar would have been
  orphaned. A section heading over the launcher nav reads as intended.

## Nothing was blocked

Every visual change the brief asked for was achievable without touching
behaviour. There is no item I had to skip because it would have required a
handler/prop/hook/condition change.

## Setup note (not a code change to the app)

This worktree branched from an older `main`; the shell foundation the brief
assumes lives two commits ahead on `main` (`bee7086` redesign palette in
`styles.css`, `96ef69c` `shell.css` + the `main.jsx` import). The worktree was
fast-forwarded to `main`'s tip to pick them up, and `npm install` was run (a
fresh worktree has no `node_modules`). `REDESIGN-BRIEF.md` is untracked in the
shared checkout, so it does not appear in this worktree; it was read from the
shared checkout as the spec.

## Screenshots (1440×900, dry-run, no backend)

- `frontend/src/v4/redesign-screenshots/v4-shell-01-v4-tab-dry.png` — V4 tab in
  the shell; active sidebar rail, top-bar title/subtitle + mode chip, indigo
  Create/Generate primaries beside quiet secondaries.
- `frontend/src/v4/redesign-screenshots/v4-shell-02-live-vermilion.png` — the
  live-mode signature: frame borders + active rail + mode chip turn vermilion,
  chain/user chips and the "live · spends real funds" status indicator. Captured
  via a temporary local-only `health` probe that was reverted (see setup note;
  the working tree no longer contains it).
- `frontend/src/v4/redesign-screenshots/v4-shell-03-v1-launcher.png` — the v1
  Launcher tab reparented into the same shell (its amber primary intact, since
  v1 is untouched in this pilot).
