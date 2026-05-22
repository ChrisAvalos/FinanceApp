# 100/100 polish audit — punchlist

**Methodology:** Walked all 32 panels via Chrome MCP. Captured screenshots, console errors, network 4xx/5xx, layout/copy issues. Severity: 🔴 broken / data integrity, 🟡 paper-cut, 🔵 nice-to-have.

## 🔴 Broken / data integrity

### 1. Categorization not running on Plaid-imported transactions
**Evidence:** Transactions panel shows ALL 200 transactions as "Uncategorized" — including obvious matches like 7-Eleven, Trader Joe's, Target, FoodMaxx, Tickets. Trends panel confirms — only one row, "(uncategorized)", with $20K+ monthly outflow. 200+ categorization rules exist but aren't being applied to Plaid-fed rows.

**Likely cause:** Categorization engine runs on `description_clean` only, but Plaid stores rows with raw descriptions like "POS DEBIT TROJAN STORAGE OF SAN J" in `description_raw`. Either: (a) the description-cleaning step isn't running on the Plaid path, or (b) the rules need to also match against `description_raw`.

**Impact:** Cascades into Budgets (everything is "Unbudgeted spending"), Trends ((uncategorized) is the only row), Tax export ($0 buckets), Money on table (kind-by-category aggregations are off), Attribution top-categories drill-in.

**Fix:** Audit the Plaid sync path in `plaid_connector.py` — confirm `description_clean` is populated, and the categorization engine fires post-ingest. The "Run categorization" button on the Transactions panel might need to be clicked once to backfill.

### 2. Duplicate Zelle transactions
**Evidence:** Anomaly panel shows the same Zelle payment to Valeria Briseo appearing 2× — same date (3/1/2026), same amount (-$2,300), same external_id (JPM99c7igjhe). Same pattern for 2/1/2026 (-$2,075 JPM99c457po3 2×) and 3/30/2026 (-$2,075 JPM99cbah8px 2×).

**Likely cause:** Plaid returns Zelle transactions on both sides of the transfer (the originating account + the bill-pay account), each with its own external_id but conceptually the same outflow. Our dedup is keyed on `(source, external_id, account_id)` — they have different account_ids and the IDs differ slightly so they pass dedup.

**Fix:** Add a Zelle-specific dedup pass that catches same-date / same-amount / same-counterparty pairs across accounts, OR detect transfer pairs and net them like the attribution module does.

### 3. Holdings empty state leaks API implementation details
**Evidence:** "No holdings yet. POST /api/securities and /api/holdings to add manual entries…" — this exposes raw API endpoints to a non-developer user.

**Fix:** Replace with a UI-only CTA: "Add holdings manually" button that opens a form, plus a "Plaid investments will populate this when granted" note.

## 🟡 Paper-cuts

### 4. Tax export defaults to 2025
**Evidence:** Year selector defaults to 2025 but we're in May 2026; user has to manually select 2026 to see anything.
**Fix:** Default to current calendar year, fall back to most recent year with data.

### 5. Trends panel May vs avg not partial-month-normalized
**Evidence:** May 2026 shows -94.7% vs trailing avg ($592 vs $11,209). May is only 10% through; comparing partial-month against full-month average is misleading.
**Fix:** Either (a) annotate "10% through month" on the comparison, (b) prorate the trailing avg, or (c) hide the % when current month is < N% complete.

### 6. Shopping patterns "Monthly merchant spend" label is wrong
**Evidence:** Card shows "$160,648.84 — Sum across tracked merchants" labeled "MONTHLY MERCHANT SPEND". That's a 12-month sum.
**Fix:** Rename to "12-MO MERCHANT SPEND" or divide by 12 and call it monthly.

### 7. Card benefits can't match Chase card by name
**Evidence:** "1 card(s) unmatched" — Plaid named the account "CREDIT CARD", benefits matcher needs "Sapphire Reserve" or similar.
**Fix:** Add a manual "what card is this?" picker on the Connections panel; OR match against MASKed digits to a known-cards catalog.

### 8. Credit utilization live balance shown as negative
**Evidence:** "$-1,174.11 of $5,000.00" in the utilization bar label. Sign conveys nothing useful in this context — utilization is by definition a positive ratio.
**Fix:** `Math.abs()` for the displayed balance string in CreditPanel's utilization row (already done for the percentage).

### 9. Cash flow has no forecast events; empty state needs CTA
**Evidence:** STARTING BALANCE $2,561.89 / FORECAST EVENTS 0 / PAYCHECK CADENCE — / CRUNCH DAYS 0 — totally flat chart, "Upcoming events (0)" empty state has no CTA.
**Fix:** When forecast events == 0, surface a CTA: "Run subscription detection (Subscriptions panel) to populate forecast events."

### 10. Merchants panel has no suggested merchants
**Evidence:** Just an empty search box. User has to type the exact uppercase string from a transaction.
**Fix:** Below the search, list "Top 10 merchants by spend (last 90 days)" as clickable chips — derived from the same data the chat tool uses.

### 11. Cross-store deals scrapers all need auth, no clear next step
**Evidence:** All 5 stores (Walmart/Target/Costco/Amazon Fresh/Kroger) show "needs auth" badges. No CTA explaining how to bootstrap.
**Fix:** Add "How to bootstrap auth" expandable note linking to the README section, OR a button that opens a guided flow.

### 12. Attribution: May 2026 partial-month bars very small
**Evidence:** Only $592 of spending so far in May; the bars are 5-10 pixels wide and hard to see next to closed months ($15-21K).
**Fix:** Either (a) accept it visually (small is honest), or (b) add a "current month" tag and use a separate partial-progress visual.

### 13. Attribution: empty months (Dec/Nov 2025) clutter the list
**Evidence:** Months with no transactions still show with "no snapshot · cash flow: $0".
**Fix:** Hide rows where delta is null AND cash flow is 0 AND no top categories — collapse to a "5 earlier months had no activity" footer.

### 14. Budgets hero stats are flat $0 when no budgets are set
**Evidence:** BUDGETED $0 / SPENT $0 / REMAINING $0 / UNBUDGETED SPEND $592.02 — first three feel dead.
**Fix:** When BUDGETED == 0, swap the hero for a one-card prominent CTA: "Set up your first budget — Copy from Apr 26 / Fill from 3-mo average".

## 🔵 Nice-to-have

### 15. Heatmap day-cell interactivity
Day cells could show day-total + top txn on hover or click. Currently static.

### 16. FIRE pinned-year picker not URL-persisted
F5 resets to default Gaussian, no pinned year. Stress-test setup is lost.
**Fix:** Encode mode + pinned year + assumption overrides in the URL hash so deep-links survive reloads.

### 17. Ask AI auto-submits — no preview
The contextual prompt prefills AND auto-submits. Some users will want to tweak the question before sending.
**Fix:** Either (a) prefill but don't auto-submit (user hits Enter), or (b) keep auto-submit but show a brief "you asked: …" preview with a "rephrase" affordance.

## Cross-cutting findings

- **Empty states are inconsistent.** Some are tasteful + actionable (Class actions, Yield optimization, Cross-store deals). Some are wireframe-y with raw API hints (Holdings). A shared `<EmptyState title icon ctaLabel ctaHref>` component would unify them.
- **Loading states vary.** Some panels show "Loading…" text, some show spinners, some show nothing. Pick one.
- **No consistent error state pattern.** Different panels handle 5xx differently — some show error text, some stay loading forever. Need a shared `<PanelError>` component.
- **Panels with "Refresh" button vary in placement** — top-right vs bottom vs not-present-at-all. Should standardize.
- **Sidebar `Money on ta…` truncation** — full label "Money on table" gets ellipsis-cut because of the badge. Either widen sidebar or shorten label.

## What's working well

- Sidebar nav + grouping + badges (the new ones from this session)
- Chase real data flowing into Net Worth panel
- Yield optimization panel (production-quality copy + data)
- Class actions panel (Settlemate-inspired UX is clean)
- Redress panel (matched-against-spend callout is great)
- Anomaly detection (the σ-based explanations are excellent — once we fix the dup issue)
- Heatmap visualization
- Daily Moves queue + Recently actioned + Undo flow
- FIRE projection with mode toggle + SWR + pinned year
- Attribution panel (now that it's not 500ing)

## Status

- Audit complete: 32 panels visited, ~17 distinct issues identified
- 3 🔴 broken/data items (categorization, dup Zelle txns, Holdings copy leak)
- 11 🟡 paper-cuts
- 3 🔵 nice-to-haves

**Recommended fix order:**
1. ✅ Categorization on Plaid path (Issue #1) — biggest leverage, fixes 5+ downstream panels
2. ✅ Holdings empty state copy (Issue #3) — trivial, removes implementation leak
3. ✅ Tax year default (Issue #4) — trivial, big UX win on a yearly cadence
4. ✅ Credit live-balance abs (Issue #8) — already half-done; finish the symmetry
5. ✅ Shopping-patterns label (Issue #6) — trivial wording fix
6. ✅ Trends partial-month annotation (Issue #5) — small but high-trust impact
7. ⏳ Shared `<EmptyState>` component — built. Adopted by Holdings + Benefits + Cash flow's events block. Remaining panels (Card offers, Class actions empty bucket states, Subscriptions, Receipts, Notifications, Card applications, Unclaimed) still on their own ad-hoc empty states; can be migrated incrementally without behavior change.
8. ⏸ Zelle dedup (Issue #2) — needs investigation against live DB. Suspected cause: same Plaid transaction_id appearing in two account_ids (originator vs counterparty), bypassing the `(source, external_id, account_id)` unique key. Fix path: add a post-sync "transfer pair" detector that catches same-date / same-amount / matching-description pairs across accounts and merges them.

## Wave 1 fixes shipped

Edits this session:

- `backend/finance_app/ingestion/plaid_connector.py`: call `CategorizationEngine.categorize_all()` at end of `sync_transactions`. Wrapped in try/except so a categorization failure can't tank a sync.
- `web/src/HoldingsPanel.tsx`: replaced API-instruction empty state with a real explanation pointing to Connections.
- `web/src/TaxPanel.tsx`: default year is now `getFullYear()` instead of `getFullYear() - 1`.
- `web/src/CreditPanel.tsx`: utilization bar label now `Math.abs(balance)`, so "$1,174.11" instead of "−$1,174.11".
- `web/src/ShoppingPatternsPanel.tsx`: relabeled "Monthly merchant spend" → "Combined avg/month" with a clarifying sublabel about sum-of-averages.
- `web/src/TrendsPanel.tsx`: added `pctThroughCurrentMonth()` helper and surfaced the % to both the Latest table header and the topSwings cards.
- `web/src/components/EmptyState.tsx`: NEW shared component with three variants (default/hint/waiting) and href-or-onClick CTA support.
- `web/src/HoldingsPanel.tsx`, `web/src/BenefitsPanel.tsx`, `web/src/CashFlowPanel.tsx`: adopt the shared component / improve empty-state copy.

## To verify after backend hot-reloads

- Visit Transactions, click "Run categorization" once. Confirm the 200 existing rows take their proper categories.
- Re-load Trends. Should now show real categories instead of one (uncategorized) row, and the May 26 row should annotate "X% of month".
- Tax export should default to 2026 with real numbers.
- Credit utilization should read `$1,174.11 of $5,000.00` (positive).
- Shopping patterns should say "Combined avg/month" with the clarifying sublabel.
- Holdings should show the new emoji-headed empty state.
