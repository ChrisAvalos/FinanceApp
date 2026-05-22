"""Chat tool registry for LLM-driven query routing.

The chat orchestrator can run in two modes:

  1. **Context mode** (the original): bake every relevant data summary
     into the prompt up-front, hope the LLM finds the right number.
     Simple, but token-hungry and brittle on niche questions.

  2. **Tool-use mode** (new): give the LLM a small list of tools it
     can request, ask it to emit a JSON plan, run the tools server-
     side, then re-prompt with the results. The LLM never has to
     hold thousands of transactions in context — it just asks for
     the slice it needs.

This module is the registry for mode 2. Each tool is a small Python
function with a JSON-schema-ish signature; ``execute()`` looks up the
function by name and runs it. The schemas live in :data:`TOOL_SPECS`
which is also what we hand the LLM in the plan prompt.

Tools intentionally return small structured dicts (not raw rows) so
the LLM doesn't choke on volume. A "top 10 merchants" query is fine;
"give me every transaction" is not on offer.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Account,
    Category,
    Goal,
    Subscription,
    SubscriptionStatus,
    Transaction,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
#  Tool specs — also used to build the LLM-facing tool list
# ---------------------------------------------------------------------------


TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "query_spending",
        "description": (
            "Sum of OUTFLOW (spending) over a date window, optionally "
            "filtered to a single category by name (case-insensitive "
            "substring match). Returns total cents and transaction count."
        ),
        "args": {
            "category": "string | null — substring of category name; null = all categories",
            "days": "int — window length, e.g. 30 for last 30 days",
        },
    },
    {
        "name": "query_income",
        "description": "Sum of INFLOW (income) over a date window. Returns total cents and transaction count.",
        "args": {
            "days": "int — window length",
        },
    },
    {
        "name": "query_account_balances",
        "description": (
            "Current balance for each active account. Optionally filtered by "
            "account-name substring (case-insensitive)."
        ),
        "args": {
            "name_filter": "string | null — substring match on account name; null = all",
        },
    },
    {
        "name": "query_top_merchants",
        "description": (
            "Top N merchants by total outflow over a date window. Returns "
            "each merchant with total cents and txn count."
        ),
        "args": {
            "days": "int",
            "limit": "int — max rows, default 10",
        },
    },
    {
        "name": "query_subscriptions",
        "description": "List active confirmed subscriptions with monthly cost. Returns total monthly cost too.",
        "args": {},
    },
    {
        "name": "query_goals",
        "description": "List in-progress goals with current/target/progress%/deadline.",
        "args": {},
    },
    {
        "name": "compare_spending_periods",
        "description": (
            "Compare spending in two recent windows. Returns total for each "
            "window and the absolute + percentage delta. Useful for 'is this "
            "month higher than last' style questions."
        ),
        "args": {
            "category": "string | null — substring match",
            "period_a_days": "int — newer window, e.g. 30 for the most-recent 30 days",
            "period_b_days": "int — older window, e.g. 30 for the 30 days before that",
        },
    },
    {
        "name": "query_category_breakdown",
        "description": (
            "Break down outflow by category over a date window. Returns "
            "list of (category_name, total_cents, txn_count) sorted desc by "
            "spend. Excludes transfer-like categories. Use this for 'what "
            "are my biggest spending buckets?'-style questions."
        ),
        "args": {
            "days": "int",
            "limit": "int — max rows, default 12",
        },
    },
    {
        "name": "query_fire_projection",
        "description": (
            "Run the FIRE Monte Carlo simulator with current auto-derived "
            "defaults (net worth, recent savings rate, last-12mo spending). "
            "Returns FIRE number, median hit age, success probability, "
            "safe withdrawal rate, and summary text. Use for 'am I on "
            "track to retire?' / 'when can I retire?' questions. The "
            "user can override age/retirement on the FIRE panel itself."
        ),
        "args": {
            "current_age": "int — default 32 if user hasn't set one",
            "target_retirement_age": "int — default 55",
            "simulation_mode": "string — 'normal' or 'historical'; default 'normal'",
        },
    },
    {
        "name": "query_attribution_month",
        "description": (
            "Net-worth attribution for a single recent month: how much "
            "did NW change, and what drove it (income, spending, debt "
            "paydown, market gains/other). Returns the month's "
            "decomposition + top spending categories. Use for 'why did "
            "my net worth change in October?' style questions."
        ),
        "args": {
            "month_offset": "int — 0 = current month, 1 = last month, etc. Default 1.",
        },
    },
]


# ---------------------------------------------------------------------------
#  Tool implementations
# ---------------------------------------------------------------------------


def _category_id_filter(db: Session, name_substr: str | None) -> set[int] | None:
    """Resolve a category-name substring to a set of matching category IDs.

    Returns None if name_substr is empty/None (caller treats as "no filter").
    Returns set() if the substring matches no categories — the caller should
    return zeros in that case rather than running an unfiltered query.
    """
    if not name_substr:
        return None
    rows = db.execute(select(Category)).scalars().all()
    needle = name_substr.lower()
    out = {c.id for c in rows if c.name and needle in c.name.lower()}
    return out  # empty set is a valid "no match" signal


# Tx-related categorization slugs we treat as transfers (mirrors
# attribution.py). These get excluded from spending/income queries
# unless the LLM explicitly asks for the transfer category.
_TRANSFER_PREFIXES = ("financial.transfer", "financial.payment",
                      "financial.loan_payment", "financial.mortgage_payment")


def _transfer_category_ids(db: Session) -> set[int]:
    rows = db.execute(select(Category.id, Category.slug)).all()
    return {
        cid
        for cid, slug in rows
        if slug and any(slug.startswith(p) for p in _TRANSFER_PREFIXES)
    }


def query_spending(db: Session, category: str | None = None, days: int = 30) -> dict[str, Any]:
    cutoff = date.today() - timedelta(days=days)
    cat_filter = _category_id_filter(db, category)
    transfer_ids = _transfer_category_ids(db)

    where = [
        Transaction.posted_date >= cutoff,
        Transaction.amount_cents < 0,
    ]
    if cat_filter is not None:
        where.append(Transaction.category_id.in_(cat_filter))
        if not cat_filter:
            return {
                "category_filter": category,
                "matched_categories": 0,
                "total_outflow_cents": 0,
                "txn_count": 0,
                "days": days,
                "note": f"No category matched substring '{category}'.",
            }
    else:
        # Exclude transfers from "spending" by default
        if transfer_ids:
            where.append(Transaction.category_id.notin_(transfer_ids))

    total = db.execute(
        select(
            func.coalesce(func.sum(func.abs(Transaction.amount_cents)), 0).label("total"),
            func.count().label("n"),
        ).where(*where)
    ).one()
    return {
        "category_filter": category,
        "matched_categories": (None if cat_filter is None else len(cat_filter)),
        "total_outflow_cents": int(total.total or 0),
        "txn_count": int(total.n or 0),
        "days": days,
    }


def query_income(db: Session, days: int = 30) -> dict[str, Any]:
    cutoff = date.today() - timedelta(days=days)
    transfer_ids = _transfer_category_ids(db)
    where = [Transaction.posted_date >= cutoff, Transaction.amount_cents > 0]
    if transfer_ids:
        where.append(Transaction.category_id.notin_(transfer_ids))
    total = db.execute(
        select(
            func.coalesce(func.sum(Transaction.amount_cents), 0).label("total"),
            func.count().label("n"),
        ).where(*where)
    ).one()
    return {
        "total_inflow_cents": int(total.total or 0),
        "txn_count": int(total.n or 0),
        "days": days,
    }


def query_account_balances(db: Session, name_filter: str | None = None) -> dict[str, Any]:
    rows = db.execute(
        select(Account).where(Account.is_active.is_(True)).order_by(Account.name)
    ).scalars().all()
    needle = (name_filter or "").lower()
    out = []
    total_assets = 0
    total_liab = 0
    for a in rows:
        if needle and needle not in (a.name or "").lower():
            continue
        bal = a.current_balance_cents or 0
        if bal >= 0:
            total_assets += bal
        else:
            total_liab += abs(bal)
        out.append(
            {
                "name": a.name,
                "type": a.account_type.value if hasattr(a.account_type, "value") else str(a.account_type),
                "balance_cents": bal,
            }
        )
    return {
        "accounts": out,
        "total_assets_cents": total_assets,
        "total_liabilities_cents": total_liab,
        "net_cents": total_assets - total_liab,
    }


def query_top_merchants(db: Session, days: int = 90, limit: int = 10) -> dict[str, Any]:
    cutoff = date.today() - timedelta(days=days)
    # See chat/__init__.py _top_merchants — Transaction has a
    # ``merchant`` *relationship*, not a scalar column. Aggregate by
    # ``description_clean`` instead, falling back to ``description_raw``.
    merchant_col = func.coalesce(
        Transaction.description_clean, Transaction.description_raw
    )
    rows = db.execute(
        select(
            merchant_col.label("merchant"),
            func.sum(func.abs(Transaction.amount_cents)).label("total"),
            func.count().label("n"),
        )
        .where(
            Transaction.amount_cents < 0,
            Transaction.posted_date >= cutoff,
        )
        .group_by(merchant_col)
        .order_by(func.sum(func.abs(Transaction.amount_cents)).desc())
        .limit(limit)
    ).all()
    return {
        "days": days,
        "merchants": [
            {"merchant": m, "total_cents": int(total or 0), "txn_count": int(n)}
            for m, total, n in rows
            if m
        ],
    }


def query_subscriptions(db: Session) -> dict[str, Any]:
    rows = (
        db.execute(
            select(Subscription).where(Subscription.status == SubscriptionStatus.active)
        )
        .scalars()
        .all()
    )
    out = []
    total_monthly = 0
    for s in rows:
        amt = abs(s.amount_cents or 0)
        out.append(
            {
                "merchant": s.merchant or "?",
                "monthly_cents": amt,
                "cadence": getattr(s, "cadence_label", None) or "monthly",
            }
        )
        total_monthly += amt
    return {
        "total_monthly_cents": total_monthly,
        "active_subscriptions": out,
    }


def query_goals(db: Session) -> dict[str, Any]:
    rows = db.execute(select(Goal)).scalars().all()
    out = []
    for g in rows:
        status_val = (
            g.status.value if hasattr(g.status, "value") else str(g.status or "")
        )
        if status_val in {"completed", "abandoned", "archived"}:
            continue
        target = g.target_amount_cents or 0
        current = g.current_amount_cents or 0
        out.append(
            {
                "name": g.name,
                "target_cents": target,
                "current_cents": current,
                "progress_pct": round(100.0 * current / target, 1) if target > 0 else 0.0,
                "deadline": g.target_date.isoformat() if g.target_date else None,
            }
        )
    return {"goals": out}


def compare_spending_periods(
    db: Session,
    category: str | None = None,
    period_a_days: int = 30,
    period_b_days: int = 30,
) -> dict[str, Any]:
    today = date.today()
    a_start = today - timedelta(days=period_a_days)
    b_end = a_start
    b_start = b_end - timedelta(days=period_b_days)

    cat_filter = _category_id_filter(db, category)
    transfer_ids = _transfer_category_ids(db)

    def _sum(start: date, end: date) -> int:
        where = [
            Transaction.posted_date >= start,
            Transaction.posted_date < end,
            Transaction.amount_cents < 0,
        ]
        if cat_filter is not None:
            where.append(Transaction.category_id.in_(cat_filter))
            if not cat_filter:
                return 0
        elif transfer_ids:
            where.append(Transaction.category_id.notin_(transfer_ids))
        return int(
            db.execute(
                select(func.coalesce(func.sum(func.abs(Transaction.amount_cents)), 0))
                .where(*where)
            ).scalar_one() or 0
        )

    a_total = _sum(a_start, today)
    b_total = _sum(b_start, b_end)
    delta = a_total - b_total
    pct = (100.0 * delta / b_total) if b_total > 0 else None
    return {
        "category_filter": category,
        "period_a": {"days": period_a_days, "total_cents": a_total},
        "period_b": {"days": period_b_days, "total_cents": b_total},
        "delta_cents": delta,
        "delta_pct": round(pct, 1) if pct is not None else None,
    }


def query_category_breakdown(db: Session, days: int = 30, limit: int = 12) -> dict[str, Any]:
    cutoff = date.today() - timedelta(days=days)
    transfer_ids = _transfer_category_ids(db)
    where = [
        Transaction.posted_date >= cutoff,
        Transaction.amount_cents < 0,
    ]
    if transfer_ids:
        where.append(Transaction.category_id.notin_(transfer_ids))
    rows = db.execute(
        select(
            Transaction.category_id,
            func.sum(func.abs(Transaction.amount_cents)).label("total"),
            func.count().label("n"),
        )
        .where(*where)
        .group_by(Transaction.category_id)
        .order_by(func.sum(func.abs(Transaction.amount_cents)).desc())
        .limit(limit)
    ).all()
    if not rows:
        return {"days": days, "categories": []}
    cat_names = {c.id: c.name for c in db.execute(select(Category)).scalars().all()}
    return {
        "days": days,
        "categories": [
            {
                "name": cat_names.get(cid, "Uncategorized"),
                "total_cents": int(total or 0),
                "txn_count": int(n),
            }
            for cid, total, n in rows
        ],
    }


# ---------------------------------------------------------------------------
#  Dispatcher
# ---------------------------------------------------------------------------


def query_fire_projection(
    db: Session,
    current_age: int = 32,
    target_retirement_age: int = 55,
    simulation_mode: str = "normal",
) -> dict[str, Any]:
    """Run a small-trial FIRE simulation using auto-derived defaults.

    Lower n_trials than the interactive endpoint (we need a fast,
    chat-friendly response). The result is good enough for the
    "are you on track" headline numbers.
    """
    # Local import to avoid circulars between fire/ and chat/.
    from finance_app.api.fire import (
        _derive_annual_spending_cents,
        _derive_monthly_savings_cents,
        _derive_starting_cents,
    )
    from finance_app.fire import FireInputs, simulate

    starting = _derive_starting_cents(db)
    monthly_savings = _derive_monthly_savings_cents(db)
    annual_spending = _derive_annual_spending_cents(db)
    try:
        proj = simulate(
            FireInputs(
                current_age=current_age,
                target_retirement_age=target_retirement_age,
                starting_cents=starting,
                monthly_savings_cents=monthly_savings,
                annual_spending_cents=annual_spending,
                n_trials=2_000,  # chat-friendly speed
                simulation_mode=simulation_mode,
            )
        )
    except ValueError as e:
        return {"error": str(e)}
    return {
        "inputs_used": {
            "current_age": current_age,
            "target_retirement_age": target_retirement_age,
            "starting_cents": starting,
            "monthly_savings_cents": monthly_savings,
            "annual_spending_cents": annual_spending,
            "simulation_mode": simulation_mode,
        },
        "fire_number_cents": proj.fire_number_cents,
        "median_hit_age": proj.median_hit_age,
        "success_probability_pct": proj.success_probability_pct,
        "prob_hit_target_by_retirement_pct": proj.prob_hit_target_by_retirement_pct,
        "safe_withdrawal_rate_pct": proj.safe_withdrawal_rate_pct,
        "summary": proj.summary_text,
    }


def query_attribution_month(db: Session, month_offset: int = 1) -> dict[str, Any]:
    """Attribution for one specific month.

    ``month_offset`` is calendar months back: 0 = current partial month,
    1 = last full month, 2 = month before last, etc.
    """
    from finance_app.networth.attribution import compute as compute_attribution

    if month_offset < 0:
        return {"error": "month_offset must be >= 0"}
    # Compute enough months to cover the requested offset (+1 cushion).
    report = compute_attribution(db, n_months=max(month_offset + 2, 3))
    # report.months is oldest → newest. Newest is the current partial
    # month, so offset=0 hits months[-1], offset=1 hits months[-2], etc.
    idx = -1 - month_offset
    if abs(idx) > len(report.months):
        return {"error": f"month_offset={month_offset} exceeds available history"}
    m = report.months[idx]
    return {
        "month_label": m.month_label,
        "month_start": m.month_start.isoformat(),
        "nw_start_cents": m.nw_start_cents,
        "nw_end_cents": m.nw_end_cents,
        "delta_cents": m.delta_cents,
        "income_cents": m.income_cents,
        "spending_cents": m.spending_cents,
        "net_cash_flow_cents": m.net_cash_flow_cents,
        "debt_paydown_cents": m.debt_paydown_cents,
        "other_cents": m.other_cents,
        "top_spending_categories": [
            {"name": c.name, "cents": c.cents, "txn_count": c.txn_count}
            for c in m.top_spending_categories
        ],
    }


_TOOL_FUNCS = {
    "query_spending": query_spending,
    "query_income": query_income,
    "query_account_balances": query_account_balances,
    "query_top_merchants": query_top_merchants,
    "query_subscriptions": query_subscriptions,
    "query_goals": query_goals,
    "compare_spending_periods": compare_spending_periods,
    "query_category_breakdown": query_category_breakdown,
    "query_fire_projection": query_fire_projection,
    "query_attribution_month": query_attribution_month,
}


def execute(db: Session, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run a single tool call. Errors are caught and returned as a dict
    so the LLM doesn't crash the orchestrator on bad arg names.
    """
    fn = _TOOL_FUNCS.get(name)
    if fn is None:
        return {"error": f"unknown tool: {name!r}"}
    try:
        return fn(db, **(args or {}))
    except TypeError as e:
        return {"error": f"bad args for {name}: {e}"}
    except Exception as e:  # noqa: BLE001
        logger.exception("tool %s failed: %r", name, e)
        return {"error": f"{type(e).__name__}: {e}"}


__all__ = ["TOOL_SPECS", "execute"]
