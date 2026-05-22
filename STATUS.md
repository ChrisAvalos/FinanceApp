# Finance App — status vs. the original vision

A scorecard of where the app sits against the four pillars + unique
angles + hard constraints. Last refreshed **2026-04-28** after Phase 4.3
(credit-score scrapers) shipping, full mobile parity (28 screens with a
5-primary + More-grid tab redesign), and the mobile-API audit fixes.

---

## Pillar 1 — Budgeting with month-over-month insight

| Original goal | Status |
|---|---|
| Categorized spending across all accounts | ✅ Engine + 330+ rules; per-rule hit counters |
| Per-category monthly budgets | ✅ `/api/budgets` CRUD + monthly rollup |
| Pace-aware over-budget warnings | ✅ Pace badge fires when burn-rate > calendar-rate |
| Month-over-month variance + drift surfacing | ✅ Trends panel: top-3 swings + sparklines |
| Copy-from-prior + average-fill budget templates | ✅ Both endpoints + UI buttons |
| Spending pace projection per budget | ✅ Phase 7.3 |

**Gaps to close later:** rollover-budget math (YNAB-style carry-forward) — modeled but not exposed.

---

## Pillar 2 — Credit operations

| Original goal | Status |
|---|---|
| Track score over time | ✅ Manual CRUD; sparkline in panel |
| Per-card utilization with FICO cliff markers | ✅ Cliff bars at 1/10/30/50/75% |
| Statement-close-day optimizer | ✅ Phase 4.1 |
| CLI opportunity detection | ✅ Phase 4.2 |
| Best-card-for-merchant rewards optimizer | ✅ Phase 4.4 |
| Card sign-up bonus + 5/24 tracker | ✅ Phase 8.2 |
| Unused card-benefit tracker (use-it-or-lose-it credits) | ✅ Phase 8.3 |
| Playwright score scrapers (Credit Karma / Cap One CreditWise / Chase Credit Journey) | ✅ Phase 4.3 — 3 scrapers + bootstrap helper + daily cron + smoke test |

**Status: 8 of 8 done. Phase 4.3 needs `python -m finance_app.scrapers.credit_scores.bootstrap <site>` once per portal to drop the auth-state JSON; from then on the daily 3 AM cron runs headlessly.**

---

## Pillar 3 — Unified transaction ledger

| Original goal | Status |
|---|---|
| Plaid (sandbox + production) | ✅ Sandbox proven; **prod approval in hand**, activation pending one config-flip |
| CSV / OFX manual imports | ✅ 6 importer formats |
| Gmail parsing | ✅ 18 parsers (T1 bespoke + T2 cross-sender + T3 Ollama fallback) |
| Playwright browser automation | ✅ Class-action + Chase/Amex Offers + Credit Karma / CreditWise / Credit Journey scrapers |
| Auto-categorization | ✅ Rules → fuzzy → T3 Ollama fallback |
| **NEW: Receipt OCR + line items (Phase 10A)** | ✅ pytesseract pipeline with paste-text fallback |
| **NEW: Coupon extraction from receipts (Phase 10C)** | ✅ Bottom-of-receipt parser → ReceiptCoupon table |
| Email signal coverage | ✅ score updates, statement-ready, payment-due, large-charge, fraud, balance, deposit, card-shipment, CLI-change, rewards |

**Status: 5 of 5 channels live + receipt photo upload.**

---

## Pillar 4 — Savings & bill-cutting

| Original goal | Status |
|---|---|
| Detect surplus + recommend allocation | ✅ Phase D historical + forecast modes |
| Goal tracker with allocation suggestions | ✅ |
| Detect retention offers + scripts | ✅ Phase 5.2 |
| Detect price hikes + zombies | ✅ Phase B detector |
| Free-trial → paid conversion alerts | ✅ Phase 9.5 |
| **App NEVER moves money** | ✅ Hard constraint enforced |

**Status: complete.**

---

## Phase 7 — "things every other app has" parity

| Feature | Status |
|---|---|
| 7.1 Net-worth tracker (assets + balance snapshots + sparkline) | ✅ |
| 7.2 Bill calendar / cash-flow forecast | ✅ |
| 7.3 Spending pace projection per budget | ✅ |
| 7.4 Tax-time export (categorized CSV) | ✅ |
| 7.5 Per-merchant deep-dive view | ✅ |
| 7.6 Annual review | ✅ |

---

## Phase 8 — "money on the table" surfacing

| Feature | Status |
|---|---|
| 8.1 Unclaimed property tracker (NAUPA + per-state) | ✅ |
| 8.2 Card sign-up bonus + 5/24 tracker | ✅ |
| 8.3 Card-benefit (use-it-or-lose-it) tracker | ✅ |
| 8.4 HYSA / T-bill yield-arb suggester | ✅ |
| 8.5 CFPB / state-AG redress search + match | ✅ |
| 8.6 Money-on-the-table unified dashboard | ✅ Cohort tabs + 9 source kinds |

---

## Phase 9 — Empower-style depth

| Feature | Status |
|---|---|
| 9.1 Investment holdings tracking | ✅ Manual entry; Plaid investments hookup pending |
| 9.2 HSA receipt bank (decades-deferred reimbursement) | ✅ |
| 9.3 Anomaly / unusual-transaction detection (≥3σ baseline) | ✅ |
| 9.4 Spending heatmap (calendar grid) | ✅ |
| 9.5 Free-trial → paid conversion alerts | ✅ |

---

## Phase 10 — Shopping intelligence

| Slice | Description | Status |
|---|---|---|
| 10A Receipts | OCR pipeline + line-item parser + ReceiptsPanel | ✅ Shipped, smoke test passing |
| 10B Patterns | Recurring-purchase detector + merchant rollup + ShoppingPatternsPanel | ✅ Shipped, smoke test passing |
| 10C Coupons | extract_coupons → ReceiptCoupon → Money-on-the-Table aggregator | ✅ Shipped, smoke test passing |
| 10D Cross-store deal scrapers | Costco / Walmart / Target / Amazon Fresh / Kroger stubs + price-observation framework | ✅ Shipped, smoke test passing (live scrapers need auth bootstrap) |
| 10E Item canonicalization | "CHRMN UL TP 24CT" ≈ "Charmin Ultra Soft 24" cross-store | ✅ Shipped, smoke test passing — UPC + brand+size + fuzzy ≥0.65 three-tier matcher |

**Status: all 5 slices shipped + automated regression coverage.**

---

## Settlemate-inspired class-action redesign

Triggered by competitive UI review of [Settlemate](https://www.settlemate.app):

| Improvement | Status |
|---|---|
| Hero with personalized "$X pending" headline | ✅ |
| State filter chips (CA / FL / TX / etc.) | ✅ State extraction parser + 15 state-specific TCA URLs |
| "Up to $X" / "TBD" framing | ✅ |
| Company logos via Clearbit | ✅ With initials fallback |
| "Top matches, ranked" + "Other claims" two-section layout | ✅ |
| Proof heuristic improvements (removed "Up to $X" false positive) | ✅ |
| `state_eligibility` column on LegalClaim | ✅ Auto-migration |
| `?state=CA` API filter + `counts_by_state` stats | ✅ |

---

## Hard constraints

| Constraint | Status |
|---|---|
| No LLM API costs (local Ollama only) | ✅ |
| Plaid is OK (paid bank data source) | ✅ |
| Python/FastAPI + SQLite (WAL mode) + React | ✅ |
| Shared TS types via openapi-typescript | ✅ |
| App NEVER moves money | ✅ |
| Every recommendation includes before/after math | ✅ |

**Status: zero violations.**

---

## Inventory snapshot (refreshed 2026-04-28)

- **Backend**: 34 routers (added `/api/credit/scores/scrape`), all mounted in `main.py`. 8 scheduler jobs registered (added `credit-scores-scrape` daily at 3 AM).
- **Frontend**: 28 panels, all wired into `App.tsx`. Vite/TS clean build.
- **Smoke tests**: 14 in `backend/scripts/` — foundation, phase B, phase D, budget+credit, legal claims (manual + scrapers), receipts, shopping patterns, deals, canonicalization, phase 7, phase 8, phase 9, **credit-score scrapers (NEW Phase 4.3)**.
- **Documentation**: 11 markdown files in repo root.
- **Mobile**: 28 screens — full parity with web. New nav model: 5 primary morning-check tabs (Money / Worth / Cash / Budget / Credit) + a "More" pseudo-tab whose body is a 4-column grid of the remaining 23 screens grouped by section (Opportunities / Tracking / Analytics / System).

---

## Manual tasks still on you

1. **Plaid production activation** — approval is in hand. Drop `PLAID_ENV=production` + the prod secret into `backend/.env`, restart uvicorn, click Connect Bank. Real txns from there on. ~$1.50–$4/mo.
2. **Playwright auth bootstraps** — five sites total (Chase Offers, Amex Offers, Credit Karma, CreditWise, Credit Journey). One-time interactive login each:
   - `python -m finance_app.scrapers.offers.bootstrap chase`
   - `python -m finance_app.scrapers.offers.bootstrap amex`
   - `python -m finance_app.scrapers.credit_scores.bootstrap credit_karma`
   - `python -m finance_app.scrapers.credit_scores.bootstrap creditwise`
   - `python -m finance_app.scrapers.credit_scores.bootstrap credit_journey`
3. **Ollama + llama3.1 install** — unlocks T3 categorization + weekly narrator. Graceful-degrades without it. ~4 GB.
4. **Tesseract install** — unlocks Phase 10A photo upload. `choco install tesseract` (Windows). Without it, paste-text fallback works in the panel.
5. **iPhone setup** — Expo Go + `mobile/` config; install once and the existing Tailscale path keeps it reachable from anywhere.

---

## Deferred / explicit backlog

The roadmap is genuinely close to empty. Remaining items:

- **#117 (USER)**: Plaid prod activation — config-flip + first real Connect.
- **Plaid Investments product hookup** — model is ready; needs the `investments` product enabled on the Plaid Item config + a sync path. Will pair with the prod activation.
- **Rollover budgets exposed in rollup** — column already exists in `Budget`; the rollup endpoint just doesn't surface it yet.
- **Mobile camera-roll receipt upload** — needs `expo-image-picker` + `expo-camera`. Paste-text path works today.
- **On-device shakedown** — first walk-through of every mobile screen with real data once Plaid prod lands.

Explicitly out of scope until requested:
- Multi-user / sharing / threat-model widening
- Q&A intake flow for non-Plaid accounts
- Native Plaid Link SDK in the mobile app (would require ejecting from Expo Go; web's Plaid Link is the supported add-bank path)

---

## Beyond Phase 10 — what's interesting next

1. **Slice 10D + 10E** — deal scrapers + canonicalization. The big payoff after the foundation is in.
2. **Mobile catch-up** — start with Money on the Table + Net Worth + Receipts (the three I'd check on phone).
3. **Plaid investments sync** — currently Holdings is manual-entry only.
4. **Phase 4.3 credit scrapers** — once you're ready for the multi-day Playwright auth work.
5. **Real-data UI test pass** — every panel rendered with non-trivial data, screenshots-and-bugs style. Last pass was on seed data; lots has shipped since.
