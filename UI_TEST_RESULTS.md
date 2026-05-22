# Finance App — UI test pass — 2026-04-27

I drove the §4 walkthrough from your Chrome via the Chrome MCP, against
your live `uvicorn` + Vite servers. This is the punchlist. All severities
are mine, not yours — push back on anything that disagrees with your
priorities.

## TL;DR

- **Three real migration bugs** that prevented the app from running at
  all on your existing `finance.db` (created in Phase A). I patched all
  three; details below. **Restart `uvicorn`** to be sure migrations re-run
  cleanly on next boot — they ran on auto-reload during the test, but a
  fresh boot is cheap insurance.
- **Six UI / engine quality findings** across panels — from
  false-positive subscriptions to a math inconsistency on Trends. None
  of them block daily use, but they're real bugs.
- **Every panel rendered.** The architecture is solid; what's wrong is
  in the seams, not the bones.

---

## Bugs I FIXED during the test (verify on next boot)

### 1. `accounts.plaid_item_id` / `accounts.plaid_account_id` missing from auto-migrator
**Severity:** Critical — `GET /api/accounts` returned 500 every time.
**Root cause:** Phase 2 added the Plaid columns to the `Account` model
but `_COLUMN_ADDITIONS` in `db/migrations.py` was never updated. Fresh
DBs got the columns via `create_all`; existing DBs created in Phase A
did not. SQLAlchemy's SELECT then exploded with `no such column:
plaid_item_id`.
**Fix:** Added both columns to `_COLUMN_ADDITIONS`. After auto-reload,
`/api/accounts` returns `[]` cleanly.
**Followup:** Index on `plaid_account_id` is still missing (SQLite
ALTER can't add UNIQUE in one shot). Low priority — only matters if you
ever sync many Plaid accounts; add a `_POST_ADDITION_INDEXES` mechanism
when you next touch the migrator.

### 2. `budgets.month_start` missing — every budget endpoint 500'd
**Severity:** Critical — Budgets panel completely non-functional.
**Root cause:** The Budget refactor from `(year, month)` ints to
`month_start: date` (task #38) updated the model but never updated the
auto-migrator. Existing rows still had only year/month; new code's
`SELECT ... WHERE month_start = ...` blew up.
**Fix:** Added `("budgets", "month_start", "DATE")` to
`_COLUMN_ADDITIONS` plus a `_POST_ADD_BACKFILLS` entry that runs
`UPDATE budgets SET month_start = printf('%04d-%02d-01', year, month)`
to migrate any pre-existing rows.

### 3. `INSERT INTO budgets` fails with `NOT NULL constraint failed: budgets.year`
**Severity:** Critical — even after #2 fix, creating a budget still
failed because the legacy `year`/`month` columns are still NOT NULL
in the existing DB schema.
**Root cause:** SQLite can't relax NOT NULL on an existing column
without a full table rebuild. The model dropped year/month so SQLAlchemy
never wrote them; the DB still demanded them.
**Fix:** Re-added `year` and `month` to the `Budget` model as nullable,
plus a `before_insert/before_update` event listener that derives them
from `month_start` automatically. Mirrors the pattern already used for
`legal_claims.proof_required`. The application code never reads these
columns — they exist purely to keep the DB constraint happy.
**Files touched:** `db/migrations.py`, `db/models.py` (Budget class +
`_sync_budget_year_month` listener after the existing
`_sync_proof_required` one).

---

## UI / engine findings (NOT fixed — over to you)

### 4. Recurring · monthly card on Overview shows a NEGATIVE figure in red
**Severity:** Cosmetic but confusing.
**What I saw:** The card shows `-$1,964.85` in red, with subtitle
`0 confirmed · 4 to review · 11 categories`. The other 90d cards
follow a positive-number-with-red-color convention (Money Out 90d shows
`$9,129.03` in red, not `-$9,129.03`); the Recurring card breaks that
convention by also showing the minus sign.
**Why:** `/api/subscriptions/stats` returns `monthly_cost_cents:
-196485` (signed, since outflows are stored negative). The frontend
prints the value as-is.
**Fix idea:** In `App.tsx` (or wherever the snapshot card renders),
display `Math.abs(cents)` and let the red color carry the outflow
signal — same as the other three cards. Also revisit the subtitle:
`11 categories` doesn't match the 5 distinct subscription types the API
returns; probably you meant something else by "categories" but the count
is off.

### 5. Subscription detector has at least 4 false positives in the seed data
**Severity:** Real product issue — these are exactly the kind of false
positives a user would lose trust over.
**What I saw:** The detector flagged as "subscriptions":
- `RENT APT` at 87% confidence (4× monthly $1,500 — technically
  recurring but clearly not a subscription)
- `CHEVRON` at 86% (4× monthly gas fillups)
- `SHELL GAS STATION` at 86% (same)
- `HOG ISLAND OYSTER` at 73% (two visits a month apart)

So 4 of 9 detected subs are noise.
**Fix ideas:**
- **Add a category-based exclusion:** if a transaction's category is
  `housing.rent_mortgage`, `transport.gas`, or `food.restaurants`,
  don't propose it as a subscription. The detector already runs after
  categorization — it just isn't using the result.
- **Boost the amount-coefficient-of-variation threshold** for
  variable-amount detection: gas at $52, $48, $54, $49 has a CV that
  passes the current 8% strict threshold but reasonable people wouldn't
  call it recurring.
- The 73% Hog Island case is harder to filter without category help —
  maybe require ≥3 occurrences before promoting from "suspected" to
  "active". Currently 2× is enough.

### 6. Salary appears as a row in "Unbudgeted spending"
**Severity:** Minor — visually odd but doesn't cause damage.
**What I saw:** On Budgets, the "Unbudgeted spending" list includes a
`Salary` row at $0.00. Income categories shouldn't appear in the
"spending" rollup at all.
**Fix idea:** In `api/budgets.py` rollup query, filter the categories
list to those with `kind != "income"` (or whatever the field is named).

### 7. Trends panel: `Avg` and `vs avg %` use different denominators
**Severity:** Real math bug — users will catch this and lose trust.
**What I saw:** For Delivery the API returns `avg_outflow_cents=8760`
(across all 6 months including the two zero months pre-data) AND
`trend_pct_vs_avg=147.2`. But the % is computed against a 5-month
trailing average (excluding the latest month: `(0+0+10460+9700+15010)/5
= 7034 → 147.2%`). So the panel **shows** an Avg of $87.60 but **bases
the +147.2%** on a different number ($70.34) the user can't see.
**Fix idea:** Pick one denominator and use it consistently. I'd
recommend trailing average (excluding current) for both display and
percentage — that's the more intuitive "vs your normal" framing. Then
display the chosen avg in the card.

### 8. Categorization rules miss several common merchants
**Severity:** Polish.
**What I saw:** In the seed I planted:
- `SHELL GAS STATION` → Uncategorized (Chevron caught fine)
- `TARTINE BAKERY` → Uncategorized
- `HOG ISLAND OYSTER` → Uncategorized
- `APPLE STORE` → Uncategorized
- `REI` → Uncategorized
- `UBER EATS` → Delivery ✓ (caught)

The Uncategorized total is $1,585.50 — about 17% of total outflow over
90d. That's enough to make the Trends and Budgets panels noisy.
**Fix idea:** Add Shell Oil, Shell Gas, regional bakery patterns,
specialty restaurants, big-box retailers (REI, Costco, Apple Store) to
the rule set in `categorization/rules.yml` (or wherever the rules live).

### 9. (Possibly) Plaid 12h auto-refresh is overdue
**Severity:** Cosmetic.
**What I saw:** Bank Connections panel header says "auto-refresh every
12h · next Apr 27, 5:23 PM". Today is Apr 27, current time is past 4
PM — so the next refresh is ~75 minutes out. This is fine; just noting
that if the scheduler hasn't fired in a while you may have stale
"next" timestamps. Not a bug per se.

---

## What rendered cleanly (no findings)

- Overview snapshot cards (Money in/out/net 90d). ✓
- Budgets panel — rollup, pace bar (105.8% of budget vs 90% of month
  → over), templates, unbudgeted spending list. After fixes 1-3 the
  whole flow works. ✓
- Phase D Savings — surplus card shows $2,366.44 for both 30d windows,
  Suggestions section with all three empty states (allocate / cancel
  / debt) shown correctly, "+ New goal" button visible. ✓
- Credit panel — 3 score cards, utilization table with Sapphire Visa
  at 0.0% (you haven't logged a balance yet), Score history form. ✓
- Trends — bar chart, top-3 swing cards, sparklines per category.
  Visually polished; only the math behind `vs avg` is suspect.
- Class-action settlements — empty (no rows yet), endpoints work.
- Bank Connections — Plaid configured (sandbox), "Connect a bank"
  + "Sandbox quick-connect" buttons render. Empty list as expected.
- Gmail — `configured=true, authorized=true, deps_installed=true`,
  shows "500 fetched · 2 parsed · 0 failed · last sync Apr 24 12:49 AM",
  PARSED tab shows 2 Xfinity bill rows ($-71.37 each). ✓
- Recent Transactions — 88 rows, dates/categories/amounts render
  correctly, "Run categorization" + "API docs" header. ✓
- Subscriptions panel — 4 stat cards, 15 filter tabs with counts,
  per-row Confirm / Set type / Cancelled / Dismiss buttons, confidence
  % badges. Only the false-positive issue (#5) is a real concern.

---

## What I did NOT cover

- **Plaid Link sandbox flow** — would have required clicking through
  the Link modal; can come back to this in a focused pass.
- **Gmail re-sync end-to-end** — didn't trigger a fresh sync (would
  hit live Google APIs).
- **Class-action scraper "Run scraper" button** — would hit live
  `topclassactions.com` / `classaction.org`. Can do in a focused pass.
- **Cross-cutting cache-invalidation check** (TESTING.md §5) —
  worth doing once you sit down with the live UI yourself, since it's
  hard to verify "snappy update" via screenshots.
- **Browser DevTools console sweep** — Chrome MCP can read console
  messages and I queried for explicit errors only; broader sweep
  pending.

---

## Recommendation on next steps

1. **Restart uvicorn** so migrations re-run on a clean boot. Should be
   silent (no "added columns ..." line) since I already triggered them
   via auto-reload.
2. **Fix #4 (Recurring card sign convention)** — 5 minutes, big quality
   win. Same for #6 (Salary in unbudgeted list).
3. **Fix #5 (subscription false positives)** — most impactful product
   improvement on this list. The category-exclusion idea is the smallest
   change for the biggest win. Maybe a 30-minute fix.
4. **Fix #7 (Trends math)** — silently corrupting user trust. Pick a
   single denominator and use it consistently.
5. **Categorization gaps (#8)** — keep a running list of patterns to
   add as you encounter real merchants from your real bank data.
6. The mobile / iPhone work (tasks #74–#78) is still queued from before
   we pivoted to testing — pick that up whenever.
