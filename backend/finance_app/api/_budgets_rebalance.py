"""Sprint L-4 — Rebalance suggestions endpoint."""
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
)
from finance_app.api.schemas import (
    RebalanceApply,
    RebalancePatchBudget,
    RebalanceSuggestion,
    RebalanceSuggestionsResponse,
)
from finance_app.budgets.monthly_financials import compute_month_income
from finance_app.db.models import (
    Account,
    AccountType,
    Budget,
    Category,
    Goal,
    GoalStatus,
    Transaction,
)
from finance_app.db.session import get_db


def rebalance_suggestions(
    month_start: date,
    db: Session = Depends(get_db),
) -> RebalanceSuggestionsResponse:
    """Sprint L-4 — given the current unassigned amount for the month,
    return ranked allocation suggestions the user can apply with one
    click.

    Surplus (unassigned > 0) → "what should I do with this extra?":
      * Crush debt (apply to credit card paydown budget cap)
      * Aggressively fund a savings goal (raise monthly rate)
      * Pad over-cap categories (raise caps to match actual)
      * Split debt/savings 50/50
      * Hold as buffer (no-op)

    Deficit (unassigned < 0) → "what should I trim?":
      * Trim top over-cap variable categories
      * Reduce a savings goal's funding rate
      * (TODO) Defer a savings target_date
    """
    ms = _normalize_month_start(month_start)
    first, last = _month_bounds(ms)
    today = date.today()

    # 1. Re-derive `unassigned_cents` by reusing the same math the
    # assignment-ledger endpoint uses. Cheaper than calling it as a
    # function — we only need the totals, not the items.
    # Sprint O-3: income is the SAME canonical figure the ledger uses
    # (`compute_month_income(...).expected_total_cents`), so `unassigned`
    # here matches `unassigned` on the ledger exactly.
    recurring_income = compute_month_income(db, ms).expected_total_cents

    # Total planned across groups, via the per-month-totals helper.
    _, total_planned, _, _ = _ledger_month_kind_totals(db, ms)
    unassigned = recurring_income - total_planned

    suggestions: list[RebalanceSuggestion] = []

    # ------------------------------------------------------------------
    # SURPLUS PATH (unassigned >= some-threshold). We use a $25 floor
    # to avoid suggesting allocations for a rounding-noise surplus.
    # ------------------------------------------------------------------
    if unassigned >= 2500:
        rank = 0

        # A) Crush debt — find the highest-balance debt account, propose
        # bumping its Credit Card Payment / Loan Payment category cap
        # by the full surplus. Estimate payoff acceleration.
        debt_accts = db.execute(
            select(Account).where(
                Account.is_active.is_(True),
                Account.account_type.in_(
                    [AccountType.credit_card, AccountType.loan]
                ),
            )
        ).scalars().all()
        debt_accts.sort(
            key=lambda a: abs(a.current_balance_cents or 0), reverse=True
        )
        primary_debt = next(
            (a for a in debt_accts if abs(a.current_balance_cents or 0) > 0),
            None,
        )
        # The "Credit Card Payment" category is the standard sink for
        # paydown commitments. We'll find it and bump its cap.
        cc_pay_cat = db.execute(
            select(Category).where(
                func.lower(Category.name) == "credit card payment"
            )
        ).scalar_one_or_none()
        cc_pay_budget = None
        if cc_pay_cat is not None:
            cc_pay_budget = db.execute(
                select(Budget)
                .where(Budget.category_id == cc_pay_cat.id)
                .where(Budget.month_start == ms)
            ).scalar_one_or_none()
        if primary_debt is not None and cc_pay_budget is not None:
            bal = abs(primary_debt.current_balance_cents or 0)
            current_cap = int(cc_pay_budget.amount_cents)
            new_cap = current_cap + unassigned
            # Months to clear at this new rate (excluding interest, rough).
            months_to_clear = max(1, -(-bal // new_cap))  # ceil
            rank += 1
            suggestions.append(
                RebalanceSuggestion(
                    rank=rank,
                    kind="crush_debt",
                    title=f"Crush your {primary_debt.name} debt",
                    description=(
                        f"Bump your Credit Card Payment cap from "
                        f"${current_cap / 100:,.0f} to ${new_cap / 100:,.0f}/mo. "
                        f"With a balance of ${bal / 100:,.0f}, this clears the "
                        f"card in about {months_to_clear} month"
                        f"{'s' if months_to_clear != 1 else ''}."
                    ),
                    impact_text=(
                        f"Clears ${bal / 100:,.0f} balance ~{months_to_clear} mo"
                    ),
                    apply=RebalanceApply(
                        kind="patch_budgets_multi",
                        budget_patches=[
                            RebalancePatchBudget(
                                category_id=cc_pay_cat.id,
                                category_name=cc_pay_cat.name,
                                current_cap_cents=current_cap,
                                new_cap_cents=new_cap,
                            )
                        ],
                    ),
                )
            )

        # B) Fund savings — find the primary active goal and propose
        # bumping its monthly rate by the full surplus. Apply uses the
        # new /goals/{id}/set-funding-rate endpoint.
        primary_goal = db.execute(
            select(Goal)
            .where(Goal.status == GoalStatus.active)
            .where(Goal.target_amount_cents > 0)
            .order_by(Goal.priority.asc())
        ).scalars().first()
        if primary_goal is not None:
            # Current monthly target rate (fixed-rate math).
            if primary_goal.target_date is None:
                total_months = 24
            else:
                created = (
                    primary_goal.created_at.date()
                    if hasattr(primary_goal.created_at, "date")
                    else primary_goal.created_at
                )
                total_months = max(
                    1,
                    (primary_goal.target_date.year - created.year) * 12
                    + (primary_goal.target_date.month - created.month),
                )
            current_rate = primary_goal.target_amount_cents // total_months
            new_rate = current_rate + unassigned
            # Months to hit target at the new rate, using effective_current.
            eff_current = _effective_goal_current_cents(primary_goal, db)
            remaining = primary_goal.target_amount_cents - eff_current
            months_to_target = max(1, -(-remaining // new_rate))
            rank += 1
            suggestions.append(
                RebalanceSuggestion(
                    rank=rank,
                    kind="fund_savings",
                    title=f"Aggressively fund {primary_goal.name}",
                    description=(
                        f"Bump your monthly contribution from "
                        f"${current_rate / 100:,.0f} to ${new_rate / 100:,.0f}/mo. "
                        f"At that rate you'd hit the ${primary_goal.target_amount_cents / 100:,.0f} "
                        f"target in about {months_to_target} month"
                        f"{'s' if months_to_target != 1 else ''}."
                    ),
                    impact_text=(
                        f"Hits ${primary_goal.target_amount_cents / 100:,.0f} target "
                        f"~{months_to_target} mo"
                    ),
                    apply=RebalanceApply(
                        kind="set_goal_funding_rate",
                        goal_id=primary_goal.id,
                        goal_new_monthly_cents=new_rate,
                    ),
                )
            )

        # C) Pad over-cap categories — multi-PATCH to set each over-cap
        # variable category's cap to its actual outflow this month.
        # This is the "accept the overspend" path, valuable when the
        # caps are clearly wrong.
        over_cap_rows = db.execute(
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
                Transaction.category_id, Category.name, Category.is_discretionary
            )
        ).all()
        over_cap_patches: list[RebalancePatchBudget] = []
        total_overage = 0
        for r in over_cap_rows:
            if r.category_id is None:
                continue
            if not r.is_discretionary:
                continue
            if _is_catchall_cat(r.name):
                continue
            budget = db.execute(
                select(Budget)
                .where(Budget.category_id == r.category_id)
                .where(Budget.month_start == ms)
            ).scalar_one_or_none()
            if budget is None:
                continue
            actual = int(r.outflow or 0)
            if actual <= budget.amount_cents:
                continue
            overage = actual - budget.amount_cents
            if overage < 1000:  # Skip noise < $10
                continue
            over_cap_patches.append(
                RebalancePatchBudget(
                    category_id=r.category_id,
                    category_name=r.name,
                    current_cap_cents=int(budget.amount_cents),
                    new_cap_cents=actual,
                )
            )
            total_overage += overage
        # Cap the total spend by the surplus available (don't go over).
        if over_cap_patches and total_overage > 0:
            # Scale patches proportionally if total overage > unassigned.
            if total_overage > unassigned:
                scale = unassigned / total_overage
                for p in over_cap_patches:
                    addl = p.new_cap_cents - p.current_cap_cents
                    p.new_cap_cents = p.current_cap_cents + int(addl * scale)
                applied_amount = sum(
                    p.new_cap_cents - p.current_cap_cents for p in over_cap_patches
                )
            else:
                applied_amount = total_overage
            # Sort patches by amount desc for the description.
            over_cap_patches.sort(
                key=lambda p: p.new_cap_cents - p.current_cap_cents, reverse=True
            )
            top_3 = over_cap_patches[:3]
            top_names = ", ".join(p.category_name for p in top_3)
            rank += 1
            suggestions.append(
                RebalanceSuggestion(
                    rank=rank,
                    kind="pad_over_cap",
                    title="Pad categories you're consistently over on",
                    description=(
                        f"Raise the caps on {top_names}"
                        + (
                            f" and {len(over_cap_patches) - 3} more"
                            if len(over_cap_patches) > 3
                            else ""
                        )
                        + " to match what you're actually spending. Total: "
                        + f"${applied_amount / 100:,.0f}/mo of surplus reassigned."
                    ),
                    impact_text=(
                        f"Realigns {len(over_cap_patches)} cap"
                        f"{'s' if len(over_cap_patches) != 1 else ''}"
                        f" to actual spend"
                    ),
                    apply=RebalanceApply(
                        kind="patch_budgets_multi",
                        budget_patches=over_cap_patches,
                    ),
                )
            )

        # D) Hold as buffer — no-op.
        rank += 1
        suggestions.append(
            RebalanceSuggestion(
                rank=rank,
                kind="hold",
                title="Hold as buffer",
                description=(
                    f"Keep ${unassigned / 100:,.0f}/mo unassigned. Useful if you "
                    f"expect irregular spend (medical, travel, repairs) and want "
                    f"a cushion in checking. The downside: unassigned cash tends "
                    f"to disappear into variable spend unless you watch it."
                ),
                impact_text="Builds your emergency buffer",
                apply=RebalanceApply(kind="noop"),
            )
        )

    # ------------------------------------------------------------------
    # DEFICIT PATH (unassigned <= −$25). Suggest trims.
    # ------------------------------------------------------------------
    elif unassigned <= -2500:
        # For v1, just point at the existing recommendations endpoint
        # (which already ranks over-cap categories). A single suggestion
        # is enough — we can split this out later.
        suggestions.append(
            RebalanceSuggestion(
                rank=1,
                kind="trim_deficit",
                title=f"You're over-committed by ${abs(unassigned) / 100:,.0f}",
                description=(
                    "See Smart Recommendations below for ranked trim "
                    "suggestions (largest overspends first)."
                ),
                impact_text="Match commitments to income",
                apply=None,
            )
        )

    return RebalanceSuggestionsResponse(
        month_start=ms,
        unassigned_cents=unassigned,
        suggestions=suggestions,
    )
