"""Weekly digest builder + narrator.

Two-step design:

  1. ``build_weekly_digest(db, today)`` — pure data. Pulls structured
     facts about the past 7 days (spending vs. trailing average,
     new subs detected, biggest swings, surplus, top utilization).
     Returns a :class:`WeeklyDigest` dataclass.

  2. ``render_digest(digest)`` — turns the dataclass into prose.
     Tries Ollama first for nicer-sounding output; falls back to a
     deterministic template if Ollama isn't reachable. Either way the
     consumer (digest email, dashboard tile) gets a non-empty string.

The split is deliberate: the data layer is testable / cacheable, the
prose layer is swappable. If we ever want to swap llama3.1 for a
different local model or for a hosted API, only ``render_digest``
changes.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ..db.models import (
    Account,
    AccountType,
    Category,
    Subscription,
    SubscriptionStatus,
    Transaction,
)
from ..llm import OllamaUnavailable, get_client

logger = logging.getLogger(__name__)


@dataclass
class CategoryDelta:
    """One category's spend this week vs. its trailing-average week."""
    category_name: str
    this_week_cents: int
    avg_week_cents: int
    delta_pct: float  # signed — positive means up


@dataclass
class WeeklyDigest:
    """Structured digest input. JSON-serializable."""

    week_start: date
    week_end: date
    total_outflow_cents: int
    total_inflow_cents: int
    net_cents: int
    # Spending vs. trailing 4-week average — overall + per category
    overall_delta_pct: float
    biggest_increases: list[CategoryDelta] = field(default_factory=list)
    biggest_decreases: list[CategoryDelta] = field(default_factory=list)
    # Subs flagged as new this week (status changed to active)
    new_active_subs: list[str] = field(default_factory=list)
    # Aggregate live utilization across all credit cards (0–100)
    aggregate_utilization_pct: float | None = None
    # Cards with utilization above any FICO cliff
    cards_above_cliff: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------
#  Data layer
# ---------------------------------------------------------------------


def _outflow_in_window(
    db: Session, *, start: date, end: date
) -> tuple[int, dict[int, int]]:
    """Return (total_outflow, by_category_id) for the window [start, end]."""
    outflow_expr = func.sum(
        case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
    ).label("outflow")
    rows = db.execute(
        select(Transaction.category_id, outflow_expr)
        .where(Transaction.posted_date >= start)
        .where(Transaction.posted_date <= end)
        .group_by(Transaction.category_id)
    ).all()
    total = 0
    by_cat: dict[int, int] = {}
    for r in rows:
        v = int(r.outflow or 0)
        total += v
        if r.category_id is not None:
            by_cat[r.category_id] = v
    return total, by_cat


def _inflow_in_window(db: Session, *, start: date, end: date) -> int:
    expr = func.sum(
        case((Transaction.amount_cents > 0, Transaction.amount_cents), else_=0)
    )
    return int(
        db.execute(
            select(expr)
            .where(Transaction.posted_date >= start)
            .where(Transaction.posted_date <= end)
        ).scalar()
        or 0
    )


def _category_names(db: Session) -> dict[int, str]:
    return {c.id: c.name for c in db.execute(select(Category)).scalars().all()}


def build_weekly_digest(
    db: Session, *, today: date | None = None
) -> WeeklyDigest:
    """Build a structured digest for the past 7 days.

    Compares the past 7 days against the 4 prior weeks (28 days). Edge
    cases:
      * Brand-new DB with <7 days of data — most fields will be zero.
        That's fine; the narrator handles empty gracefully.
      * Categories with no spend in the trailing window get skipped
        from the biggest-swings list (no baseline to compare against).
    """
    today = today or date.today()
    week_start = today - timedelta(days=6)
    week_end = today
    avg_window_start = today - timedelta(days=34)
    avg_window_end = today - timedelta(days=7)

    # 1. Spend totals + per-cat for THIS week
    this_total, this_by_cat = _outflow_in_window(db, start=week_start, end=week_end)
    inflow = _inflow_in_window(db, start=week_start, end=week_end)

    # 2. Same for trailing 4 weeks → average per week
    avg_total, avg_by_cat = _outflow_in_window(
        db, start=avg_window_start, end=avg_window_end
    )
    weeks = 4
    avg_per_week_total = avg_total // weeks if avg_total else 0
    avg_per_week_by_cat = {k: v // weeks for k, v in avg_by_cat.items()}

    overall_pct = (
        ((this_total - avg_per_week_total) / avg_per_week_total * 100)
        if avg_per_week_total > 0
        else 0.0
    )

    # 3. Per-category deltas
    cat_names = _category_names(db)
    deltas: list[CategoryDelta] = []
    all_cats = set(this_by_cat) | set(avg_per_week_by_cat)
    for cid in all_cats:
        if cid is None:
            continue
        this_v = this_by_cat.get(cid, 0)
        avg_v = avg_per_week_by_cat.get(cid, 0)
        if avg_v == 0 and this_v == 0:
            continue
        if avg_v == 0:
            delta_pct = 100.0  # new spending category — show as +100% to floor it
        else:
            delta_pct = (this_v - avg_v) / avg_v * 100
        deltas.append(
            CategoryDelta(
                category_name=cat_names.get(cid, "Uncategorized"),
                this_week_cents=this_v,
                avg_week_cents=avg_v,
                delta_pct=round(delta_pct, 1),
            )
        )

    # Biggest 3 increases + 3 decreases by absolute % change. Skip
    # categories under $20 this week — too noisy.
    sig = [d for d in deltas if d.this_week_cents >= 2000 or d.avg_week_cents >= 2000]
    increases = sorted(sig, key=lambda d: d.delta_pct, reverse=True)[:3]
    decreases = sorted(sig, key=lambda d: d.delta_pct)[:3]
    decreases = [d for d in decreases if d.delta_pct < -10]

    # 4. New active subs this week (proxy: created_at in window)
    new_subs = list(
        db.execute(
            select(Subscription.name)
            .where(Subscription.created_at >= week_start)
            .where(Subscription.status == SubscriptionStatus.active)
        ).scalars().all()
    )

    # 5. Live utilization across credit cards
    cards = list(
        db.execute(
            select(Account).where(Account.account_type == AccountType.credit_card)
        ).scalars().all()
    )
    total_limit = sum(c.credit_limit_cents or 0 for c in cards)
    total_balance = sum(c.current_balance_cents or 0 for c in cards)
    agg_util = (
        round(total_balance / total_limit * 100, 1)
        if total_limit > 0
        else None
    )
    above_cliff_cards: list[str] = []
    for c in cards:
        if c.credit_limit_cents and c.current_balance_cents:
            pct = c.current_balance_cents / c.credit_limit_cents * 100
            if pct > 30:  # above the major FICO cliff
                above_cliff_cards.append(f"{c.name} ({pct:.0f}%)")

    return WeeklyDigest(
        week_start=week_start,
        week_end=week_end,
        total_outflow_cents=this_total,
        total_inflow_cents=inflow,
        net_cents=inflow - this_total,
        overall_delta_pct=round(overall_pct, 1),
        biggest_increases=increases,
        biggest_decreases=decreases,
        new_active_subs=new_subs,
        aggregate_utilization_pct=agg_util,
        cards_above_cliff=above_cliff_cards,
    )


# ---------------------------------------------------------------------
#  Prose layer
# ---------------------------------------------------------------------


def render_template(d: WeeklyDigest) -> str:
    """Deterministic templater. Always works; sounds robotic but useful."""
    lines: list[str] = []
    lines.append(
        f"Week {d.week_start.isoformat()} → {d.week_end.isoformat()}: "
        f"${d.total_outflow_cents/100:,.0f} out, ${d.total_inflow_cents/100:,.0f} in, "
        f"net ${d.net_cents/100:+,.0f}."
    )
    if abs(d.overall_delta_pct) >= 5:
        direction = "up" if d.overall_delta_pct > 0 else "down"
        lines.append(
            f"Overall spending is {direction} {abs(d.overall_delta_pct):.1f}% vs your "
            f"trailing 4-week average."
        )
    if d.biggest_increases:
        top = d.biggest_increases[0]
        lines.append(
            f"Biggest increase: {top.category_name} "
            f"(${top.this_week_cents/100:.0f} vs ${top.avg_week_cents/100:.0f} avg, "
            f"{top.delta_pct:+.0f}%)."
        )
    if d.biggest_decreases:
        top = d.biggest_decreases[0]
        lines.append(
            f"Biggest decrease: {top.category_name} "
            f"({top.delta_pct:+.0f}% vs trailing avg)."
        )
    if d.new_active_subs:
        names = ", ".join(d.new_active_subs[:3])
        lines.append(f"New subscriptions detected this week: {names}.")
    if d.cards_above_cliff:
        lines.append(
            f"Heads up: {', '.join(d.cards_above_cliff)} above the 30% utilization "
            f"cliff — consider paying down before statement close."
        )
    return " ".join(lines)


_NARRATOR_SYSTEM = (
    "You are a personal-finance assistant. Given a structured weekly "
    "summary, write a friendly 3-5 sentence digest the user will read "
    "with their morning coffee. Concrete and specific. No emoji, no "
    "filler, no platitudes. Mention dollar amounts when helpful. Don't "
    "repeat the data verbatim — synthesize."
)


def _digest_to_prompt(d: WeeklyDigest) -> str:
    parts = [
        f"Week: {d.week_start.isoformat()} to {d.week_end.isoformat()}",
        f"Total outflow this week: ${d.total_outflow_cents/100:,.2f}",
        f"Total inflow this week: ${d.total_inflow_cents/100:,.2f}",
        f"Net: ${d.net_cents/100:,.2f}",
        f"Overall spending vs 4-week avg: {d.overall_delta_pct:+.1f}%",
    ]
    if d.biggest_increases:
        parts.append("Biggest spending increases:")
        for x in d.biggest_increases:
            parts.append(
                f"  - {x.category_name}: ${x.this_week_cents/100:.0f} vs "
                f"${x.avg_week_cents/100:.0f} avg ({x.delta_pct:+.0f}%)"
            )
    if d.biggest_decreases:
        parts.append("Biggest spending decreases:")
        for x in d.biggest_decreases:
            parts.append(
                f"  - {x.category_name}: ${x.this_week_cents/100:.0f} vs "
                f"${x.avg_week_cents/100:.0f} avg ({x.delta_pct:+.0f}%)"
            )
    if d.new_active_subs:
        parts.append(f"New subscriptions detected: {', '.join(d.new_active_subs)}")
    if d.cards_above_cliff:
        parts.append(f"Cards above 30% utilization cliff: {', '.join(d.cards_above_cliff)}")
    if d.aggregate_utilization_pct is not None:
        parts.append(f"Aggregate credit utilization: {d.aggregate_utilization_pct:.1f}%")
    return "\n".join(parts)


def render_digest(d: WeeklyDigest) -> str:
    """Return the prose digest. Ollama if available, deterministic template otherwise."""
    template_version = render_template(d)
    try:
        client = get_client()
        if not client.is_available():
            return template_version
        prompt = (
            f"{_digest_to_prompt(d)}\n\n"
            "Write a 3-5 sentence plain-English digest. Be specific."
        )
        prose = client.generate(
            prompt,
            system=_NARRATOR_SYSTEM,
            temperature=0.4,
            max_tokens=320,
        ).strip()
        # Defensive: if the LLM produces nothing useful, fall back.
        if len(prose) < 30:
            return template_version
        return prose
    except OllamaUnavailable:
        return template_version
    except Exception:  # noqa: BLE001 — never let narrator failures break a digest
        logger.exception("Narrator error; falling back to template")
        return template_version
