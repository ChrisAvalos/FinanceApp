# Re-audit — 2026-05-12 night (post Sprints 36–41)

**Method:** delta audit against the evening pass (audit-2026-05-12-evening.md, **91.6/100**). Sprints 36–41 shipped between the two audits; this pass quantifies the lift. Verified live in the browser for the three panels with material visual change (Cash Flow, Holdings, plus the prior verifications of the changed panels in the morning audit).

## Headline

| Metric | Morning | Evening | Night | Δ today |
|---|---|---|---|---|
| **Overall score** | 87.6 | 91.6 | **93.0** | **+5.4** |
| Daily group | 84.7 | 89.7 | **90.7** | +6.0 |
| Opportunities group | 86.0 | 89.6 | **89.9** | +3.9 |
| Tracking group | 89.3 | 90.4 | **91.0** | +1.7 |
| Analytics group | 89.5 | 91.0 | **91.5** | +2.0 |
| System group | 91.4 | 92.2 | **92.4** | +1.0 |

The app went from a regression-laden 87.6 baseline this morning to **93.0** by tonight — a 5.4-point lift in a single session. Crossed both the 90 and 92 lines today; the 93 line came in this final pass.

## Per-panel scorecard (changed panels only; this pass)

| # | Panel | Evening | Night | Δ | Cause |
|---|---|---|---|---|---|
| 7 | **Cash flow** | 87 | **91** | +4 | Sprint 40 — "Coming up — annual renewals" section with Truthly/Settlemate/ESPN+ surfaced; 12-mo total chip |
| 4 | Money found | 92 | **93** | +1 | Sprint 41 — "Saved this session" chip wired to celebration counter |
| 19 | Holdings | 88 | **89** | +1 | Sprint 39 — high-contrast "DEMO DATA" stamp + dashed border + "not your accounts" line on preview tile |
| 27 | Trends | 88 | **90** | +2 | Sprint 36 — display cap at ±200% removes the last alarming outliers |
| 20 | HSA receipts | 91 | **92** | +1 | Sprint 38 — coupon-row Del button no longer blocks the browser |
| 24 | Product catalog | 81 | **84** | +3 | Sprint 38 — Delete + Merge use the new two-click confirm pattern |
| 30 | Receipts | 91 | **92** | +1 | Sprint 38 — 3 confirm() callsites cleaned (line, receipt, coupon) |
| 14 | Redress | 80 | **80** | 0 | No change this pass |
| 18 | Cross-store deals | 88 | **88** | 0 | No change this pass (Sprint 38 cleaned the observation-delete confirm) |
| — | All other panels | — | — | 0 | Already at their post-evening scores |

The Receipts / HSA / Product catalog / Cross-store moves are small but real: each shaved a window.confirm() callsite, all of which were UX warts the audit cared about.

## Dimension-wise lift

| Dimension | Morning | Evening | Night | Δ today |
|---|---|---|---|---|
| Functionality | 9.0 | 9.4 | **9.5** | +0.5 |
| UX | 9.1 | 9.3 | **9.4** | +0.3 |
| Beauty | 9.0 | 9.2 | **9.2** | +0.2 |
| Intelligence | 8.6 | 8.7 | **8.8** | +0.2 |
| Delightfulness | 8.3 | 8.9 | **9.1** | +0.8 |
| Completeness | 8.9 | 9.0 | **9.2** | +0.3 |
| Trust | 8.6 | 8.9 | **9.0** | +0.4 |
| Accessibility | 8.0 | 8.8 | **8.8** | +0.8 |
| Performance | 8.9 | 8.9 | **8.9** | 0.0 |

Delightfulness clears 9.0 for the first time. Trust crosses 9.0 too (the Holdings "DEMO DATA" stamp + the Sprint 28 FIRE clamp note + the Sprint 19 chat-hygiene fix all add up here).

## What got verified live this pass

- **Cash flow** — "Coming up — annual renewals" section rendering correctly under the regular 30-day Upcoming events list. Three months visible (June: Truthly Pro $29.99, July: Settlemate $34.99, September: ESPN+); 12-month total $194.97 in the right-side chip. Groups by month for scan-ability.
- **Holdings** — high-contrast amber "DEMO DATA" stamp visible top-right of the preview tile, dashed border, amber "*The numbers below are illustrative — not your accounts*" line under the description. Round numbers ($248,500 / +29.3% / 14 holdings) now read as obviously illustrative.
- (Sprints 36, 38, 41 changes verified during the implementation passes — Trends cap, confirm() sweep, MoneyFound chip wiring all confirmed in code review + earlier screenshots.)

## What's still imperfect

### 🟡 UX warts (carried forward)

1. **Cross-Store Deals scrapers** — Walmart ready, four others "needs auth". Bootstrap is a CLI command; one-click bootstrap from the panel would be ideal but requires Playwright auth-state management changes.
2. **Holdings preview is still the only thing showing** because Plaid investments product isn't granted. The DEMO DATA stamp solves the trust gap; the underlying "ask your bank for the investments scope" step is documented in the empty state but not enforced.

### 🟢 Architectural

3. **Trends `≥+200%` cap** is purely a display change — the underlying API still emits the raw number. Anyone using the raw API gets the unbounded value. Fine for now (only one consumer); worth caching in the response shape if a second consumer ever shows up.
4. **CelebrationToast session counter** lives in module-state, not React context. If the app ever gets SSR or microfrontends, the counter would split. Not a real risk today.

## Why we're at 93.0, not 100

| Dimension | Score | What 1+ more point would take |
|---|---|---|
| Functionality | 9.5 | Two known niche bugs left (Cross-Store bootstrap UX, Holdings preview-vs-real gap). |
| UX | 9.4 | First-run setup checklist on Overview chaining the user through Plaid / Gmail / Receipts setup. |
| Beauty | 9.2 | A typography pass — consistent heading scales, more deliberate vertical rhythm. |
| Intelligence | 8.8 | LLM-driven receipt OCR (close the Shopping Patterns → Cross-Store Deals loop without 3 manual receipt uploads). |
| Delightfulness | 9.1 | Celebration toasts on non-subscription wins (class action paid, unclaimed property received, IRS refund found). |
| Completeness | 9.2 | Annual-renewals UI now exists but doesn't yet feed back into Money on the Table's "Big tickets" tab. Surface the September ESPN+ in the right cohort. |
| Trust | 9.0 | A source-citations pass on chat answers — show which transactions / subscriptions backed the response. |
| Accessibility | 8.8 | Keyboard-only walk-through audit + color-contrast pass. |
| Performance | 8.9 | First-paint optimization on heavy panels (Subscriptions ~20 rows + 3 banners). |

## Strategic recommendations — next session

### Same-day fixes (≤1 hour)
1. **Surface "Coming up" annuals on Money Found's Big-tickets tab.** The data is now available via `/api/cashflow/upcoming-annuals` — wire it as a `source_kind` so the user sees "Truthly Pro $29.99 due in 37 days" as a planning opportunity, not just a forecast event.
2. **Type ramp pass.** Audit all `text-3xl / text-2xl / text-xl / text-lg / text-base / text-sm / text-xs` usage. The hero stats on Money Found are larger than the FIRE stats, which are larger than the Net Worth stats — pick one scale and unify.

### Sprint-sized (1–3 hours)
3. **First-run setup checklist on Overview.** "Plaid ✓ · Gmail ✓ · Receipts (0/3) · Ollama ✓ · Chase Offers ✓ · Amex Offers needs auth". Each item links to its setup flow. Closes the "user lands and doesn't know what to do" gap that the audit identified.
4. **Celebration toasts on non-subscription wins.** Class action paid → "$60 collected from Facebook settlement". Unclaimed property received → "Got $127 back from Massachusetts!". Each is a 5-line addition at the mutation success site.
5. **Mobile parity refresh.** The trend banner + bundle banner are on mobile (Sprint 27) but the new Coming-up section + Saved-this-session chip aren't. Port both.

### Bigger swing
6. **Receipt OCR via Ollama vision.** Pattern matching → vision-model extraction. Closes the Shopping Patterns / Cross-Store Deals onboarding loop. The biggest unlock for non-power-users.
7. **Comprehensive a11y audit.** Tab-order walk, color-contrast pass, screen-reader walk-through, `prefers-reduced-motion` audit beyond CountUp.

## Bottom line

Three audits today, scored 87.6 → 91.6 → **93.0**. The day produced 24 shipped sprints (19–41) plus 3 audits and 4 verification rounds. The audit-fix-re-audit rhythm continues to be the right cadence — each pass picks the most-leveraged remaining issue, ships a focused fix, and the next score comes up.

The remaining 7 points to 100 break down across roughly six dimension-level themes (typography, a11y, performance, semantic understanding, celebration breadth, source-citation in chat). None of them are a single sprint; they're each multi-session investments. Reasonable target for the next equivalent session: **95**.
