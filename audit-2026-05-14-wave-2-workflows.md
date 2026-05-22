# Wave 2 — Workflow stress test (2026-05-14)

Eight critical user-decision workflows. Target: each must be answerable in <30 seconds. Hero workflows (WF 1-2) should be <10 seconds.

## Workflow scoring

| # | Workflow | Target | Actual | Verdict | Notes |
|---|----------|--------|--------|---------|-------|
| 1 | "Can I afford this $200 purchase tonight?" | <10s | **~5s** | ✅ Excellent | Land on Budgets, see SAFE TO SPEND, type into simulator. Verdict appears live. Best-in-class. |
| 2 | "Where's my money going this month?" | <15s | **~12s** | ✅ Good | Scroll past hero + projection, find Top 5 Spending card. Visible without leaving Budgets panel. |
| 3 | "Am I on track to my eTrade goal?" | <10s | **~15s** | ⚠️ Slow + WRONG | Goal Pace card says "on track" but uses `current_amount_cents = 0` even though eTrade balance is $400. Trust hole — answer is presented confidently but is wrong. |
| 4 | "What's my biggest spending leak?" | <15s | **~20s** | ⚠️ Ambiguous | "Biggest leak" could mean (a) largest spend in absolute terms (Top 5 → Rent), or (b) largest overspend vs cap (Smart Recs → Restaurants $519/mo). Currently the panel offers both but doesn't anchor on the more useful framing. |
| 5 | "Did I get paid this week?" | <10s | **~25s** | ❌ FAIL | Must navigate to Transactions panel, scroll/filter for Livio wires. No "latest paycheck" surface on Budgets / Overview / Cash Flow. |
| 6 | "Restaurants last month vs this month?" | <20s | **~30s** | ⚠️ Slow | MoM chip on Budgets shows the % delta but not raw dollars stacked. To see "April $X vs May $Y," must navigate to Trends panel. Click + scroll required. |
| 7 | "What subscriptions am I paying for that I forgot about?" | <30s | **~15s** | ✅ Good | Sidebar → Subscriptions. 20 active listed. Easy scan. |
| 8 | "Should I make a $500 investment trade — do I have liquidity?" | <20s | **~40s** | ❌ FAIL | No single "available liquid cash" surface. Must check Net Worth panel for checking balance ($15) AND mentally subtract any pending bills. No cushion / liquidity view. |

## Pass rate

- ✅ Pass: 3/8 (WF 1, 2, 7)
- ⚠️ Slow / partial: 3/8 (WF 3, 4, 6)
- ❌ Fail: 2/8 (WF 5, 8)

## Workflow trust deductions

- **WF 3 surfaces a wrong answer confidently** — biggest single trust hole found. The Goal Pace card claims "on track" without disclaiming that the $400 already in eTrade isn't being counted. **Trust −5.**
- **WF 5, 8 not answerable from Budgets panel** — forces user to multi-panel hunt. **Trust −3 each = −6.**
- **WF 4 ambiguity** — two interpretations, no anchor. **Trust −2.**
- **WF 6 needs raw-dollar MoM not just %** — currently slow. **Trust −2.**

## Total Wave 2 Trust impact: −15

## Recommended fixes (priority order)

1. **Fix Goal.current_amount to reflect actual eTrade balance** — most important. The "on track" message must be true.
2. **Add a "Latest paycheck" chip to Overview or Budgets hero** — "$3,620 from Livio · 14 days ago" closes WF 5.
3. **Add an "Available cash" / "Liquid" stat to the StatStrip** — closes WF 8.
4. **MoM chip expand-on-hover** — show "April $592 → May $X (−15%)" on hover. Closes WF 6.
5. **"Biggest leak" anchor** — auto-surface the largest overspend-vs-cap on the panel header. Closes WF 4 ambiguity.

## Best-in-class moments

- **SAFE TO SPEND + Quick Spend Simulator** is genuinely excellent. Better than any equivalent in RocketMoney/Monarch/Copilot. Daily-decision UX at its best.
- **MoM chips** on every category row are a nice density choice — RocketMoney's category view doesn't do this.
- **Wealth Pulse "Building wealth / Burning savings"** with verbal framing is a UX win over a raw "+/−$X" presentation.
