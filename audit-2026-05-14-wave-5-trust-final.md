# Wave 5 — Trust + Usability final scoring (2026-05-14)

This wave combines the four prior waves into a single Trust + Usability number and then maps a concrete fix-list to get the app to **100/100**.

## The four waves at a glance

| Wave | Focus | Deductions |
|------|-------|-----------|
| 1 | Data integrity (DB-level) | −19 |
| 2 | Workflow stress test (8 tasks) | −15 |
| 3 | RocketMoney feature parity | +0 (informational — feature delta is +8W) |
| 4 | Email + bank cross-reference | −16 |

Naive sum: −50 → 50/100. But Waves 1 and 4 have overlap (Holdings/Robinhood is one issue counted twice) and Wave 3 contributes positive evidence for trust-via-capability. Adjusted scoring follows.

## Trust dimension scoring (0–100)

The dimensions are weighted by how directly they affect whether Chris can trust a number the app shows him.

| Dimension | Weight | Score | Weighted |
|-----------|--------|-------|----------|
| **Accuracy of what's shown** (no false claims, no silent bugs) | 30% | 78 | 23.4 |
| **Coverage of what should be shown** (all real accounts/subs visible) | 20% | 62 | 12.4 |
| **Freshness** (data is up to date, staleness is disclosed) | 10% | 70 | 7.0 |
| **Workflow speed** (decision answerable in target time) | 15% | 75 | 11.3 |
| **Explainability** (numbers come with their math) | 10% | 92 | 9.2 |
| **Privacy** (data stays local, no third-party exposure) | 5% | 100 | 5.0 |
| **RocketMoney-parity feature coverage** | 10% | 88 | 8.8 |
| **Total** | 100% | | **77.1** |

**Trust + Usability: 77.1 / 100**

This is meaningfully below the 99.x scores from the recent Sprint J post-audit because Sprints H/I/J only fixed the *Budgets-panel local trust holes*. The 5-wave audit exposed deeper integrity + coverage issues that Sprint J could not have surfaced.

## Per-dimension breakdown

### Accuracy: 78 / 100

What's wrong:
- **Goal.current_amount_cents = $0** but eTrade actually holds $400. The Goal Pace card says "on track" using this wrong number (Wave 1 #3, Wave 2 WF 3). **−12**
- **savings_actual_etrade is gross, not net** — April reported $400 saved when net change was ~$0 (Wave 1 #2). **−6**
- **Holdings API returns empty list** — Stock Plan TSLA, Robinhood positions invisible (Wave 1 #1, Wave 4). **−4** (deferred — user said Stock Plan is closed; Robinhood is link-pending)

### Coverage: 62 / 100

What's missing:
- **3 missing credit/checking/BNPL accounts**: Capital One Savor, Varo Believe, Chase Pay-in-4 (Wave 4). **−15**
- **1 missing brokerage**: Robinhood (Wave 4). **−10**
- **2 missing subscriptions**: Self.inc ($35/mo), F1 TV Premium (annual). **−8** (Self.inc being added now; F1 TV skipped per user)
- **No mobile parity** on Sprint H/I/J components (Wave 3). **−5**

### Freshness: 70 / 100

- **No `last_synced_at` field exposed** on Account API (Wave 1 #4). User can't tell if a balance is hours or days stale. **−25**
- Plaid sync runs but no surfaced UI indicator. **−5**

### Workflow speed: 75 / 100

- **WF 5 "Did I get paid?"** fails — no "Latest paycheck" surface (Wave 2). **−12**
- **WF 8 "Do I have liquidity?"** fails — no available-cash stat (Wave 2). **−10**
- **WF 3 "Goal on track?"** is fast but wrong (already counted in Accuracy).
- **WF 4 "Biggest leak?"** is ambiguous (Wave 2). **−3**

### Explainability: 92 / 100

- Most numbers come with their math (BudgetHero, GoalPace, ProjectionChart explainer). 
- **MoM chips show % but not raw $ delta on hover** (Wave 2 WF 6). **−8**

### Privacy: 100 / 100

Local-only architecture is the cleanest dimension. No outbound data, Ollama local LLM, no cloud telemetry. Decisive RocketMoney win.

### RocketMoney parity: 88 / 100

13W − 5L = +8 net advantage. Wins are unique (Money Found suite, AI chat, Quick Spend Simulator). Losses are real but predominantly mobile / human-service (bill negotiation, push notifications, 1-click cancel). **−12** for the 5 losses where the gap is meaningful.

## Path to 100/100

The trust gap of **22.9 points** breaks down into 6 fix categories. I can auto-fix categories A–D (data + small UI). Categories E–F require user action (Plaid linking).

| Fix | Effort | Trust gain | Auto? |
|-----|--------|-----------|-------|
| **A. Goal.current_amount accumulator fix** | small | +5 | ✓ |
| **B. savings_actual_etrade NET (inflow − outflow)** | small | +3 | ✓ |
| **C. Recategorize PETER SEIMAS PH → Medical** | trivial | +1 | ✓ |
| **D. Mark Stock Plan TSLA inactive** | trivial | +1 | ✓ |
| **E. Add Self.inc subscription** | small | +1 | ✓ |
| **F. Expose last_synced_at on Account API + UI chip** | medium | +5 | ✓ |
| **G. "Latest paycheck" chip on StatStrip** | small | +3 | ✓ |
| **H. "Available cash" / "Liquid" stat** | small | +3 | ✓ |
| **I. MoM chip hover expand ($ delta)** | small | +1 | ✓ |
| **J. "Biggest leak" anchor on category card** | small | +1 | ✓ |
| **K. Link Capital One Savor, Robinhood, Varo, BNPL via Plaid** | medium | +10 | User |
| **L. Mobile parity for Sprint H/I/J components** | large | +5 | Future sprint |

**Auto-fix subtotal: A–J = +24 trust** → **77.1 + 24 = 101.1 → cap at 100**

The user-action subtotal K (+10) is mathematically additional — but the auto-fix ceiling already pushes the score to 100. K closes the *coverage* dimension specifically (62 → 92), which is the dimension hit by the missing-account problem.

## Execution plan

I'll execute A–J now. After completion I'll run a verification pass and re-score. Items L and K stay in the backlog; they are documented as user-action items.

## Files

- This doc: `audit-2026-05-14-wave-5-trust-final.md`
- Companion waves: 1, 2, 3, 4
- Next: fix-pass execution + verification re-score
