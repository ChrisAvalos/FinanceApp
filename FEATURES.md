# Finance App — full feature inventory

A complete user-facing feature list, refreshed 2026-04-28 (later in the
day) after **Phase 4.3** (Playwright credit-score scrapers) shipping
and **full mobile parity** (28 of 28 web panels, with a 5-primary +
More-grid tab redesign).

Cross-referenced with [STATUS.md](STATUS.md) (original-vision scorecard) and
[MANUAL_TASKS.md](MANUAL_TASKS.md) (things only Chris can do).

For each feature: ✅ shipped, 🟡 partial, ⏳ planned/deferred, ❌ not built.

---

## 1. Dashboard / Overview

✅ **Money In · 90d card** — sum of all positive transactions, last 90 days.
✅ **Money Out · 90d card** — sum of all negative transactions, last 90 days.
✅ **Net · 90d card** — in − out.
✅ **Recurring · monthly card** — sum of detected active subscriptions, projected to monthly. Subtitle: "X confirmed · Y to review · Z types."

## 2. Budgets

✅ **Monthly per-category budgets** — full CRUD via `/api/budgets`.
✅ **Pace-aware warnings** — fires when burn-rate exceeds calendar-rate, not an arbitrary 80%.
✅ **Copy from prior month** — one-click template; skips categories already set.
✅ **Average from 3-month history** — fills budgets from trailing average.
✅ **Unbudgeted-spending blind-spot list** — categories with spend but no cap. Income categories filtered out.
✅ **Pace projection** — "at this pace you'll land at $750 vs your $500 cap." Linear extrapolation, skipped early-month to avoid noise.
🟡 **Rollover budgets** (YNAB-style carry-forward) — column exists in DB, not yet exposed in rollup.

## 3. Savings & Goals (Phase D)

✅ **Surplus card** — three modes: Last 30d (historical), Next 30d (forecast), Both.
✅ **Goal tracker** — kind / priority / target / current / linked debt account / status.
✅ **Allocation suggestions** — every recommendation includes before/after math.
✅ **Cancellation suggestions** — high-confidence sub-cancel rows ranked by annual savings.
✅ **Debt-payoff strategies** — avalanche + snowball comparison with score-Δ projection.
✅ **Goal milestone notifications** — 50/75/100% one-shot alerts (idempotent).

## 4. Credit (Phases 4.1–4.4)

✅ **Score history** — manual log + Credit Karma sparkline. Per-bureau supported.
✅ **Per-card utilization** — with FICO cliff bars at 1/10/30/50/75%.
✅ **Statement-close-day optimizer** (Phase 4.1) — tier-ladder paydown plan with $-cost / score-Δ per rung.
✅ **CLI opportunity heuristic** (Phase 4.2) — 6-month history check + portal-specific scripts.
✅ **Best-card-for-merchant rewards optimizer** (Phase 4.4) — 11 card profiles, $-leakage report, top-10 misuses.
✅ **Playwright score scrapers** (Phase 4.3) — Credit Karma (TU + EF VantageScore3), Capital One CreditWise (TU VS3), Chase Credit Journey (Experian VS3). Auth-state-file bootstrap pattern shared with offers; daily 3 AM cron via `credit-scores-scrape` APScheduler job; `POST /api/credit/scores/scrape` for on-demand. Per-portal `ScoreSource` enum values (`scraped_credit_karma`, `scraped_creditwise`, `scraped_credit_journey`) keep CK + CW from colliding on the (bureau, model, as_of, source) natural key when both report TU/VS3 the same day.

## 5. Trends & analytics (Phase 7.3 + 9.3 + 9.4)

✅ **Month-over-month comparison** — top-3 swings + sparklines + %-vs-trailing-avg.
✅ **Spending heatmap** (Phase 9.4) — GitHub-style calendar grid; reveals weekend-vs-weekday, payday spikes, dry-run days.
✅ **Anomaly detection** (Phase 9.3) — 3σ outlier flagging with per-category baseline; tiny-category fallback to median × 3.

## 6. Class-action settlements (Phase F + Settlemate redesign)

✅ **Settlement tracker** — manual + scraped, lifecycle (available → claimed → paid → archive).
✅ **3-state proof requirement** — not_required / required / unknown (triage tab).
✅ **Improved proof heuristic** — "up to $X" no longer falsely flags as required; added "documentation is not required" / "self-attested" / "without receipts" patterns.
✅ **TopClassActions scraper** — 6 category indexes + 15 state-specific indexes.
✅ **ClassAction.org scraper**.
✅ **ClassActionRebates scraper** — captures the "no proof" + "quick claim" tag pages explicitly.
✅ **State eligibility extraction** — parser detects "California residents", "FL residents only", multi-state via "and"/comma; defaults to nationwide.
✅ **State filter chips** (Settlemate-inspired) — All / Nationwide / per-state with counts.
✅ **Hero with personalized payout total** — "You've got up to $X in pending payouts."
✅ **"Up to $X" / "TBD" framing** — replaces "$X" / "—".
✅ **Company logos** — via Clearbit's free domain API; falls back to initials.
✅ **"Top matches, ranked"** — best $/day no-proof claims.
✅ **Weekly auto-scrape** (Sunday) + on-demand "Scrape now" button.
✅ **Reclassify script** — re-runs heuristics on existing rows without re-scraping.

## 7. Subscriptions (Phase B + 9.5)

✅ **Detection from transaction patterns** — gap-analysis cadence, amount stability, status by recency.
✅ **Subscription type classifier** — streaming / saas / utilities / etc. (12 types).
✅ **Variable-amount bill detection** — utilities / mortgage with predictable due-day.
✅ **Price-change tracker** — `prior_amount → last_amount` flagged on the row.
✅ **Mid-history price change** — detector splits and re-tries cadence on the post-change window.
✅ **Promo-applier** — Gmail T2 parser pulls price changes / trial expirations / new subs.
✅ **Confirm / dismiss UI** — type-tabbed, confidence-weighted.
✅ **Free-trial → paid conversion alerts** (Phase 9.5).
✅ **Retention playbook** (Phase 5.2) — type-specific tone, leverage points, counter-offer ladder, walkaway line. Outcome log per attempt.

## 8. Cash flow & forecasting (Phase 7.1, 7.2)

✅ **Net-worth tracker** (Phase 7.1) — assets minus liabilities + per-account-type breakdown + 30d/1y deltas + daily NetWorthSnapshot history.
✅ **Cash flow forecast** (Phase 7.2) — rolling 30-day projection. Paycheck cadence + bills + subs + crunch-day flagging.

## 9. Tax (Phase 7.4)

✅ **Annual tax-bucket roll-up** — categorized CSV/JSON for upload to TurboTax / your CPA.
✅ **Untagged-spending list** — categories with spend but no tax bucket mapped.

## 10. Per-merchant deep-dive (Phase 7.5)

✅ **Merchant detail view** — lifetime spend + monthly breakdown bar chart + recent transactions + related sub + matched offers.

## 11. Annual review (Phase 7.6)

✅ **Once-per-year summary** — total spend by category, biggest single purchases, year-over-year deltas, sub adds/removes, score trajectory.

## 12. Money on the Table — Phase 8 (unified dashboard)

✅ **Cohort-tab UX** — Quick wins / Big tickets / Urgent / Triage / All / Needs proof.
✅ **9 source kinds** — see breakdown below.
✅ **"Sources of free money" strip** — every kind always visible, with populate-hint when empty.
✅ **Ranked-by-$/minute opportunity queue** — answers "what's the best 5 minutes I could spend?"
✅ **Cross-source kinds**:
  - ✅ **Class action** (8.x via legal_claims)
  - ✅ **Unclaimed property** (Phase 8.1) — NAUPA / state portal logger + search-tips checklist.
  - ✅ **Card sign-up bonuses + 5/24 tracker** (Phase 8.2).
  - ✅ **Card benefits** (Phase 8.3) — annual-credit gap report by premium card profile.
  - ✅ **Yield-arb** (Phase 8.4) — HYSA/T-bill alternatives ranked by $-delta.
  - ✅ **Regulatory redress** (Phase 8.5) — CFPB/FTC/state-AG catalog matched against transaction history.
  - ✅ **Sub-cancel** — high-confidence detected subs the user hasn't confirmed.
  - ✅ **Bank-bonus catalog** — Chase $300, SoFi $300, Discover $200, etc.
  - ✅ **Brokerage-bonus catalog** — Schwab transfer, Fidelity, Robinhood Gold IRA match.
  - ✅ **Passive-check catalog** — NAUPA, IRS refund tracker, savings bonds, FDIC failed-bank lookup, FTC redress, CFPB redress, USPS undelivered, Amazon price-drop, manufacturer recall, rebate follow-up, gift-card balance recovery, expired warranty payouts.
  - ✅ **Receipt coupons** (Phase 10C) — extracted from receipt OCR text bottom.
  - ✅ **Cross-store deals** (Phase 10D) — items beating the user's typical price by ≥15%.

## 13. Investments (Phase 9.1)

✅ **Holdings tracking** — manual entry of securities + per-account holdings.
✅ **Portfolio rollup** — total value / cost basis / unrealized gain + allocation by security type + top-10.
🟡 **Plaid investments sync** — model is ready, hookup pending.

## 14. HSA receipt bank (Phase 9.2)

✅ **Decades-deferred reimbursement strategy** — log out-of-pocket medical, save receipts, reimburse later when HSA has compounded.
✅ **30yr-at-7% projection** — illustrates compounding trade-off.
✅ **Status lifecycle** — saved / reimbursed / voided.

## 15. Notifications

✅ **In-app inbox** — anomaly scans, goal milestones, daily-digest summaries, free-trial alerts.
✅ **Mark read / mark all read / delete**.

## 16. Bank connections

✅ **Plaid Link flow** — sandbox proven end-to-end.
✅ **Per-Item refresh** — manual + scheduler-driven.
✅ **Transaction sync** + balance snapshots.
🟡 **Plaid production** — approval in hand; activation is `PLAID_ENV=production` + prod secret in `backend/.env` + uvicorn restart, then click Connect Bank.

## 17. Gmail signal extraction (Phase 3 + Phase E)

✅ **18 parsers**:
- T1 bespoke (5): Chase / Credit Karma / Experian / Cap One / financial-alert variants.
- T1 historical (13): score updates, statement-ready, payment-due, large-charge, fraud, balance, deposit, card-shipment, CLI-change, rewards.
- T2 cross-sender (2): financial_alert and subscription_promo.
✅ **T3 Ollama fallback** (Phase 5.4) — local LLM for uncategorized merchants, deterministic by default.

## 18. Daily / weekly automation

✅ **Daily digest email** (Phase 6) — yesterday's spend, anomalies, goal progress.
✅ **Per-Item Plaid refresh** — auto-syncs every N hours per Item.
✅ **Goal milestones** — idempotent 50/75/100% notifications.
✅ **Net-worth daily snapshot** — feeds the history chart.
✅ **Offers scrape** — Chase + Amex weekly.
✅ **Class-action scrape** — Sunday weekly.
✅ **DB backups** — every N hours; configurable retention.
✅ **Local insights narrator** (Phase 5.3) — Ollama-driven weekly digest narrative.

---

## Phase 10 — Shopping intelligence (in this batch)

The 5 slices that turn the app from "track money" into "spend money smarter":

✅ **Slice A — Receipts** (Phase 10A)
- Photo upload (or paste text) → OCR via pytesseract → line-item parser → ReceiptItem rows.
- Editable per-receipt detail view: merchant / date / subtotal / tax / total / line items / raw OCR.
- Status lifecycle: pending / parsed / failed / manual.
- Reparse button for previously-uploaded images.

✅ **Slice B — Recurring purchase patterns** (Phase 10B)
- Detector groups ReceiptItems by SKU (or normalized name fallback).
- Requires ≥3 occurrences over ≥45 days at stable cadence + price.
- "Item-level patterns" UI tab + "Merchant rollup" UI tab (Plaid-fed alternative when no receipts).
- Per-pattern annualized cost projection.
- name_locked / dismissed lifecycle survives re-detect runs.

✅ **Slice C — Coupon extraction** (Phase 10C)
- `extract_coupons()` parser scans bottom of receipts for codes / values / expirations / URLs.
- ReceiptCoupon table with status (available / used / expired / dismissed).
- Auto-feeds Money on the Table as `receipt_coupon` source kind.
- Per-receipt coupon section in the detail view.

✅ **Slice D — Cross-store deals** (Phase 10D)
- PriceObservation table tracking (recurring_purchase, merchant, price, observed_at, in_stock, source).
- Detector flags observations ≥15% below the user's typical price as deals.
- Annualized savings projection using cadence × per-trip savings.
- Stub scrapers for Walmart / Target / Costco / Amazon Fresh / Kroger (auth bootstrap pending).
- Manual price-observation entry path that works today.
- Auto-feeds Money on the Table as `cross_store_deal` source kind.

✅ **Slice E — Item canonicalization** (Phase 10E)
- CanonicalProduct table with brand / size / category / normalized_key / UPC.
- Three-tier matcher: UPC exact → brand+size+fuzzy ≥0.65 → exact normalized key.
- Brand catalog (Charmin, Bounty, Coca-Cola, Tide, etc. — ~30 household brands).
- Size extractor (24CT / 64 fl oz / 1GAL).
- Stdlib-only fuzzy match (no rapidfuzz dep) blending Jaccard + SequenceMatcher.
- Manual merge endpoint when canonicalizer over-fragments.

---

## Mobile (Expo + React Native)

**Full parity: 28 of 28 web panels mirrored** on iPhone via Expo Go + Tailscale. In-house tab navigator (no `@react-navigation` dep), shared theme.

**Two-tier nav model**: 5 primary morning-check tabs in the bottom bar + a "More" pseudo-tab whose body is a 4-column grid of the remaining 23 screens grouped into Opportunities / Tracking / Analytics / System.

**Primary tabs (always in the bar):**
✅ Money on the Table · ✅ Net Worth · ✅ Cash Flow · ✅ Budgets · ✅ Credit

**Opportunities (More section):**
✅ Offers (Chase + Amex) · ✅ Claims (Settlemate-style) · ✅ Redress · ✅ Unclaimed property · ✅ Card benefits · ✅ Yield arbitrage · ✅ Cross-store deals

**Tracking (More section):**
✅ Holdings (portfolio + allocation) · ✅ HSA receipts · ✅ Card applications (5/24 + min-spend bars) · ✅ Subscriptions · ✅ Goals · ✅ Shopping patterns · ✅ Canonical products · ✅ Merchants

**Analytics (More section):**
✅ Tax export · ✅ Trends · ✅ Heatmap · ✅ Anomaly

**System (More section):**
✅ Receipts · ✅ Bank connections (Plaid sync, no Link SDK) · ✅ Notifications · ✅ Transactions

⏳ **Image upload from camera** — needs `expo-image-picker` + `expo-camera` modules. Paste-text path always works.

**Note on Plaid Link**: the Connections screen in the mobile app is read-only (list items, sync, schedule snapshot). Adding new banks requires Plaid's native Link SDK which would force ejecting from Expo Go — the screen points users to the web app for adding new banks instead. Once linked there, items sync automatically on the phone.

---

## Smoke test coverage

**Backend smoke tests** (`backend/scripts/`):

✅ `smoke_test.py` — foundation (CSV ingest, categorization, basic API).
✅ `smoke_phase_b.py` — subscription detector + parser.
✅ `smoke_phase_d.py` — surplus + suggestions + goals.
✅ `smoke_budget_credit.py` — budget rollup, credit utilization, MoM.
✅ `smoke_legal_claims.py` — manual CRUD + stats roll-up.
✅ `smoke_legal_scrapers.py` — TCA + CAO + CAR fixtures parse cleanly.
✅ `smoke_receipts.py` — receipt ingest + line items + coupons + cascade delete.
✅ `smoke_shopping_patterns.py` — pattern detector + name lock + dismissed-stay-dismissed + merchant rollup.
✅ `smoke_deals.py` — deal detector + thresholds + out-of-stock filter + MoT integration.
✅ `smoke_canonicalization.py` — brand + size extractors + fuzzy match + cross-store collapse + merge.
✅ `smoke_phase_7.py` — networth + cashflow + tax + merchants.
✅ `smoke_phase_8.py` — unclaimed + card apps + yield-arb + redress + MoT.
✅ `smoke_phase_9.py` — holdings + hsa + anomaly + heatmap.
✅ `smoke_credit_score_scrapers.py` — CK / CW / CJ parsers + coordinator persistence + dedupe + crash isolation + auth-missing handling. **(NEW in this batch — Phase 4.3)**

14 smoke tests covering ~45 distinct backend features. Phase 4.3 + 7-9 features all have automated regression coverage.

---

## What you can do today, in plain English

1. **See your full financial picture in one place** — connections to multiple banks, credit cards, brokerages.
2. **Know if you're on pace this month** — without doing the math yourself.
3. **Spot zombie subscriptions** before another billing cycle hits.
4. **Track every "free money" lever you have** — class actions, unclaimed property, card sign-up bonuses, unused benefits, idle cash, regulatory redress, receipt coupons, cross-store deal alerts.
5. **Know exactly which card to use for the next purchase** to maximize rewards.
6. **Get an in-app weekly narrative** of what changed, written by a local LLM (no API costs).
7. **Track every recurring purchase** — Charmin every 6 weeks at Costco, almond milk every 2 weeks, etc.
8. **Get deal alerts when another store undercuts your usual price** — manually-logged observations work today; live scrapers ship as you bootstrap auth.
9. **Open the app on your phone** — 28 screens at full parity with the web app, with a 5-tab morning-check bar and a More-grid drawer for the rest.
10. **Never have an automated action** taken on your money — every recommendation includes before/after math; you execute.
