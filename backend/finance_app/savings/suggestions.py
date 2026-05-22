"""Phase D — suggestion engine.

Three families of recommendation, each with required before/after math:

1. **allocate_to_goal** — split available surplus across active funding goals
   (emergency_fund / general_savings / specific_savings) by priority.
2. **cancel_subscription** — confirmed Phase B subs the user could shed,
   sorted by monthly cost. Annualised savings shown.
3. **debt_payoff** — strategy comparison (avalanche by APR vs snowball by
   balance) for active debt_payoff goals + their linked credit/loan
   accounts. Shows how the surplus would translate into months saved /
   interest avoided under each strategy.

Why a single module?
--------------------
All three families share the same "current state vs projected if act vs
projected if don't act" output shape, and the allocation engine needs to
know about debt payoff goals when deciding how to split surplus (a
high-APR debt should preempt a low-priority savings goal). Centralising
keeps the priority rules legible.

NEVER moves money — every Suggestion is a recommendation Chris executes
manually. The endpoint that surfaces these is read-only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Account,
    AccountType,
    Goal,
    GoalKind,
    GoalStatus,
    Subscription,
    SubscriptionStatus,
)
from finance_app.savings.surplus import (
    SurplusMode,
    compute_surplus,
)


SuggestionKind = Literal[
    "allocate_to_goal",
    "cancel_subscription",
    "debt_payoff_avalanche",
    "debt_payoff_snowball",
]


# --------------------------------------------------------------------
#  Result types — flat dicts for easy JSON serialisation downstream
# --------------------------------------------------------------------


@dataclass
class BeforeAfter:
    """Three-state framing required by every Phase D suggestion.

    Stored as integer cents for the math, plus a human-readable summary the
    UI renders directly. Per Chris's hard rule (project memory): every
    recommendation must show all three.
    """
    label: str                             # short title for the row
    current_cents: int                     # state today
    if_act_cents: int                      # state in 30 days IF Chris acts
    if_dont_act_cents: int                 # state in 30 days IF he doesn't
    summary: str                           # human-readable explainer


@dataclass
class Suggestion:
    """One actionable recommendation."""
    kind: SuggestionKind
    title: str
    body: str
    estimated_savings_cents: int           # 30d impact (positive = good)
    confidence: float                      # 0..1
    goal_id: int | None = None
    subscription_id: int | None = None
    account_id: int | None = None
    before_after: list[BeforeAfter] = field(default_factory=list)
    extra: dict = field(default_factory=dict)


@dataclass
class SuggestionBundle:
    """All suggestions returned together, grouped by kind for the UI."""
    as_of: date
    surplus_mode: SurplusMode
    surplus_cents: int                     # the anchor we're allocating from
    allocations: list[Suggestion] = field(default_factory=list)
    cancellations: list[Suggestion] = field(default_factory=list)
    debt_strategies: list[Suggestion] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


# --------------------------------------------------------------------
#  Allocation: split surplus across funding goals + high-APR debt
# --------------------------------------------------------------------


# Lower number = funded first. Within the same kind, the user-set
# Goal.priority breaks ties; lower wins there too.
_KIND_ORDER: dict[GoalKind, int] = {
    GoalKind.emergency_fund: 1,    # always come first — Chris's hard rule
    GoalKind.debt_payoff: 2,       # high-APR debt beats general savings
    GoalKind.specific_savings: 3,
    GoalKind.general_savings: 4,
}


def _gap_cents(goal: Goal) -> int:
    """How many cents are left to hit target. Never negative."""
    return max(0, (goal.target_amount_cents or 0) - (goal.current_amount_cents or 0))


def _ranked_active_goals(db: Session) -> list[Goal]:
    """Active goals sorted by (kind priority, user priority, deadline)."""
    rows = db.execute(
        select(Goal).where(Goal.status == GoalStatus.active)
    ).scalars().all()

    def sort_key(g: Goal):
        target = g.target_date or date(2100, 1, 1)  # no deadline → far future
        return (
            _KIND_ORDER.get(g.kind, 99),
            g.priority if g.priority is not None else 99,
            target,
            g.id,  # deterministic tiebreaker
        )

    return sorted(rows, key=sort_key)


def _build_allocation_suggestion(
    goal: Goal,
    proposed_alloc_cents: int,
    surplus_cents: int,
    today: date,
) -> Suggestion:
    """Render the per-goal allocation row with before/after math."""
    gap = _gap_cents(goal)
    cur = goal.current_amount_cents or 0
    target = goal.target_amount_cents or 0

    if_act = cur + proposed_alloc_cents
    if_dont = cur  # 30d horizon: without action the cache stays the same

    # Months-to-goal math, only if a positive monthly contribution implies a path
    months_remaining_summary = ""
    if proposed_alloc_cents > 0 and gap > 0:
        months_to_complete = max(1, -(-gap // proposed_alloc_cents))  # ceil div
        months_remaining_summary = (
            f" At this monthly pace, you'd hit the target in "
            f"~{months_to_complete} month{'s' if months_to_complete != 1 else ''}."
        )

    deadline_note = ""
    if goal.target_date:
        days = (goal.target_date - today).days
        if days >= 0:
            deadline_note = f" Target date: {goal.target_date.isoformat()} ({days} days out)."
        else:
            deadline_note = f" Target date {goal.target_date.isoformat()} is {-days} days past."

    body = (
        f"Move ${proposed_alloc_cents/100:.2f} this month toward '{goal.name}'. "
        f"Current ${cur/100:.2f} of ${target/100:.2f} ({(cur/target*100) if target > 0 else 0:.0f}%)."
        f"{months_remaining_summary}{deadline_note}"
    )

    return Suggestion(
        kind="allocate_to_goal",
        title=f"Allocate ${proposed_alloc_cents/100:.2f} to {goal.name}",
        body=body,
        estimated_savings_cents=proposed_alloc_cents,
        confidence=0.9,
        goal_id=goal.id,
        before_after=[
            BeforeAfter(
                label="Goal balance",
                current_cents=cur,
                if_act_cents=if_act,
                if_dont_act_cents=if_dont,
                summary=(
                    f"${cur/100:.2f} now → ${if_act/100:.2f} if you transfer this month, "
                    f"vs ${if_dont/100:.2f} if you don't."
                ),
            ),
            BeforeAfter(
                label="Surplus left after this allocation",
                current_cents=surplus_cents,
                if_act_cents=surplus_cents - proposed_alloc_cents,
                if_dont_act_cents=surplus_cents,
                summary=(
                    f"${surplus_cents/100:.2f} surplus → "
                    f"${(surplus_cents - proposed_alloc_cents)/100:.2f} remaining after this move."
                ),
            ),
        ],
        extra={
            "goal_kind": goal.kind.value if hasattr(goal.kind, "value") else str(goal.kind),
            "gap_cents": gap,
            "user_priority": goal.priority,
        },
    )


def build_allocations(
    db: Session,
    surplus_cents: int,
    today: date,
) -> list[Suggestion]:
    """Greedy-allocate surplus across ranked active goals.

    The algorithm: walk the ranked list; for each goal, allocate
    ``min(remaining_surplus, gap)`` until the goal's target is filled or
    surplus is exhausted. Debt-payoff goals are also funded by this loop —
    the debt-strategy section handles the *strategy comparison* separately
    so Chris can pick avalanche vs snowball before adopting the
    allocations.

    If surplus is non-positive we still return the ranked goals with a
    zero-dollar suggestion so the UI shows the planned order — useful for
    "if I had $X next month, here's where it would go."
    """
    if surplus_cents < 0:
        return []  # in deficit: no surplus to allocate; UI will show notes instead

    suggestions: list[Suggestion] = []
    remaining = surplus_cents
    for goal in _ranked_active_goals(db):
        gap = _gap_cents(goal)
        if gap <= 0:
            continue  # already at or above target
        alloc = min(remaining, gap)
        if alloc <= 0 and remaining <= 0:
            # No surplus left, but show a zero-allocation row so the user
            # sees the priority order. Only include the top 3 zero-rows
            # to avoid noise.
            if sum(1 for s in suggestions if s.estimated_savings_cents == 0) < 3:
                suggestions.append(
                    _build_allocation_suggestion(goal, 0, surplus_cents, today)
                )
            continue
        suggestions.append(
            _build_allocation_suggestion(goal, alloc, surplus_cents, today)
        )
        remaining -= alloc
    return suggestions


# --------------------------------------------------------------------
#  Cancellations: Phase B confirmed subs ranked by monthly cost
# --------------------------------------------------------------------


def _monthly_cost_cents(amount_cents: int, cadence_days: int) -> int:
    cad = cadence_days or 30
    if cad <= 0:
        cad = 30
    return abs(int(round(amount_cents * 30 / cad)))


def _annual_cost_cents(amount_cents: int, cadence_days: int) -> int:
    cad = cadence_days or 30
    if cad <= 0:
        cad = 30
    return abs(int(round(amount_cents * 365 / cad)))


def build_cancellations(db: Session, surplus_cents: int) -> list[Suggestion]:
    """Surface confirmed-active subs as cancel candidates, biggest first.

    We don't try to *predict* which ones the user wants to cancel — that's
    too presumptuous. Instead the engine ranks all confirmed-active subs by
    monthly cost and lets the UI show them with the savings math attached.
    Chris triages.

    ``streaming`` and ``saas`` types get a confidence bump because they're
    typically discretionary; ``utilities``/``insurance`` get a confidence
    cut because cancelling them isn't usually realistic.
    """
    rows = db.execute(
        select(Subscription).where(
            Subscription.is_user_confirmed.is_(True),
            Subscription.status == SubscriptionStatus.active,
        )
    ).scalars().all()

    out: list[Suggestion] = []
    for sub in rows:
        monthly = _monthly_cost_cents(sub.amount_cents, sub.cadence_days)
        annual = _annual_cost_cents(sub.amount_cents, sub.cadence_days)
        if monthly <= 0:
            continue

        type_str = sub.subscription_type.value if hasattr(sub.subscription_type, "value") else str(sub.subscription_type)
        # Confidence = how "discretionary-feeling" the type is.
        if type_str in ("streaming", "gaming", "fitness", "news_media"):
            confidence = 0.75
        elif type_str in ("saas", "storage"):
            confidence = 0.55
        elif type_str in ("utilities", "insurance", "internet", "telecom"):
            confidence = 0.20  # cancelling these usually isn't realistic
        else:
            confidence = 0.40

        body = (
            f"Cancelling '{sub.name}' would free ${monthly/100:.2f}/mo "
            f"(~${annual/100:.2f}/yr). Type: {type_str}. "
            f"This is a suggestion only — review whether you still use it before cancelling."
        )

        out.append(Suggestion(
            kind="cancel_subscription",
            title=f"Cancel {sub.name} — save ${monthly/100:.2f}/mo",
            body=body,
            estimated_savings_cents=monthly,
            confidence=confidence,
            subscription_id=sub.id,
            before_after=[
                BeforeAfter(
                    label="Monthly outflow on this sub",
                    current_cents=monthly,
                    if_act_cents=0,
                    if_dont_act_cents=monthly,
                    summary=(
                        f"${monthly/100:.2f}/mo now → $0 if cancelled, "
                        f"vs ${monthly/100:.2f}/mo continuing."
                    ),
                ),
                BeforeAfter(
                    label="Annual cost",
                    current_cents=annual,
                    if_act_cents=0,
                    if_dont_act_cents=annual,
                    summary=(
                        f"${annual/100:.2f}/yr now → $0 if cancelled, "
                        f"vs ${annual/100:.2f}/yr continuing."
                    ),
                ),
                BeforeAfter(
                    label="Available surplus",
                    current_cents=surplus_cents,
                    if_act_cents=surplus_cents + monthly,
                    if_dont_act_cents=surplus_cents,
                    summary=(
                        f"${surplus_cents/100:.2f} surplus today → "
                        f"${(surplus_cents + monthly)/100:.2f}/mo after cancellation."
                    ),
                ),
            ],
            extra={"subscription_type": type_str, "annual_savings_cents": annual},
        ))

    # Biggest savings first
    out.sort(key=lambda s: s.estimated_savings_cents, reverse=True)
    return out


# --------------------------------------------------------------------
#  Debt-payoff strategies: avalanche vs snowball
# --------------------------------------------------------------------


@dataclass
class _DebtRow:
    """Internal representation of one debt slot for ordering."""
    goal_id: int
    goal_name: str
    account_id: int | None
    balance_cents: int          # >0 = amount owed
    apr_bps: int                # 2450 = 24.50%
    minimum_payment_cents: int  # estimated; we use 2% of balance as a default


def _collect_debts(db: Session) -> list[_DebtRow]:
    """Active debt_payoff goals, hydrated with their linked-account balance + APR.

    Falls back to the goal's own target_amount_cents if no linked account
    is set, treating that as the principal owed (less common but supported
    so users can model "I owe $4k informally" without linking).
    """
    rows = db.execute(
        select(Goal).where(
            Goal.status == GoalStatus.active,
            Goal.kind == GoalKind.debt_payoff,
        )
    ).scalars().all()

    out: list[_DebtRow] = []
    for g in rows:
        account = (
            db.get(Account, g.linked_debt_account_id)
            if g.linked_debt_account_id else None
        )
        # Balance: prefer live balance on the linked account, fall back to
        # the goal's gap (target - current = remaining).
        if account is not None and account.current_balance_cents is not None:
            # current_balance is signed: credit cards typically store as negative
            # (you owe money). Treat magnitude as the principal.
            balance = abs(account.current_balance_cents)
        else:
            balance = max(0, g.target_amount_cents - (g.current_amount_cents or 0))

        if balance <= 0:
            continue

        apr_bps = (account.apr_bps if account and account.apr_bps else 0) or 0

        # Minimum payment heuristic: 2% of balance, with $25 floor.
        # Real cards differ; this is a reasonable proxy for ranking.
        min_pay = max(2500, balance * 2 // 100)

        out.append(_DebtRow(
            goal_id=g.id,
            goal_name=g.name,
            account_id=account.id if account else None,
            balance_cents=balance,
            apr_bps=apr_bps,
            minimum_payment_cents=min_pay,
        ))
    return out


def _months_to_payoff(balance_cents: int, monthly_payment_cents: int, apr_bps: int) -> int | None:
    """Estimate months to clear principal at fixed monthly payment.

    Uses the standard amortisation formula:
        n = -log(1 - r·B/P) / log(1 + r)
    where r = monthly rate, B = balance, P = payment. Returns None if
    payment doesn't cover monthly interest (the loan grows). Capped at
    600 months (50y) to avoid absurd projections.
    """
    if monthly_payment_cents <= 0 or balance_cents <= 0:
        return None
    monthly_rate = (apr_bps / 10000.0) / 12.0
    if monthly_rate <= 0:
        return max(1, -(-balance_cents // monthly_payment_cents))
    # Payment must exceed monthly interest, else principal never declines.
    monthly_interest = balance_cents * monthly_rate
    if monthly_payment_cents <= monthly_interest:
        return None
    import math
    try:
        n = -math.log(1 - monthly_rate * balance_cents / monthly_payment_cents) / math.log(1 + monthly_rate)
    except (ValueError, ZeroDivisionError):
        return None
    return min(600, max(1, int(round(n))))


def _total_interest_cents(balance_cents: int, monthly_payment_cents: int, apr_bps: int) -> int:
    """Total interest paid over the life of the loan at fixed payment."""
    months = _months_to_payoff(balance_cents, monthly_payment_cents, apr_bps)
    if months is None:
        return 0  # can't be computed; UI shows "—"
    total_paid = months * monthly_payment_cents
    return max(0, total_paid - balance_cents)


def _build_debt_strategy(
    debts: list[_DebtRow],
    extra_surplus_cents: int,
    strategy: Literal["avalanche", "snowball"],
) -> Suggestion | None:
    """Compose one strategy comparison row.

    The "extra_surplus_cents" is added to the FIRST debt's monthly payment
    (highest APR for avalanche, smallest balance for snowball). All other
    debts continue with their minimum. We compute total months + total
    interest paid for the prioritised debt under both 'with surplus' and
    'minimum only' scenarios, so the user sees how much the surplus
    accelerates payoff.
    """
    if not debts:
        return None

    if strategy == "avalanche":
        ordered = sorted(debts, key=lambda d: (-d.apr_bps, d.balance_cents))
        kind: SuggestionKind = "debt_payoff_avalanche"
        title_strategy = "Avalanche (highest APR first)"
    else:
        ordered = sorted(debts, key=lambda d: (d.balance_cents, -d.apr_bps))
        kind = "debt_payoff_snowball"
        title_strategy = "Snowball (smallest balance first)"

    target = ordered[0]
    # Don't fully drain surplus — show the math as if surplus is added on top
    # of the minimum on this single account. User decides whether to actually
    # commit it.
    accelerated_payment = target.minimum_payment_cents + max(0, extra_surplus_cents)
    months_min = _months_to_payoff(
        target.balance_cents, target.minimum_payment_cents, target.apr_bps
    )
    months_acc = _months_to_payoff(
        target.balance_cents, accelerated_payment, target.apr_bps
    )
    interest_min = _total_interest_cents(
        target.balance_cents, target.minimum_payment_cents, target.apr_bps
    )
    interest_acc = _total_interest_cents(
        target.balance_cents, accelerated_payment, target.apr_bps
    )
    interest_saved = max(0, interest_min - interest_acc)
    months_saved = (months_min - months_acc) if (months_min and months_acc) else None

    apr_pct = target.apr_bps / 100.0
    body_lines: list[str] = [
        f"Strategy: {title_strategy}.",
        f"Target debt: '{target.goal_name}' "
        f"(${target.balance_cents/100:.2f} @ {apr_pct:.2f}% APR).",
    ]
    if months_min and months_acc:
        body_lines.append(
            f"At minimum (${target.minimum_payment_cents/100:.2f}/mo): "
            f"~{months_min} months, ${interest_min/100:.2f} interest."
        )
        body_lines.append(
            f"With +${extra_surplus_cents/100:.2f} surplus "
            f"(${accelerated_payment/100:.2f}/mo): "
            f"~{months_acc} months, ${interest_acc/100:.2f} interest."
        )
        if months_saved is not None:
            body_lines.append(
                f"Net: {months_saved} months saved, "
                f"${interest_saved/100:.2f} less interest."
            )
    else:
        body_lines.append(
            "(Couldn't project payoff months — payment may not exceed monthly interest.)"
        )

    other_debts_summary = ""
    if len(ordered) > 1:
        others = ", ".join(
            f"{d.goal_name} (${d.balance_cents/100:.2f} @ {d.apr_bps/100:.2f}%)"
            for d in ordered[1:]
        )
        other_debts_summary = f" Continue minimums on: {others}."
        body_lines.append(other_debts_summary.strip())

    body = " ".join(body_lines)

    return Suggestion(
        kind=kind,
        title=f"{title_strategy}: target {target.goal_name}",
        body=body,
        estimated_savings_cents=interest_saved,
        confidence=0.85 if strategy == "avalanche" else 0.65,
        goal_id=target.goal_id,
        account_id=target.account_id,
        before_after=[
            BeforeAfter(
                label="Months to payoff (this debt)",
                current_cents=(months_min or 0) * 100,    # encode months as cents for uniform shape
                if_act_cents=(months_acc or 0) * 100,
                if_dont_act_cents=(months_min or 0) * 100,
                summary=(
                    f"~{months_min or '—'} months at minimum "
                    f"vs ~{months_acc or '—'} months with surplus."
                ),
            ),
            BeforeAfter(
                label="Total interest paid (this debt)",
                current_cents=interest_min,
                if_act_cents=interest_acc,
                if_dont_act_cents=interest_min,
                summary=(
                    f"${interest_min/100:.2f} at minimum → "
                    f"${interest_acc/100:.2f} with surplus "
                    f"(saves ${interest_saved/100:.2f})."
                ),
            ),
            BeforeAfter(
                label="Surplus deployed",
                current_cents=extra_surplus_cents,
                if_act_cents=0,
                if_dont_act_cents=extra_surplus_cents,
                summary=(
                    f"${extra_surplus_cents/100:.2f} would go toward this debt "
                    f"and then become available again once it clears."
                ),
            ),
        ],
        extra={
            "strategy": strategy,
            "target_apr_bps": target.apr_bps,
            "target_balance_cents": target.balance_cents,
            "target_min_payment_cents": target.minimum_payment_cents,
            "accelerated_payment_cents": accelerated_payment,
            "months_min": months_min,
            "months_accelerated": months_acc,
            "interest_min_cents": interest_min,
            "interest_accelerated_cents": interest_acc,
            "interest_saved_cents": interest_saved,
            "n_other_debts": max(0, len(ordered) - 1),
        },
    )


def build_debt_strategies(db: Session, surplus_cents: int) -> list[Suggestion]:
    """Return both avalanche and snowball comparisons.

    Returning both lets the UI show them side-by-side. Chris's project
    memory says he wants to *see the tradeoff* — for low-APR debts the two
    strategies look almost identical and the smaller-balance ordering can
    be more motivating; for high-APR cards, avalanche wins by a lot.
    Forcing one would lose that nuance.
    """
    debts = _collect_debts(db)
    if not debts:
        return []
    extra = max(0, surplus_cents)
    out: list[Suggestion] = []
    av = _build_debt_strategy(debts, extra, "avalanche")
    sn = _build_debt_strategy(debts, extra, "snowball")
    if av:
        out.append(av)
    if sn:
        out.append(sn)
    return out


# --------------------------------------------------------------------
#  Top-level entry point
# --------------------------------------------------------------------


def build_suggestions(
    db: Session,
    mode: SurplusMode = "historical",
    today: date | None = None,
) -> SuggestionBundle:
    """Compose the full bundle.

    The ``mode`` argument selects which surplus number anchors the
    allocations + debt-payoff math. We deliberately compute against ONE
    surplus mode here instead of both — comparing allocations for both
    modes gets confusing fast. The UI lets the user toggle and re-fetch.
    """
    today = today or date.today()
    snap = compute_surplus(db, mode if mode != "both" else "historical", today)
    chosen_mode: SurplusMode = mode if mode != "both" else "historical"
    if chosen_mode == "historical":
        anchor = snap.historical.surplus_cents if snap.historical else 0
    else:
        anchor = snap.forecast.surplus_cents if snap.forecast else 0

    bundle = SuggestionBundle(
        as_of=today,
        surplus_mode=chosen_mode,
        surplus_cents=anchor,
    )

    bundle.allocations = build_allocations(db, max(0, anchor), today)
    bundle.cancellations = build_cancellations(db, anchor)
    bundle.debt_strategies = build_debt_strategies(db, anchor)

    if anchor < 0:
        bundle.notes.append(
            f"Surplus is negative (${anchor/100:.2f}). Allocations are skipped; "
            f"focus on cancellations to free room before contributing."
        )
    elif anchor == 0:
        bundle.notes.append(
            "Surplus is exactly zero — no room to allocate this cycle. "
            "Consider cancellations to create surplus."
        )
    return bundle
