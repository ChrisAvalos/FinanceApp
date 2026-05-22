# Wave 4 — Gmail + bank cross-reference (2026-05-14)

Cross-referenced the app's known accounts and subscriptions against the user's Gmail (receipts, statements, subscription renewals) and bank statement mentions. Goal: catch what the app is *missing* that real-world email evidence shows is active.

## Method

Three Gmail searches over the last ~60 days:

1. `receipt OR invoice OR "your order" after:2026/04/01`
2. `subscription OR renewal OR "your subscription" after:2026/03/01`
3. `(CapitalOne OR Robinhood OR Amex OR Chase) AND ("statement is available" OR "balance" OR "payment due") after:2026/03/01`

Then compared every account / merchant surfaced against:
- The 8 accounts the app has linked (Albert ×3, Chase CC, E*TRADE ×3, TOTAL CHECKING)
- The 22 detected subscriptions

## 🔴 Missing accounts (not linked to app)

| Account | Evidence | Trust impact |
|---------|----------|--------------|
| **Capital One Savor** credit card | Capital One statement notification (2026-05-10) — "Your statement is available" | Net worth + spend coverage gap. Card transactions invisible. **−4** |
| **Robinhood** (active investing) | Multiple shareholder notices: NVDA proxy vote, USPE IPO allocation, VTV/VONG/EMXC/SPMO prospectuses (March–May 2026) | Net worth misses invested balance + holdings. Holdings API already returns []. **−4** |
| **Varo Believe Card** (credit builder) | Statement notification email | Net worth + credit utilization invisible. **−2** |
| **Chase Pay-in-4** (accounts ...5004, ...0320) | Multiple Chase Pay-in-4 installment notifications | Possibly BNPL liability that doesn't appear as a balance. **−2** |

**Subtotal: −12 trust**

The Capital One Savor and Robinhood gaps are the most material — the user has an actively traded brokerage and an active credit card whose transactions are completely absent from spend categorization, MoM trends, and net worth.

## 🟡 Missing / outdated subscriptions

| Subscription | Email evidence | Current app state | Action |
|--------------|---------------|-------------------|--------|
| **F1 TV Premium** | Renewal notice — expires 2026-05-17 | Not in Subscriptions panel | Add (annual cadence) |
| **Hopper** | Email confirming cancellation 2026-05-12 | Not in Subscriptions panel | N/A — already canceled, but worth showing as "recently canceled" |
| **Google Home Premium / Nest Aware** | Trial / signup confirmation | Not in Subscriptions panel | Confirm with user — trial may auto-convert |
| **iLearntoHunt** | Course purchase receipt | Not in Subscriptions panel | Likely one-time — confirm |
| **Self.inc credit builder** (acct ...6689) | $35 due 2026-05-18 | Not in Subscriptions panel | Add (monthly cadence) |
| **Peacock TV** (via Apple receipt 2026-05-07) | Apple composite charge line item | Should be in Subscriptions if Apple receipt parser ran | Verify F-3 Apple parser captured this |
| **RevenueCat** receipts | Multiple in April–May | These are app-store metadata, not subscriptions | Filter out — false-positive risk |

**Subtotal: −4 trust** (Self.inc + F1 TV are the meaningful misses; the others are confirmations or edge cases)

## 🟢 Confirmed (working as intended)

- **Costco orders** — categorized as Groceries correctly
- **ACE Parking voucher** — one-time, correctly not flagged as subscription
- **Chase Credit Card ...0483** — IS the linked Chase CC. Statement ($2,098.09, due 6/9, min $50) matches app data ✓
- **Apple receipt parser** — caught the May 7 receipt with composite line items (this is the F-3 work paying off)

## What Wave 4 reveals about the data integrity dimension

The app has been measured against the 8 accounts and 22 subscriptions it knows about — but the Gmail cross-reference says the user has **at least 11 accounts** (8 linked + 3 missing) and **24+ active subscriptions** (22 detected + Self.inc + F1 TV).

This means:
- Net worth is **systematically understated** (missing Robinhood positions)
- Credit utilization is **completely uncomputed** (missing two credit cards)
- Spend categorization is **missing a card's worth of transactions** (Capital One Savor)
- Subscription total is **understated by ~$50/mo** (Self.inc $35 + F1 TV pro-rated)

These are coverage gaps, not bugs — but for a "100% trustworthy" target, they matter as much as logic errors.

## Total Wave 4 Trust impact: −16

## Recommended fixes (priority order)

1. **Link Capital One Savor via Plaid** — biggest single coverage win
2. **Link Robinhood via Plaid** — fixes Holdings API + net worth
3. **Add Self.inc and F1 TV to Subscriptions** — either via Gmail parser extension or manual add
4. **Link Varo Believe + Chase Pay-in-4** — lower priority but completes the picture
5. **Verify Apple parser captured Peacock TV** from the 2026-05-07 receipt

## User resolutions (2026-05-14)

- **Capital One Savor**: Link via Plaid ✓ (user will perform link)
- **Robinhood**: Link via Plaid ✓ (user will perform link)
- **Varo Believe + Chase Pay-in-4**: Link both via Plaid ✓ (user will perform link)
- **Self.inc**: Add to Subscriptions ✓ (Claude to data-fix)
- **F1 TV Premium**: Skip (user chose not to add)

All four missing-account groups are confirmed as real and tracked-intent. Plaid linking is a credentialed action only Chris can perform, so these stay as documented Trust deductions until linked. The Self.inc subscription is added programmatically below.

## Files

- This doc: `audit-2026-05-14-wave-4-email-bank-crossref.md`
- Next: Wave 5 — Trust scoring + final re-eval
