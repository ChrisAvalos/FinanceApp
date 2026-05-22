# Finance App — Honest Scorecard (7-dimension audit)

**You called me out, fairly.** My earlier ratings folded delight, beauty, and efficiency into a single "Polish" score that hid real weaknesses. This rewrite uses 7 distinct dimensions and a strict rubric. Most scores went DOWN. That's the point.

## Rubric (calibrated against real products)

| Score | What it means | Reference points |
|---|---|---|
| **100** | Best in the world on this dimension | Linear, Stripe Dashboard, Things 3, Notion's best moments |
| **90** | Beats most commercial competitors | Mid-tier polished SaaS — Mercury, Ramp, Superhuman |
| **80** | Solid, ship-ready, has noticeable rough edges | Most YC-stage products at launch |
| **70** | Functional but obviously a side project | Self-hosted dashboards, Phoenix LiveView demos |
| **60** | Works but rough/incomplete | Internal tools, hackathon polish |
| **50** | Halfway there. Major gaps. | Very early MVP |
| **<50** | Broken or missing | — |

## Seven dimensions — what each measures

1. **Backend** — correctness, performance, robustness, observability, schema design
2. **Data correctness** — does the math work, are the numbers right, edge cases
3. **Ease of use** — clicks to common task, discoverability, onboarding, error recovery
4. **Beauty** — visual polish, alignment, color/typography choices, breathing room, design system consistency
5. **Delightfulness** — micro-interactions, animations, copy voice, surprise moments, personality
6. **Efficiency** — load speed, responsiveness, skeleton states, optimistic updates, bundle size
7. **Completeness** — handles empty/error/edge cases, surfaces own state, mobile parity

## Headline

| | Old (v3) | Honest |
|---|---|---|
| **Overall app** | 96 | **82** |

The honest number is much lower because:
- **Beauty: 75** average. The app is a clean Tailwind dashboard, not Linear. No custom typography (just system fonts). Generic navy palette. Inconsistent spacing across panels. No iconography system beyond emoji + Heroicons-default. This is what every shadcn/ui starter looks like.
- **Delightfulness: 62** average. Nearly zero animations. No skeleton screens (just "Loading…" text). No celebration moments. Copy is professional but interchangeable. No personality. No keyboard shortcuts. No command palette. No empty-state illustrations beyond emojis.
- **Efficiency: 73** average. React Query handles caching well, but: Prime takes 30+ seconds (synchronous scrapes), no skeleton states, full re-renders on mutations, no optimistic updates, bundle size unknown.
- **Ease of use: 78** average. Sidebar nav is fine for power users, overwhelming for new ones. 32 panels with no progressive disclosure. The new Prime button is good but most other features (bulk categorize, card-profile picker, inline categorize) require discovery.

Where the app is genuinely great is the **strategic stuff**: backend architecture, data correctness, the Money-on-the-Table aggregator, FIRE projection. Those are 90+ and not contested. But on the dimensions you specifically called out — beauty, delight, ease of use, efficiency — the app is a solid 75.

---

## Foundation layer

| | Backend | Data | UX | Beauty | Delight | Efficiency | Complete | **Avg** |
|---|---|---|---|---|---|---|---|---|
| **Backend architecture** | 92 | 95 | — | — | — | 78 | 85 | **88** |
| **Database / data model** | 90 | 92 | — | — | — | 80 | 85 | **87** |
| **API surface** | 88 | 92 | 75 | — | — | 75 | 80 | **82** |
| **Categorization engine** | 92 | 90 | 88 | 75 | 65 | 70 | 88 | **81** |
| **Plaid integration** | 88 | 90 | 80 | — | — | 78 | 85 | **84** |
| **Scheduler** | 88 | 88 | 60 | — | — | 88 | 82 | **81** |
| **Local-first / privacy** | 92 | — | 88 | 80 | 70 | 90 | 88 | **85** |
| **Visual design system** | — | — | 78 | **72** | **60** | — | 70 | **70** |

**Visual design system 70.** Hardest read. It's *clean* but not *designed*. The light theme is generic SaaS-blue. The "Chase-style navy" is not actually Chase's navy — it's a generic Tailwind blue-700. Typography is system-ui everywhere. No type scale (no clear h1/h2/h3 hierarchy). Cards are 1px borders + bg-card. There's no "this is the Finance App look" — it could be any Vercel template.

**Categorization engine delight 65.** It works correctly but the inline "+ Categorize" → ✓ ROT created · 12 rows match toast is the ONLY moment of delight. No animation when the row updates. No celebration sound. No streak counter ("you've categorized 38 rows today!").

---

## Daily-use panels

| Panel | Backend | Data | UX | Beauty | Delight | Efficiency | Complete | **Avg** |
|---|---|---|---|---|---|---|---|---|
| **Overview** | 88 | 92 | 82 | 75 | 65 | 78 | 88 | **81** |
| **Ask AI (chat)** | 85 | 80 | 80 | 70 | 75 | 60 | 78 | **75** |
| **Today's moves** | 88 | 90 | 85 | 75 | 70 | 78 | 85 | **82** |
| **Money found (MoT)** | 92 | 92 | 88 | 80 | 75 | 80 | 90 | **85** |
| **Net worth** | 88 | 92 | 82 | 75 | 60 | 78 | 80 | **79** |
| **Attribution** | 92 | 90 | 82 | 78 | 65 | 75 | 88 | **81** |
| **Cash flow** | 88 | 88 | 78 | 70 | 60 | 75 | 82 | **77** |
| **Budgets** | 85 | 88 | 78 | 72 | 65 | 75 | 82 | **78** |
| **Savings & goals** | 85 | 85 | 78 | 75 | 70 | 75 | 80 | **78** |
| **FIRE projection** | 95 | 95 | 88 | 78 | 75 | 78 | 90 | **86** |
| **Credit** | 85 | 88 | 78 | 70 | 60 | 75 | 80 | **77** |

**Honest reads:**

- **Overview 81.** Hero is good. Recent transactions table is utilitarian. The "Find money on the table" CTA is the most delightful thing on the page, and that's a single hero card. No skeleton on initial load. No animation when categories update.
- **Ask AI 75.** The tool-use planner is impressive backend work, but the UI is a basic chat with no streaming, no markdown rendering for tables, no history sidebar, no per-message copy/regenerate. Compared to Claude / ChatGPT it's bare-bones.
- **FIRE 86.** The strongest panel. Monte Carlo + pinned year + SWR slider is genuinely clever. Beauty is OK (chart is functional, not gorgeous). Delight is OK because the controls feel responsive. But it's still a static chart, not interactive (no hover tooltips on the wealth curve).
- **Money found 85.** The strategic concept is 95. The execution is 80 — cohort tabs are fine, ROI-per-minute ranking is the right idea, but the rows look like a generic table. No urgency cues for time-sensitive opportunities.
- **Cash flow 77.** Forecast events list is a plain table. The running-balance chart is a basic SVG line, no axis labels, no hover. Crunch days are red dots with no animation. A YNAB-grade product would make this beautiful.
- **Net worth 79.** Account list is fine. The chart is now properly guarded for low snapshots (the +5 from last wave). But the chart itself is a basic SVG. No allocation pie, no asset class drift visualization.
- **Credit 77.** Utilization bar is functional. Score history is one-line text. No score-vs-time chart. No "what's pulling your score down right now" callout. CreditWise / Credit Karma both look better.

---

## Opportunities panels

| Panel | Backend | Data | UX | Beauty | Delight | Efficiency | Complete | **Avg** |
|---|---|---|---|---|---|---|---|---|
| **Card offers** | 78 | 75 | 70 | 70 | 55 | 70 | 70 | **70** |
| **Class actions** | 90 | 88 | 85 | 80 | 70 | 78 | 85 | **82** |
| **Redress (CFPB)** | 78 | 80 | 78 | 72 | 60 | 75 | 78 | **74** |
| **Unclaimed property** | 70 | 70 | 70 | 72 | 60 | 75 | 65 | **69** |
| **Card benefits** | 90 | 92 | 85 | 78 | 70 | 78 | 88 | **83** |
| **Yield optimization** | 90 | 90 | 80 | 72 | 60 | 80 | 85 | **80** |
| **Cross-store deals** | 75 | 78 | 70 | 70 | 55 | 70 | 65 | **69** |

**Honest reads:**

- **Card offers 70.** All scrapers report auth_missing today. There's no in-app guided bootstrap — just an empty list with a Scan button that returns nothing. Compared to AwardWallet / Card Pointers, this is wireframe-tier.
- **Class actions 82.** Settlemate-inspired UX is the best in this section. State filter + 3-tab proof status works. Beauty is OK. Delight is low — no "you might be eligible for $X" ranking against the user's own spend.
- **Unclaimed property 69.** No NAUPA scrape, just manual entry. Honest score reflects the panel is mostly empty + uninspiring.
- **Yield optimization 80.** Now has live FRED rates (this wave). Math is correct. UI is a list of products. No animations when rates update. No "set alert when 4w T-bill crosses 5.0%" feature.

---

## Tracking panels

| Panel | Backend | Data | UX | Beauty | Delight | Efficiency | Complete | **Avg** |
|---|---|---|---|---|---|---|---|---|
| **Holdings (Empower-style)** | 85 | 88 | 80 | 75 | 60 | 75 | 78 | **77** |
| **HSA receipts** | 82 | 80 | 75 | 72 | 60 | 72 | 70 | **73** |
| **Card applications** | 85 | 85 | 82 | 75 | 70 | 75 | 82 | **79** |
| **Subscriptions** | 90 | 88 | 82 | 75 | 65 | 78 | 85 | **80** |
| **Shopping patterns** | 80 | 78 | 75 | 72 | 60 | 75 | 72 | **73** |
| **Product catalog** | 78 | 78 | 72 | 70 | 60 | 75 | 70 | **72** |
| **Tax export** | 88 | 90 | 82 | 75 | 60 | 78 | 85 | **80** |
| **Trends (MoM)** | 88 | 88 | 80 | 72 | 60 | 75 | 80 | **78** |
| **Anomaly detection** | 90 | 88 | 82 | 75 | 70 | 78 | 85 | **81** |
| **Heatmap (calendar)** | 88 | 90 | 82 | 80 | 70 | 78 | 82 | **81** |
| **Merchants drill-in** | 85 | 85 | 78 | 72 | 60 | 75 | 78 | **76** |
| **Receipts (OCR)** | 82 | 80 | 75 | 72 | 65 | 72 | 72 | **74** |

**Honest reads:**

- **Subscriptions 80.** The backend is excellent (type classifier, price-change tracking, retention playbook). UI is a sortable list with confirm/dismiss. No comparison-to-typical chart. No "5 cheaper alternatives" inline.
- **Tax export 80.** Math fix landed (Untagged ≤ Total outflow). Default year correct. CSV download works. But there's no "this is what you owe" forecast, no Schedule C breakdown, no TurboTax-import format.
- **Anomaly detection 81.** σ-based explanations are excellent. Now feeding notifications. But the panel itself is just a list of flagged transactions — no per-transaction "approve / dismiss" buttons, no rule learning ("never flag this merchant again").
- **Heatmap 81.** GitHub-style calendar grid is the most visually interesting panel in the app. Day-of-week stats are a nice touch. But day cells are non-interactive (no click-to-drill), and there's no week / month aggregation toggle.

---

## Cross-cutting

| Feature | Backend | Data | UX | Beauty | Delight | Efficiency | Complete | **Avg** |
|---|---|---|---|---|---|---|---|---|
| **Notifications** | 85 | 82 | 78 | 72 | 60 | 75 | 80 | **76** |
| **Connections (banks)** | 88 | 90 | 85 | 78 | 70 | 78 | 85 | **82** |
| **Sidebar nav** | — | — | 82 | 80 | 65 | 90 | 78 | **79** |
| **Empty states** | — | — | 78 | 75 | 60 | — | 75 | **72** |
| **Loading + error states** | — | — | 65 | 60 | 50 | 70 | 60 | **61** |
| **Inline categorize-this** | 92 | 90 | 92 | 80 | 80 | 88 | 92 | **88** |
| **Bulk categorize wizard** | 92 | 90 | 92 | 80 | 78 | 85 | 90 | **87** |
| **Prime everything** | 90 | 88 | 88 | 80 | 75 | 65 | 85 | **82** |
| **Auto-prime daily** | 88 | 88 | 70 | — | — | 88 | 80 | **82** |
| **Mobile (RN/Expo)** | 80 | 80 | 75 | 70 | 60 | 70 | 65 | **71** |

**Honest reads:**

- **Loading + error states 61.** The single lowest score. 4 of 21 panels use the shared component. The rest still show `<div>Loading…</div>`. Errors usually result in stale state or a broken-looking panel. This is the biggest UX paper-cut at the app level.
- **Inline categorize-this 88.** The most delightful feature in the app. Picker → instant feedback ("✓ Rule created · 12 rows match"). The cascade is satisfying.
- **Mobile 71.** Honest. Has 22 screens but lacks the new web features (bulk wizard, Prime button, card-profile picker, best-bonuses shelf, inline categorize). Not visually verified this session.
- **Notifications 76.** Down from my earlier 87. Yes the producer now writes to the table — but the panel itself displays them as a plain list with no priority sorting, no swipe-to-dismiss, no native OS notifications, no email/SMS routing. The infrastructure is good; the surface is plain.
- **Sidebar nav 79.** Solid for power users. 32 entries is a lot. No fuzzy search (Cmd+K). No customizable order. No collapsing groups.

---

## What pulls the overall average down

These are the dimensions where average scores are below 75:

- **Delightfulness 62 average.** The single biggest opportunity. Concrete fixes:
  - Skeleton screens replace "Loading…" everywhere
  - Animated number transitions (CountUp.js or similar) on hero stats
  - Confetti / haptic when a goal hits a milestone
  - Streak counter for daily-moves completion
  - Per-panel hero copy with personality (currently all generic)
  - Tasteful empty-state illustrations beyond emojis
  - Cmd+K command palette
  - Keyboard shortcuts (G then O for Overview, G then T for Transactions, etc.)
  - Sound effects (optional, off by default) for major actions
  - Easter egg: type "kaching" or "show me the money"
- **Beauty 73 average.** Concrete fixes:
  - Custom typography (Söhne, Inter Variable, or something with personality)
  - Distinct color palette beyond Tailwind navy (a card-issuer-style brand color)
  - Real type scale (h1 vs h2 vs h3 hierarchy enforced by component)
  - Iconography system (Lucide consistently used everywhere — currently mixed)
  - Per-panel hero illustration / data-driven background graphic
  - Table styling — alternating rows / hover states / sortable indicators
- **Efficiency 73 average.** Concrete fixes:
  - Skeleton screens (covered above too)
  - Optimistic updates on common mutations (categorize, confirm, dismiss)
  - Code-splitting per panel
  - Debounced search inputs
  - Backend: precompute MoT report on schedule instead of on read
  - Background-fetch Prime (return immediately + WebSocket progress) instead of synchronous 30+ second wait

---

## Single-line answer (no inflation)

**App: 82 / 100 honestly.**

Strengths: Backend architecture, data correctness, FIRE, Money-on-the-Table, inline+bulk categorize, the strategic concepts.

Weaknesses: Delightfulness, Beauty, and Loading/Error states pull the average down hard. The app is a great power-user tool that needs a designer-pass to feel like a 95+ product.

The single highest-leverage change for the score: **a real designer pass** with custom typography, distinct color palette, skeleton screens, and 3-4 micro-interactions. That alone would move the average ~7 points across the board.
