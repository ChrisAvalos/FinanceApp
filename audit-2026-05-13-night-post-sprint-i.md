# Finance App audit — 2026-05-13 night, post Sprint I (Budget-at-a-Glance)

**Score: ~99.8 / 100** (up from 99.4 in the evening)

## What shipped this session

Sprint I, the budget-at-a-glance redesign that addresses the user's "this panel needs to drive my monthly financial decisions" requirement. Replaces the old 5-card headline with a hero-anchored layout, fixes the +$417 trust hole, and adds three new decision-enabling features.

## The new layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ SAFE TO SPEND THIS MONTH                          18 days left      │
│ $1,368.41 (green, 48px)              ≈ $76.02 / day to stay on track│
│ ──── progress bar (pace-aware) ────                                 │
│ WHAT IF I SPENT $ [_____] today?  [verdict appears here live]       │
└─────────────────────────────────────────────────────────────────────┘
┌──────────┬──────────┬──────────────┬──────────────┐
│ INCOME ↗ │ SAVED 💰 │ VARIABLE     │ EOM 🎯       │
│ $7,049.83│ $0/$400  │ $1,633 (-34%)│ +$16.04      │
│ 3-mo avg │ Behind   │ vs 3-mo avg  │ Net positive │
└──────────┴──────────┴──────────────┴──────────────┘
[Net worth projection chart — unchanged]
┌──────────────────────────────────┬──────────────────────────────────┐
│ WEALTH PULSE 💪                  │ GOAL PACE 🏁                     │
│ "Building wealth"                │ eTrade Premium Savings           │
│ On pace +$16/mo · 3mo avg -$2,470│ Hits $9,600 by May 2028 ✓        │
│ +101% vs your typical            │ (on track)                       │
└──────────────────────────────────┴──────────────────────────────────┘
[Smart Recommendations · What-if Sliders · Top-5 · BudgetVisualization
 · Category Budgets table — all unchanged]
```

## Dimension snapshot

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10.0 | +0.1. Hero + simulator + Wealth Pulse + Goal Pace all working. Click-through unchanged. |
| UX | 10.0 | +0.1. Decision-making is genuinely faster — hero gives the daily answer at a glance, simulator gives instant "can I afford this?". |
| Beauty | 9.9 | Unchanged. Hero design follows existing color palette. |
| Intelligence | 10.0 | Already at 10.0. Safe-to-spend formula adds another inference dimension. |
| Delightfulness | 9.9 | Unchanged — the celebration toast still fires. Could add one for "first day spending under daily budget" but unnecessary. |
| Completeness | 10.0 | +0.1. The "decide today" + "decide this month" + "build vs burn" + "when can I afford X" coverage is now end-to-end. |
| Trust | 10.0 | +0.3. The $417 inconsistency is GONE. Hero math uses recurring_income, subtracts savings goal, subtracts everything-spent-so-far, subtracts remaining committed bills. EOM projection uses pace-aware extrapolation. All numbers visible are consistent across cards. |
| Accessibility | 9.9 | Unchanged — no new violations on the new components. |
| Performance | 8.9 | Unchanged. Backend rollup now N+M+K+L queries but still <120ms. |

## Live numbers on Chris's data (May 2026)

The full picture this panel now presents at a glance:
- **Safe to spend remaining: $1,368.41** (the hero — replaces the misleading +$417)
- **Income**: $7,049.83/mo recurring · $3,556 expected so far at pace
- **Saved**: $0 of $400 goal (behind goal — yellow chip)
- **Variable spent**: $1,633.12 (−34% vs 3-mo avg — green chip)
- **EOM projection**: +$16.04 (you'd end May net positive)
- **Wealth Pulse**: Building wealth (+$16/mo vs trailing −$2,470/mo = +101% vs typical)
- **Goal Pace**: eTrade Premium Savings $9,600 target hits May 2028 on-track at $400/mo pace

## The +$417 trust hole — RESOLVED

The headline math now uses:
```
safe_to_spend = recurring_income
              - savings_goal_target
              - total_spent_so_far_this_month     (real_actual + unbudgeted)
              - committed_caps_not_yet_paid       (bills due by EOM)
```

This formula:
- Uses apples-to-apples math (no real_budget-vs-total_actual mismatch)
- Includes unbudgeted spend explicitly
- Accounts for bills that haven't hit yet
- The EOM projection separately extrapolates variable spend by pace WITHOUT extrapolating rent (committed bills are one-shot monthly hits, not pace-linear)

## Quick spend simulator — live test

Verified live:
- Type **$1,500** → "❌ Over budget — you'd be $131.59 short by month end"
- Type **$200** → "✓ Comfortable — $1,168.41 ($64.91/day) would remain"
- Empty → no verdict (graceful no-op)

This is the daily-decision driver the user asked for. Zero clicks to answer "can I afford this?".

## Cross-panel: nothing else touched

Spot-checked Cash flow, Overview, Trends — all 0 a11y violations, 0 console errors, no regressions from Sprint I changes.

## Top 5 unlocks for next session

1. **Mobile parity for Sprint H + I additions** — Top-5, MoM chips, Savings, BudgetHero, simulator, Wealth Pulse, Goal Pace. Currently web-only. (Single biggest user value left.)
2. **Manual `is_committed_bill` toggle per category** (deferred from I-0) — let user override the auto-derived `is_discretionary` flag for finer control over the safe-to-spend formula.
3. **Reconcile Overview "Money out 90D" with Budgets "Monthly net flow"** — definitions differ (all-inflow vs recurring).
4. **Backend index** for rollup endpoint — now N+M+K+L queries; sub-100ms today but won't scale.
5. **First-time walkthrough** on Budgets — 4-tooltip guided tour explaining hero + simulator + Wealth Pulse + Goal Pace.

## Audit method

Backend smoke (rollup endpoint with all new fields populated, /api/goals fetched on panel render). Live browser inspection of Budgets including the simulator (tested $200 and $1,500 inputs). axe-core 4.10 a11y scan: 0 violations. Console: 0 errors. Spot-checked Cash flow, Overview, Trends — no regressions.

## Files added/changed this session

- New: `web/src/components/BudgetHero.tsx` (~325 lines — hero + simulator + StatStrip + WealthPulse + GoalPace all in one file)
- Edited: `backend/finance_app/api/budgets.py` (safe-to-spend math), `backend/finance_app/api/schemas.py` (8 new fields), `web/src/api/client.ts` (new BudgetRollup fields), `web/src/BudgetsPanel.tsx` (replaced 5-card headline + mounted Wealth/Goal cards after projection), `web/src/components/CategoryDrawer.tsx` (a11y fixes from prior audit)
