"""Sprint L — zero-based assignment ledger endpoint."""
from __future__ import annotations

from datetime import date

from fastapi import Depends
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.api._budgets_helpers import (
    _effective_goal_current_cents,
    _is_catchall_cat,
    _ledger_month_kind_totals,
    _month_bounds,
    _normalize_month_start,
    _prior_month_start,
)
from finance_app.api.schemas import (
    AssignmentGroup,
    AssignmentItem,
    AssignmentLedgerResponse,
    MonthHistorySummary,
)
from finance_app.budgets.monthly_financials import compute_month_income
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
from finance_app.db.session import get_db


def assignment_ledger(
    month_start: date,
    db: Session = Depends(get_db),
) -> AssignmentLedgerResponse:
    """Sprint L — zero-based assignment ledger for ``month_start``.

    Returns the full grouped ledger (with per-item detail) for the
    requested month, plus a lightweight 3-month history strip (kind
    totals only) so the UI can show drift patterns.

    Math: income = sum(planned across groups) + unassigned. Unassigned
    can be negative when the user has over-committed.
    """
    ms = _normalize_month_start(month_start)
    first, last = _month_bounds(ms)

    # Sprint M-4 (2026-05-14): preload all categories so AssignmentItem
    # rows can include parent_id + parent_name for the "Group by
    # category" view toggle on The Plan card.
    _all_cats = db.execute(select(Category)).scalars().all()
    _cat_by_id: dict[int, Category] = {c.id: c for c in _all_cats}

    def _ledger_parent_info(cat_id: int | None) -> tuple[int | None, str | None]:
        if cat_id is None:
            return None, None
        cat = _cat_by_id.get(cat_id)
        if cat is None or cat.parent_id is None:
            return None, None
        parent = _cat_by_id.get(cat.parent_id)
        if parent is None:
            return None, None
        return parent.id, parent.name

    # Sprint O-3: income comes from the ONE canonical computation
    # (`compute_month_income`), not a per-endpoint re-derivation. Before
    # this, the ledger computed its own 90-day payroll average ($7,159)
    # while the hero / Fixed-Bills cards showed the month's expected
    # total ($7,240) — the same income, two numbers, same page. The
    # ledger now shows `expected_total` so The Plan agrees with the hero.
    #
    # `expected_total` = paychecks landed this month + paychecks still
    # expected before month-end. It never reads $0 mid-month before
    # payday (the old reason the ledger used a rolling average): the
    # still-expected portion fills the gap.
    _income = compute_month_income(db, ms)
    recurring_income = _income.expected_total_cents
    # "Irregular" income on the ledger = non-payroll inflows (peer
    # transfers, settlements), trailing-90-day averaged. Derived from the
    # same canonical figures — all-inflow average minus the payroll
    # average — so it can't drift from the recurring number above.
    irregular_income = max(
        0, _income.all_inflow_avg_cents - _income.recurring_avg_cents
    )

    # Per-category budget caps.
    budgets = db.execute(
        select(Budget).where(Budget.month_start == ms)
    ).scalars().all()
    cap_by_cat: dict[int, int] = {b.category_id: int(b.amount_cents) for b in budgets}

    # Per-category actual spend (positive = outflow magnitude).
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
    cat_meta: dict[int, tuple[str, bool, int]] = {}
    for r in cat_rows:
        if r.category_id is None:
            continue
        cat_meta[r.category_id] = (
            r.name or "(unnamed)",
            bool(r.is_discretionary),
            int(r.outflow or 0),
        )
    # Include capped categories with zero spend (the user committed but
    # hasn't drawn against it yet this month).
    for cat_id in cap_by_cat:
        if cat_id not in cat_meta:
            cat = db.get(Category, cat_id)
            if cat is not None:
                cat_meta[cat_id] = (cat.name, bool(cat.is_discretionary), 0)

    # Bucket per-category items into committed / variable / unbudgeted.
    committed_items: list[AssignmentItem] = []
    variable_items: list[AssignmentItem] = []
    unbudgeted_items: list[AssignmentItem] = []
    for cat_id, (name, is_disc, actual) in cat_meta.items():
        if _is_catchall_cat(name):
            continue
        planned = cap_by_cat.get(cat_id, 0)
        if planned == 0 and actual == 0:
            continue
        is_paid = planned > 0 and actual >= int(planned * 0.8)
        _pid, _pname = _ledger_parent_info(cat_id)
        if planned == 0:
            unbudgeted_items.append(
                AssignmentItem(
                    kind="unbudgeted_actual",
                    label=name,
                    planned_cents=0,
                    actual_cents=actual,
                    category_id=cat_id,
                    is_paid=False,
                    parent_id=_pid,
                    parent_name=_pname,
                )
            )
        elif is_disc:
            variable_items.append(
                AssignmentItem(
                    kind="variable",
                    label=name,
                    planned_cents=planned,
                    actual_cents=actual,
                    category_id=cat_id,
                    is_paid=is_paid,
                    parent_id=_pid,
                    parent_name=_pname,
                )
            )
        else:
            committed_items.append(
                AssignmentItem(
                    kind="committed",
                    label=name,
                    planned_cents=planned,
                    actual_cents=actual,
                    category_id=cat_id,
                    parent_id=_pid,
                    parent_name=_pname,
                    is_paid=is_paid,
                )
            )

    # Savings items — one per active goal, using the fixed monthly rate.
    savings_items: list[AssignmentItem] = []
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
        planned = g.target_amount_cents // total_months
        # Actual: linked-account net inflow + any logged contributions.
        actual = 0
        if g.linked_account_id is not None:
            net_txn = db.execute(
                select(func.coalesce(func.sum(Transaction.amount_cents), 0))
                .where(Transaction.account_id == g.linked_account_id)
                .where(Transaction.posted_date >= first)
                .where(Transaction.posted_date <= last)
            ).scalar() or 0
            actual = max(0, int(net_txn))
        contribs = db.execute(
            select(GoalContribution)
            .where(GoalContribution.goal_id == g.id)
            .where(GoalContribution.contributed_at >= first)
            .where(GoalContribution.contributed_at <= last)
        ).scalars().all()
        actual += sum(int(c.amount_cents) for c in contribs)
        savings_items.append(
            AssignmentItem(
                kind="savings",
                label=g.name,
                planned_cents=planned,
                actual_cents=actual,
                goal_id=g.id,
                is_paid=actual >= int(planned * 0.8),
            )
        )

    # Debt items — credit cards + loans with positive balance.
    debt_items: list[AssignmentItem] = []
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
            min_payment = max(2500, int(bal * 0.02))
        else:
            min_payment = max(2500, int(bal * 0.01))
        pay = db.execute(
            select(func.coalesce(func.sum(Transaction.amount_cents), 0))
            .where(Transaction.account_id == a.id)
            .where(Transaction.amount_cents > 0)
            .where(Transaction.posted_date >= first)
            .where(Transaction.posted_date <= last)
        ).scalar() or 0
        actual = max(0, int(pay))
        debt_items.append(
            AssignmentItem(
                kind="debt",
                label=f"{a.name} paydown",
                planned_cents=min_payment,
                actual_cents=actual,
                account_id=a.id,
                is_paid=actual >= int(min_payment * 0.8),
            )
        )

    # Sort each group by planned_cents desc so the biggest commitments
    # surface first when the user expands the group.
    committed_items.sort(key=lambda i: -i.planned_cents)
    variable_items.sort(key=lambda i: -i.planned_cents)
    savings_items.sort(key=lambda i: -i.planned_cents)
    debt_items.sort(key=lambda i: -i.planned_cents)
    unbudgeted_items.sort(key=lambda i: -i.actual_cents)

    def _group(kind: str, label: str, items: list[AssignmentItem]) -> AssignmentGroup:
        return AssignmentGroup(
            kind=kind,
            label=label,
            planned_cents=sum(i.planned_cents for i in items),
            actual_cents=sum(i.actual_cents for i in items),
            items=items,
        )

    groups: list[AssignmentGroup] = [
        _group("committed", "Committed bills", committed_items),
        _group("variable", "Variable spending", variable_items),
        _group("savings", "Savings goals", savings_items),
        _group("debt", "Debt paydown", debt_items),
    ]
    # Surface unbudgeted spend even though it doesn't count as "planned".
    if unbudgeted_items:
        groups.append(
            _group("unbudgeted_actual", "Unbudgeted (no cap set)", unbudgeted_items)
        )

    total_planned = sum(
        g.planned_cents for g in groups if g.kind != "unbudgeted_actual"
    )
    total_actual = sum(g.actual_cents for g in groups)
    unassigned = recurring_income - total_planned

    # 3-month history strip — just totals per kind, no item detail.
    history: list[MonthHistorySummary] = []
    for n in range(1, 4):
        hist_ms = _prior_month_start(ms, n)
        h_income, h_planned, h_actual, h_by_kind = _ledger_month_kind_totals(
            db, hist_ms
        )
        history.append(
            MonthHistorySummary(
                month_start=hist_ms,
                income_cents=h_income,
                planned_cents=h_planned,
                actual_cents=h_actual,
                by_kind=h_by_kind,
            )
        )

    return AssignmentLedgerResponse(
        month_start=ms,
        income_cents=recurring_income,
        irregular_income_cents=irregular_income,
        groups=groups,
        total_planned_cents=total_planned,
        total_actual_cents=total_actual,
        unassigned_cents=unassigned,
        history=history,
    )
