# Wave 3 — RocketMoney parity matrix (2026-05-14)

Feature-by-feature comparison vs RocketMoney (formerly Truebill). Verdict per row:
- **WIN**: we're better
- **TIE**: equivalent
- **LOSS**: they're better, gap exists
- **N/A**: not applicable

## The matrix

| Feature | RocketMoney | This app | Verdict | Notes |
|---------|-------------|----------|---------|-------|
| **Account linking (Plaid)** | ✓ via Plaid | ✓ via Plaid | TIE | Same backend, same coverage |
| **Bill negotiation service** | ✓ (they call providers to negotiate Internet/cable/etc.) | ✗ | LOSS | This is RocketMoney's flagship monetization. We can't beat them on the human-in-the-loop part, but we can replicate the *detection* of negotiable bills. |
| **Subscription tracking** | ✓ good but generic | ✓ + bundles + composite-charge unmask + LLM Gmail discovery | **WIN** | Our F-1/F-5/Sprint 16 work goes deeper. We catch Apple/Google composite charges and Gmail-only signal that RM misses. |
| **Subscription cancellation (1-click)** | ✓ they cancel for you | ✗ informational only | LOSS | They have negotiated agreements with providers. We can surface "here's the cancel URL" but can't act. |
| **Cash flow / upcoming bills** | ✓ basic timeline | ✓ Cash Flow panel + Coming Up + annual renewal prediction | **WIN** | Sprint 13/40 prediction logic gives us a multi-month look-ahead RM doesn't have. |
| **Spending insights / trends** | ✓ MoM breakdown | ✓ Trends panel + 6mo bars + top movers ≥+200% chips | **WIN (slight)** | Visualization parity, but our top-mover threshold detection (Sprint 11/22) is more aggressive. |
| **Budget tracking** | ✓ category caps | ✓ category caps + projection + what-if sliders + safe-to-spend hero + simulator + Wealth Pulse | **WIN (significant)** | Sprint G/H/I/J — they have caps, we have a decision-support system. The Quick Spend Simulator alone is a class above. |
| **Goal tracking** | ✓ savings goals | ✓ savings + debt-payoff goals + Goal Pace card + per-goal sliders in projection | **WIN** | Goal Pace explanation card ("hits target by [date] · X months late · need +$Y/mo") is a level deeper than RM. |
| **Auto-saving** | ✗ (RM doesn't auto-save) | ⚠️ tracks Albert/eTrade but doesn't move money | TIE | Neither moves money. We track external auto-savers; they don't. |
| **Net worth** | ✓ basic chart | ✓ Net Worth panel + Sprint 28 FIRE projection + dual projection lines | **WIN** | Our FIRE projection + dual projection (conservative/optimistic) on Budgets is more sophisticated. |
| **Credit score** | ✓ monthly score from TransUnion | ⚠️ CreditScoreSnapshot exists but no live tracking | LOSS | They have a paid pipeline to a bureau; we don't. Could integrate Credit Karma data or skip. |
| **Credit / Card offers** | ✗ | ✓ Card Offers panel | **WIN** | We surface card offers; they don't (at least not prominently). |
| **Transaction search / filter** | ✓ standard | ✓ standard | TIE | Both have filter/search. No standout. |
| **Transaction recategorize** | ✓ one at a time | ✓ one at a time + ML rules + Plaid PFC auto-mapper + Gmail cross-ref | **WIN** | Our 4-layer categorization (rule → PFC → Gmail → LLM) is much richer. |
| **Notifications / alerts** | ✓ push + email | ⚠️ in-app banners only | LOSS | We're web-only. No push. RM wins on mobile alerts. |
| **Email / receipt ingestion** | ✗ | ✓ Gmail OAuth + parsers + LLM-Gmail discovery + receipt OCR | **WIN (significant)** | Sprint 49 + Sprint 16 — RM has nothing like this. |
| **Bank statement parsing** | ✗ | ✓ BofA/Wells/Chase/Amex parsers | **WIN** | RM relies purely on Plaid. We supplement with email statements. |
| **Mobile app** | ✓ iOS + Android | ⚠️ partial (some panels only) | LOSS | Major gap. RM is mobile-first; we're web-first with mobile catching up. |
| **AI advisor / chat** | ✗ (no real AI chat yet) | ✓ Ask About Money via Ollama | **WIN** | Local LLM with full data context. Privacy + capability win. |
| **Data export / tax** | ✓ CSV | ✓ Tax export panel with categorization-aware splits | **WIN (slight)** | Both export. Ours is more tax-aware. |
| **Privacy / local-first** | ✗ cloud, sells anonymized data | ✓ "Secure · Local-only" badge in header | **WIN (decisive)** | Our data never leaves Chris's machine. RM monetizes via data + bill negotiation. |
| **Onboarding** | ✓ polished | ✓ First-run setup checklist (Sprint 46) | TIE | Both reasonable. |
| **Unclaimed property / class actions / etc.** | ✗ | ✓ Class Actions + Unclaimed Property + Card Benefits + Redress | **WIN (unique)** | RM doesn't surface these "money found" opportunities. |
| **Money found / hidden value** | ✗ | ✓ Money Found panel | **WIN** | Aggregates: bundle savings, store swaps, unclaimed property, class actions, annual renewals. Unique. |

## Tally

- **WIN: 13** (subscriptions, cash flow, trends, budgets, goals, net worth, card offers, recategorize, email/receipt, statement parsing, AI chat, data export, privacy, unclaimed/found)
- **TIE: 5** (Plaid, auto-saving, transaction search, onboarding)
- **LOSS: 5** (bill negotiation, subscription cancellation, credit score, mobile, notifications)
- **Score: 13W − 5L = +8** (significant net advantage)

## Where we're decisively better

1. **Daily-decision UX** (Budgets hero + simulator) — nothing in RM compares
2. **Money Found suite** — unique angle (class actions, unclaimed property, card benefits, bundle savings)
3. **Email / statement ingestion** — RM is Plaid-only; we cross-reference Gmail
4. **Privacy** — local-only is a differentiator for the privacy-aware buyer
5. **Categorization depth** — 4-layer (rule + PFC + Gmail + LLM) vs their generic ML

## Where we need to close gaps

1. **Mobile parity for Sprint H/I/J** (highest priority — RM is mobile-first)
2. **Bill negotiation detection** — even without the human-in-loop service, we can surface "your Comcast is X% above the average — call this number to negotiate" type recommendations
3. **Push notifications** — wire to email or SMS via SendGrid/Twilio
4. **Credit score live tracking** — integrate Credit Karma feed or similar (lower priority — we have CreditScoreSnapshot infrastructure already)
5. **1-click subscription cancellation links** — at minimum, store the cancel URL per service

## The pitch vs RocketMoney

> "RocketMoney sells you visibility and offers human-mediated cancellation. We give you visibility AND the math to make daily decisions yourself, plus three money-finding surfaces they don't have (class actions, unclaimed property, bundle savings), all without sending your data anywhere. The trade-off: no bill negotiation human, no 1-click cancellation. If you'd rather have **better decision tools** than **someone else doing the work for you**, we win."

This is a real positioning — and it matches a specific audience (someone who likes to drive, not someone who wants a chauffeur).
