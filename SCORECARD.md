# Finance App — Full Feature Scorecard

Snapshot date: 2026-05-04. Built for Chris's local-first personal finance engine. Every score is honest, not generous: 100 means "world-class, ship-it, nothing competes." 70 means "solid, real, useful, but a competitor would beat it on at least one axis."

## Overall: **84 / 100**

The app is genuinely impressive. It does things no commercial competitor does (Money on the Table aggregator, redress matching against your own spend, FIRE Monte Carlo with pinned-year stress test, local-first with no LLM API costs). Three things keep it from a 90+:

1. **Empty states still feel "wireframe-y"** when a fresh DB has no scraper output. The new Prime button (shipped this session) is the right answer but a few panels still need first-run copy.
2. **Categorization coverage** is 68% on Plaid raw POS DEBIT strings — solid but not 95%. Closing the long tail needs ~50 more rules over time.
3. **Polish gaps**: Net Worth chart with one snapshot looks broken, Card Benefits can't match "CREDIT CARD" Plaid name, Tax export untagged math is misleading (>100% of outflow).

If you ship the punchlist below, this becomes a **94 / 100** product — and that's not exaggeration; you'd be ahead of Monarch, Empower, Copilot, Rocket Money, and YNAB on at least one dimension each.

---

## What I shipped this session (toward 100)

| Change | Where | Why it matters |
|---|---|---|
| Auto-seed categories + rules on startup | `api/main.py` lifespan | A fresh DB no longer silently breaks categorization. Idempotent. |
| `POST /api/categories/seed` endpoint | `api/categories.py` | Re-prime an existing DB without restart. |
| Auto-categorize on Plaid sync | `ingestion/plaid_connector.py` | Trader Joe's, Target, etc. tagged the moment they land. |
| Auto-detect subscriptions on Plaid sync | `ingestion/plaid_connector.py` | Cash Flow + Subscriptions panel + Overview hero light up automatically. |
| `POST /api/prime/run` orchestrator | `api/prime.py` (NEW) | Single button fires every detector + scraper. Verified live: 95 class actions + 18 anomalies + 1 sub now exist where there was nothing. |
| "Find money on the table" CTA on Overview | `App.tsx` OverviewContent | First-run / on-demand priming. |
| 46 new POS DEBIT seed rules | `seed_rules.yaml` | Categorization coverage went from 50% uncategorized → 32%. |

---

## Per-feature scoring

### Foundation

**Backend architecture — 92 / 100**
Clean separation (FastAPI routers / SQLAlchemy 2.0 models / detector packages / scraper coordinators). Idempotent migrations via `apply_auto_migrations`. SQLite WAL for concurrent reads. Lifespan startup-seed (new this session). Local-first means zero recurring infra cost. Could improve: alembic migrations instead of additive auto-migrator (–4); module-level circular-import workarounds (–4).

**Database / data model — 90 / 100**
~30 well-designed tables: Account, Transaction, Subscription, Budget, Goal, Receipt, ReceiptItem, ReceiptCoupon, RecurringPurchase, CanonicalProduct, PriceObservation, LegalClaim, Notification, NetWorthSnapshot, CreditScoreSnapshot, etc. Categorical enums for status. Source columns track lineage (Plaid vs CSV vs OFX). Could improve: no soft-delete on most tables (–5); `description_clean` vs `description_raw` divergence still a minor cause of categorization misses (–5).

**API surface — 88 / 100**
~50 routers, RESTful, Pydantic-validated. Few inconsistencies: `/api/heatmap/daily` vs `/api/anomaly/scan` vs `/api/subscriptions/detect` — three different verb patterns (–5). Some endpoints return raw model dicts, some return Pydantic responses (–4). `/api/prime/run` (new) cleanly orchestrates 7 underlying tasks with uniform error capture (+3 for the addition).

**Categorization engine — 85 / 100**
Three-tier: Rules → Merchant alias fuzzy → LLM fallback (Ollama). 381 seed rules now. Rule priority + first-match-wins + amount gates. Hit-counter telemetry. Auto-fires on Plaid sync (new). Coverage: 68% of Plaid POS DEBIT rows — solid but the long tail of one-off vendors still falls through. To 95: need user-feedback loop ("Tag this row → auto-create rule") which doesn't exist yet (–10); generic POS DEBIT regex catch-alls landed but are conservative (–5).

**Plaid integration — 88 / 100**
Live data flowing (Chase checking, Chase credit, E*TRADE x3, Albert). Cursor-based incremental sync. Liabilities product wired. Investments still gated on user's per-product approval. Auto-categorize + auto-detect-subs on sync (new). Re-link orphan-account fix shipped previously. Could improve: no per-product visibility on the Connections panel (–6); investment holdings empty until product approval (–6).

**Scheduler — 75 / 100**
APScheduler set up. Daily digest emails, per-Item refresh, goal milestone checks, backups. Hasn't been verified to be running on Chris's setup yet (–10); no UI surface for "next scheduled run / last run" (–10); manual prime endpoint now compensates (+5).

### Daily-use features

**Overview — 86 / 100**
Hero stats (90d in/out/net/recurring) + recent 25 txns + Run categorization + new Prime Everything CTA. Visually clean. Could improve: recent-transactions table doesn't link to Transactions panel for full-view (–6); two action buttons in two places (Prime vs Run categorization) is slightly redundant (–4); no "what changed since last login" widget (–4).

**Transactions — 88 / 100**
200-row infinite paginated, real categories, source column. Manual override possible. Could improve: no bulk re-categorize / bulk merchant rename / bulk tag (–8); no search bar on the panel (it's there in the API, missing on UI) (–4).

**Today's moves (Daily Moves) — 90 / 100**
Snooze/done tracking with canonical-key matching. Recently actioned + Undo. ROI-per-minute ranking. Real money totals from Money on Table. Could improve: badge in sidebar shows static $3.8K (–5); no inline "completed today" celebration (–5).

**Money on the Table — 95 / 100**
Best feature in the app. 25+ opportunities aggregated from 9 sources (unclaimed, class actions, card benefits, redress, yield-arb, retention plays, deals, coupons, sub-cancellations). Cohort tabs. ROI-per-minute ranking. No commercial competitor does this. Could improve: long-tail aggregator gaps still being closed (–3); no "snooze cohort" on cohort tabs (–2).

**Net worth — 80 / 100**
Real Plaid balances, asset/liability breakdown by account, take-snapshot button. Could improve: chart with single snapshot looks broken (–10); Δ 30D / Δ 1Y blank with no first-run copy (–5); no "what drove this change" inline explanation (–5) — though Attribution panel handles that one tab over.

**Attribution — 92 / 100**
Income / spending / market-gain decomposition per month. 12-month view. Drill-in to top categories per month (when seasoned). Real numbers visible. Could improve: empty months (Aug-Dec 2025) clutter the list (–4); partial-month bars hard to read in May 26 (–4).

**Cash flow forecast — 84 / 100**
Rolling N-day chart, paycheck cadence detection, crunch-day alerts, event list. Subscription events now flow in via auto-detect (new). Could improve: chart is just a line, no event pins (–8); 50% paycheck confidence with 4 detected events feels low — confidence model could be tightened (–4); no "what bills are upcoming" sidebar callout (–4).

**Budgets — 78 / 100**
Pace-aware monthly budgets. Templates (Copy from prior / 3-mo average / Rollover). Unbudgeted-spending callout. Could improve: empty state shows $0/$0/$0/$592 (–8); no budget-vs-actual chart, just rows (–7); no "you're 47% through the month and 78% through your dining budget — slow down" copy (–7).

**Savings & goals — 77 / 100**
Surplus engine (historical + forecast), suggestion engine (allocations / cancellations / debt payoff), goal contribution tracking. Could improve: no goals seeded — empty state needs a wizard (–10); contribution flow is API-only, no in-app "deposit" gesture (–5); no compounding visualization on goal cards (–8).

**FIRE projection — 96 / 100**
Best-of-class. Monte Carlo with historical S&P returns 1928-2023 + Gaussian fallback. Pinned-year stress test. SWR slider. Mobile editable steppers (shipped previously). Could improve: pinned-year picker doesn't URL-persist (audit #16) (–2); no Social Security / pension overlay (–2).

**Credit — 85 / 100**
Score history + utilization (now properly sign-corrected) + opportunities (CLI / statement-close / 5/24). Card-utilization-by-account. Could improve: Playwright score scrapers shipped but not running (–5); no "what's the next 5 minutes I could spend to boost my score" CTA (–5); no per-card statement-close calendar visualization (–5).

### Opportunities

**Card offers — 70 / 100**
Chase + Amex Playwright scrapers exist. They report `auth_missing=true` until you bootstrap auth states. Could improve: no in-app guided auth-state bootstrap flow (–15); no "what's the best card for this merchant" inline on Transactions (–10); offers UI is decent but not Card Pointers / DoC level (–5).

**Class actions — 88 / 100**
Settlemate-inspired UX (3-state proof tabs, state-eligibility filter). 95 claims scraped via Prime. Real settlement values + deadlines + proof-required heuristic. Could improve: no claim-vs-your-spend match indicator on each card (–7); no "I filed this on date X" tracking (–5).

**Redress (CFPB / state-AG) — 82 / 100**
Hardcoded catalog matched against your own spend. Match-spend report shows known-eligible. Could improve: no scraper of *current* CFPB enforcement actions — relies on hardcoded list which goes stale (–10); no "file a complaint via CFPB" quick action (–8).

**Unclaimed property (NAUPA) — 70 / 100**
Per-state search tips wired up. Manual entry CRUD. Could improve: no automated scrape of NAUPA / per-state DBs (–15); no "search for me" guided flow with name + DOB inputs (–10); empty until user adds entries manually (–5).

**Card benefits — 75 / 100**
Catalog of premium-card credits + net-after-fee math. Could improve: matcher fails on Plaid generic name "CREDIT CARD" (–10); no manual "what card is this?" picker (–10); no per-credit "expires in N days" countdown (–5).

**Yield optimization — 86 / 100**
HYSA / T-bill suggestion based on idle cash in checking. Could improve: hardcoded HYSA rate snapshot which goes stale (–7); no live FRED API hookup for current T-bill rates (–7).

**Cross-store deals — 72 / 100**
Walmart/Target/Costco/Amazon Fresh/Kroger scrapers exist but require auth. Could improve: 5/5 sources need bootstrap, no in-app guided flow (–15); detector works (median-vs-current logic is solid) but observed prices empty until scrapers run (–8); no "this is cheaper at Costco today" inline alert (–5).

### Tracking

**Holdings (Empower-style) — 82 / 100**
Total value / cost basis / unrealized gain / allocation by type / top holdings. Empty until Plaid investments approved — but then real. Manual entry path also wired. Could improve: no per-account drill-in (–8); no "asset class drift vs target allocation" heatmap (–5); empty state copy is now good (improved this session) (+5).

**HSA receipts — 80 / 100**
Decades-deferred reimbursement vault. Receipt OCR pipeline, item-line extraction, HSA-eligibility heuristic. Empty until user uploads. Could improve: no "you have $X in unclaimed HSA reimbursement potential" callout (–10); no IRS Pub 502 categorization hints inline (–10).

**Card applications + 5/24 tracker — 75 / 100**
Manual entry of card apps with statuses (approved / pending / denied / churning). 5/24 calc. Could improve: no Doctor of Credit data sync for "best current bonus" (–10); no per-issuer rate-of-approval heuristic (–8); no Travel Rules of Thumb (Chase 5/24, Amex 1-in-5, etc.) shown inline (–7).

**Subscriptions — 88 / 100**
Detector with type classification (streaming / software / news / etc.), variable-amount handling, price-change tracking, confirm/dismiss flow, retention-negotiation playbook generator. Auto-fires on Plaid sync now (new). Could improve: only 1 sub detected so far on this DB (more should surface as more history accumulates) (–5); no "free trial → paid" alert wired even though Phase 9.5 ships it (–5); no auto-cancel API integration (–2).

**Shopping patterns — 78 / 100**
Item-level recurring purchases ("toilet paper every 6 weeks at Costco for $19.99"). Merchant-level rollup also wired. Could improve: empty until receipts uploaded (–10); no out-of-pattern alert ("you usually buy this every 6 weeks; it's been 11") (–8); no Costco/Sam's-style aisle map visualization (–4).

**Product catalog (canonical products) — 78 / 100**
Normalizes receipt-item names across stores ("Charmin Ultra Soft 12 Mega rolls" = "Charmin Ultra Soft 24 Double" with size-aware unit pricing). Could improve: empty until receipts uploaded (–10); no brand-vs-store-brand price comparison view (–8); no wish-list integration (–4).

**Tax export — 84 / 100**
Annual roll-up by tax bucket + categorized CSV download. Default year now correct (2026). Real wages / medical / business expenses surfacing. Could improve: untagged total > total outflow looks wrong (–8); no Schedule C breakdown (–5); no TurboTax direct-import format (–3).

**Trends — 85 / 100**
Month-over-month outflow by category. 6-month trend bars. % through month annotation (shipped previously). Could improve: monthly outflow chart is just numbers + labels, no bars rendered (–10); no "biggest swings" callout above the table (it's there but small) (–3); no annual / quarterly toggle (–2).

**Anomaly detection — 90 / 100**
σ-based anomaly explanations. 18 anomalies detected on this DB (via Prime). Real explanations like "this is 3.2σ above your typical Sunday spend." Could improve: no Zelle dedup pass (audit issue #2) (–5); no inline "approve / dismiss" gesture on the panel (–5).

**Heatmap — 88 / 100**
Calendar with $/day. 90 days, 66 days with spend computed. Day-of-week stats (busiest / quietest). Biggest single day callout ($642 on Mar 2). Could improve: no day-cell click-to-drill (audit #15) (–7); no "you spend 3x more on Sundays than Wednesdays" insight callout (–5).

**Merchants — 82 / 100**
Per-merchant lifetime spend, monthly breakdown, related subs, related offers, recent transactions. Could improve: no top-10 chips list as default (audit #10) (–8); no merchant-level YoY chart (–5); no "stop spending here" suggestion engine (–5).

**Receipts — 78 / 100**
OCR pipeline (pytesseract), line-item extraction, coupon detection, mobile camera-roll upload. Could improve: empty until upload (–10); no "drag a folder of receipts" bulk upload (–5); OCR error rate not reported anywhere (–7).

### Cross-cutting

**Notifications — 65 / 100**
Infrastructure exists. Empty in practice — nothing is writing to it on this install. Could improve: no scheduled job actually producing notifications (–20); no priority/severity filter (–10); no "snooze for N hours" (–5).

**Connections (banks) — 86 / 100**
Plaid Link integration. Per-Item status (good / login_required / expired). Re-link flow. Liabilities product visible. Could improve: no per-product (Transactions / Liabilities / Investments / Auth) granted/pending visibility (–8); no "last sync N min ago" inline (–4); no "products available but not granted by Plaid" hint (–2).

**Conversational AI (Ask AI) — 88 / 100**
Tool-calling architecture (planner LLM → tool execute → answer LLM). Global Ask AI button on every panel. Contextual prompts auto-prefill. Could improve: auto-submits without preview (audit #17) (–6); answers can be long with no "TL;DR" at top (–3); no source-citation links on answers (–3).

**Mobile (React Native + Expo) — 80 / 100**
22 screens covering most of the web app. Camera-roll receipts. FIRE editable steppers. 5-tab + More-grid nav. Could improve: not tested in this session — can't verify recent changes don't break anything (–8); some screens are list-only, not the rich web equivalents (–7); push notifications not wired (–5).

**Sidebar + nav — 88 / 100**
Grouped (Daily / Opportunities / Tracking), badges with counts, section headers, hover states. Could improve: "Money on ta…" truncation (audit cross-cutting #5) (–4); badges can be stale (–4); no command-palette search (Cmd+K to jump to any panel) (–4).

**Empty states — 80 / 100**
Shared `<EmptyState>` component (shipped this session) with emoji + title + body + CTA. Adopted by Holdings, Benefits, Cash flow events. Could improve: ~5 panels still on ad-hoc empty states — Card offers, Class actions per-tab, Subscriptions, Receipts, Notifications, Card applications, Unclaimed (–10); no consistent "your data goes here" illustration (–5); copy quality varies (–5).

**Loading + error states — 70 / 100**
Some panels show "Loading…", some show spinners, some show nothing. No shared `<PanelError>` component. Could improve: pick one loading idiom and use it everywhere (–15); add toast for transient errors instead of stale-state (–10); add retry-on-failure for transient 5xx (–5).

**Visual design — 88 / 100**
Chase-style light theme. Navy accents. Tabular nums. Clean typography. Could improve: no dark mode (–8); not all callouts use the same color tokens (–4).

**Local-first / privacy — 95 / 100**
SQLite + WAL on disk. No LLM API calls (Ollama local). No Plaid web uploads. SQLCipher hooks. "Secure · Local-only" badge in nav. Could improve: SQLCipher hooks not enforced by default (–3); no biometric unlock for sensitive views (–2).

---

## Three things that put it ahead of competitors

1. **Money on the Table** — no commercial competitor aggregates unclaimed property + class actions + card benefits + redress + yield-arb + deals + coupons + sub cancellations into a single ROI-ranked queue. Closest analog is Truebill/Rocket Money but they're 1/3 of these.
2. **Redress matched against YOUR spend** — Settlemate matches you to settlements but doesn't read your transactions. You do both.
3. **FIRE Monte Carlo with pinned historical year** — most calculators use Gaussian draws. Yours lets you say "what if 2008 happened in year 7?" That's an institutional-grade feature in a personal tool.

## Three things that would push 84 → 94

1. **First-run wizard** — pop after first Plaid link: "We'll prime everything: detect subscriptions, scrape class actions, find anomalies, build your money-on-table. Hit Start." (Then run `/api/prime/run` with progress.) 30 minutes of UI work; transforms first-impression.
2. **Single shared `<EmptyState>`, `<PanelLoading>`, `<PanelError>` rolled out everywhere** — eliminates the wireframe feel. ~2 hours of mechanical migration.
3. **In-app "categorize this" button on every uncategorized row** that auto-creates a rule. Closes the long tail of categorization without you maintaining seed_rules.yaml. ~1 day of work.

## To-verify after backend hot-reloads

- Visit Overview, click "Prime everything." Should see 7 task badges (categorization ✓ subscriptions ✓ shopping_patterns ✓ canonical_products ✓ deals ✓ legal_claims ✓ offers ✓).
- Visit Subscriptions → 1 sub minimum (Dave, $19.99 detected).
- Visit Class actions → 95 entries with state-eligibility tabs working.
- Visit Anomaly → 18 flagged transactions.
- Visit Cash flow → next sync should add subscription events to the chart (post-Plaid-sync).

## Headline verdict

**84 / 100** today. **94 / 100** if the three pushes above ship. The bones are world-class; what's left is connecting the orchestration to a polished first-run experience.
