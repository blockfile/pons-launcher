# V4 Seed Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The V4 seed table groups wallets into Ready to use / Not ready yet (with a status per row) / Withdrawn, instead of by run.

**Architecture:** A pure `seedStatus` helper decides each wallet's state from the wallet row and its campaign transfer fact; the panel derives its sections and the status column from it.

**Tech Stack:** React 19 + Vite, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-12-v4-seed-readiness-design.md`

## Global Constraints
- Ready = `daysSinceFunded >= 1` and not withdrawn — identical to the tab's existing "usable" rule.
- A wallet is in exactly one section. Withdrawn is checked first.
- No change to search, sort, ticks, bulk actions, backup buttons' behaviour, CSS, or any backend file.
- Status chips use existing `.fund-state` classes only (`is-in`, `is-wait`, `is-part`, base).

### Task 1: `seedStatus` helper (TDD)
**Files:** Create `frontend/src/v4/seedStatus.js`, `frontend/src/v4/seedStatus.test.js`
- [ ] Tests: ready at ≥1 day; aging with hours left (ceil, min 1) from `fundedAt`; `abandoned` → failed; unfunded + campaign cancelled → cancelled; halted; paused; running/pending → waiting; no campaign & no fact → not in a campaign; claimed but no fact yet → waiting; `orderByStatus` puts failed before aging before waiting before not-in-a-campaign and is stable; `statusCounts` counts by key.
- [ ] Implement; `cd frontend && node --test src/v4/seedStatus.test.js` → PASS.

### Task 2: wire it in
**Files:** Modify `frontend/src/v4/V4Console.jsx` (`seedFacts` + `campaignStatus`), `frontend/src/v4/V4SeedPanel.jsx`
- [ ] Remove run clustering and its hints; derive `readyList` / `notReadyList` (status-ordered) / `withdrawnList`.
- [ ] `seedSection(title, hint, list, { accent, showStatus })`; drop `showUsable`; add a Status column when `showStatus`.
- [ ] Update the "no wallet matches" check and the explanatory comments.
- [ ] `cd frontend && npm test && npm run build` → PASS; visual check in the console.
- [ ] Commit.
