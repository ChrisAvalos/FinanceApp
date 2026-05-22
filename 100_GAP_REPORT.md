# 100/100 gap report — what's missing to ship

**Methodology:** Walked the live app via browser automation and probed every panel's endpoint. Captured what's broken, what's empty, and what would feel "world-class." Severity: 🔴 broken / data-correctness / blocks usefulness, 🟡 paper-cut, 🔵 nice-to-have.

## Headline finding (the real 100/100 gap)

**The biggest gap isn't UX — it's first-run priming.** Most panels look wireframe-empty not because the code is wrong, but because the detectors and scrapers that produce their data have never been run on this database. Of 20 endpoints I probed, only 1 returned populated data:

| Endpoint | Items | Why empty |
|---|---|---|
| `/api/money-on-table/report` | 25 ✅ | Aggregator runs on read |
| `/api/heatmap/daily?days=90` | 90 days, 66 with spend ✅ | Computed on read |
| `/api/subscriptions` | 0 → 1 after `POST /detect` | Detector hasn't run on Plaid data |
| `/api/anomaly` | 0 | Detector hasn't run |
| `/api/shopping-patterns` | 0 | Detector needs receipts (none uploaded) |
| `/api/portfolio` (holdings) | 0 | Plaid investments not approved |
| `/api/card-benefits` | 0 rows | Plaid named the card "CREDIT CARD" — unmatched |
| `/api/yield-opt` | 0 suggestions | No HYSA observations to compare |
| `/api/redress` | empty | CFPB / state-AG scrape never ran |
| `/api/unclaimed` | 0 | NAUPA scrape never ran |
| `/api/legal-claims` | 0 | TopClassActions scrape never ran |
| `/api/notifications` | 0 | Nothing to notify about yet |
| `/api/offers` | 0 | Chase Offers / Amex scrape never ran |
| `/api/card-applications` | 0 | User hasn't logged any |
| `/api/receipts` | 0 | User hasn't uploaded any |
| `/api/deals` | 0 | Price scrapers never ran |
| `/api/canonical-products` | 0 | No receipts → no products |
| `/api/goals` | 0 | User hasn't set any |

**Reach 100/100 by:** add a "First-time setup wizard" or a "Prime everything" button on Overview that fires every detector + scraper in order, OR auto-fire each panel's detector on first view (with cached results), OR have the scheduler do it on the FIRST tick after install.

## 🔴 Broken / data-correctness

### 1. Categories table was empty on this DB → categorization silently failed for everything (FIXED this session)
**Evidence:** `/api/categories` returned `[]`. Without categories, seed rules loaded with `category_id=null`, and the engine's first run tagged 340 rows with `source=rule, category_id=null` — locking them out of `only_unset=True` re-runs.

**Fix shipped:**
- `backend/finance_app/api/main.py`: lifespan now calls `ensure_categories()` + `load_seed_rules()` on startup if the categories table is empty. Idempotent.
- `backend/finance_app/api/categories.py`: added `POST /api/categories/seed` so we can re-prime an existing DB without restart.
- Ran the new endpoint against your live DB — 50 categories + 335 rules now populated, 340 rows categorized.

**Verify on next backend restart:** the lifespan log should print `[startup-seed] populated categories + seed rules (50 categories)` if any future fresh DB ever exists.

### 2. Subscription detector hasn't been run against Plaid history
**Evidence:** Overview hero shows `RECURRING · MONTHLY $0.00 — 0 confirmed`, Cash Flow shows only paychecks (no Netflix/internet/etc.), Subscriptions panel empty. After I called `POST /api/subscriptions/detect` it found 1.

**Fix:** wire `subscription_detector.detect_all()` into the Plaid post-sync hook (same pattern I used for categorization) OR add a "Run detection" button to the Subscriptions panel that surfaces.

### 3. Anomaly detector hasn't been run; route name unclear
**Evidence:** `POST /api/anomaly/detect` 404. The previous test session showed "duplicate Zelle" anomalies, so anomalies are computed somewhere. Need to check whether they're computed on read or require a separate run.

**Fix:** confirm route, run it post-sync, or compute on read.

### 4. Card-benefits: Chase card matches by account name = "CREDIT CARD"
**Evidence:** Plaid returned `CREDIT CARD` as the account name; the benefits matcher needs "Sapphire Reserve" to map to the catalog. `unmatched_card_ids: 0` in the API but the panel title still says "1 card unmatched" — a stale-cache issue and the matcher is silently giving up.

**Fix:** add a "what card is this?" picker on the Connections panel that lets you choose from the catalog by name; OR match by Plaid account mask `0483` against a hardcoded map of well-known card last-4s if the user maintains one.

## 🟡 Paper-cuts

### 5. Overview: "Run categorization" button is duplicated on Overview AND Transactions
Same button, two places. If both panels mount it, click on one doesn't refresh the other (different React Query cache keys).
**Fix:** put it only on Transactions, or have both share a single mutation that invalidates `["transactions"]` and `["stats"]`.

### 6. Net worth panel: Δ 30D / Δ 1Y are blank with no explanation
"Take snapshot" exists but a first-time user sees `—` with no hint that snapshots accumulate over time.
**Fix:** when zero history, swap `—` for a soft "First snapshot — comparisons appear after 30 days."

### 7. Net-worth chart with a single snapshot looks broken
Just a diagonal line because there's only 1-2 data points.
**Fix:** when `snapshots.length < 3`, hide the chart and show a callout: "Daily snapshots accumulate over time. Come back tomorrow."

### 8. Budgets: hero is $0 / $0 / $0 / $592 because no budgets set
Audit item #14 — already noted. Recommended fix:
**Fix:** when `budgeted_total === 0`, replace the 4-card hero with a single big CTA card: "Set up your first budget. Copy from Apr 26 / Fill from 3-mo average / Build from scratch."

### 9. Tax export: untagged outflow is huge ($64K of $56K total outflow looks wrong)
Confusing because untagged outflow > total outflow. Likely double-counting transfers as outflow once and as untagged-outflow again.
**Fix:** clarify denominator (this is "uncategorized + non-tax-mapped"), or filter transfers from the untagged total.

### 10. Trends: monthly outflow chart is just numbers, no bars
The "TOTAL OUTFLOW PER MONTH" card shows "$0 / $1K / $15K / $20K / $18K / $592" but no actual bars to visualize the swing.
**Fix:** the bars exist conceptually — make sure they render. Currently I only see month labels and amounts on a horizontal axis line.

### 11. Attribution: empty months (Aug-Dec 2025) clutter the list
Audit item #13 — already noted. 6 months of "no snapshot · cash flow: $0" rows.
**Fix:** when `delta_cents === null && cash_flow_cents === 0 && top_categories.length === 0`, hide; collapse to "5 earlier months had no activity" footer.

### 12. Cash flow forecast doesn't include subscriptions or bills
Only paychecks show in events because subscription detector hasn't run. After detector runs, those events should populate.
**Fix:** depends on #2. Once subscriptions are detected, this fills automatically.

### 13. Connections panel: user can't tell Plaid which products were granted
Holdings empty state says "if Plaid investments granted" but there's no way to view per-Item which products are actually authorized — confusing when investments aren't showing.
**Fix:** Connections panel should display a row per product (Transactions / Liabilities / Investments / Auth) per Item with a "granted ✓ / pending" indicator from Plaid's `accounts:get` `subtype` data.

### 14. Top untagged categories on Tax export still includes "Transfer" and "Credit Card Payment"
These shouldn't surface as "untagged" — they ARE categorized, just not into a tax bucket. The label is misleading.
**Fix:** rename to "Categorized but not tax-mapped" OR auto-add Transfer + Credit Card Payment to a hardcoded "non-deductible" tax bucket.

## 🔵 Nice-to-have

### 15. POS DEBIT prefix gap in seed rules
98 of 200 transactions are still "Uncategorized" because Plaid's raw description format `POS DEBIT FOODMAXX #422 SANTA CLARA CA 0108` isn't matched by rules that look for `FOODMAXX`. The `_rule_matches` function does concatenate `description_raw + description_clean`, but obvious chains like FOODMAXX, MOVEMENT (climbing gym), TROJAN STORAGE, JAKESOFWILLOWGLEN, DILIGENT FINANCIAL are missing from seed_rules.yaml.
**Fix:** add ~30 patterns to `categorization/seed_rules.yaml` covering the top uncategorized merchants for your spending pattern. I can produce the diff in a follow-up.

### 16. Notifications panel never has anything because no scheduled job is producing them
The infrastructure exists; nothing is writing to the notifications table during a normal session.
**Fix:** ensure the scheduler is running and producing notifications for new transactions over a threshold, anomalies, subscription price changes, etc.

### 17. Goals panel CTA after "no goals" is hidden
**Fix:** big "Set your first goal — emergency fund / down payment / car" wizard CTA when goals.length === 0.

### 18. Receipts is empty until user uploads — UX should sell the value
Empty state should pitch the Money on Table benefit (HSA receipt vault, coupon detection, recurring purchase analysis).

### 19. Sidebar `Money on ta…` truncation
Audit cross-cutting #5 — already noted. Either widen sidebar or shorten label to "Money found".

### 20. Sidebar badges are stale
"Today's moves $3.8K" and "Money on ta… $5.1K" probably haven't refreshed since the categorization fix; the actual numbers may have changed.
**Fix:** ensure the badge query refetches when the underlying data invalidates.

## What's working well (don't change)

- Sidebar nav + grouping + section labels
- Real Plaid data flowing into Net Worth + Transactions + Cash Flow paychecks
- Categorization now lights up the Transactions panel cleanly (Trader Joe's → Groceries, 7-Eleven → Gas, etc.)
- Tax export year defaults to current calendar year (2026) — wave-1 fix landed
- Trends panel "% through month" annotation — wave-1 fix landed
- Credit utilization absolute-value display — wave-1 fix landed
- Shopping patterns "Combined avg/month" relabel — wave-1 fix landed
- EmptyState component shipped to Holdings + Benefits + Cash flow
- Attribution panel (no more 500)
- FIRE projection mode toggle + SWR slider + pinned-year picker (browser-tested previously)
- Daily Moves queue + Recently actioned + Undo flow
- Money on Table (only panel that's "lit" out of the box)

## Recommended fix order

1. ✅ **DONE this session** — Categories + seed rules autoseed at startup + force-categorize backfill
2. **Subscriptions detector** wired into Plaid post-sync (#2) — lights up Cash Flow + Overview hero + Subscriptions panel together
3. **Empty-month collapse** on Attribution (#11) + **single-snapshot guard** on Net Worth (#7) + **first-budget CTA** on Budgets (#8) — the three "this looks dead" panels become approachable in one wave
4. **Add 30 POS DEBIT patterns** to seed_rules.yaml (#15) — closes the 102/200 still-uncategorized rows
5. **Run-everything orchestration** — a single endpoint or button that fires anomaly + subscription + shopping-patterns + deals + free-trials detectors + the legal-claims / redress / unclaimed / offers scrapers in sequence. Surface as "Find money on the table" on Overview. This is what makes the app feel "100/100" out of the box.
6. **Card-benefits matcher** (#4) — manual picker on Connections panel
7. **Tax export untagged math** (#9) — fix the >100% display
8. **Net-worth comparison empty-state copy** (#6) + **chart guard** (#7)

## Numbers to revisit

- 200 transactions, 102 categorized, 98 still Uncategorized → fixable with #15
- 20 panels probed via API, 19 empty → fixable with #5 (orchestration)
- 1 confirmed bug fix shipped this session (categories autoseed)
- 1 new endpoint shipped (`POST /api/categories/seed`)
- 1 backend lifespan change (idempotent first-run seed)
