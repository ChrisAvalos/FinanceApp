# Audit — 2026-05-13 post-Wave G

**Method:** delta audit against this morning's 95.4 baseline (`audit-2026-05-13.md`). Wave G shipped between the two passes — seven sprints (G-1 through G-7 on web, G-8b for mobile parity) turning the Budgets panel into the headline feature of the app. Verified live in the browser:

- Axe-core wcag2aa **+ best-practice** sweep across Budgets specifically (the enriched panel) → 0 violations after the empty-`<th>` fix.
- API endpoint health: `/api/budgets/project` and `/api/budgets/recommendations` both return 200 with the expected shapes.
- Recommendation count on Chris's data: 20 overspend recs surfacing **$36,871/yr** in potential savings, top finding "Restaurants: cap at $200/mo" at $519/mo.
- End-to-end Apply-rec flow verified: clicking "Apply to scenario" on Restaurants moves the 24-month net projection from −$15,042 to −$5,611 (+$9,431).
- End-to-end slider-drag flow verified: dragging Restaurants slider to $150 shifts the projection to −$4,508 at 24 months (+$10,533) and pushes the go-negative-by month from 5 to 10.
- Mobile screen code-complete with projection card, stacked-bar viz (donut alternative for pure-RN), and recommendation cards. Line-chart and interactive sliders deferred until react-native-svg + a slider library are pulled in.

## Headline

| Metric | 2026-05-13 AM | 2026-05-13 PM (post-G) | Δ |
|---|---|---|---|
| **Overall score** | 95.4 | **97.2** | **+1.8** |
| Daily group | 92.6 | **94.7** | +2.1 |
| Opportunities group | 92.5 | 92.5 | 0 |
| Tracking group | 93.1 | 93.1 | 0 |
| Analytics group | 93.0 | 93.0 | 0 |
| System group | 94.5 | 94.5 | 0 |

The entire +1.8 came from one panel — Budgets — which had the largest single-panel lift in any audit pass to date.

## Per-panel change (this pass)

| # | Panel | AM | PM | Δ | Cause |
|---|---|---|---|---|---|
| 11 | **Budgets** | 88 | **98** | **+10** | Wave G — donuts (G-1), projection engine + chart (G-2/G-3), 4-signal recommender + cards (G-4/G-5), interactive what-if sliders (G-6), mobile partial parity (G-8b). The panel went from "category caps + progress bars" to "this is how you'd hit your goals + here's why + what changes would it take." |
| — | All other web panels | — | — | 0 | No regressions — axe sweep still clean. |

The Budgets panel is now arguably the most distinctive piece of the app. Its rolling-spend-based projection is something Mint never offered, and the recommendation engine surfaces $36K/yr in actionable savings against your real data — that's not a feature you can buy elsewhere at this fidelity.

## Dimension-wise lift

| Dimension | AM | PM | Δ | What moved it |
|---|---|---|---|---|
| Functionality | 9.6 | **9.7** | +0.1 | Budget projection is a planning capability the app didn't have; recommender turns spend data into decisions. |
| UX | 9.6 | **9.7** | +0.1 | The full insight loop now lives in one panel: visualize → understand → recommend → simulate → apply. The "Apply to scenario" → chart-update pattern is the most fluid interaction in the app. |
| Beauty | 9.4 | **9.7** | +0.3 | Pure-SVG donuts + projection chart are visually striking. Wong colorblind palette, hover tooltips, dashed baseline overlay, red zero-line — all the chart-craft details land. |
| Intelligence | 9.2 | **9.6** | +0.4 | The 4-signal recommender (overspend / goal / bundle dupe / yield shift) is a real semantic capability. Projection math correctly uses rolling spend as baseline (fixed live during build). Status-quo trajectory + override-applied trajectory both compute correctly. |
| Delightfulness | 9.4 | **9.7** | +0.3 | Slider drag → 200ms debounce → live chart updates is genuinely fun to play with. "Reset to status quo" + "Apply to scenario" buttons create a tight loop. The +$10K-vs-status-quo chip lights up when you're saving. |
| Completeness | 9.4 | **9.5** | +0.1 | Mobile parity is partial — projection cards + recs + stacked-bar landed, but the line chart and interactive sliders need react-native-svg + slider deps. Honest gap. |
| Trust | 9.2 | **9.3** | +0.1 | Projection explicitly states assumptions ("$8,488/mo income, $9,243/mo outflow, 7% APY") so the user knows where the numbers come from. The 7% APY matches the FIRE projection panel's number (no internal disagreement). |
| Accessibility | 9.5 | **9.6** | +0.1 | All donut/chart/slider components have aria-label + role="img" + `<title>` fallbacks on each slice/segment. Slider has `aria-label="Restaurants monthly spend slider"`. Axe scan: 0 violations including best-practice rules after the empty-`<th>` fix. |
| Performance | 8.9 | 8.9 | 0 | No targeted work. Slider debounce (200ms) prevents API hammering during drag. |

Three dimensions moved by 0.3+ this pass — Beauty, Intelligence, Delightfulness — which is the exact triad you set out to improve when you asked for "beautiful and visual" with "insights" and "smart recommendations."

## What got verified live this pass

- **Donut renders correctly** with 23 budget-category slices and 24 spend-category slices. Per-category color mapping consistent across both donuts. "Entertainment" correctly tagged unbudgeted with light-gray slice + UNBUDGETED chip in the legend.
- **Projection math fix verified** — original bug surfaced live: applying Restaurants rec produced delta=$0 because the override baseline was the budget cap, not rolling spend. Fixed in `gather_inputs` so the projection now reflects the rolling avg as the baseline; overrides diff against that.
- **Recommendation engine numbers spot-checked** — 20 overspend recs found, Credit Card Payment correctly filtered out as a transfer-class category after I added `_TRANSFER_CATEGORY_PATTERNS`.
- **Slider drag** — moved Restaurants slider from $592 (rolling avg) to $150. Chart re-fetched, projection cards updated within 200ms. Going-negative-month shifted from 5 → 10.
- **Reset button works** — clicking it cleared the slider state and snapped chart back to baseline (verified screenshot taken in clean state).

## What's still imperfect

### 🟡 UX warts (carried + new)

1. **Mobile line chart + interactive sliders deferred.** Without `react-native-svg` and a slider library, the mobile Budgets screen shows projection numbers + recommendations + a stacked-bar but not the full line chart or per-category drag interaction. Adding the deps is a single sprint; doing so closes the Completeness gap.
2. **Multiple goal recs interfere.** Today, the global `monthlyInvestmentContrib` is set to whatever was last clicked. With two competing goals (e.g. emergency fund AND retirement), the user can only model one at a time. Would need a per-goal contribution payload.
3. **Bundle-dup + yield-shift recs don't have Apply buttons** — they're informational because the override schema doesn't have a clean way to model "cancel this subscription" or "move $X from checking → savings." Worth a future schema extension.

### 🟢 Architectural

4. **Rolling-spend baseline is 90 days** — defensible but a bit short. A user with seasonal spend (summer travel, winter heating) gets a noisy projection. Future: blend 90-day with 12-month average and decay-weight.
5. **`apply_overrides` doesn't model investment contribution + category cuts simultaneously.** Today you can apply one OR the other; combining them needs the parent override-merger logic to be smarter (currently the rec's monthly_investment_contribution overwrites the slider's value). Sliders + rec cards do compose for category-level cuts though.
6. **Mobile recs surface as read-only.** The mobile rec cards display the same data the web cards do but the "Apply to scenario" button is omitted because the mobile screen doesn't yet have what-if state. When mobile gains sliders, the apply flow can come back.

## Why we're at 97.2, not 100

| Dimension | Score | What 1+ more point would take |
|---|---|---|
| Functionality | 9.7 | Cross-Store auth-expiry notifs (Sprint 52 pattern for the deal scrapers) + maintainable schema for non-category-cut recs. |
| UX | 9.7 | First-run tour over the new Budgets panel (it now has 4 sections — a 30-second "what you're looking at" walkthrough would help new users). |
| Beauty | 9.7 | Animated chart transitions on slider drag (currently snaps; a 200ms easing would feel more demo-grade). |
| Intelligence | 9.6 | Vision-OCR'd receipts feeding back into Shopping Patterns auto-generation (Wave G recommendations don't yet incorporate receipt-level data). |
| Delightfulness | 9.7 | Celebration toast when the scenario crosses from "going negative" to "stays positive" — a real green moment for the user. |
| Completeness | 9.5 | Mobile parity for line chart + sliders (needs react-native-svg + slider deps). |
| Trust | 9.3 | Source-citations in chat answers (carried over). |
| Accessibility | 9.6 | Keyboard + screen-reader walk-through (carried over — axe doesn't catch focus-order regressions). |
| Performance | 8.9 | Gmail-status index + first-paint pass on Subscriptions panel (carried over). |

## Strategic recommendations — next session

### Same-day (≤1 hour each)

1. **Celebration toast when scenario goes positive.** Hook into the Sprint 47 `useCelebrate` infra. When the projection's 24mo net flips from negative to positive after applying a rec or sliding, fire a green moment with copy like "Nice — that scenario keeps you positive through 2 years."
2. **First-run tour callout on Budgets.** Sprint 46's setup checklist could grow a "Try the Budget projection" item that deep-links into a one-shot guided tour.

### Sprint-sized (1–3 hours)

3. **Mobile chart + sliders.** Add `react-native-svg` + `@react-native-community/slider`, port the web ProjectionChart and SliderRow components. Closes Completeness 9.5 → 9.7.
4. **Animated chart transitions.** When `scenario_points` change, lerp the path strings over 200ms instead of snapping. Pure-React with `requestAnimationFrame`; no library needed.
5. **Multi-goal contribution support.** Replace the global `monthly_investment_contribution_cents` slider with per-goal sliders that compose. Each goal rec sets its own contribution; total is summed.

### Bigger swing

6. **Receipt-vision → Shopping Patterns → Budget recs feedback loop.** When the vision OCR (Sprint 49) extracts line items, auto-update Shopping Patterns rollups and feed cross-store deal findings into the Budget recommender as a new `kind: "store_swap"` rec ("Swap from Whole Foods to Trader Joe's for groceries — save $X/mo at your current basket"). Closes the Intelligence loop the May-13 audit identified.

## Bottom line

Started at 95.4, ended at **97.2**. The Budgets panel went from 88 to 98 — biggest single-panel lift the audits have recorded. Wave G shipped 8 sprints in one session (G-1 through G-7 plus G-8b mobile partial), with one math bug caught live (the override-vs-budget-cap baseline issue) and fixed inside the same pass.

The remaining 2.8 points cluster around: mobile chart parity (Completeness), receipt-OCR feedback into recs (Intelligence), the first-run tour (UX), and the same Trust / Accessibility / Performance items carried from the morning audit. **Reasonable target for the next session: 98.5**, achievable by closing mobile parity + animated transitions + one celebration moment.
