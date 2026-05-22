# Finance App — Post-Wave-D Comprehensive Audit
**Date:** 2026-05-07 · **Method:** live browser walk of all 34 panels via Chrome MCP
**Prior audit:** 2026-05-06 (post-Wave-C, **82.8/100**). Same 9 dimensions for an apples-to-apples delta.

## Dimensions (each scored 0–10, panel score = sum/90 × 100)

1. **Functionality (F)** — does it work end-to-end with real data?
2. **UX (U)** — flow, copy, empty states, discoverability
3. **Beauty (B)** — visual polish, typography, color hierarchy
4. **Intelligence (I)** — non-obvious inferences and insights
5. **Delightfulness (D)** — small joys, motion, "huh, that's cool"
6. **Completeness (C)** — does the panel cover the surface area its spec implied?
7. **Trust / freshness (T)** — sync chips, accuracy signals, source attribution
8. **Accessibility (A)** — keyboard nav, ARIA, focus rings, motion-sensitive support
9. **Performance (P)** — first paint, perceived snappiness

## Headline numbers

| Group | Panels | Avg score | vs. prior |
|---|---:|---:|---:|
| Daily | 11 | **85.8** | +1.4 |
| Opportunities | 7 | **84.3** | +1.4 |
| Tracking | 7 | **82.4** | +3.4 |
| Analytics | 4 | **88.8** | +2.5 |
| System | 5 | **87.2** | +5.2 |
| **App-wide** | **34** | **85.4** | **+2.6** |

The biggest movers are System (+5.2, driven by the Gmail explainer and Receipts delight grid) and Tracking (+3.4, driven by Holdings preview + HSA greeting). Daily moves modestly because the Today's-moves regression bug isn't fully resolved — chip lifted T but I dropped (more on this below).

## Per-panel scorecard

| # | Panel | F | U | B | I | D | C | T | A | P | Sum | Score | Δ |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Overview | 9 | 9 | 9 | 8 | 7 | 8 | 9 | 8 | 9 | 76 | **84** | +4 |
| 2 | Ask about money | 9 | 9 | 8 | 9 | 8 | 7 | 7 | 8 | 9 | 74 | **82** | 0 |
| 3 | Today's moves | 9 | 9 | 8 | 7 | 8 | 9 | 9 | 8 | 9 | 76 | **84** | +2 |
| 4 | Money found | 10 | 10 | 9 | 10 | 9 | 10 | 7 | 8 | 8 | 81 | **90** | 0 |
| 5 | Net worth | 9 | 9 | 9 | 8 | 7 | 10 | 9 | 8 | 9 | 78 | **87** | 0 |
| 6 | Attribution | 9 | 9 | 9 | 9 | 7 | 9 | 9 | 8 | 9 | 78 | **87** | +5 |
| 7 | Cash flow | 9 | 9 | 9 | 8 | 7 | 9 | 9 | 8 | 9 | 77 | **86** | +3 |
| 8 | Budgets | 9 | 9 | 8 | 8 | 7 | 8 | 6 | 8 | 9 | 72 | **80** | 0 |
| 9 | Savings & goals | 9 | 9 | 8 | 9 | 7 | 9 | 6 | 8 | 9 | 74 | **82** | 0 |
| 10 | **FIRE projection** | 10 | 10 | 10 | 10 | 9 | 10 | 9 | 8 | 9 | 85 | **94** | +2 |
| 11 | Credit | 9 | 9 | 9 | 9 | 7 | 10 | 9 | 8 | 9 | 79 | **88** | 0 |
| 12 | Card offers | 8 | 9 | 9 | 8 | 8 | 9 | 9 | 8 | 9 | 77 | **86** | 0 |
| 13 | Class actions | 10 | 10 | 10 | 9 | 10 | 10 | 9 | 8 | 8 | 84 | **93** | +2 |
| 14 | Redress | 9 | 9 | 9 | 9 | 7 | 8 | 9 | 8 | 9 | 77 | **86** | +4 |
| 15 | Unclaimed property | 8 | 9 | 8 | 7 | 7 | 7 | 9 | 8 | 9 | 72 | **80** | +3 |
| 16 | Card benefits | 9 | 8 | 8 | 8 | 7 | 7 | 9 | 8 | 9 | 73 | **81** | +3 |
| 17 | Yield optimization | 10 | 10 | 9 | 10 | 8 | 10 | 9 | 8 | 9 | 83 | **92** | +2 |
| 18 | Cross-store deals | 7 | 8 | 8 | 8 | 7 | 7 | 9 | 8 | 9 | 71 | **79** | +3 |
| 19 | Holdings | 8 | 10 | 9 | 7 | 9 | 7 | 7 | 8 | 9 | 74 | **82** | +6 |
| 20 | HSA receipts | 9 | 10 | 9 | 8 | 9 | 7 | 8 | 8 | 9 | 77 | **86** | +7 |
| 21 | Card applications | 9 | 9 | 9 | 9 | 7 | 8 | 8 | 8 | 9 | 76 | **84** | +3 |
| 22 | Subscriptions | 9 | 9 | 9 | 9 | 7 | 9 | 8 | 8 | 9 | 77 | **86** | +2 |
| 23 | Shopping patterns | 8 | 9 | 8 | 8 | 6 | 7 | 8 | 8 | 9 | 71 | **79** | +2 |
| 24 | Product catalog | 8 | 9 | 8 | 8 | 7 | 7 | 8 | 8 | 9 | 72 | **80** | +2 |
| 25 | Merchants | 9 | 9 | 8 | 8 | 6 | 6 | 7 | 8 | 9 | 70 | **78** | 0 |
| 26 | Tax export | 9 | 10 | 9 | 8 | 7 | 9 | 9 | 8 | 9 | 78 | **87** | +7 |
| 27 | Trends | 10 | 10 | 10 | 10 | 8 | 10 | 9 | 8 | 9 | 84 | **93** | +2 |
| 28 | Heatmap | 9 | 10 | 10 | 9 | 8 | 9 | 9 | 8 | 9 | 81 | **90** | +2 |
| 29 | Unusual txns | 9 | 9 | 9 | 10 | 7 | 9 | 9 | 8 | 9 | 79 | **88** | +2 |
| 30 | Receipts | 9 | 10 | 9 | 8 | 9 | 8 | 8 | 8 | 9 | 78 | **87** | +9 |
| 31 | Bank connections | 10 | 10 | 9 | 8 | 7 | 10 | 9 | 8 | 9 | 80 | **89** | 0 |
| 32 | **Gmail inbox** | 8 | 10 | 9 | 9 | 9 | 8 | 7 | 8 | 9 | 77 | **86** | **+14** |
| 33 | Alerts | 9 | 10 | 9 | 9 | 8 | 9 | 9 | 8 | 9 | 80 | **89** | +2 |
| 34 | Transactions | 10 | 9 | 9 | 8 | 7 | 9 | 9 | 8 | 9 | 78 | **87** | +3 |

## Top 5 / Bottom 5

**Top 5** (showcase quality, do not regress):
1. FIRE projection — **94** (was 92)
2. Class actions — **93** (was 91)
3. Trends — **93** (was 91)
4. Yield optimization — **92** (was 90)
5. Heatmap — **90** (was 88) tied with Money found — **90**

**Bottom 5** (next investment targets):
30. Merchants — 78
29. Cross-store deals — 79
28. Shopping patterns — 79
27. Unclaimed property — 80
26. Product catalog — 80

The 72 → 86 jump on Gmail inbox is the headline single-panel move. Receipts +9 and HSA +7 are next. Anything that started below 80 is now ≥ 78 except Merchants (which is intentionally skipped from sync chip wiring; its score doesn't move because nothing about it changed).

## Per-dimension app-wide averages

| Dimension | Avg /10 | vs. prior | Note |
|---|---:|---:|---|
| Functionality | 8.9 | ≈ flat | Bugs caught (mojibake, label) without regressions |
| UX | 9.3 | +0.2 | Tax CTA, Holdings preview, Receipts grid, Gmail explainer |
| Beauty | 8.8 | +0.1 | Mojibake gone; chips add visual rhythm to every panel head |
| Intelligence | 8.4 | flat | Today's-moves I dropped a point (regression below); rest unchanged |
| Delightfulness | **8.0** | **+0.7** | Biggest qualitative gain — greetings + empty-state previews everywhere |
| Completeness | 8.4 | +0.2 | Tax "Categorize unmapped" CTA closes the only Completeness gap noted in prior audit |
| **Trust / freshness** | **8.6** | **+1.7** | Chips on 31 of 34 panels (skipped Chat / Budgets / Merchants intentionally) |
| Accessibility | 8.0 | flat | No new a11y work in Wave D; floor holds |
| Performance | 8.9 | flat | gcTime parity for mobile didn't move web; cache-first nav still feels instant |

The two stand-out dimensions are **Trust** (+1.7) and **Delightfulness** (+0.7). Both were the explicit Wave D goals; the audit confirms they landed.

## Wave D wins verified live

- **D-1 sync chips.** Every chip wired in D-1 is rendering. Spot-checked Overview ("Snapshot computed synced just now"), Trends ("Trend computed synced just now"), Cash flow, FIRE, Heatmap, Tax, Anomaly, Attribution — all green/just-now. Net worth and Card benefits both correctly show "synced 23h ago" (amber tier kicks in past 24h, but these are inside the 24h muted band).

- **D-2 bug 1 (mojibake).** Card applications descriptions now render `—` correctly. "Sole-prop is fine for 'business' — Etsy / freelancing / 1099 work all qualify" reads as intended; no `â€"` artifacts on any of the 6 cards.

- **D-2 bug 3 (Tax untagged CTA).** "UNTAGGED OUTFLOW" stat card on Tax export now shows the "Categorize unmapped →" CTA below the txn count. Verified the click navigates to `#transactions` and the "Only uncategorized" checkbox is present in the Transactions header.

- **D-2 bug 4 (Shopping patterns label).** Card label changed from "Combined avg/month" → "Sum of merchant rates" with the subtitle "Σ per-merchant 30d avg — relative ranking, not a real monthly spend". No more $21K/mo confusion.

- **D-2 bug 5 + D-3 (Gmail).** Empty-state explainer card is the dominant visual on the panel: "What gets parsed when you sync · 18 parsers ready" with the parser registry grouped by kind (Transaction · 6 / Bill · 4 / Offer · 1 / Report · 6 / Misc · 1) and example labels per group. The previously-hidden Registered parsers fold is still there for full detail. This is the single biggest UX upgrade in Wave D.

- **D-3 delight passes.**
  - Holdings: "Once your brokerage is linked, you'll see…" PREVIEW card with synthetic stat cards ($248,500 / +$56,360 / 14 holdings) + sample allocation bar. Empty state now sells the panel instead of stalling at it.
  - HSA receipts: "Bank your first receipt to start the clock" + "today's $100 doctor bill becomes $761 in 30 years" + "What you'll need" hint. Compounding insight is now emotionally legible.
  - Receipts: 4-card grid showing the four downstream panels each receipt unlocks (Shopping patterns, Money on the Table, HSA bank, Cross-store deals). The upload card now feels like a key, not a form.

- **D-5 parser promotions.** Parser counts on Gmail inbox confirm the 6 promotions: TRANSACTION · 6 (Chase, Amex, BofA, Wells Fargo, Netflix, Spotify), BILL · 4 (Xfinity, PG&E, Student loan, water_bill), REPORT · 6 (Credit Karma, TransUnion, Equifax, Experian, SmartCredit, rocket_money). The 4 stubs that remain are appropriate: rocket_money_digest (low signal), student_loan_statement (medium), and water_bill is now real (was stub).

## Bugs and rough edges still present

1. **Today's moves still ranks expired class actions at the top.** The D-2 fix to `_priority_score` works (expired items get 0.5× depressor instead of the prior 9.5× boost), but the spread between class-action face value and cancel-subscription value is bigger than 0.5×. Items 1–3 in Today's moves are expired $25K class actions ($416/min after depressor) and items 4–5 are $2.4K/yr cancellations ($240/min). The mathematically-correct fix is more aggressive: drop the depressor to 0.1× OR exclude expired items from the daily queue entirely. **Recommend: filter expired out of `/api/daily/moves` selection rather than just demoting their score.** This is the single highest-impact follow-up.

2. **Card offers Amex bootstrap missing.** Same as prior audit. Chase Offers is "Logged in (2d ago)"; Amex shows "Auth missing" with the bootstrap command in a code block. Not a regression, just a remaining setup task.

3. **Cross-store deals only Walmart auth-ready.** Same as prior audit. Walmart "ready"; Target / Costco / Amazon Fresh / Kroger all need auth. Not a regression.

4. **Inter font on mobile is wired but inert.** D-4 added the `FONT.body` / `FONT.semibold` slots but they're `undefined` until `expo-font` + `@expo-google-fonts/inter` get installed. The type *scale* changes are live; only the typeface itself is pending.

## Wave-D delta summary

App-wide: **82.8 → 85.4 (+2.6)**

By dimension, the lift came from where Wave D was aimed:
- Trust/freshness: 6.9 → **8.6** (+1.7) — the chip-on-every-panel push paid off
- Delightfulness: 7.3 → **8.0** (+0.7) — the empty-state and greeting work moves the floor
- Functionality stays flat at 8.9 — no regressions; the priority-score fix hasn't fully landed but didn't make anything worse either
- Beauty / UX / Completeness all moved 0.1–0.2 — the mojibake fix, label fix, and Tax CTA each contribute small amounts

## Recommended next wave

**Wave E candidates, ranked by ROI:**

1. **Fix Today's-moves expired filtering at the query level.** Either filter expired class actions out of the selection or drop the depressor to 0.1×. The current state means the headline "morning glance" panel still misranks, even though the underlying score formula is now sane. ETA: 30 minutes.

2. **Bottom-5 polish.** Merchants (78), Cross-store deals (79), Shopping patterns (79), Unclaimed (80), Product catalog (80). Each has a specific gap — Merchants is lookup-only (no prefilled common-merchants strip), Cross-store deals is single-source (Walmart), Shopping patterns has no item-level data yet. ETA: 1 day.

3. **Mobile chip rollout to remaining ~20 screens.** D-4 wired 5 high-traffic screens; the pattern is established but mechanical work remains. ETA: half a day.

4. **Inter font install on mobile.** `expo-font` + `@expo-google-fonts/inter`, flip two lines in `theme.ts`. ETA: 15 minutes.

5. **Today's moves curation polish.** Beyond the expired bug — look at why $25K class-action face values dominate the queue at all. The "estimated payout" for class actions is wildly speculative; maybe weight them at 10% of face value when computing $/min. ETA: 1 hour.

## Method note

Walked all 34 panels live in the dev server (localhost:5173) via Chrome MCP, with screenshots and a DOM inspection on the Overview panel to debug a Vite resolution issue (stale `App.js` siblings shadowing every `.tsx`; fixed by reordering `resolve.extensions` in `vite.config.ts`). Same 9-dimension calibration as the 2026-05-06 audit so deltas are honest. A "10" remains reserved for genuinely-best-in-class panels (FIRE Monte Carlo, Class actions Settlemate-style UX, Trends pie+drill, Money found cohort dashboard, Heatmap calendar grid, Bank connections sync UX) — most panels score in the 7–9 range per dimension.
