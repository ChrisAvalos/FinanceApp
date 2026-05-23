# Audit — 2026-05-22 (comprehensive, 13-dimension)

**Scope:** All 35 panels, full re-score. First audit to add four new dimensions —
**Consistency, Resilience, Maintainability, Security & Privacy** — alongside the
original nine. (The app has grown to 35 panels; "Categorize" is new since the
2026-05-14 audit's 34.)

**Method:** This is a **code-grounded** audit. Unlike the 2026-05-14 audit
(browser-verified spot-checks with baseline carry-over), the app was not run
interactively. Every score is grounded in reading source across the ~50k-line
backend and ~33k-line frontend, plus executing backend logic in a sandbox to
verify real figures. Four parallel deep-read passes covered the panel groups and
the backend's cross-cutting concerns.

**Reading the headline number.** This audit scores **75.7 / 100**, against 93.1
on 2026-05-14. **The app did not regress.** The lens changed, in two ways:

1. A code-grounded read sees what browser spot-checks cannot — zero automated
   test coverage, missing error states, 2,500-line files. Scoring *only the
   original 9 dimensions* with this stricter lens gives **78.5** — that gap from
   93.1 is method, not regression.
2. The four new dimensions pull the composite down, Maintainability (5.5/10)
   most of all.

Treat 75.7 as a new, harder, more honest baseline.

## The 13 dimensions

| Key | Dimension | What it measures |
|---|---|---|
| F | Functionality | Works end-to-end without errors |
| U | UX | Easy to navigate / understand at a glance |
| B | Beauty | Visual quality, hierarchy, typography |
| I | Intelligence | Strength of inferences / derivations |
| D | Delightfulness | Animation, micro-copy, surprise |
| C | Completeness | Coverage vs. what the panel claims |
| T | Trust | Source citations, staleness flags, math transparency |
| A | Accessibility | Keyboard, semantic HTML, focus, ARIA |
| P | Performance | Speed of first paint + interaction |
| Cn | **Consistency** | Same quantity shown as the same number everywhere |
| R | **Resilience** | Error / loading / empty states, graceful degradation |
| M | **Maintainability** | File size, duplication, dead code, test coverage |
| S | **Security & Privacy** | Secret handling, sensitive-data exposure |

Panel score = sum of the 13 dimension scores / 130 x 100.

## Group averages

| Group | Panels | Avg score |
|---|---|---|
| Daily | 11 | 76.6 |
| Opportunities | 7 | 76.4 |
| Tracking | 8 | 76.4 |
| Analytics | 4 | 74.5 |
| System | 5 | 72.6 |
| **Overall** | **35** | **75.7** |

## Per-panel scorecard

| # | Panel | F | U | B | I | D | C | T | A | P | Cn | R | M | S | Sum | /100 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Overview | 8 | 8 | 8 | 7 | 6 | 8 | 6 | 7 | 6 | 8 | 5 | 4 | 7 | 88 | **68** |
| 2 | Ask about money | 9 | 9 | 8 | 8 | 7 | 8 | 7 | 6 | 7 | 8 | 8 | 7 | 7 | 99 | **76** |
| 3 | Today's moves | 9 | 9 | 9 | 9 | 9 | 8 | 7 | 7 | 8 | 9 | 8 | 6 | 7 | 105 | **81** |
| 4 | Money found | 9 | 9 | 9 | 9 | 7 | 9 | 8 | 7 | 8 | 7 | 8 | 6 | 7 | 103 | **79** |
| 5 | Net worth | 8 | 9 | 9 | 8 | 6 | 8 | 8 | 7 | 8 | 8 | 8 | 6 | 7 | 100 | **77** |
| 6 | Attribution | 9 | 8 | 8 | 9 | 6 | 8 | 8 | 7 | 8 | 8 | 8 | 6 | 7 | 100 | **77** |
| 7 | Cash flow | 9 | 8 | 8 | 8 | 6 | 8 | 9 | 7 | 8 | 9 | 8 | 7 | 7 | 102 | **78** |
| 8 | Budgets | 8 | 8 | 8 | 8 | 7 | 9 | 8 | 7 | 6 | 7 | 7 | 3 | 7 | 93 | **72** |
| 9 | Savings & goals | 8 | 9 | 8 | 9 | 8 | 9 | 8 | 7 | 7 | 7 | 6 | 4 | 7 | 97 | **75** |
| 10 | FIRE projection | 9 | 9 | 9 | 10 | 9 | 9 | 8 | 6 | 9 | 8 | 8 | 5 | 7 | 106 | **82** |
| 11 | Credit | 9 | 9 | 9 | 9 | 7 | 8 | 8 | 7 | 8 | 8 | 8 | 5 | 6 | 101 | **78** |
| 12 | Card offers | 8 | 9 | 8 | 7 | 7 | 9 | 7 | 7 | 8 | 7 | 8 | 5 | 7 | 97 | **75** |
| 13 | Class actions | 9 | 9 | 9 | 7 | 8 | 9 | 7 | 8 | 7 | 8 | 8 | 5 | 7 | 101 | **78** |
| 14 | Redress | 8 | 8 | 8 | 8 | 6 | 8 | 9 | 6 | 8 | 7 | 8 | 6 | 7 | 97 | **75** |
| 15 | Unclaimed property | 9 | 9 | 8 | 8 | 7 | 9 | 8 | 7 | 8 | 8 | 9 | 5 | 7 | 102 | **78** |
| 16 | Card benefits | 9 | 8 | 9 | 8 | 6 | 9 | 9 | 7 | 8 | 9 | 9 | 7 | 8 | 106 | **82** |
| 17 | Yield optimization | 8 | 8 | 8 | 8 | 6 | 8 | 8 | 7 | 8 | 8 | 6 | 7 | 8 | 98 | **75** |
| 18 | Cross-store deals | 8 | 8 | 8 | 7 | 6 | 8 | 8 | 6 | 7 | 8 | 6 | 6 | 8 | 94 | **72** |
| 19 | Holdings | 9 | 9 | 8 | 7 | 7 | 9 | 9 | 7 | 8 | 9 | 9 | 7 | 8 | 106 | **82** |
| 20 | HSA receipts | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 7 | 8 | 8 | 8 | 6 | 6 | 99 | **76** |
| 21 | Card applications | 8 | 8 | 8 | 9 | 8 | 9 | 8 | 7 | 8 | 7 | 7 | 6 | 7 | 100 | **77** |
| 22 | Subscriptions | 8 | 8 | 8 | 9 | 8 | 9 | 8 | 8 | 7 | 8 | 7 | 3 | 7 | 98 | **75** |
| 23 | Categorize | 9 | 9 | 8 | 9 | 9 | 8 | 6 | 5 | 8 | 8 | 8 | 4 | 7 | 98 | **75** |
| 24 | Shopping patterns | 8 | 8 | 8 | 8 | 7 | 8 | 9 | 6 | 8 | 9 | 6 | 6 | 7 | 98 | **75** |
| 25 | Product catalog | 8 | 8 | 8 | 7 | 6 | 8 | 8 | 7 | 7 | 8 | 6 | 6 | 8 | 95 | **73** |
| 26 | Merchants | 8 | 9 | 8 | 8 | 6 | 8 | 8 | 7 | 8 | 8 | 9 | 6 | 8 | 101 | **78** |
| 27 | Tax export | 7 | 8 | 8 | 7 | 6 | 7 | 9 | 7 | 7 | 9 | 4 | 6 | 8 | 93 | **72** |
| 28 | Trends | 7 | 9 | 9 | 9 | 8 | 8 | 9 | 6 | 8 | 8 | 5 | 5 | 8 | 99 | **76** |
| 29 | Heatmap | 8 | 8 | 8 | 8 | 7 | 8 | 8 | 4 | 8 | 9 | 8 | 7 | 8 | 99 | **76** |
| 30 | Unusual txns | 8 | 8 | 7 | 9 | 6 | 8 | 9 | 6 | 8 | 7 | 5 | 7 | 8 | 96 | **74** |
| 31 | Receipts | 8 | 8 | 8 | 7 | 9 | 9 | 6 | 6 | 7 | 8 | 6 | 4 | 6 | 92 | **71** |
| 32 | Bank connections | 8 | 8 | 7 | 7 | 6 | 9 | 8 | 6 | 8 | 7 | 8 | 5 | 7 | 94 | **72** |
| 33 | Gmail inbox | 8 | 9 | 8 | 8 | 7 | 8 | 9 | 7 | 8 | 7 | 6 | 6 | 6 | 97 | **75** |
| 34 | Alerts | 8 | 10 | 9 | 7 | 9 | 9 | 7 | 9 | 8 | 8 | 6 | 6 | 7 | 103 | **79** |
| 35 | Transactions | 8 | 8 | 7 | 7 | 6 | 7 | 7 | 7 | 6 | 8 | 5 | 3 | 7 | 86 | **66** |

Top: FIRE projection, Card benefits, Holdings (82). Bottom: Transactions (66),
Overview (68) — both pulled down by living inside the 1,516-line `App.tsx` with
no error states.

## Dimension averages (app-wide, /10)

| Dim | Avg | Note |
|---|---|---|
| UX | 8.5 | Strongest axis. Consistent shell, shared components, clear empty states. |
| Completeness | 8.3 | Panels deliver what they claim; few stubs. |
| Functionality | 8.3 | Works end-to-end; a few broken edge paths (see Issues). |
| Beauty | 8.2 | Cohesive visual system, good hierarchy. |
| Intelligence | 8.0 | FIRE Monte Carlo, attribution decomposition, anomaly baselines. |
| Consistency | 7.9 | Sprint O/N consolidation largely succeeded; one residual gap. |
| Trust | 7.9 | Strong staleness chips + math footnotes; a few soft-derivation fibs. |
| Performance | 7.6 | Lazy-fetch + memoization; a couple of over-broad refetches. |
| Resilience | 7.1 | Backend strong (8); frontend uneven — most panels lack error states. |
| Delightfulness | 7.1 | Good micro-copy; animation/surprise uneven across panels. |
| Accessibility | 6.7 | Charts visual-only; drag interactions keyboard-inaccessible. |
| Security & Privacy | 7.2 | Secrets handled well; PII unencrypted at rest drags it down. |
| **Maintainability** | **5.5** | **Lowest. Zero tests on ~50k LOC; six 1k-2.5k-line files.** |

## The four new dimensions

### Consistency — 7.9

The Sprint O / Sprint N consolidation worked. `budgets/monthly_financials.py` is
now the single source for monthly income and outflow, and `enrichment/` the
single source for transaction classification. The consumers verifiably read from
them — `api/budgets.py`, `budgets/projector.py`, `api/fire.py`, `api/recurring.py`
and `cashflow/service.py` all import `monthly_financials`. The "$7,240 vs
$7,159 on the same page" class of bug that motivated Sprint O is closed for the
Budgets / ledger / projection / FIRE surfaces. `fmtCents` is the universal money
formatter on the frontend, so dollar rendering doesn't drift.

Residual drift risk: (1) `cashflow/service.py`'s paycheck projection still selects
income by the `income.salary` category slug rather than the canonical `is_payroll`
heuristic — an uncategorized paycheck is invisible to the cash-flow forecast but
counted by the rollup. (2) `api/recurring.py` re-implements its own bill-cadence
detection instead of reusing the subscription detector. (3) Frontend: the
`categorize` section key is wired into the nav and router but is missing from the
`SectionKey` type union in `App.tsx` — runtime-fine, type-unsafe.

### Resilience — 7.1

Split verdict. **Backend: 8/10** — genuinely battle-tested. Plaid sync has real
retry-with-backoff that distinguishes transient from permanent errors; every
sub-step (accounts, liabilities, investments, categorization) is individually
wrapped so one failure can't tank the rest; `sync_all` isolates per-institution;
the scheduler wraps every job so a Playwright crash can't kill the daemon; balance
scrapers separate "auth missing" from genuine failure. No swallowed errors of
consequence (260 `except` clauses, none doing `except: pass` destructively).

**Frontend: weak.** Only 4 of 33 panels use the shared `PanelError` component
(Cash flow, Heatmap, Holdings, Card benefits). Roughly 20 panels have no error
branch at all — a failed query degrades to `$0` stat cards, a blank section, or
worse: a failed Notifications fetch renders the "you're all caught up" empty state,
actively miscommunicating.

### Maintainability — 5.5 (lowest dimension)

Two structural problems outweigh otherwise clean, well-commented code.

**Effectively zero automated tests on ~50k lines of money-handling backend.**
Confirmed: no `test_*.py` anywhere in the project; only `scripts/smoke_test.py`
(a happy-path end-to-end script). `pyproject.toml` declares pytest but there is
nothing to run. Sign-flip conventions, the Plaid fuzzy-dedup that can silently
merge two distinct transactions, effective-month payroll bucketing, catchall
exclusions — none are protected. The Sprint O/N consolidation itself shipped
without characterization tests.

**Oversized files.** Backend: `api/budgets.py` 2,532 lines (four features —
rollup, assignment-ledger, rebalance, templates — in one router), `db/models.py`
2,104, `api/subscriptions.py` 1,643, `ingestion/plaid_connector.py` 1,431,
`api/money_on_table.py` 1,411, `api/schemas.py` 1,034. Frontend: `api/client.ts`
3,495, `BudgetsPanel.tsx` 2,082, `SubscriptionsPanel.tsx` 1,744, `App.tsx` 1,516.
`schemas.py`'s `BudgetRollupResponse` has ~50 fields accreted across sprints, many
overlapping (`monthly_income_cents`, `recurring_income_cents`,
`month_income_landed_cents`, `month_income_expected_total_cents`...). The code is
legible today only because of dense sprint-history comments.

### Security & Privacy — 7.2

Secrets handling is sound. `config.py` uses `pydantic-settings` with `.env`;
every secret defaults to empty rather than a hardcoded value; nothing real is in
source. No token is ever logged. The Plaid `access_token` is stored server-side
and deliberately omitted from the `PlaidItemOut` response schema. The Gmail OAuth
token file is written `chmod 600` and the scope is pinned read-only. The frontend
exposes no secrets anywhere.

What drags it down is **PII at rest**. `gmail/connector.py` persists full email
bodies (up to 50KB) for every *parsed* message — and Experian / Equifax /
TransUnion / SmartCredit parsers exist, so full credit-report plaintext sits in
an **unencrypted** `finance.db`, which is then copied verbatim into `backend/backups/`
with 60-day retention. SQLite is unencrypted by default (`config.py` mentions
SQLCipher only as optional). This is the same exposure class as the scraped
SmartCredit dashboard that was found in git history earlier this session (now
mitigated: `.debug/` git-ignored and untracked).

## Verified by running code

- The cash-flow forecast runs end-to-end against the live DB; this session's
  variable-spend wiring produces realistic running balances and working
  crunch-day detection (30-day projection went from a fantasy ~$9,240 to ~$2,235).
- `monthly_financials` produces single canonical figures — income $7,240
  expected-total / $7,159 recurring-average, real outflow $7,423/mo — and the
  five consumer modules verifiably import it.

## Issues

### High impact

1. **No automated test suite (~50k LOC, money-handling).** The single biggest
   liability. Every refactor of the 2,500-line files is unprotected; the
   consistency consolidation is exactly the kind of change that needs
   characterization tests and has none.
2. **Unencrypted PII at rest.** Full credit-bureau email bodies in plaintext
   `finance.db`, copied to `backups/` for 60 days. Either strip/truncate report
   bodies after parsing (as is already done for ignored marketing mail) or make
   SQLCipher the default.

### Medium impact

3. **~20 panels have no error state.** A failed query renders `$0`/blank;
   Notifications failure masquerades as "all caught up." Standardize on
   `PanelError`.
4. **`api/budgets.py` is 2,532 lines / four features in one router.** Highest-
   churn file in the app; split rollup / ledger / rebalance / templates.
5. **Two real frontend bugs.** `SubscriptionsPanel.tsx`'s manual-add form has
   literal `…` / `—` escape text in JSX children (renders as raw text,
   not ellipsis/em-dash). `HsaPanel.tsx`'s empty state puts `max-w-xl mx-auto` on
   a `<td>`, which won't center.
6. **Trends drill-in broken path.** Clicking the "Other (N categories)" or
   uncategorized pie slice sends an ID the transaction matcher can't resolve; the
   table shows an apologetic message instead of data — shipped broken.
7. **`cashflow/service.py` paycheck projection bypasses `compute_month_income`** —
   the last Sprint O consistency gap.
8. **`categorization/engine.py` silent failures** — `except: pass` at three sites
   with no logging; a degraded categorizer is invisible.
9. **Delete-UX inconsistency.** Redress, Unclaimed, Shopping patterns, Bank
   connections, and Notifications' "clear read" still use blocking
   `window.confirm()`; other panels migrated to undo-toast / two-click. A
   half-finished migration.

### Polish

10. **Budgets dead code** — a shipped `{false && (...)}` block (~lines 1707-1795,
    the old 5-card headline) that never renders; delete it.
11. **Accessibility** — inline SVG charts (Net worth, Cash flow, Attribution, FIRE)
    are visual-only with no `role="img"`/`<title>`; sliders lack `aria-valuetext`;
    Categorize's drag-to-recategorize has no keyboard path; Heatmap cells are
    non-interactive `<div>`s.
12. **Stale `.js` siblings** of `.tsx` components checked into `web/src/` — dead
    build artifacts; git-ignore and remove.
13. **Overview's keyless `qc.invalidateQueries()`** refetches every query in the
    app after categorize/prime; scope it.
14. **Third-party leak** — `LegalClaimsPanel` fetches Clearbit logos, sending
    company names off-device.
15. **Stale "Coming next" copy** on Receipts and Tax for features that already
    shipped.

## What changed since 2026-05-14

- Sprints L / N / O shipped: zero-based assignment ledger, the `enrichment`
  classification consolidation, and the `monthly_financials` consistency module.
- This session: the cash-flow forecast now subtracts everyday variable spending
  (wired into Sprint O's `monthly_financials`); git version control was
  established (private repo, `.gitignore` covering secrets + financial data);
  "Categorize" is counted as the 35th panel.
- Method change: this audit is code-grounded and adds four dimensions — the score
  is on a stricter scale than the 2026-05-14 number and is not comparable directly.

## Recommended next moves

1. **Stand up a test suite.** Characterization tests first — `monthly_financials`,
   the Plaid sign-flip + fuzzy-dedup, the budget rollup. Highest leverage in the
   codebase; every other improvement is risky without it.
2. **Encrypt PII at rest.** Strip credit-bureau report bodies after parsing, or
   make SQLCipher the default DB driver. Closes the largest remaining privacy hole.
3. **Standardize error states.** Adopt `PanelError` across all ~35 panels — the
   single highest-leverage Resilience fix, and it lifts ~20 panels at once.
4. **Split `api/budgets.py`** into rollup / ledger / rebalance / template modules
   while there is sprint context to do it safely (ideally after step 1).

## Score

**Overall: 75.7 / 100** — 13-dimension, code-grounded, 35 panels.

- Original 9 dimensions only, same lens: **78.5** (vs 93.1 browser-verified on
  2026-05-14 — the gap is method, not regression).
- Strongest dimensions: UX 8.5, Completeness 8.3, Functionality 8.3.
- Weakest: Maintainability 5.5, Accessibility 6.7, Delightfulness/Resilience 7.1.
- Strongest panels: FIRE projection, Card benefits, Holdings (82).
- Weakest panels: Transactions (66), Overview (68).

The product is feature-rich, intelligent, and visually coherent — and it is held
together by one developer's working memory rather than by tests. The headline
risk is not any single panel; it is that ~50k lines of money logic have no
regression net. Fix that first.
