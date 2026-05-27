"""Shared helpers for the budgets API modules.

Helpers used by 2+ feature modules (rollup, assignment-ledger, rebalance,
templates) live here so each feature module can import a single source of
truth. Module-private helpers stay alongside their endpoint.
"""
from __future__ import annotations

from calendar import monthrange
from datetime import date

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Account,
    AccountType,
    Budget,
    Category,
    Goal,
    GoalContribution,
    GoalStatus,
    Transaction,
)

# Re-export classifier aliases so feature modules and downstream callers
# (notably ``finance_app.budgets.projector``) keep their existing import
# paths working. The "_is_*" prefix is preserved purely for back-compat.
from finance_app.enrichment.classifiers import (
    is_catchall as _is_catchall_cat,           # noqa: F401  back-compat alias
    is_other_income as _is_other_income,       # noqa: F401  Sprint O-1
    is_payroll as _is_payroll_desc,            # noqa: F401  back-compat alias
    is_rent_category as _is_rent_cat,          # noqa: F401  back-compat alias
    is_savings_transfer as _is_savings_outflow_desc,  # noqa: F401  back-compat alias
)
from finance_app.enrichment.effective_month import (
    RENT_SHIFT_DAY_CUTOFF as _RENT_SHIFT_DAY_CUTOFF,  # noqa: F401  back-compat alias
    find_rent_like_txns as _find_rent_like_txns,      # noqa: F401  back-compat alias
)


def _normalize_month_start(d: date) -> date:
    """Coerce any date to the first day of its month.

    We accept ``2026-04-15`` as "April 2026" instead of rejecting it — small
    forgiveness that makes the API easier to call. The stored value is
    always YYYY-MM-01 so the unique constraint works.
    """
    return date(d.year, d.month, 1)


def _month_bounds(month_start: date) -> tuple[date, date]:
    ms = _normalize_month_start(month_start)
    _, last_day = monthrange(ms.year, ms.month)
    return ms, date(ms.year, ms.month, last_day)


def _prior_month_start(d: date, n: int = 1) -> date:
    """Return ``d`` shifted backward by ``n`` whole months.

    Consolidated from the two prior definitions in ``api/budgets.py`` — the
    templates feature called it with a single arg (n defaulted to 1) and the
    assignment-ledger called it with an explicit ``n``. Both call patterns
    keep working unchanged.
    """
    y, m = d.year, d.month
    for _ in range(n):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return date(y, m, 1)


# Wave 5 fix A (2026-05-14): Goal.current_amount_cents is a cache of
# manually-recorded GoalContributions, but for goals linked directly to
# a savings/investment account, the user expects the *account balance*
# to count as progress. The audit found Goal #N (eTrade Premium Savings)
# saying $0 even though the account had $400.
#
# This helper returns the EFFECTIVE current amount for a goal:
#   - If linked_account_id is set AND the account exists -> account balance
#   - Else -> the cached contribution sum
def _effective_goal_current_cents(g: Goal, db: Session) -> int:
    """Return the most-truthful 'progress so far' value for a Goal.

    For account-linked goals, use the linked account's live balance.
    For abstract / unlinked goals, fall back to the contribution-sum cache.
    """
    if g.linked_account_id is not None:
        acct = db.get(Account, g.linked_account_id)
        if acct is not None and acct.current_balance_cents is not None:
            return max(0, int(acct.current_balance_cents))
    return int(g.current_amount_cents or 0)


def _ledger_month_kind_totals(
    db: Session, ms: date
) -> tuple[int, int, int, dict[str, dict[str, int]]]:
    """Return (income, total_planned, total_actual, by_kind) for one month.

    Used by the assignment-ledger history strip and by the rebalance
    endpoint — a lighter pass than building the full grouped ledger
    because we only need totals, not items.
    """
    first, last = _month_bounds(ms)

    # Income (recurring only — same Livio filter as the rollup).
    income_rows = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents > 0)
        .where(Transaction.posted_date >= first)
        .where(Transaction.posted_date <= last)
    ).scalars().all()
    income = sum(int(tx.amount_cents) for tx in income_rows if _is_payroll_desc(tx))

    # Budget caps by category.
    budgets = db.execute(
        select(Budget).where(Budget.month_start == ms)
    ).scalars().all()
    cap_by_cat = {b.category_id: int(b.amount_cents) for b in budgets}

    # Per-category spend.
    cat_rows = db.execute(
        select(
            Transaction.category_id,
            Category.name.label("name"),
            Category.is_discretionary,
            func.sum(
                case(
                    (Transaction.amount_cents < 0, -Transaction.amount_cents),
                    else_=0,
                )
            ).label("outflow"),
        )
        .join(Category, Category.id == Transaction.category_id, isouter=True)
        .where(Transaction.posted_date >= first, Transaction.posted_date <= last)
        .group_by(
            Transaction.category_id,
            Category.name,
            Category.is_discretionary,
        )
    ).all()
    spend_by_cat: dict[int, tuple[str, bool, int]] = {}
    for r in cat_rows:
        if r.category_id is None:
            continue
        spend_by_cat[r.category_id] = (
            r.name or "(unnamed)",
            bool(r.is_discretionary),
            int(r.outflow or 0),
        )

    # Need category metadata for caps with zero spend.
    for cat_id in cap_by_cat:
        if cat_id not in spend_by_cat:
            cat = db.get(Category, cat_id)
            if cat is not None:
                spend_by_cat[cat_id] = (cat.name, bool(cat.is_discretionary), 0)

    committed_planned = 0
    committed_actual = 0
    variable_planned = 0
    variable_actual = 0
    unbudgeted_actual = 0
    for cat_id, (name, is_disc, actual) in spend_by_cat.items():
        if _is_catchall_cat(name):
            continue  # transfers/uncategorized don't get assignments
        planned = cap_by_cat.get(cat_id, 0)
        if planned == 0 and actual == 0:
            continue
        if planned == 0:
            unbudgeted_actual += actual
            continue
        if is_disc:
            variable_planned += planned
            variable_actual += actual
        else:
            committed_planned += planned
            committed_actual += actual

    # Savings — fixed monthly target rate from each goal's original plan.
    savings_planned = 0
    savings_actual = 0
    active_goals = db.execute(
        select(Goal)
        .where(Goal.status == GoalStatus.active)
        .where(Goal.target_amount_cents > 0)
    ).scalars().all()
    for g in active_goals:
        eff = _effective_goal_current_cents(g, db)
        if eff >= g.target_amount_cents:
            continue
        if g.target_date is None:
            total_months = 24
        else:
            created = (
                g.created_at.date() if hasattr(g.created_at, "date") else g.created_at
            )
            total_months = max(
                1,
                (g.target_date.year - created.year) * 12
                + (g.target_date.month - created.month),
            )
        savings_planned += g.target_amount_cents // total_months

        # Actual this month — net inflow into the linked account + any
        # logged contributions in this window.
        if g.linked_account_id is not None:
            net_txn = db.execute(
                select(func.coalesce(func.sum(Transaction.amount_cents), 0))
                .where(Transaction.account_id == g.linked_account_id)
                .where(Transaction.posted_date >= first)
                .where(Transaction.posted_date <= last)
            ).scalar() or 0
            savings_actual += max(0, int(net_txn))
        contribs = db.execute(
            select(GoalContribution)
            .where(GoalContribution.goal_id == g.id)
            .where(GoalContribution.contributed_at >= first)
            .where(GoalContribution.contributed_at <= last)
        ).scalars().all()
        savings_actual += sum(int(c.amount_cents) for c in contribs)

    # Debt paydown — credit cards & loans. Min payment is heuristic:
    # 2% of balance with a $25 floor for cards, 1% for loans/mortgages.
    debt_planned = 0
    debt_actual = 0
    debt_accts = db.execute(
        select(Account).where(
            Account.is_active.is_(True),
            Account.account_type.in_(
                [AccountType.credit_card, AccountType.loan, AccountType.mortgage]
            ),
        )
    ).scalars().all()
    for a in debt_accts:
        bal = abs(a.current_balance_cents or 0)
        if bal == 0:
            continue
        if a.account_type == AccountType.credit_card:
            debt_planned += max(2500, int(bal * 0.02))
        else:
            debt_planned += max(2500, int(bal * 0.01))
        # Actual paydown — positive txns landing on this account this month.
        pay = db.execute(
            select(func.coalesce(func.sum(Transaction.amount_cents), 0))
            .where(Transaction.account_id == a.id)
            .where(Transaction.amount_cents > 0)
            .where(Transaction.posted_date >= first)
            .where(Transaction.posted_date <= last)
        ).scalar() or 0
        debt_actual += max(0, int(pay))

    total_planned = (
        committed_planned + variable_planned + savings_planned + debt_planned
    )
    total_actual = (
        committed_actual
        + variable_actual
        + savings_actual
        + debt_actual
        + unbudgeted_actual
    )
    by_kind = {
        "committed": {"planned": committed_planned, "actual": committed_actual},
        "variable": {"planned": variable_planned, "actual": variable_actual},
        "savings": {"planned": savings_planned, "actual": savings_actual},
        "debt": {"planned": debt_planned, "actual": debt_actual},
        "unbudgeted_actual": {"planned": 0, "actual": unbudgeted_actual},
    }
    return income, total_planned, total_actual, by_kind
