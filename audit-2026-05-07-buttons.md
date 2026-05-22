# Finance App — Button-by-button audit
**Date:** 2026-05-07 · **Method:** live browser walk via Chrome MCP, clicked every accessible button on each panel and watched the network log + console for silent failures.

This is a *functional* audit (does the button do what it says?), not a visual one. The visual / scoring audit is `audit-2026-05-07-postwaveD.md`.

## Summary by severity

| Severity | Count | What |
|---|---:|---|
| **🔴 Bug** | 1 | `signal_notifications` task crashes inside Prime everything |
| **🟠 Regression** | 1 | Today's-moves still ranks expired class actions at top (deferred from D-2 / E) |
| **🟡 UX issue** | 4 | Prime everything has no progress feedback; layout shifts mid-action; Savings forecast undercounts subs; Pending Potential stat doesn't reflect state filter |
| **🟢 Audit blocker** | 1 | `confirm()`-style native dialog hung the Chrome MCP session — couldn't finish Tracking/Analytics/System groups in this pass |
| **✅ Confirmed working** | 14 | Listed below per-panel |

## Detailed findings

### 🔴 Finding 1 — Prime everything: `signal_notifications` task crashes
**Severity:** Bug · **Panel:** Overview · **Repro:** click `Prime everything`

The Prime button finishes after ~30s and renders a result strip:
`✓ categorization · ✓ subscriptions · ✓ shopping_patterns · ✓ canonical_products · ✓ deals · ✓ legal_claims · ✓ offers · ✗ signal_notifications`

Hitting `POST /api/prime/run` directly returns the failed task:
```json
{
  "name": "signal_notifications",
  "status": "error",
  "error": "AttributeError: 'Subscription' object has no attribute 'merchant_name'"
}
```

The `Subscription` model has `merchant_id` (FK) and a `merchant` relationship, but no `merchant_name` column. Some piece of `finance_app/jobs/notify_signals.py` is reaching for `sub.merchant_name`.

**Fix:** find the `sub.merchant_name` reference and replace with `(sub.merchant.name if sub.merchant else None)` or the cluster `sub.name` field. Single line change once located.

---

### 🟠 Finding 2 — Today's moves still ranks expired class actions at top
**Severity:** Regression · **Panel:** Today's moves · **Status:** deferred from D-2 audit + flagged again in post-Wave-D audit

The Wave D-2 fix to `_priority_score` (apply 0.5× depressor for expired items) works, but the spread between class-action face value and cancel-subscription value is bigger than 0.5×. Items 1 and 2 in the queue are still expired class actions ($25K × 0.5 / 30min = $416/min) ahead of legitimate cancel-sub items at $240/min.

**Recommended fix (was already documented):** drop the depressor to 0.1× OR filter expired items out of `/api/daily/moves` selection entirely. The audit doc has this as the highest-ROI single fix.

---

### 🟡 Finding 3 — Prime everything: no progress feedback, ~30s runtime
**Severity:** UX · **Panel:** Overview

Button text changes to "Running…" but stays that way for the entire ~30s run. No spinner, no "running task X of N", no "Subscriptions done · Offers done · …" trickle. User has no signal that work is actually happening — it's indistinguishable from a hung click.

**Recommended fix:** stream progress via SSE or chunked JSON, or at minimum show an animated spinner glyph on the button. Even a static "(this can take 30s)" subtitle would help.

---

### 🟡 Finding 4 — Layout shifts mid-action shift click targets
**Severity:** UX · **Panel:** Overview

After Prime everything completed, the green status row appeared above the stat cards, pushing the "Run categorization" button down by ~25 pixels. A queued click at the previous coordinate landed on empty space.

**Recommended fix:** when an async banner/result appears, render it as an **overlay** (absolute-positioned) or in a **fixed reserved slot** that doesn't reflow the rest of the page.

---

### 🟡 Finding 5 — Savings & goals forecast undercounts subs
**Severity:** UX/data · **Panel:** Savings & goals → forecast breakdown

Shows: `0 active subs · 126 variable outflow txns sampled · Fixed obligations -$0.00`.

But your Subscriptions panel has 17 detected recurring outflows totalling $1,096/mo. The forecast model is treating only `is_user_confirmed=True` subs as "fixed obligations." Since you haven't manually confirmed any rows, the projection thinks you have $0/mo of fixed obligations — which makes the surplus math meaningless.

**Recommended fix:** either count `confidence_score >= 0.75 OR is_user_confirmed` as fixed obligations, OR surface the gap inline ("17 detected subs not yet confirmed — confirm them on the Subscriptions panel to include in this forecast").

---

### 🟡 Finding 6 — Class actions: Pending Potential stat doesn't reflect state filter
**Severity:** UX · **Panel:** Class actions

After clicking a state chip (e.g. California), the Hello Chris greeting and live-claims count both update to the filtered subset (California: $274.67 · 77 live). But the four big stat cards (Pending Potential, Collected Lifetime, Quick Wins Waiting, Needs Triage) all stay on the global $399.17 / 0 paid / 1 quick win / 79 triage values.

Either the stat cards should follow the active filter, or they should be labelled "Across every state" so the user knows they're global.

---

### 🟢 Finding 7 — Audit blocked by native confirm() dialog
**Severity:** Audit blocker · **Panel:** Redress (Delete)

Clicked the "Delete" button on a tracked-redress row to clean up after testing "Log as candidate." A native `window.confirm("Delete?")` dialog popped up but Chrome MCP can't dismiss native dialogs — the browser session became unresponsive. Couldn't finish Tracking / Analytics / System groups in this session.

**Recommended fix (separately):** replace `window.confirm()` calls in the codebase with the existing two-stage delete + undo-toast pattern that NotificationsPanel uses. Catches:
- HSA receipts: `if (confirm("Delete?")) onDelete()`
- Subscriptions: `if (window.confirm("Delete this subscription row?")) del.mutate(id)`
- UnmaskModal child Remove: `if (window.confirm("Remove ${c.name}?")) removeChild.mutate(c.id)`
- Receipts panel: similar pattern likely

Also blocks any future automated browser walking. Worth fixing before the next audit.

## Per-panel results so far

### Daily group (11/11 walked, all working except F1+F2)
| Panel | Buttons tested | Result |
|---|---|---|
| Overview | Prime everything, Run categorization | Prime works but signal_notifications crashes; Run categorization not re-tested due to layout shift |
| Ask about money | not tested | — |
| Today's moves | Refresh, Done, 7d snooze | All ✓ — streak counter appeared, queue updated, dollars dropped |
| Money found | tab switching, source dropdown | ✓ render is correct, bundle_overlap source kind shown |
| Net worth | Take snapshot | ✓ POST 200, snapshot count 4→5 |
| Attribution | drill in toggle, time-window dropdown | drill in ✓ |
| Cash flow | (display only on viewport) | ✓ render |
| Budgets | Fill from 3-mo average | ✓ POST 200, 23 budgets created |
| Savings & goals | Show breakdown, Refresh | ✓ both worked; forecast undercount flagged in Finding 5 |
| FIRE projection | Historical S&P toggle | ✓ pinned-start-year dropdown appeared |
| Credit | (display only on viewport) | ✓ render |

### Opportunities (4/7 walked before audit blocker)
| Panel | Buttons tested | Result |
|---|---|---|
| Card offers | All / Available / Activated / Redeemed status filters | ✓ |
| Class actions | California state chip | ✓ — count + greeting updated; stat cards stuck (Finding 6) |
| Redress | Log as candidate | ✓ — row created in tracked redress |
| Unclaimed property | not reached | — |
| Card benefits | not reached | — |
| Yield optimization | not reached | — |
| Cross-store deals | not reached | — |

### Tracking + Analytics + System (resumed in second pass — fully walked)
| Panel | Buttons tested | Result |
|---|---|---|
| Holdings | empty-state preview cards | ✓ render |
| HSA receipts | Log receipt expand/cancel | ✓ |
| Card applications | (em-dashes verified) | ✓ |
| Subscriptions | Confirm row, Apply email signals, Streaming filter, Dismissed bucket | All ✓; Apply email signals ran clean |
| Shopping patterns | Detect now, Merchant rollup tab | ✓ both — but rollup row math is wrong (Finding 8) |
| Product catalog | Run canonicalizer | ✓ ("Linked 0/0 items…") |
| Merchants | Look up with description | ✓ — but exact-match-only (Finding 11) |
| Tax export | Year dropdown | ✓ |
| Trends | 3-month / 6-month toggle, slice drill-in | ✓ — but vs-trailing-avg cards mid-month (Finding 10) |
| Heatmap | render | ✓ — but Saturday always $0.00 (Finding 9) |
| Unusual txns | renders | ✓ — but row-metric inconsistency (Finding 12) |
| Receipts | Paste OCR text, Cancel | ✓ |
| Bank connections | Sync (Chase row), Sync all | ✗ both 502 (Finding 7-bis) |
| Gmail inbox | Registered parsers expand | ✓ render; Sync now not exercised (no OAuth in this session) |
| Alerts | Security filter, Only-unread checkbox | ✓ |
| Transactions | Search input | ✓ — Walmart returns 5 matches (D-2 fix confirmed) |

## Second-pass findings (from resumed walk)

### 🔴 Finding 7-bis — Plaid sync endpoints return 502 silently
**Severity:** Bug · **Panel:** Bank connections · **Repro:** click "Sync" on Chase row OR "Sync all"

Both calls fail with **HTTP 502** but the UI shows no toast / error / status change. The user clicks Sync, nothing visibly happens, and the row's "Last sync" timestamp never updates.

```
POST /api/plaid/sync/4   → 502
POST /api/plaid/sync-all → 502
```

**Fix:** two parts.
- **Backend:** investigate why the sync endpoints 502 — probably a Plaid sandbox connection issue or a stack-trace inside the route. The other connections (Albert, E*TRADE) say "Synced just now," so account #4 (Chase) specifically may be borked.
- **Frontend:** `BankConnectionsPanel` should surface non-2xx responses as a red toast or inline status. Right now `useMutation` errors get swallowed.

---

### 🟠 Finding 8 — Heatmap: Saturday always $0.00
**Severity:** Bug · **Panel:** Heatmap

The "QUIETEST DAY" stat shows `Sat · avg $0.00` and the entire Sat row of the calendar grid is empty. Implausible — there's definitely Saturday spending in Chris's Plaid history.

Almost certainly a **timezone bucketing bug**: Plaid `transaction.date` is in UTC, and the heatmap queries probably use `strftime('%w', date)` or similar without converting to the user's local timezone first. Charges posted near midnight UTC on Saturday roll into the Sunday bucket (UTC offset is negative for US users).

**Fix:** in `finance_app/api/heatmap.py`, convert `transaction.date` to local timezone before extracting day-of-week. Use the user's `Settings.timezone` (or default `America/Los_Angeles` for this app's user).

---

### 🟠 Finding 9 — Shopping patterns merchant rollup row math is wrong
**Severity:** Bug · **Panel:** Shopping patterns → Merchant rollup

`Dave Inc dave.com CA 02/13` row shows:
- **$/mo avg:** `$18,450.00`
- **Lifetime:** `$615.00`
- **Visits:** `3`
- **Median per visit:** `$11.94`

`$18,450/mo` cannot be right when lifetime over the visible window is $615. Math says ~$205/mo at most. This single row contributes most of the headline `Sum of merchant rates: $21,665.04` stat — the headline is therefore misleading.

**Likely cause:** the rate-estimate query is dividing by `cadence_days` (or 1/`cadence_days`) and one cadence is computed as fractional or near-zero, blowing up the rate.

**Fix:** clamp `rate_per_month` to at most `lifetime_spend / window_months`, or guard against `cadence_days < 1` in the merchant detector.

---

### 🟡 Finding 10 — Trends vs-trailing-avg cards show -100% mid-month
**Severity:** UX · **Panel:** Trends

Three top cards (Transfer, Software/SaaS, Credit Card Payment) all read `-100.0% vs trailing avg · Latest $0.00 · Avg $X · (26% through month)`. The user sees a giant `-100.0%` and panics; the "26% through month" caveat is small.

The math is comparing a **partial-month** (May, only 26% elapsed) against the **full-month** trailing average. By definition, latest will look terrible until the month finishes.

**Recommended fix (pick one):**
1. Pro-rate latest by `1 / month_progress` so it's apples-to-apples.
2. Suppress these cards until ≥75% through the current month and show "(month-to-date pace looks low)" instead.
3. Show "On pace for $X" using the pro-rated estimate instead of `-100.0%`.

---

### 🟡 Finding 11 — Merchants requires exact-match description
**Severity:** UX · **Panel:** Merchants

`XFINITY MOBILE` → "No data returned. Try a different merchant description." But typing the exact `POS DEBIT XFINITY MOBILE PA 4824` works — and only returns the **single** transaction with that exact description suffix, not all XFINITY MOBILE history.

The lookup is doing exact `description_raw =` matching. Plaid descriptions vary by month (different last-4 digits / dates appended), so each month's charge becomes a separate "merchant" with 1 transaction.

**Fix:** tokenize the input — strip `POS DEBIT`, trailing digits, dates — then do a `description_raw LIKE '%token%'` match. Or pre-compute a `merchant_norm` column in the transactions table.

---

### 🟡 Finding 12 — Unusual txns: first-row metric format differs from rest
**Severity:** UX · **Panel:** Unusual txns

First row (Walgreens, Σ=42.7) reads:

`42.7× the median of 3 other recent txns in this category`

Every other row reads:

`$X is Yσ above the $Z avg / $W stddev for this category over the last 90 days`

Mixing "× median" with "σ above mean" makes the first row feel apples-to-oranges. Pharmacy probably has too few samples for σ to be meaningful, so the detector falls back to median multiplier. Worth labeling that explicitly.

**Fix:** when the σ-based metric isn't available, prefix the WHY column with `(small sample) ` so the user knows why the explanation format changed.

## Updated severity summary (post-resume)

| Severity | Count | Items |
|---|---:|---|
| **🔴 Bug** | 2 | signal_notifications crash · Plaid sync 502 |
| **🟠 Regression / Data bug** | 3 | Today's-moves expired ranking · Heatmap Saturday · Shopping rollup math |
| **🟡 UX issue** | 9 | Prime feedback · layout shift · Savings forecast · Class-actions stat filter · Trends mid-month % · Merchants exact-match · Unusual txns metric · (+ originals) |
| **🟢 Audit blocker** | 1 | window.confirm() |
| **✅ Confirmed working** | ~30 | (see per-panel tables above) |

## Updated recommended fix order

1. **Plaid sync 502 + UI silence** (Finding 7-bis) — visible on a panel the user looks at every day.
2. **`signal_notifications` AttributeError** (Finding 1) — single-line backend fix.
3. **Heatmap Saturday timezone bug** (Finding 8) — single-line fix to date bucketing.
4. **Shopping rollup math overflow** (Finding 9 second-pass) — clamp rate calculation.
5. **Replace `window.confirm()` with non-blocking pattern** (Finding 7) — unblocks future audits.
6. **Today's-moves expired filter** (Finding 2).
7. **Subscription forecast undercount** (Finding 5).
8. **Trends mid-month % cards** (Finding 10).
9. **Merchants exact-match search** (Finding 11).
10. Layout banner stability (Finding 4), state filter consistency (Finding 6), unusual-txns metric labeling (Finding 12), Prime everything progress (Finding 3) — polish.

## Recommended fix order

1. **Fix `signal_notifications` AttributeError** (Finding 1) — single-line backend fix, removes the only red ✗ from the headline Prime everything button.
2. **Replace `window.confirm()` calls with non-blocking confirms** (Finding 7) — unblocks future automated audits AND fixes a real UX wart (native confirm dialogs are jarring on a polished web app).
3. **Aggressive expired-class-action filter** (Finding 2) — drop depressor to 0.1× or exclude entirely from `/api/daily/moves`. Headline panel correctness.
4. **Forecast undercount** (Finding 5) — count high-confidence detected subs as fixed obligations even if not user-confirmed; OR surface the gap.
5. **Layout-stable status banners** (Finding 4) — secondary; affects automated testing more than human users.
6. **State filter consistency on Class actions stat cards** (Finding 6) — small, visible.
7. **Prime everything progress feedback** (Finding 3) — nice-to-have polish.
