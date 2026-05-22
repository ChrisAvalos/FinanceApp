# Finance App — Roadmap to "actual working app"

Originally decided 2026-04-27. Goal: take the app from "demo dashboard
with sandbox data" to "this is the app I check every morning instead of
Rocket Money."

Hard constraints carry over from the project memory: app NEVER moves
money, no LLM API costs, every recommendation includes before/after math.

---

## Where we actually are (state as of 2026-04-28 evening)

The original roadmap below is preserved for context, but most of it
has shipped. Quick reality check:

| Phase | Status |
|---|---|
| Phase 1 — Plaid prod | 🟡 Approval **in hand**; needs `.env` flip + first Connect |
| Phase 2 — Polish round | ✅ All 3 logged findings fixed, 200+ categorization rules |
| Phase 3 — Gmail T1 + T2 parsers | ✅ 18 parsers shipped + T3 Ollama fallback |
| Phase 4.1 — Statement-close optimizer | ✅ Tier-ladder paydown plan |
| Phase 4.2 — CLI heuristic | ✅ Portal-specific scripts |
| Phase 4.3 — Credit-score scrapers | ✅ **Just shipped** — CK + CreditWise + Credit Journey + bootstrap helper + daily cron + smoke test |
| Phase 4.4 — Best-card-for-merchant | ✅ 11 card profiles, leakage report |
| Phase 5.1 — Chase + Amex Offers | ✅ Both portals + matcher + value-rank |
| Phase 5.2 — Retention playbook | ✅ Type-specific scripts + outcome log |
| Phase 5.3 — Insights narrator | ✅ Local Ollama weekly digest |
| Phase 5.4 — T3 Ollama fallback | ✅ Uncategorized merchants written back as user-rules |
| Phase 6 — Glue + automation | ✅ Daily digest, per-Item refresh, milestones, backups, SQLCipher |
| Phase 7 — "things every other app has" | ✅ All 6 sub-phases (net worth, cash flow, pace, tax, merchant deep-dive, annual review) |
| Phase 8 — Money on the table | ✅ All 6 sub-phases + 9 source kinds + cohort tabs |
| Phase 9 — Empower-style depth | ✅ All 5 sub-phases (holdings, HSA, anomaly, heatmap, free-trial alerts) |
| Phase 10 — Shopping intelligence | ✅ All 5 slices (receipts, patterns, coupons, deals, canonicalization) |
| Phase 7 (the second one) — Mobile | ✅ Full parity, 28/28 screens, 5+More nav model |

**What's actually left:**

1. **Plaid prod activation** (you flip `.env`, I confirm + verify Investments product hookup at the same time)
2. **Plaid Investments product wired to the holdings sync path** (model is ready)
3. **Rollover budgets exposed in `/api/budgets/rollup`** (column exists, not surfaced)
4. **Mobile camera-roll receipt upload** (`expo-image-picker` + `expo-camera`; paste-text works today)
5. **On-device shakedown** with real Plaid prod data — held until #1 lands

The original phase-by-phase plan below is kept verbatim for historical
reference, in case you ever want to remember why a particular decision
was made.

---

## Phase 1 — Real data (your task in parallel)

### What you do (Plaid production application)

Plaid production isn't a one-click upgrade — it's an approval process.
Estimated wall time: 1–2 business days for review, plus ~30 minutes of
your time on the form. While that's processing I'll be working on Phase 2
below.

1. Go to https://dashboard.plaid.com/team/keys (sign in with the same
   account you used for sandbox).
2. Top-right of the keys page, click **Request Production Access**.
3. Plaid asks a short application form covering:
   - **Use case**: "Personal finance dashboard for my own accounts. No
     other users. Read-only access to transactions and account balances
     for budgeting, credit utilization tracking, and recurring-charge
     detection. App never initiates transfers or moves money."
   - **Data retention**: Locally, on my own machine, in an encrypted
     SQLite file. Never transmitted to any third party.
   - **Number of users**: 1 (yourself).
   - **Estimated # of Plaid Items**: however many real banks you'll
     link — count Chase + Amex + savings + investment accounts. Probably
     5–8.
4. Submit. Plaid usually responds within 1–2 business days.
5. **When approved**, the dashboard will show a new `secret` for the
   `production` env. Copy three things:
   - `PLAID_CLIENT_ID` (same as sandbox, but production-enabled now)
   - `PLAID_SECRET` (the production-specific one)
   - The `production` env name

### What I do (when you've got the approval)

Update `backend/.env`:

```
PLAID_ENV=production
PLAID_CLIENT_ID=<your-prod-client-id>
PLAID_SECRET=<your-prod-secret>
```

Restart uvicorn. Bank Connections panel will now hit Plaid's prod
endpoints. You'll click **Connect a bank**, real Plaid Link modal
appears, you log in to Chase / Amex / etc with your real credentials,
your real transactions land. From then on the daily flow is just "open
the app, the data is current."

### Cost note

Plaid prod pricing is per-Item per-month, currently ~$0.30 / account /
month under "Item-based pricing" (or ~$0.50 / month under transactions-
only pricing — they keep changing this). For 5–8 linked banks you're
looking at $1.50–$4.00 / month total. The fees only apply to live
production Items; sandbox stays free forever.

---

## Phase 2 — Polish round (~1 day)

While you wait for Plaid approval, I knock out the three logged
findings and harden the data layer for what's coming.

- **Fix #100 — TopClassActions scraper grabs site nav.** The `<a>`
  selector is too broad; tighten to only listing-detail anchors. Add a
  fixture-based test against the current TopClassActions HTML. Re-run
  on your data, expect noise rows to drop from 14 to 0.
- **Fix #102 — detector misses subs whose price change happened
  mid-history.** Add a second outlier-removal pass that tries
  `amounts[1:]` (oldest is the outlier), not just `amounts[:-1]`. Adds
  Netflix-style retroactive price hikes to the detector's coverage.
- **Beef up categorization rules from 60 patterns to 200+.** Add
  common SF/Bay Area merchants (since that's where you live based on
  the seed I built), nationwide chains (Trader Joe's regional codes,
  Whole Foods 365, McDonald's franchise numbers), and the long tail
  Plaid normally returns (most merchants come back with format
  `MERCHANT*FRANCHISE LOCATION` so we need pattern variants).
- **Add per-rule hit counters** so the rule-management UI can show you
  which rules fire most often. Useful when manually adding new ones.

---

## Phase 3 — Phase E parsers (Gmail coverage gap, ~2–3 days)

Today only 2 of 500 fetched emails parse. The fix is layered.

- **T1 (specific senders)**: add bespoke parsers for Chase alerts
  (8 distinct subject patterns: payment due, statement available, large
  purchase alert, autopay set up, etc.), Credit Karma score updates,
  Experian score updates, Capital One alerts, Amex alerts, Discover
  alerts.
- **T2 (cross-sender regex)**: extend `subscription_promo` to a
  general-purpose `financial_alert` parser with regex for "score
  available", "statement ready", "payment due in N days", "large
  purchase $X", "balance update".
- **Coverage target**: get the parse rate from 0.4% to >40% on a
  typical month's Gmail. The remaining 60% will be genuinely irrelevant
  (newsletters, marketing, personal emails) — that's expected.

This phase unblocks Phase 5 (offer detection) since most offer-bearing
emails come from these same senders.

---

## Phase 4 — Phase C credit ops (~1 week, biggest unique value)

This is THE differentiator vs Rocket Money / EveryDollar / Copilot.
None of them do this. All of it is deterministic math + Playwright,
no LLM needed.

### 4.1 — Statement-close-day optimizer

For each credit card, given (current_balance_cents,
last_statement_balance_cents, statement_close_day, credit_limit_cents),
compute and surface:

- "Pay $X by day N to drop your reported utilization from Y% to Z%"
- Projected score impact (use the FICO cliff table — 1%, 10%, 30%, 50%
  — already wired in the panel)
- "If you don't act, expected reported utilization on close = X%"
- The "before / after / no-action" trio you've already established as
  the project's UX standard.

### 4.2 — CLI (credit-limit-increase) opportunity heuristic

Watch for patterns that indicate a likely-approved CLI request:

- Account ≥ 12 months old
- 6+ months of on-time payments
- Utilization regularly hitting 30%+ on this card (suggests headroom
  would be useful)
- Income increase signal (paycheck-deposit amount up vs. 6 months ago)

Surface as a card on the Credit panel with a "What to say when you call"
script and the issuer's specific CLI request portal URL.

### 4.3 — Score-tracking with manual + scraped sources

Phase A shipped the manual entry form. Add Playwright scrapers for
Credit Karma + Capital One CreditWise + Chase Credit Journey to pull
your scores without you typing them. Scrapers run on a daily cron
(reuse the APScheduler infra). Manual entry stays as the override path.

### 4.4 — Best-card-for-this-merchant suggestion

Given your (categorized) spend pattern + the rewards profile of each
linked card (Chase Sapphire 3x dining, Amex Gold 4x grocery, etc.),
flag transactions where you used the wrong card. "You spent $400 at
Whole Foods on Sapphire (1x = $4 back). Amex Gold would have given
you $16 back. You left $12 on the table." Don't reinvent: cards have
public reward profiles you can encode as YAML once.

---

## Phase 5 — Phase E offer detection + insights narrator (~1 week)

Requires Phase 3 parsers (Gmail signal coverage) and ideally Phase 1
(real Plaid spend data).

### 5.1 — Chase Offers + Amex Offers scraper (Playwright)

Both portals show your "available" + "added" offers. Scrape them daily.
Cross-reference each offer's merchant against your last 90 days of
spending; surface as a card if expected savings exceed $5/month.

### 5.2 — Retention offer playbook

For subscriptions you've flagged "Cancel or downgrade", generate a
**negotiation script**: opening line, leverage points (your real usage
history pulled from txns + emails), counter-offers to ask for, fallback
to "OK then I'll cancel." Plus an outcome log (you record what they
offered, whether you accepted) so the playbook gets smarter over time.

### 5.3 — Insights narrator (local Ollama, T3 fallback)

Once a week, run llama3.1 over the past week's data + uncategorized
emails to produce 3–5 sentences of plain-English insight: "Your
delivery spend jumped 147% this month — that's $173 vs your $87 average.
Three new subscriptions you haven't reviewed yet. Your Chase Sapphire
utilization is 47% — pay $X by April 28 to drop it under 30% before
statement close." Email it to yourself, render in the dashboard.

### 5.4 — T3 fallback for uncategorized merchants

Same Ollama pipeline, batch-classify any merchant the rule-set missed.
Write the result back as a high-priority user-rule so it's fast next time.

---

## Phase 6 — Quality + automation glue (~3 days)

- **Daily digest email**: surplus snapshot, new offers, score change,
  CLI opportunities. One email at 7am, locally generated.
- **Per-account auto-refresh**: once Plaid prod is live, hourly Plaid
  sync + on-demand "Refresh now" button per Item.
- **Goal milestone notifications**: when surplus contribution would
  cross a target (50%, 75%, 100%), surface in the dashboard.
- **Backup + restore**: weekly automatic SQLite backup to a folder you
  designate, plus restore-from-backup CLI command. Important when
  you're trusting this with real financial data.
- **Encryption at rest**: switch SQLite to SQLCipher (drop-in
  replacement; the password lives in the OS keychain via
  `python-keyring`). Acceptable for v1 to ship plain SQLite; encryption
  is a hard requirement before iPhone sync.

---

## Phase 7 — Mobile re-queue

Whenever you have time on the MacBook. Scaffold is already in `mobile/`,
just needs `eas build --platform ios --profile development` once.
Multi-screen port (Subscriptions, Goals, Credit) is a screen-per-sitting
unit of work after the dev build is installed.

---

## Recommended sequence

I'm going to work in this order, since each phase unblocks the next:

1. **Phase 2 — Polish** (1 day) — quick wins, unblocks cleaner Phase 5 demo.
2. **Phase 3 — Gmail parsers** (2–3 days) — unblocks offer detection.
3. **Phase 4 — Credit ops** (1 week) — biggest unique value, no deps.
4. **Phase 5 — Offer detection + narrator** (1 week) — needs 3 + ideally 1.
5. **Phase 6 — Glue + automation** (3 days) — final polish.
6. **Phase 7 — Mobile** — when you're at the Mac.

You'll have Plaid prod approval back during Phase 3 or 4. We swap
sandbox → prod in `.env`, you click Connect, and from that point on the
features being built operate against your real spending.

Total real-clock estimate: ~3 focused weeks. You can reorder freely —
e.g. if Phase 5 (offers) is what excites you most, we do it first
and accept that Phase 3 (parsers) becomes a hard dependency we knock
out concurrently.
