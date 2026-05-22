"""Annual review — "year in money" digest (Phase 7.6).

Companion to the weekly digest. Produces a structured year-end summary
the user reviews once a year (or in mid-year as a check-in). Layers
in YoY comparison when the prior year has data.

What gets surfaced
------------------
  * Total inflow / outflow / net for the year
  * Top 10 categories by spend, with $ + % of total + YoY delta
  * Top 10 single-purchase transactions
  * Subscriptions added during the year + cancelled during the year
  * Total recurring-monthly cost shift (start of year vs. end)
  * Credit-score trajectory (first vs. last vs. min vs. max)
  * Retention savings — sum of (monthly_savings × duration_months)
    from accepted RetentionAttempt rows during the year
  * Goal achievements — goals that flipped to "achieved" during the year
  * Net-worth delta — first vs. last NetWorthSnapshot in the year
  * Class-action collected — sum of paid LegalClaim actual_payout_cents

This is structured data; rendering to a long-page UI happens elsewhere.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ..db.models import (
    Category,
    CreditScoreSnapshot,
    Goal,
    GoalStatus,
    LegalClaim,
    LegalClaimStatus,
    NetWorthSnapshot,
    RetentionAttempt,
    RetentionOutcome,
    Subscription,
    SubscriptionStatus,
    Transaction,
)


@dataclass
class CategoryYearTotal:
    category_id: int | None
    category_name: str
    total_cents: int
    pct_of_total: float
    yoy_delta_cents: int | None  # signed: + means more than last year
    yoy_delta_pct: float | None


@dataclass
class TopPurchase:
    transaction_id: int
    posted_date: date
    description: str
    amount_cents: int  # negative for outflow (we store as-is)
    category_name: str | None


@dataclass
class ScoreTrajectory:
    bureau: str
    first_score: int | None
    first_seen: date | None
    last_score: int | None
    last_seen: date | None
    min_score: int | None
    max_score: int | None
    delta: int | None  # last - first


@dataclass
class AnnualReview:
    year: int
    total_inflow_cents: int
    total_outflow_cents: int
    net_cents: int
    yoy_outflow_delta_cents: int | None
    top_categories: list[CategoryYearTotal] = field(default_factory=list)
    top_purchases: list[TopPurchase] = field(default_factory=list)
    subs_added: list[str] = field(default_factory=list)
    subs_cancelled: list[str] = field(default_factory=list)
    recurring_monthly_start_cents: int = 0
    recurring_monthly_end_cents: int = 0
    score_trajectories: list[ScoreTrajectory] = field(default_factory=list)
    retention_savings_cents: int = 0
    retention_attempts_count: int = 0
    goals_achieved: list[str] = field(default_factory=list)
    net_worth_start_cents: int | None = None
    net_worth_end_cents: int | None = None
    net_worth_delta_cents: int | None = None
    class_action_collected_cents: int = 0


def build_annual_review(db: Session, year: int) -> AnnualReview:
    start = date(year, 1, 1)
    end = date(year, 12, 31)
    prev_start = date(year - 1, 1, 1)
    prev_end = date(year - 1, 12, 31)

    # ---- 1. Year totals ----
    inflow_expr = func.sum(
        case((Transaction.amount_cents > 0, Transaction.amount_cents), else_=0)
    )
    outflow_expr = func.sum(
        case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
    )
    inflow, outflow = (
        db.execute(
            select(inflow_expr, outflow_expr)
            .where(Transaction.posted_date >= start)
            .where(Transaction.posted_date <= end)
        ).one()
    )
    inflow = int(inflow or 0)
    outflow = int(outflow or 0)

    prev_outflow = int(
        db.execute(
            select(outflow_expr)
            .where(Transaction.posted_date >= prev_start)
            .where(Transaction.posted_date <= prev_end)
        ).scalar()
        or 0
    )
    yoy_outflow_delta = (outflow - prev_outflow) if prev_outflow > 0 else None

    # ---- 2. Top categories with YoY ----
    rows = list(
        db.execute(
            select(
                Transaction.category_id,
                func.sum(
                    case(
                        (Transaction.amount_cents < 0, -Transaction.amount_cents),
                        else_=0,
                    )
                ).label("outflow"),
            )
            .where(Transaction.posted_date >= start)
            .where(Transaction.posted_date <= end)
            .group_by(Transaction.category_id)
        ).all()
    )
    prev_rows = dict(
        db.execute(
            select(
                Transaction.category_id,
                func.sum(
                    case(
                        (Transaction.amount_cents < 0, -Transaction.amount_cents),
                        else_=0,
                    )
                ).label("outflow"),
            )
            .where(Transaction.posted_date >= prev_start)
            .where(Transaction.posted_date <= prev_end)
            .group_by(Transaction.category_id)
        ).all()
    )
    cat_names = {c.id: c.name for c in db.execute(select(Category)).scalars().all()}
    top_cats: list[CategoryYearTotal] = []
    for r in rows:
        total = int(r.outflow or 0)
        if total == 0:
            continue
        prev_total = int(prev_rows.get(r.category_id, 0) or 0)
        if prev_total > 0:
            yoy_delta = total - prev_total
            yoy_pct = round((yoy_delta / prev_total) * 100, 1)
        else:
            yoy_delta = None
            yoy_pct = None
        top_cats.append(
            CategoryYearTotal(
                category_id=r.category_id,
                category_name=cat_names.get(r.category_id, "Uncategorized")
                if r.category_id
                else "Uncategorized",
                total_cents=total,
                pct_of_total=round(total / outflow * 100, 1) if outflow > 0 else 0,
                yoy_delta_cents=yoy_delta,
                yoy_delta_pct=yoy_pct,
            )
        )
    top_cats.sort(key=lambda c: c.total_cents, reverse=True)
    top_cats = top_cats[:10]

    # ---- 3. Top single purchases ----
    purchases_q = list(
        db.execute(
            select(Transaction)
            .where(Transaction.posted_date >= start)
            .where(Transaction.posted_date <= end)
            .where(Transaction.amount_cents < 0)
            .order_by(Transaction.amount_cents.asc())  # most negative first
            .limit(10)
        ).scalars().all()
    )
    top_purchases = [
        TopPurchase(
            transaction_id=t.id,
            posted_date=t.posted_date,
            description=t.description_raw or "",
            amount_cents=t.amount_cents,
            category_name=cat_names.get(t.category_id) if t.category_id else None,
        )
        for t in purchases_q
    ]

    # ---- 4. Subs added / cancelled ----
    subs_added = [
        s.name
        for s in db.execute(
            select(Subscription)
            .where(Subscription.created_at >= start)
            .where(Subscription.created_at <= end)
            .where(Subscription.status == SubscriptionStatus.active)
        ).scalars().all()
    ]
    subs_cancelled = [
        s.name
        for s in db.execute(
            select(Subscription)
            .where(Subscription.updated_at >= start)
            .where(Subscription.updated_at <= end)
            .where(Subscription.status == SubscriptionStatus.cancelled)
        ).scalars().all()
    ]

    # Approximate recurring-monthly start vs end. Best-effort — we don't
    # track historical sub state, so we use "subs that existed by Jan 1
    # and are still alive" vs "subs that exist on Dec 31."
    all_subs = list(db.execute(select(Subscription)).scalars().all())
    rec_start = sum(
        abs(s.last_amount_cents or s.amount_cents or 0)
        for s in all_subs
        if s.created_at.date() < start
        and s.status in (SubscriptionStatus.active, SubscriptionStatus.suspected)
    )
    rec_end = sum(
        abs(s.last_amount_cents or s.amount_cents or 0)
        for s in all_subs
        if s.created_at.date() <= end
        and s.status == SubscriptionStatus.active
    )

    # ---- 5. Score trajectories per bureau ----
    score_rows = list(
        db.execute(
            select(CreditScoreSnapshot)
            .where(CreditScoreSnapshot.as_of >= start)
            .where(CreditScoreSnapshot.as_of <= end)
            .order_by(CreditScoreSnapshot.as_of)
        ).scalars().all()
    )
    by_bureau: dict[str, list[CreditScoreSnapshot]] = defaultdict(list)
    for s in score_rows:
        # bureau is a CreditBureau enum — store as string key for grouping
        bureau_key = s.bureau.value if hasattr(s.bureau, "value") else str(s.bureau)
        by_bureau[bureau_key].append(s)
    trajectories: list[ScoreTrajectory] = []
    for bureau, scores in by_bureau.items():
        if not scores:
            continue
        first = scores[0]
        last = scores[-1]
        all_vals = [s.score for s in scores]
        trajectories.append(
            ScoreTrajectory(
                bureau=bureau,
                first_score=first.score,
                first_seen=first.as_of,
                last_score=last.score,
                last_seen=last.as_of,
                min_score=min(all_vals),
                max_score=max(all_vals),
                delta=last.score - first.score,
            )
        )

    # ---- 6. Retention savings ----
    accepted = list(
        db.execute(
            select(RetentionAttempt)
            .where(RetentionAttempt.contacted_at >= start)
            .where(RetentionAttempt.contacted_at <= end)
            .where(RetentionAttempt.outcome == RetentionOutcome.accepted)
        ).scalars().all()
    )
    retention_savings = sum(
        (a.monthly_savings_cents or 0) * (a.duration_months or 0) for a in accepted
    )

    # ---- 7. Goals achieved ----
    goals_achieved = [
        g.name
        for g in db.execute(
            select(Goal)
            .where(Goal.status == GoalStatus.achieved)
            .where(Goal.updated_at >= start)
            .where(Goal.updated_at <= end)
        ).scalars().all()
    ]

    # ---- 8. Net-worth delta ----
    nw_first = db.execute(
        select(NetWorthSnapshot)
        .where(NetWorthSnapshot.as_of >= start)
        .where(NetWorthSnapshot.as_of <= end)
        .order_by(NetWorthSnapshot.as_of)
        .limit(1)
    ).scalar_one_or_none()
    nw_last = db.execute(
        select(NetWorthSnapshot)
        .where(NetWorthSnapshot.as_of >= start)
        .where(NetWorthSnapshot.as_of <= end)
        .order_by(NetWorthSnapshot.as_of.desc())
        .limit(1)
    ).scalar_one_or_none()
    nw_start_cents = nw_first.net_cents if nw_first else None
    nw_end_cents = nw_last.net_cents if nw_last else None
    nw_delta = (
        nw_end_cents - nw_start_cents
        if nw_start_cents is not None and nw_end_cents is not None
        else None
    )

    # ---- 9. Class-action collected ----
    paid_claims = list(
        db.execute(
            select(LegalClaim)
            .where(LegalClaim.status == LegalClaimStatus.paid)
            .where(LegalClaim.paid_at >= start)
            .where(LegalClaim.paid_at <= end)
        ).scalars().all()
    )
    class_action_total = sum(
        c.actual_payout_cents or c.estimated_payout_cents or 0 for c in paid_claims
    )

    return AnnualReview(
        year=year,
        total_inflow_cents=inflow,
        total_outflow_cents=outflow,
        net_cents=inflow - outflow,
        yoy_outflow_delta_cents=yoy_outflow_delta,
        top_categories=top_cats,
        top_purchases=top_purchases,
        subs_added=subs_added,
        subs_cancelled=subs_cancelled,
        recurring_monthly_start_cents=rec_start,
        recurring_monthly_end_cents=rec_end,
        score_trajectories=trajectories,
        retention_savings_cents=retention_savings,
        retention_attempts_count=len(accepted),
        goals_achieved=goals_achieved,
        net_worth_start_cents=nw_start_cents,
        net_worth_end_cents=nw_end_cents,
        net_worth_delta_cents=nw_delta,
        class_action_collected_cents=class_action_total,
    )
