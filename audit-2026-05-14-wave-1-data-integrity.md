# Wave 1 — Data integrity audit (2026-05-14)

## Summary stats

- **479 total transactions** — all Plaid-sourced, all categorized
- Date range: 2026-01-29 → 2026-05-13 (~3.5 months)
- 470 categorized by rule, 9 manual (FU-2 Valeria + K-6 Albert)
- **8 accounts**, all active (Albert ×3, Chase CC, E*TRADE ×3, TOTAL CHECKING)
- **22 subscriptions** (20 active, 2 dismissed, 0 suspected)
- **6 Livio paychecks** in 90 days totaling $21,150 (avg $3,524/check)
- **14 other inflows** totaling $4,314 (settlements, peer transfers, eTrade refunds, CC payment reversals)
- **0 future-dated, 0 null-dated, 0 uncategorized** ✓

## Issues found (by priority)

### 🔴 Critical (block trust = 100)

**1. Holdings API returns `[]`** — Stock Plan (TSLA) shows $0 cash but the Holdings table is empty. If real TSLA / brokerage positions exist with market value, they're missing from starting net worth. **Trust impact: −5.**

**2. `savings_actual_etrade` is gross, not net** — Only sums positive inflows on the eTrade account. In April there was a $400 deposit + $400 withdrawal; the calc reported $400.43 saved when actual net change was ~$0. **Trust impact: −4.**

**3. Goal `current_amount_cents` is $0 but eTrade has $400 balance** — Goal lifetime accumulator never updates. GoalPace card uses this number, so its "on track" claim is unreliable. **Trust impact: −3.**

### 🟡 Medium

**4. No `last_synced_at` field on account records** — can't verify balance freshness. Plaid update may be hours/days stale. **Trust impact: −2.**

**5. Albert detection is partial** — K-4 catches May Smart Save sweeps correctly ($147), but historical months Feb/Mar/Apr have 14, 15, 8 Albert-related transactions respectively that weren't analyzed:
- Some are Genius subscription fees (5 found, $19.99/mo each)
- Some are Albert Cash inflows BACK to checking (the algorithm returning funds — net negative savings periods)
- Net flow into Albert savings/investing may be negative across full window
**Trust impact: −3.**

### 🟢 Minor

**6. PETER SEIMAS PH is in Subscriptions** at $200/14d ($400/mo)
- Description: "Peter Seimas Ph. Avalos, C" — looks like a recurring payment to a person, not a SaaS
- May be medical/therapy/coaching — needs user clarification before counting as a subscription
**Trust impact: −2 (pending clarification).**

**7. False-positive duplicate detector hit** (no actual fix needed): txns 802 + 803 are two distinct $0.53 FX fees for different foreign purchases on the same day. Long descriptions differ past char 30.

### ✅ Things working well

- Income detection (Livio filter) — 6/6 paychecks identified, 0 false positives
- Rent attribution working correctly across Feb/Mar/Apr/May
- Categorization quality on sample (30 random) looks ~95% accurate
- All transactions categorized somehow (0 unset)
- Subscription detection mostly accurate (22 detected including subscriptions Chris has confirmed)

## Trust score impact

Baseline 100 − 19 deductions = **~81 on data integrity dimension alone**.

The big lifts: Holdings, savings_etrade net, Goal accumulator, freshness timestamps.

## Files

- This doc: `audit-2026-05-14-wave-1-data-integrity.md`
- Next: Wave 2 workflow stress test
