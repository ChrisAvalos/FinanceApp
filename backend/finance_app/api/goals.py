"""Goals CRUD + contributions (Phase D).

Surface area:
* GET    /goals                        — list (filterable by kind/status)
* POST   /goals                        — create
* GET    /goals/{id}                   — fetch one
* PATCH  /goals/{id}                   — update fields
* DELETE /goals/{id}                   — hard delete (cascades contributions)
* POST   /goals/{id}/contribute        — record a contribution; bumps cache
* GET    /goals/{id}/contributions     — list contributions for one goal

We NEVER move money. Contributions are records of actions the user already
took ("I transferred $200 to savings on 4/15"); the engine never executes
the transfer. That's a hard project rule (memory: 2026-04-23).

The ``current_amount_cents`` cache on Goal is updated transactionally when
contributions are added/deleted; we don't expose it as a writable field on
the PATCH endpoint to avoid drift.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from datetime import timedelta

from finance_app.api.schemas import (
    GoalContributionIn,
    GoalContributionOut,
    GoalFundingRateIn,
    GoalIn,
    GoalOut,
)
from finance_app.db.models import Account, Goal, GoalContribution, GoalKind, GoalStatus
from finance_app.db.session import get_db

router = APIRouter(prefix="/goals", tags=["goals"])


# Wave 5 fix A (2026-05-14): mirror the helper from budgets.py so any
# response that serializes a Goal has the right effective progress value.
# Kept here (vs. shared module) because the import graph is otherwise
# clean and a single ~10 line helper isn't worth a new module.
def _serialize_goal(g: Goal, db: Session) -> GoalOut:
    eff: int | None = None
    if g.linked_account_id is not None:
        acct = db.get(Account, g.linked_account_id)
        if acct is not None and acct.current_balance_cents is not None:
            eff = max(0, int(acct.current_balance_cents))
    if eff is None:
        eff = int(g.current_amount_cents or 0)
    out = GoalOut.model_validate(g)
    out.effective_current_amount_cents = eff
    return out


# ---------- CRUD ----------

@router.get("", response_model=list[GoalOut])
def list_goals(
    kind: GoalKind | None = None,
    status: GoalStatus | None = None,
    db: Session = Depends(get_db),
) -> list[GoalOut]:
    """List goals, ordered by (kind funding-priority, user priority, target date).

    Default order matches the suggestion engine's allocation ranking so the
    UI list and the suggestion list line up.
    """
    stmt = select(Goal)
    if kind is not None:
        stmt = stmt.where(Goal.kind == kind)
    if status is not None:
        stmt = stmt.where(Goal.status == status)
    rows = db.execute(stmt).scalars().all()
    # Order: emergency → debt → specific → general; within kind, by priority
    kind_rank = {
        GoalKind.emergency_fund: 1,
        GoalKind.debt_payoff: 2,
        GoalKind.specific_savings: 3,
        GoalKind.general_savings: 4,
    }
    rows.sort(key=lambda g: (
        kind_rank.get(g.kind, 99),
        g.priority if g.priority is not None else 99,
        g.target_date or date(2100, 1, 1),
        g.id,
    ))
    return [_serialize_goal(r, db) for r in rows]


@router.post("", response_model=GoalOut, status_code=201)
def create_goal(body: GoalIn, db: Session = Depends(get_db)) -> GoalOut:
    if body.target_amount_cents <= 0:
        raise HTTPException(400, "target_amount_cents must be > 0")
    if body.kind == GoalKind.debt_payoff and body.linked_debt_account_id is None:
        # Debt goals without a linked account are still legal (informal debts),
        # but warn — the suggestion engine falls back to using target_amount
        # as the principal in that case.
        pass
    g = Goal(
        name=body.name,
        kind=body.kind,
        target_amount_cents=body.target_amount_cents,
        target_date=body.target_date,
        priority=body.priority,
        status=body.status,
        linked_account_id=body.linked_account_id,
        linked_debt_account_id=body.linked_debt_account_id,
        notes=body.notes,
        current_amount_cents=0,
    )
    db.add(g)
    db.commit()
    db.refresh(g)
    return _serialize_goal(g, db)


@router.get("/{goal_id}", response_model=GoalOut)
def get_goal(goal_id: int, db: Session = Depends(get_db)) -> GoalOut:
    g = db.get(Goal, goal_id)
    if g is None:
        raise HTTPException(404, f"Goal {goal_id} not found")
    return _serialize_goal(g, db)


@router.patch("/{goal_id}", response_model=GoalOut)
def update_goal(
    goal_id: int,
    body: GoalIn,
    db: Session = Depends(get_db),
) -> GoalOut:
    g = db.get(Goal, goal_id)
    if g is None:
        raise HTTPException(404, f"Goal {goal_id} not found")
    if body.target_amount_cents <= 0:
        raise HTTPException(400, "target_amount_cents must be > 0")
    g.name = body.name
    g.kind = body.kind
    g.target_amount_cents = body.target_amount_cents
    g.target_date = body.target_date
    g.priority = body.priority
    # If user manually flips status, accept it. Auto-mark "achieved" if they
    # haven't but balance >= target — saves a click after a final contribution.
    if body.status == GoalStatus.active and g.current_amount_cents >= g.target_amount_cents and g.kind != GoalKind.debt_payoff:
        g.status = GoalStatus.achieved
    else:
        g.status = body.status
    g.linked_account_id = body.linked_account_id
    g.linked_debt_account_id = body.linked_debt_account_id
    g.notes = body.notes
    db.commit()
    db.refresh(g)
    return _serialize_goal(g, db)


@router.post("/{goal_id}/set-funding-rate", response_model=GoalOut)
def set_funding_rate(
    goal_id: int,
    body: GoalFundingRateIn,
    db: Session = Depends(get_db),
) -> GoalOut:
    """Sprint L-4 (2026-05-14) — set a goal's effective monthly funding
    rate. Backend recomputes target_date to: today + ceil(remaining_gap
    / monthly_cents) months.

    Used by the "Fund savings" rebalance suggestion. The user picks a
    rate like $1,800/mo from the modal; we recompute the deadline so
    the goal's planned schedule matches the new rate.

    Edge cases:
      * monthly_cents > remaining_gap → target_date = today + 1 month
        (we don't go below 1 month — the goal effectively hits this
        month).
      * remaining_gap <= 0 → the goal is already at/over target; no-op
        and return the goal unchanged.
    """
    g = db.get(Goal, goal_id)
    if g is None:
        raise HTTPException(404, f"Goal {goal_id} not found")

    # Compute remaining gap using the same "effective current" logic
    # the rest of the app uses — linked account balance if present.
    eff_current = g.current_amount_cents or 0
    if g.linked_account_id is not None:
        acct = db.get(Account, g.linked_account_id)
        if acct is not None and acct.current_balance_cents is not None:
            eff_current = max(0, int(acct.current_balance_cents))

    remaining = g.target_amount_cents - eff_current
    if remaining <= 0:
        return _serialize_goal(g, db)

    # Months needed (ceiling). Floor at 1 — never set a target_date in
    # the past.
    months_needed = max(1, -(-remaining // body.monthly_cents))  # ceil division
    new_target = date.today() + timedelta(days=months_needed * 30)
    # Snap to first of the month for a clean display ("hits target by
    # Oct 2026"). Use the LAST day of the projected month so we don't
    # accidentally round to a month earlier.
    new_target = date(
        new_target.year,
        new_target.month,
        min(28, new_target.day),  # day-28 ceiling avoids Feb edge cases
    )

    g.target_date = new_target
    db.commit()
    db.refresh(g)
    return _serialize_goal(g, db)


@router.delete("/{goal_id}", status_code=204)
def delete_goal(goal_id: int, db: Session = Depends(get_db)) -> None:
    g = db.get(Goal, goal_id)
    if g is None:
        raise HTTPException(404, f"Goal {goal_id} not found")
    db.delete(g)  # cascade=delete-orphan on relationship handles contributions
    db.commit()


# ---------- Contributions ----------

@router.post("/{goal_id}/contribute", response_model=GoalContributionOut, status_code=201)
def contribute(
    goal_id: int,
    body: GoalContributionIn,
    db: Session = Depends(get_db),
) -> GoalContributionOut:
    """Record a contribution toward a goal. Bumps Goal.current_amount_cents.

    NOT a money-movement endpoint — this records that the user already moved
    money themselves. The cache update happens in the same transaction as
    the insert so there's never a window where the cache is stale.

    For debt_payoff goals, ``current_amount_cents`` represents *principal
    paid down so far*, not balance owed. The UI computes "remaining" as
    target − current.
    """
    g = db.get(Goal, goal_id)
    if g is None:
        raise HTTPException(404, f"Goal {goal_id} not found")
    contrib = GoalContribution(
        goal_id=goal_id,
        amount_cents=body.amount_cents,
        contributed_at=body.contributed_at,
        source=body.source,
        transaction_id=body.transaction_id,
        notes=body.notes,
    )
    db.add(contrib)
    g.current_amount_cents = (g.current_amount_cents or 0) + body.amount_cents
    # Auto-mark achieved on the final contribution (savings goals only —
    # debt goals stay active until the linked account hits zero).
    if g.kind != GoalKind.debt_payoff and g.current_amount_cents >= g.target_amount_cents:
        g.status = GoalStatus.achieved
    db.commit()
    db.refresh(contrib)
    return GoalContributionOut.model_validate(contrib)


@router.get("/{goal_id}/contributions", response_model=list[GoalContributionOut])
def list_contributions(
    goal_id: int,
    db: Session = Depends(get_db),
) -> list[GoalContributionOut]:
    g = db.get(Goal, goal_id)
    if g is None:
        raise HTTPException(404, f"Goal {goal_id} not found")
    rows = db.execute(
        select(GoalContribution)
        .where(GoalContribution.goal_id == goal_id)
        .order_by(GoalContribution.contributed_at.desc(), GoalContribution.id.desc())
    ).scalars().all()
    return [GoalContributionOut.model_validate(r) for r in rows]


@router.delete("/{goal_id}/contributions/{contrib_id}", status_code=204)
def delete_contribution(
    goal_id: int,
    contrib_id: int,
    db: Session = Depends(get_db),
) -> None:
    """Remove a contribution and reverse the cache adjustment."""
    c = db.get(GoalContribution, contrib_id)
    if c is None or c.goal_id != goal_id:
        raise HTTPException(404, "Contribution not found for this goal")
    g = db.get(Goal, goal_id)
    if g is not None:
        g.current_amount_cents = max(0, (g.current_amount_cents or 0) - c.amount_cents)
        # If we drop below target, reopen the goal.
        if g.status == GoalStatus.achieved and g.current_amount_cents < g.target_amount_cents:
            g.status = GoalStatus.active
    db.delete(c)
    db.commit()
