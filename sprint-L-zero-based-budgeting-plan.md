# Sprint L — Zero-based budgeting ("every dollar a job")

## The user goal

> "this needs to basically give all my money an assignment so that i can truly understand what my spending habits look like and what i need to change"

This is classic zero-based budgeting (the YNAB / "Give Every Dollar a Job" model). The app already has the building blocks — income, category caps, savings goal targets, debt accounts — but they're scattered across pieces. Sprint L unifies them into a single **assignment ledger** that adds up to your income and shows you exactly what's left over (or what's over-committed).

## What success looks like

After Sprint L, the Budgets panel has a new "Plan" section that shows:

```
INCOME (recurring):                                $7,049.83
─────────────────────────────────────────────────────────────
ASSIGNED:
  ▶ Committed bills        (rent, utilities, …)  $3,162.00   ← click to expand
  ▶ Variable spending      (groceries, eats, …)  $2,830.00
  ▶ Savings goals          (eTrade)                $400.00
  ▶ Debt paydown           (Chase CC min)           $50.00
  ─────────────────────────────────────────
  Total assigned                                $6,442.00

UNASSIGNED:                                       +$607.83
  💡 Where should this $608 go? (rec engine suggests options)
```

And the same view with a "vs actual" toggle to show drift:

```
                    PLANNED     ACTUAL    DRIFT
Committed bills    $3,162.00  $2,847.50  −$314.50  (under)
Variable           $2,830.00  $4,206.40  +$1,376    (over ⚠️)
Savings            $400.00    $0.00      −$400      (missed)
Debt               $50.00     $50.00     $0
```

And a 3-month history strip so habit patterns become visible.

## Phased implementation

### L-1 — Backend `AssignmentLedger` schema + endpoint

New endpoint: `GET /api/budgets/assignment-ledger?month_start=YYYY-MM-DD`

Response shape:

```python
class Assignment(BaseModel):
    kind: Literal["committed", "variable", "savings", "debt", "unbudgeted_actual"]
    label: str
    planned_cents: int       # what user committed to
    actual_cents: int        # what actually happened so far this month
    category_id: int | None  # for committed/variable
    goal_id: int | None      # for savings
    account_id: int | None   # for debt
    is_paid: bool            # for committed bills — has it landed this month?

class AssignmentLedgerResponse(BaseModel):
    month_start: date
    income_cents: int                    # recurring_income (Livio only)
    irregular_income_cents: int          # Dave/Venmo/settlements — info only
    assignments: list[Assignment]
    total_assigned_cents: int            # sum of planned
    total_actual_cents: int              # sum of actual
    unassigned_cents: int                # income − total_assigned (can be negative)
    history: list[MonthHistorySummary]   # last 3 months: assigned vs actual
```

Pulls from existing rollup logic — most data is already computed; we're just re-shaping it.

### L-2 — Frontend `AssignmentLedgerCard` (read-only first)

New component placed between StatStrip and "Net worth — projected" on the Budgets panel.

Features:
- Income headline ($7,049.83)
- Grouped, collapsible assignment rows (4 kinds)
- Stacked horizontal bar visualization showing the assignment slices
- Footer: "Unassigned: ±$X" with color (green surplus / red deficit)
- "vs Actual" toggle in the header → shows drift columns

Click any group to expand and see the per-category breakdown.

### L-3 — Inline rebalance (interactive)

Each row gets a small "Edit" affordance. Click → inline input to change the planned amount. Saving:
- For committed/variable: PATCH the Budget cap
- For savings: would touch the Goal's target rate (if we add the fixed-target column) or its target date
- For debt: PATCH the linked Account's min payment override

Unassigned auto-recalculates as you edit.

### L-4 — "Where should this go?" suggestion modal

When unassigned > 0 and the user clicks the surplus chip, open a modal with smart suggestions:
- "Bump eTrade savings from $400 to $1,008/mo — hits goal 8 months earlier"
- "Apply $400 extra to Chase CC — clears the $2,098 balance 5 months earlier"
- "Add $200 to Restaurants (you've been over by ~$200 every month)"
- "Hold as buffer" — explicit "keep unassigned" option

When unassigned < 0, open a different modal: "You're over-committed by $X. Where do we cut?" with ranked trim suggestions from the existing recommender.

### L-5 — 3-month drift history

Below the ledger, a strip showing the last 3 months. For each month: planned vs actual per kind, color-coded.

This is where "I want to understand my spending habits" pays off — repeated over-spending in the same buckets becomes visually obvious.

### L-6 — Mobile parity

Port AssignmentLedgerCard to the mobile Budgets screen. Same data, simpler interactions (no inline-edit modal; tap a row to navigate to the category view).

## Things that are NOT in scope for Sprint L

- Multi-month forward planning (e.g. "I want to save $X by next year, distribute across months") — that's Sprint M.
- Envelope-style rollover (unspent variable money rolls into next month) — adds DB schema for rollovers, scope creep.
- True multi-user support — single-user only.

## Open questions (need answers before starting)

These will shape the implementation. I'll ask via AskUserQuestion next.

1. **Granularity:** Show all 31 categories flat, or grouped with click-to-expand?
2. **Placement:** Where on the Budgets panel does the ledger live?
3. **Interactivity level for v1:** Read-only first, or inline-edit from day one?
4. **History strip:** Include in v1, or defer to L-5 as a follow-up?

## Effort estimate

- L-1 (backend): 1–2 hours
- L-2 (frontend read-only): 2–3 hours
- L-3 (interactive): 2–3 hours
- L-4 (suggestion modal): 1–2 hours
- L-5 (history strip): 1–2 hours
- L-6 (mobile parity): 2–3 hours

Total: ~10–15 hours of focused work. Realistically a 2-day push.

## Why this is the right move

You currently have great DESCRIPTIVE views ("you spent $X this month") and a great DECISION view (Safe to spend hero). What's missing is the PLANNING view — committing each dollar to a job before the month starts. That's the loop that actually changes spending habits, because every overspend becomes "I broke my own plan," not just a number on a screen.

This is also the single thing RocketMoney does *worse* than YNAB. We can have both.

## Memory

Save to: `sprint_l_zero_based_budgeting_status.md`
