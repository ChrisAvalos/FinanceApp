# Sprint O — One source of truth for budget numbers

## The problem this fixes

The app shows the **same quantity as different numbers in different
places**. Confirmed live on 2026-05-20:

- **Income**: hero / stat strip / Fixed-Bills footer say **$7,240**;
  The Plan card says **$7,159.07**. Same page.
- **This month's outcome**: the EOM card says May ends **−$632**; the
  6-month projection's first month says **−$2,093**.
- **Fixed obligations**: the Fixed Bills card says **$2,531**; The
  Plan's "Committed" total says **$3,600**.

Root cause: the app grew feature-by-feature across Waves D–O. Each new
card/endpoint **re-derived** income, spending, and projections instead
of reading from one shared computation. Four endpoints
(`rollup`, `assignment-ledger`, `project_budgets`, `recurring-bills`)
each have their own copy of "what did Chris earn / spend this month."
They drift.

Sprint N fixed this for *transaction classification* (one
`EnrichmentService`). Sprint O does the same for *dollar aggregates*.

## The architectural shift

Create **one module that computes a month's canonical financial
figures**, and make every endpoint read from it instead of recomputing.

```python
# backend/finance_app/budgets/monthly_financials.py  (NEW)
@dataclass(frozen=True)
class MonthlyFinancials:
    month_start: date
    # income
    income_landed_cents: int          # paychecks posted this month
    income_expected_total_cents: int  # landed + still-expected
    income_recurring_avg_cents: int   # 90-day Livio avg (for FUTURE months)
    other_income_cents: int           # windfalls (Brigit etc.)
    # spending — all catchall-excluded ("real")
    committed_actual_cents: int
    variable_actual_cents: int
    real_actual_cents: int            # committed + variable
    # projection
    committed_remaining_cents: int    # bills still due before EOM
    variable_eom_estimate_cents: int  # pace-extrapolated
    eom_projected_outflow_cents: int
    # savings, balances
    savings_actual_cents: int
    liquid_balance_cents: int

def compute_monthly_financials(db, month_start, *, today=None) -> MonthlyFinancials: ...
```

Rule: **a dollar figure is computed in exactly one place.** If a panel
needs income, it reads `MonthlyFinancials.income_*`. No endpoint
re-sums transactions for a number this module already provides.

## Phases

### O-1: The `monthly_financials` module
New file `backend/finance_app/budgets/monthly_financials.py`. Lift the
income + real-spend + EOM math out of `rollup` into one
`compute_monthly_financials()`. Built on the Sprint N
`EnrichmentService` for classification. **New file → no `budgets.py`
edits → no truncation risk.**

### O-2: Rollup reads from O-1
`rollup` calls `compute_monthly_financials()` instead of its inline
math. **Zero output change** — `rollup` already computes these numbers
correctly; this is a refactor so it's the same source everyone else
uses. Verify rollup JSON is byte-identical before/after.

### O-3: assignment-ledger reads from O-1  → fixes punch-list #1
The Plan card's income becomes `income_expected_total` ($7,240),
matching the hero. The income mismatch disappears.

### O-4: project_budgets reads from O-1  → fixes #2, #3, #5
The projection's monthly outflow currently is a raw 90-day average
that counts credit-card payments / transfers / investment
contributions as "spending" — it never adopted the Sprint-H "real
spending" exclusion. Switch it to `MonthlyFinancials.real_actual` +
`eom_projected_outflow`. This fixes the −$632 vs −$2,093 contradiction
AND means a removed recurring bill stops being extrapolated.

### O-5: Reconcile "Fixed bills" vs "Committed"  → fixes #4
Decide one definition. Recommended: the Fixed Bills card (recurring
detector, evidence-based) is the source; The Plan's "Committed" group
shows the same total. Surface the gap as "unbudgeted fixed bills" if
the recurring detector finds bills with no matching budget cap.

### O-6: Label the current-vs-future income distinction  → fixes #6
Future projection months legitimately use the 90-day recurring average
(you don't have "landed" paychecks for July yet). Label it so it
doesn't read as a bug: "Projected on your typical $7,159/mo income."

### O-Z: Re-run the consistency audit
Re-pull every endpoint, confirm income / outflow / EOM all agree
across rollup, ledger, projection, recurring-bills. The punch list
goes to zero.

## Scope, risk, mitigation

**Scope:** ~1–2 sessions. Touches `budgets.py` (rollup, assignment-
ledger, project_budgets all live there).

**Risk:** `budgets.py` is 2500 lines and the Edit tool has repeatedly
truncated it mid-write this session.

**Mitigation:**
- O-1 is a brand-new file — no risk.
- O-2/O-3/O-4 edits to `budgets.py` are SMALL (swap a block of inline
  math for a function call). Each edit: make it, then immediately
  `python3 -c "import ast; ast.parse(...)"` and recover via the
  read/rewrite method if truncated.
- After each phase, re-run the live consistency check in the browser.

## What Sprint O does NOT cover

- Net Worth / Cash Flow / FIRE panel cross-checks — flagged in the
  audit as "couldn't verify"; a follow-up audit pass.
- The recurring-detector ↔ Plan-card auto-sync (a bill you confirm in
  one place auto-creating a budget line) — Sprint P.

## Success criteria

After Sprint O:
1. Income is ONE number for the current month, everywhere on Budgets.
2. The EOM card and the projection chart agree on the current month.
3. The projection excludes catchalls (no more credit-card-payment-as-
   spending inflation).
4. "Fixed bills" and "Committed" reconcile.
5. Re-running the consistency audit finds zero mismatches.

## Sequencing

O-1 → O-2 → O-Z(partial: verify rollup unchanged) → O-3 → O-4 → O-5 →
O-6 → O-Z(full). Pause for verification after O-2 and after O-4.
