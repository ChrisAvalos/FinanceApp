# Finance App audit — 2026-05-13 evening, post Sprint H + Follow-ups

**Score: ~99.4 / 100** (up from 98.7 in the afternoon)

## What moved this session

Two major work streams shipped between the prior audit (98.7) and this one:

1. **Sprint H** — 4 user-driven corrections: rent attribution (Apr 30 Valeria → May), savings-as-budget-row, Trends-style MoM chips + Top-5 card, real-budget headline that excludes catch-all caps, dual-income split (actual vs recurring).
2. **Follow-ups FU-1 through FU-5** — Rent cap bumped $250→$2,075, 4 Valeria Zelle payments recategorized from Transfer to Rent/Mortgage, Goal created ($400/mo eTrade target), sunburst inner-ring true multi-category filter, legacy BudgetDonuts code retired.

## Dimension snapshot

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9.9 | +0.2. Top-5 card, MoM chips, Savings synth row, Goal auto-pickup, sunburst true filter all working. |
| UX | 9.9 | +0.1. Click-through from any visualization view to drawer. Goal feedback baked into recommender. |
| Beauty | 9.9 | Unchanged. Already near-ceiling. |
| Intelligence | 10.0 | +0.3. Rent-attribution heuristic (description + recurrence) + income-filter heuristic both learn from txn patterns. |
| Delightfulness | 9.9 | Unchanged. Celebration toast still fires on scenario flip-positive. |
| Completeness | 9.9 | +0.2. Savings row + Goal wiring closes a Wave G gap. |
| Trust | 9.7 | +0.4. Rent attributed correctly to current month, income split, real budget. Capped by the +$417 inconsistency below. |
| Accessibility | 9.9 | +0.3. Fixed 3 violations on Budgets (aria-allowed-role on the drawer aside, scrollable-region-focusable, select-name on AddBudgetForm). |
| Performance | 8.9 | Unchanged. Backend rollup is now N+M+K queries due to rent-attribution scans but still <100ms on Chris's data. |

## Live-verified numbers on Chris's data (May 2026)

- Income: $8,487.80/mo (3-mo all-inflow avg) · $7,049.83/mo recurring (Livio-only)
- Budgeted: $5,125 (real cap, post-FU-1 bump) · raw $11,625 (with catch-alls)
- Spent: $4,707.70 — includes Apr 30 Valeria $2,075 attributed forward to May
- Remaining: +$417.30 (**flagged below — math is inconsistent**)
- Unbudgeted: $491.06

Rent / Mortgage row: $2,336 actual ($2,075 Valeria + $261 Trojan Storage) vs $2,075 cap = 113% of cap. The −24% MoM chip reflects the new 3-mo avg of $3,074 (which includes Mar 2's $2,300 back-rent payment).

## The +$417 trust hole

User flagged this. Diagnosed three sub-bugs in the headline:

1. **Inconsistent inclusion.** `real_budget_cents` ($5,125) excludes the 4 catch-all category caps (Transfer, Uncategorized, Credit Card Payment, Investment Contribution). But `total_actual_cents` ($4,707.70) STILL includes those categories' actual spend (~$456 of it). Apples-to-oranges comparison. Fix: add `real_actual_cents` to the schema using the same exclusion.
2. **Unbudgeted spend invisible.** $491 of out-of-plan spending (Entertainment $352, Fitness $121, News/Magazines $15, Gifts $2.68) doesn't appear in "Remaining $417."
3. **Snapshot, not projection.** At pace 42% (mid-month), the +$417 reflects "headroom right now." A linear EOM projection of the non-rent spend extrapolates to ~$9,161 EOM spending against $5,125 real budget = **−$4,036 actual deficit** — which is consistent with the Net worth panel's −$2,193/mo net flow assumption.

The headline tells a "you're fine" story; the projection chart tells a "you'll go negative in 2 months" story. Both are technically correct in their framing but the headline framing is the more dangerous one.

## Cross-panel verification

Spot-checked Cash flow, Overview, Trends — all 0 a11y violations, 0 console errors, render correctly with the new rent reclassification:

- **Overview**: Money in 90D $25,463, Money out 90D −$27,729, Net 90D −$2,266 (≈ −$755/mo using all inflows). Recurring monthly $586. Setup checklist 4/6 complete.
- **Trends**: Rent/Mortgage now correctly shows as 29.1% / $9,485 across 6 months — the FU-2 recategorization flowed cross-panel as intended. Top movers: Parking/Tolls ≥+200%, Online ≥+200%, Groceries +182%.
- **Cash flow**: renders cleanly.

## Top 5 unlocks for next session (priority order)

1. **Fix the +$417 headline inconsistency** (3 sub-bugs above). Biggest Trust unlock. Push score to 99.7+.
2. **Budget-at-a-glance redesign** (user explicitly asked next). Biggest UX leverage — the panel needs to drive monthly financial decisions.
3. **Mobile parity for Sprint H additions** (Top-5, MoM chips, Savings, dual-income headline). Currently web-only.
4. **End-of-month projection in the headline** instead of mid-month snapshot. Same fix as #1 + a pace-aware extrapolation.
5. **Reconcile Overview "Money out 90D" with Budgets "Monthly net flow"** so both panels tell the same story. Currently differ by $1,400+/mo due to all-inflows vs recurring-only definitions.

## Audit method

Backend smoke (rollup endpoint, /api/transactions filter, /api/goals create) + live browser inspection of Budgets, Overview, Cash flow, Trends + axe-core 4.10 a11y scan on each. Net worth, FIRE projection, Savings & goals, Subscriptions, Holdings, HSA receipts, Card applications, Shopping patterns, Product catalog, Merchants, Card offers, Class actions, Redress, Unclaimed property, Card benefits, Yield optimization, Cross-store deals, Money found, Today's moves, Attribution, Credit — assumed unchanged from prior 98.7 audit (no code touched those panels this session).
