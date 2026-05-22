"""Insights endpoints — Phase 5.3 weekly digest.

GET /insights/weekly       structured digest (no narration)
GET /insights/weekly/text  same digest rendered as prose (Ollama, with template fallback)

The structured endpoint is JSON-friendly for the dashboard to render
its own UI; the text endpoint is what the daily-digest email will
embed when Phase 6 lands.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from finance_app.db.session import get_db
from finance_app.insights import build_weekly_digest, render_digest

router = APIRouter(prefix="/insights", tags=["insights"])


class CategoryDeltaOut(BaseModel):
    category_name: str
    this_week_cents: int
    avg_week_cents: int
    delta_pct: float


class WeeklyDigestOut(BaseModel):
    week_start: date
    week_end: date
    total_outflow_cents: int
    total_inflow_cents: int
    net_cents: int
    overall_delta_pct: float
    biggest_increases: list[CategoryDeltaOut]
    biggest_decreases: list[CategoryDeltaOut]
    new_active_subs: list[str]
    aggregate_utilization_pct: float | None
    cards_above_cliff: list[str]


class WeeklyDigestTextOut(BaseModel):
    week_start: date
    week_end: date
    text: str
    source: str  # "ollama" or "template"


@router.get("/weekly", response_model=WeeklyDigestOut)
def weekly_digest(db: Session = Depends(get_db)) -> WeeklyDigestOut:
    d = build_weekly_digest(db)
    return WeeklyDigestOut(
        week_start=d.week_start,
        week_end=d.week_end,
        total_outflow_cents=d.total_outflow_cents,
        total_inflow_cents=d.total_inflow_cents,
        net_cents=d.net_cents,
        overall_delta_pct=d.overall_delta_pct,
        biggest_increases=[
            CategoryDeltaOut(
                category_name=x.category_name,
                this_week_cents=x.this_week_cents,
                avg_week_cents=x.avg_week_cents,
                delta_pct=x.delta_pct,
            )
            for x in d.biggest_increases
        ],
        biggest_decreases=[
            CategoryDeltaOut(
                category_name=x.category_name,
                this_week_cents=x.this_week_cents,
                avg_week_cents=x.avg_week_cents,
                delta_pct=x.delta_pct,
            )
            for x in d.biggest_decreases
        ],
        new_active_subs=d.new_active_subs,
        aggregate_utilization_pct=d.aggregate_utilization_pct,
        cards_above_cliff=d.cards_above_cliff,
    )


class CategoryYearTotalOut(BaseModel):
    category_id: int | None
    category_name: str
    total_cents: int
    pct_of_total: float
    yoy_delta_cents: int | None
    yoy_delta_pct: float | None


class TopPurchaseOut(BaseModel):
    transaction_id: int
    posted_date: date
    description: str
    amount_cents: int
    category_name: str | None


class ScoreTrajectoryOut(BaseModel):
    bureau: str
    first_score: int | None
    first_seen: date | None
    last_score: int | None
    last_seen: date | None
    min_score: int | None
    max_score: int | None
    delta: int | None


class AnnualReviewOut(BaseModel):
    year: int
    total_inflow_cents: int
    total_outflow_cents: int
    net_cents: int
    yoy_outflow_delta_cents: int | None
    top_categories: list[CategoryYearTotalOut]
    top_purchases: list[TopPurchaseOut]
    subs_added: list[str]
    subs_cancelled: list[str]
    recurring_monthly_start_cents: int
    recurring_monthly_end_cents: int
    score_trajectories: list[ScoreTrajectoryOut]
    retention_savings_cents: int
    retention_attempts_count: int
    goals_achieved: list[str]
    net_worth_start_cents: int | None
    net_worth_end_cents: int | None
    net_worth_delta_cents: int | None
    class_action_collected_cents: int


@router.get("/annual-review", response_model=AnnualReviewOut)
def annual_review(year: int, db: Session = Depends(get_db)) -> AnnualReviewOut:
    """Year-in-money structured digest. UI renders as a long page."""
    from finance_app.insights import build_annual_review
    r = build_annual_review(db, year=year)
    return AnnualReviewOut(
        year=r.year,
        total_inflow_cents=r.total_inflow_cents,
        total_outflow_cents=r.total_outflow_cents,
        net_cents=r.net_cents,
        yoy_outflow_delta_cents=r.yoy_outflow_delta_cents,
        top_categories=[
            CategoryYearTotalOut(
                category_id=c.category_id,
                category_name=c.category_name,
                total_cents=c.total_cents,
                pct_of_total=c.pct_of_total,
                yoy_delta_cents=c.yoy_delta_cents,
                yoy_delta_pct=c.yoy_delta_pct,
            )
            for c in r.top_categories
        ],
        top_purchases=[
            TopPurchaseOut(
                transaction_id=p.transaction_id,
                posted_date=p.posted_date,
                description=p.description,
                amount_cents=p.amount_cents,
                category_name=p.category_name,
            )
            for p in r.top_purchases
        ],
        subs_added=r.subs_added,
        subs_cancelled=r.subs_cancelled,
        recurring_monthly_start_cents=r.recurring_monthly_start_cents,
        recurring_monthly_end_cents=r.recurring_monthly_end_cents,
        score_trajectories=[
            ScoreTrajectoryOut(
                bureau=s.bureau,
                first_score=s.first_score,
                first_seen=s.first_seen,
                last_score=s.last_score,
                last_seen=s.last_seen,
                min_score=s.min_score,
                max_score=s.max_score,
                delta=s.delta,
            )
            for s in r.score_trajectories
        ],
        retention_savings_cents=r.retention_savings_cents,
        retention_attempts_count=r.retention_attempts_count,
        goals_achieved=r.goals_achieved,
        net_worth_start_cents=r.net_worth_start_cents,
        net_worth_end_cents=r.net_worth_end_cents,
        net_worth_delta_cents=r.net_worth_delta_cents,
        class_action_collected_cents=r.class_action_collected_cents,
    )


@router.get("/weekly/text", response_model=WeeklyDigestTextOut)
def weekly_digest_text(db: Session = Depends(get_db)) -> WeeklyDigestTextOut:
    """Rendered prose digest. Tries Ollama; falls back to deterministic template.

    The ``source`` field tells the UI which one was used so it can show
    a "running offline (template fallback)" badge if Ollama wasn't reachable.
    """
    from finance_app.insights.narrator import render_template
    from finance_app.llm import get_client, OllamaUnavailable

    d = build_weekly_digest(db)
    # Detect whether we'll get an LLM-rendered version vs. fallback.
    template_text = render_template(d)
    try:
        client = get_client()
        if client.is_available():
            text = render_digest(d)
            # render_digest returns the template if Ollama produced
            # something too short — distinguish by string equality.
            source = "ollama" if text != template_text else "template"
        else:
            text = template_text
            source = "template"
    except OllamaUnavailable:
        text = template_text
        source = "template"
    return WeeklyDigestTextOut(
        week_start=d.week_start,
        week_end=d.week_end,
        text=text,
        source=source,
    )
