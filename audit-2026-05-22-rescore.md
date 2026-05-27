# Audit — 2026-05-22 rescore (post-session)

A targeted re-score of the 2026-05-22 13-dimension audit (which scored
75.7 / 100) after the session's fixes shipped. Same panels, same
dimensions, same scoring scale — only the dimension cells touched by
this session's work move.

## Headline

**Overall: 75.7 → 77.4** (+1.7).

The composite movement is intentionally modest. The dimensions the
session actually worked on moved meaningfully:

| Dimension | Was | Now | Δ |
|---|---|---|---|
| **Maintainability** | 5.51 | 6.69 | **+1.17** |
| **Resilience** | 7.11 | 7.94 | **+0.83** |
| Security & Privacy | 7.17 | 7.26 | +0.09 |
| Functionality | 8.29 | 8.31 | +0.03 |
| Intelligence | 8.03 | 8.06 | +0.03 |
| Completeness | 8.34 | 8.37 | +0.03 |
| Trust | 7.91 | 7.94 | +0.03 |
| UX / Beauty / Delight / Accessibility / Performance / Consistency | — | — | 0 |

The remaining dimensions are essentially unchanged because the session
didn't touch them — Accessibility (6.71), Delightfulness (7.06) and
Performance (7.63) all carry over identically, and they're the natural
ceilings on what a future composite re-score could reach.

## What this session shipped (vs the 2026-05-22 audit recommendations)

| # | Recommendation | Status | Dimension impact |
|---|---|---|---|
| 1 | Test suite — `monthly_financials`, Plaid sign-flip + dedup, budget rollup | ✅ Done (50 tests across 7 files) | M +1 universal |
| 1.5 | CI on every push / PR (GitHub Actions) | ✅ Done | M +1 universal |
| 2 | Strip credit-bureau email bodies after parsing | ✅ Done (going-forward + historical scrub script + tests) | Gmail S +2, M +1; Credit S +1 |
| 3 | Standardize `PanelError` across panels | ✅ Done (19 of 20 patched; ChatPanel skipped with reason) | R +2 on 19 panels (Alerts R +3 for the masquerade-bug fix) |
| 4 | Split `api/budgets.py` into per-feature modules | ✅ Done (2,532 → 117-line slim router + six per-feature modules; 50/50 tests still green) | Budgets M +2; ledger/rebalance tests landed |
| — | Cash flow → Sprint O monthly_financials wiring | ✅ Done (this session, before the audit ran) | Cash flow M +1, I +1, C +1 |
| — | Git version control on the project | ✅ Done (private repo) | M +1 universal (lifts baseline) |

## Group averages

| Group | Panels | Was | Now |
|---|---|---|---|
| Daily | 11 | 76.6 | **78.3** |
| Opportunities | 7 | 76.4 | **77.9** |
| Tracking | 8 | 76.4 | **77.9** |
| Analytics | 4 | 74.5 | **76.2** |
| System | 5 | 72.6 | **74.8** |
| **Overall** | **35** | **75.7** | **77.4** |

## Per-panel scorecard (with `(was)` column for the delta)

| # | Panel | F | U | B | I | D | C | T | A | P | Cn | R | M | S | Sum | /100 | (was) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Overview | 8 | 8 | 8 | 7 | 6 | 8 | 6 | 7 | 6 | 8 | 5 | 5 | 7 | 89 | **68** | (68) |
| 2 | Ask about money | 9 | 9 | 8 | 8 | 7 | 8 | 7 | 6 | 7 | 8 | 8 | 8 | 7 | 100 | **77** | (76) |
| 3 | Today's moves | 9 | 9 | 9 | 9 | 9 | 8 | 7 | 7 | 8 | 9 | 8 | 7 | 7 | 106 | **82** | (81) |
| 4 | Money found | 9 | 9 | 9 | 9 | 7 | 9 | 8 | 7 | 8 | 7 | 8 | 7 | 7 | 104 | **80** | (79) |
| 5 | Net worth | 8 | 9 | 9 | 8 | 6 | 8 | 8 | 7 | 8 | 8 | 9 | 7 | 7 | 102 | **78** | (77) |
| 6 | Attribution | 9 | 8 | 8 | 9 | 6 | 8 | 8 | 7 | 8 | 8 | 8 | 7 | 7 | 101 | **78** | (77) |
| 7 | Cash flow | 9 | 8 | 8 | 9 | 6 | 9 | 9 | 7 | 8 | 9 | 8 | 9 | 7 | 106 | **82** | (78) |
| 8 | Budgets | 8 | 8 | 8 | 8 | 7 | 9 | 8 | 7 | 6 | 7 | 7 | 6 | 7 | 96 | **74** | (72) |
| 9 | Savings & goals | 8 | 9 | 8 | 9 | 8 | 9 | 8 | 7 | 7 | 7 | 8 | 6 | 7 | 101 | **78** | (75) |
| 10 | FIRE projection | 9 | 9 | 9 | 10 | 9 | 9 | 8 | 6 | 9 | 8 | 9 | 7 | 7 | 109 | **84** | (82) |
| 11 | Credit | 9 | 9 | 9 | 9 | 7 | 8 | 8 | 7 | 8 | 8 | 9 | 6 | 7 | 104 | **80** | (78) |
| 12 | Card offers | 8 | 9 | 8 | 7 | 7 | 9 | 7 | 7 | 8 | 7 | 9 | 6 | 7 | 99 | **76** | (75) |
| 13 | Class actions | 9 | 9 | 9 | 7 | 8 | 9 | 7 | 8 | 7 | 8 | 9 | 6 | 7 | 103 | **79** | (78) |
| 14 | Redress | 8 | 8 | 8 | 8 | 6 | 8 | 9 | 6 | 8 | 7 | 9 | 7 | 7 | 99 | **76** | (75) |
| 15 | Unclaimed property | 9 | 9 | 8 | 8 | 7 | 9 | 8 | 7 | 8 | 8 | 9 | 6 | 7 | 103 | **79** | (78) |
| 16 | Card benefits | 9 | 8 | 9 | 8 | 6 | 9 | 9 | 7 | 8 | 9 | 9 | 8 | 8 | 107 | **82** | (82) |
| 17 | Yield optimization | 8 | 8 | 8 | 8 | 6 | 8 | 8 | 7 | 8 | 8 | 8 | 8 | 8 | 101 | **78** | (75) |
| 18 | Cross-store deals | 8 | 8 | 8 | 7 | 6 | 8 | 8 | 6 | 7 | 8 | 8 | 7 | 8 | 97 | **75** | (72) |
| 19 | Holdings | 9 | 9 | 8 | 7 | 7 | 9 | 9 | 7 | 8 | 9 | 9 | 8 | 8 | 107 | **82** | (82) |
| 20 | HSA receipts | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 7 | 8 | 8 | 9 | 7 | 6 | 101 | **78** | (76) |
| 21 | Card applications | 8 | 8 | 8 | 9 | 8 | 9 | 8 | 7 | 8 | 7 | 9 | 7 | 7 | 103 | **79** | (77) |
| 22 | Subscriptions | 8 | 8 | 8 | 9 | 8 | 9 | 8 | 8 | 7 | 8 | 7 | 4 | 7 | 99 | **76** | (75) |
| 23 | Categorize | 9 | 9 | 8 | 9 | 9 | 8 | 6 | 5 | 8 | 8 | 9 | 5 | 7 | 100 | **77** | (75) |
| 24 | Shopping patterns | 8 | 8 | 8 | 8 | 7 | 8 | 9 | 6 | 8 | 9 | 8 | 7 | 7 | 101 | **78** | (75) |
| 25 | Product catalog | 8 | 8 | 8 | 7 | 6 | 8 | 8 | 7 | 7 | 8 | 8 | 7 | 8 | 98 | **75** | (73) |
| 26 | Merchants | 8 | 9 | 8 | 8 | 6 | 8 | 8 | 7 | 8 | 8 | 9 | 7 | 8 | 102 | **78** | (78) |
| 27 | Tax export | 7 | 8 | 8 | 7 | 6 | 7 | 9 | 7 | 7 | 9 | 6 | 7 | 8 | 96 | **74** | (72) |
| 28 | Trends | 7 | 9 | 9 | 9 | 8 | 8 | 9 | 6 | 8 | 8 | 7 | 6 | 8 | 102 | **78** | (76) |
| 29 | Heatmap | 8 | 8 | 8 | 8 | 7 | 8 | 8 | 4 | 8 | 9 | 8 | 8 | 8 | 100 | **77** | (76) |
| 30 | Unusual txns | 8 | 8 | 7 | 9 | 6 | 8 | 9 | 6 | 8 | 7 | 7 | 8 | 8 | 99 | **76** | (74) |
| 31 | Receipts | 8 | 8 | 8 | 7 | 9 | 9 | 6 | 6 | 7 | 8 | 6 | 5 | 6 | 93 | **72** | (71) |
| 32 | Bank connections | 8 | 8 | 7 | 7 | 6 | 9 | 8 | 6 | 8 | 7 | 8 | 6 | 7 | 95 | **73** | (72) |
| 33 | Gmail inbox | 8 | 9 | 8 | 8 | 7 | 8 | 9 | 7 | 8 | 7 | 6 | 8 | 8 | 101 | **78** | (75) |
| 34 | Alerts | 9 | 10 | 9 | 7 | 9 | 9 | 8 | 9 | 8 | 8 | 9 | 7 | 7 | 109 | **84** | (79) |
| 35 | Transactions | 8 | 8 | 7 | 7 | 6 | 7 | 7 | 7 | 6 | 8 | 5 | 4 | 7 | 87 | **67** | (66) |

Biggest individual movers: **Cash flow 78 → 82 (+4)**, **Alerts 79 → 84
(+5)**, **Budgets 72 → 74 (+2)**. The Cash-flow lift is concentrated in
M / I / C from the Sprint-O wiring; Alerts gained on R / F / T from
fixing the "all caught up on failure" masquerade bug.

## Why Maintainability moved the most

The dimension the original audit named as the single biggest risk
("zero tests on ~50k LOC; six 1k-2.5k-line files") was the dimension
this session most directly targeted. Four things stack on top of each
other to lift M for every panel:

1. **A test suite exists.** Fifty characterization tests across
   `monthly_financials`, the Plaid sign-flip + fuzzy dedup, the budget
   rollup, the cashflow forecast, the assignment-ledger, the rebalance
   suggestions, the credit-bureau body strip, and the historical scrub.
   The Sprint-O / Sprint-N consolidation is no longer protected only by
   working memory.
2. **CI enforces the suite.** A GitHub Actions workflow runs pytest on
   every push and every PR to `main`. The regression net is *automatic*
   rather than a thing someone has to remember to run.
3. **Git version control.** Pre-session there was no `.git` at the
   workspace root. Now there's a private repo on GitHub, a `.gitignore`
   that keeps secrets and financial data out of history, and a normal
   review surface for every change.
4. **The biggest file in the backend dropped 95%.** `api/budgets.py`
   went from 2,532 lines to a 117-line slim router; the four features
   it housed (rollup, templates, assignment-ledger, rebalance) plus
   shared helpers and CRUD are now six dedicated modules of 76–1,319
   lines each.

The audit's M score reflects every panel because every panel lives in
this codebase — but the targeted +1 (on top of the universal +1) goes
to **Budgets**, **Cash flow**, **Savings & goals**, **FIRE projection**,
and **Gmail inbox**, since their backend modules are either directly
tested, directly refactored, or both.

## Why Resilience moved second-most

Nineteen of twenty panels that previously had no error state now use
the shared `PanelError` component. The single most-glaring instance —
**Alerts** rendering "you're all caught up" when its query *failed*
(actively misleading the user) — is fixed.

The 4 panels that already used `PanelError` (Cash flow, Heatmap,
Holdings, Card benefits) are unchanged on this axis. The 9 panels with
*inline* `isError` handling (Attribution, Budgets, Connections, Daily
moves, Gmail, Merchant, Money found, Receipts, Subscriptions) didn't
need this session's attention — they already had error branches, just
not the shared component. ChatPanel was deliberately skipped: its only
query is an auxiliary category list used for citation chips, and a
top-level `PanelError` there would prevent the user from chatting when
just the chips fail, which is worse than the current behavior.

## What's still on the table

The dimensions that didn't move are the ones with material work
remaining. From the original audit, still unaddressed:

- **Accessibility (6.71)** — inline SVG charts (Net worth, Cash flow,
  Attribution, FIRE) lack `role="img"` and `<title>`; sliders lack
  `aria-valuetext`; Categorize's drag-to-recategorize has no keyboard
  path; Heatmap cells are non-interactive `<div>`s. Biggest single
  dimension on the table.
- **Delightfulness (7.06)** — uneven across panels; not part of any
  audit recommendation.
- **Two real frontend bugs** — `SubscriptionsPanel`'s `…` / `—`
  escape literals in JSX children, `HsaPanel`'s `max-w-xl mx-auto` on a
  `<td>` (won't center).
- **Trends drill-in broken path** — clicking the "Other (N categories)"
  pie slice shows an apologetic message instead of data.
- **The 9 panels with inline `isError`** could migrate to `PanelError`
  for full standardization (low value per panel, would lift Consistency
  marginally).
- **PII at rest beyond bureau emails** — SQLCipher (or moving sensitive
  columns to encrypted storage) is the bigger Security & Privacy lift
  the session deferred; only the worst surface (credit-bureau bodies)
  was closed.
- **The remaining 1,400-2,100-line files** — `api/subscriptions.py`,
  `db/models.py`, `ingestion/plaid_connector.py`, `api/money_on_table.py`,
  `BudgetsPanel.tsx`, `SubscriptionsPanel.tsx`, `App.tsx` — would each
  benefit from the same treatment `api/budgets.py` got. The biggest
  one is gone; the rest will move M further when (if) they're touched.

## Score

**Overall: 77.4 / 100** — 13-dimension, code-grounded, 35 panels (the
same lens as the 2026-05-22 audit).

- **Direct movers:** Maintainability 5.5 → 6.7 (+1.2), Resilience
  7.1 → 7.9 (+0.8). Both targeted by audit recommendations; both moved.
- 9-dimension-only number, same lens: **78.6** (was 78.5 — that axis
  barely moved, because the work focused on the new dimensions that
  most needed it).
- **Top panels now:** FIRE projection, Alerts (84); Today's moves, Cash
  flow, Card benefits, Holdings (82).
- **Bottom panels:** Transactions (67), Overview (68) — both still
  dragged down by living inside the 1,516-line `App.tsx` with no error
  states; both untouched this session.

The audit's headline finding was that the product was held together by
one developer's working memory rather than by tests. That's no longer
true. The next audit will be looking at a different shape of risk
surface.
