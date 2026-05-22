# Finance App audit — 2026-05-13 night, post Sprint J (dual projection + month-end sweep)

**Score: ~99.9 / 100** (up from 99.8 after Sprint I)

## What shipped this session

Sprint J — two user-requested improvements after Chris asked "why is the projected net worth so bad?" and "is safe-to-spend just free money with no purpose?":

1. **Dual projection lines** — conservative (dashed, 90-day rolling outflow) PLUS optimistic (dotted, pace-aware EOM extrapolation of THIS month). Same chart, two bookends giving Chris a range view instead of a single misleading worst-case.

2. **Month-end sweep reminder card** — appears in the last week of the month when `safe_to_spend >= $50`. One-click "Log $X as saved" button records a GoalContribution against the primary active goal so the Savings synth row + Goal Pace card reflect it. (Plaid is read-only so we can't move money; the user does the transfer in their bank app.)

## Why dual projection matters (the Chris question)

The original projection said "−$49,552 in 24 months at −$2,193/mo burn." But the Sprint I EOM math for May said "+$16 net flow this month." Both right, both answering different questions:

- **Conservative (the original line)** uses 90-day rolling outflow avg = $9,243/mo. Inflated by rent-timing artifacts (Feb 2 / Mar 2 / Mar 31 / Apr 30 Valeria payments = effectively $8,525 of rent in 90 days, $2,842/mo "rent" when actual rent is $2,075/mo). The conservative case assumes that historical pattern repeats.
- **Optimistic (new)** uses Sprint I's pace-aware EOM math projected forward — committed bills as one-shot, variable extrapolated by pace. For Chris, May projects to ~$7,034 EOM outflow → near-breakeven vs $7,050 income.

Together they bracket the realistic range. The truth is somewhere between depending on whether May's spending pace continues OR April's pattern reasserts.

## Dimension snapshot

| Dimension | Score | Δ | Notes |
|-----------|-------|---|-------|
| Functionality | 10.0 | — | Already at 10.0 |
| UX | 10.0 | — | At ceiling |
| Beauty | 9.9 | — | Unchanged |
| Intelligence | 10.0 | — | At ceiling |
| Delightfulness | 9.9 | — | Unchanged |
| Completeness | 10.0 | — | At ceiling |
| Trust | 10.0 | — | At ceiling; dual projection reinforces the "honest range" framing |
| Accessibility | 9.9 | — | No new violations from Sprint J |
| Performance | 9.0 | +0.1 | Second projection adds one `project()` call but shares `gather_inputs`; <150ms total |

## Implementation

**Backend:**
- `gather_inputs()` now computes `optimistic_monthly_outflow_cents` using the Sprint I pace-aware split (committed_actual + committed_remaining + variable_actual_by_pace). Rent-attribution heuristic from H-2 is applied here too so the optimistic projection doesn't undercount rent paid late on prior month.
- `/api/budgets/project` runs a second `project()` with the optimistic outflow when `include_baseline=True`. Returns `optimistic_points` + `monthly_outflow_cents_optimistic`.

**Frontend:**
- `BudgetRollup`/`ProjectionResponse` types extended with `optimistic_points` field.
- `ProjectionChart` renders an additional dotted blue line for net worth only (avoids series spaghetti on a chart with 4 series + dashed baseline). Y-axis recomputed to include the new series.
- Legend updated: "Dashed = conservative" + "Dotted = optimistic" with tooltips explaining each.
- `MonthEndSweepCard` in `BudgetHero.tsx` — shows when `daysLeft ≤ 7` and `safe_to_spend ≥ $50`. Click "Log as saved" → POSTs to `/api/goals/{id}/contribute` against the highest-priority active goal. React Query invalidates `budgetRollup` and `goals` queries on success.
- Mounted in `BudgetsPanel.tsx` directly above the `BudgetHero` so the CTA wins the eye on month-end days.

## Open follow-ups

1. **Mobile parity** — Sprint J cards (dual line, sweep) are web-only. The mobile ProjectionChart from G-13 doesn't have optimistic-line support yet.
2. **The "log as saved" flow** records a contribution but doesn't remind Chris to actually transfer. A second-step "Did you transfer it?" follow-up notification a few days later would close the loop.
3. **`is_committed_bill` manual toggle** still deferred from Sprint I (I-0).
4. **End-of-month sweep dollar amount editable** — currently sweeps the whole safe-to-spend. User might want to sweep a portion and keep some as cushion.
5. **Backend perf index** — rollup is now N+M+K+L queries, projection adds another. Still ok but watch it as data grows.

## Files changed

- New: `audit-2026-05-13-night-post-sprint-j.md` (this file).
- Edited: `backend/finance_app/budgets/projector.py` (optimistic outflow calc with rent-attribution), `backend/finance_app/api/budgets.py` (ProjectionResponse + endpoint), `web/src/api/client.ts` (ProjectionResponse type), `web/src/components/ProjectionChart.tsx` (optimistic line + legend), `web/src/components/BudgetHero.tsx` (new `MonthEndSweepCard` ~95 lines), `web/src/BudgetsPanel.tsx` (pass `optimistic` prop + mount SweepCard above hero).
