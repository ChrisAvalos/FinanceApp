"""Net-worth attribution — Smart Feature #4.

For each month in a window, decomposes the change in net worth into
buckets the user can interpret:

  delta = income - spending + other

  - **income**: sum of positive-amount transactions (paychecks,
    refunds, transfers in)
  - **spending**: sum of |negative-amount| transactions (everything
    that left an account)
  - **other**: residual that the cash-flow ledger doesn't explain.
    This is where market gains/losses, interest accrued, debt
    interest charged, and manual balance adjustments end up. Can be
    positive (good month for the brokerage) or negative (the rate
    bumped on the credit card).

The decomposition requires NetWorthSnapshot rows at both endpoints
of the month. The scheduler creates one daily, so recent months will
have them; for months before the snapshotter started running, we
return ``delta=None`` and let the UI render an "incomplete history"
state instead of fabricating a number.

Top-categories drill-in is computed alongside so the user can click
into "October" and see "$420 dining was the bulk of the over-budget
swing".
"""
from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.db.models import Category, NetWorthSnapshot, Transaction


# Category slugs that represent inter-account moves (debt paydown, transfers
# between own accounts). These are NOT real income/spending — they're just
# moving money you already had from one bucket to another, so we exclude
# them from those totals and surface them as their own line.
# Match by slug prefix so subcategories ("financial.payment.cc_chase") still
# count if they get added later.
_TRANSFER_CATEGORY_SLUG_PREFIXES: tuple[str, ...] = (
    "financial.transfer",
    "financial.payment",   # "Credit Card Payment" — debt paydown side
    "financial.loan_payment",
    "financial.mortgage_payment",
)


def _transfer_category_ids(db: Session) -> set[int]:
    """Return the set of Category.id values that represent transfers.

    Computed once per request; caching across requests would need
    invalidation when categories change, not worth the complexity.
    """
    rows = db.execute(select(Category.id, Category.slug)).all()
    out: set[int] = set()
    for cid, slug in rows:
        if slug and any(slug.startswith(p) for p in _TRANSFER_CATEGORY_SLUG_PREFIXES):
            out.add(cid)
    return out


# ---------------------------------------------------------------------------
#  Types
# ---------------------------------------------------------------------------


@dataclass
class CategoryDrillIn:
    name: str
    cents: int          # absolute outflow
    txn_count: int


@dataclass
class AttributionMonth:
    """Decomposition for one month.

    Income and spending are *net of transfers* — moving money from
    checking to a credit-card or mortgage payment doesn't appear here.
    Those moves go into ``debt_paydown_cents`` (positive when net debt
    went down) so the user sees a clean three-way split:

        delta ≈ income - spending + debt_paydown + other

    ``other`` (the residual) absorbs market gains/losses, interest
    accrued/charged, manual balance adjustments, and any
    asymmetrically-linked transfer pairs (where one side of a transfer
    is on a Plaid-linked account but the other isn't).
    """
    month_start: date
    month_label: str    # "Oct 2025"
    nw_start_cents: int | None       # may be null if no snapshot near start
    nw_end_cents: int | None
    delta_cents: int | None          # nw_end - nw_start; null if either endpoint missing
    income_cents: int                # always ≥ 0; excludes transfers
    spending_cents: int               # always ≥ 0; excludes transfers
    net_cash_flow_cents: int         # income - spending
    debt_paydown_cents: int          # net of transfer rows; positive = paid down debt
    other_cents: int | None          # residual; null when delta is null
    top_spending_categories: list[CategoryDrillIn] = field(default_factory=list)


@dataclass
class AttributionReport:
    months: list[AttributionMonth]
    summary_text: str


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------


def _month_starts(end: date, n_months: int) -> list[date]:
    """Return the first day of each of the last `n_months` months,
    oldest → newest. Always includes the current (partial) month."""
    out: list[date] = []
    y, m = end.year, end.month
    for _ in range(n_months):
        out.append(date(y, m, 1))
        # step back one month
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    out.reverse()
    return out


def _last_day_of_month(d: date) -> date:
    return date(d.year, d.month, monthrange(d.year, d.month)[1])


def _nearest_snapshot(
    db: Session, target: date, window_days: int = 7
) -> NetWorthSnapshot | None:
    """Return the NetWorthSnapshot closest to ``target``, within ±window days.

    NW snapshots are written daily by the scheduler but small gaps
    (uvicorn was off for a weekend) shouldn't poison the attribution.
    7 days is generous enough to bridge long gaps while still being
    tight enough that we're not comparing snapshots a month apart.
    """
    lo = target - timedelta(days=window_days)
    hi = target + timedelta(days=window_days)
    snap = db.execute(
        select(NetWorthSnapshot)
        .where(NetWorthSnapshot.as_of >= lo, NetWorthSnapshot.as_of <= hi)
        .order_by(func.abs(func.julianday(NetWorthSnapshot.as_of) - func.julianday(target)))
        .limit(1)
    ).scalar_one_or_none()
    return snap


def _income_spending(
    db: Session, start: date, end_inclusive: date, transfer_cat_ids: set[int]
) -> tuple[int, int, int]:
    """Return (income_cents, spending_cents, debt_paydown_cents) for the window.

    ``income`` and ``spending`` are computed over NON-transfer rows.
    ``debt_paydown_cents`` is the net of transfer rows: outflows
    (cash leaving for a credit-card payment) MINUS inflows (cash
    showing up on the credit-card side as the payment hits). When
    both sides of a transfer are on linked accounts, this nets to
    ~$0. When only one side is linked, this surfaces the imbalance
    so the user can see "I paid down $500 of debt this month even
    though my checking outflow shows $500 leaving".

    Sign convention for debt_paydown_cents: POSITIVE = net outflow
    in transfer rows = debt was paid down (cash went out, debt
    went down by an equal amount). NEGATIVE would mean we drew
    *from* a credit account into cash.
    """
    # Build the WHERE clauses. We can't put Python ``True`` into a
    # SQLAlchemy where() — it has to be a SQL ColumnElement — so we
    # only append the transfer-exclusion clause when there's something
    # to exclude. (Without this guard, the endpoint 500s when no
    # transfer categories exist in the DB yet.)
    base_where = [
        Transaction.posted_date >= start,
        Transaction.posted_date <= end_inclusive,
    ]
    non_transfer_where = list(base_where)
    if transfer_cat_ids:
        non_transfer_where.append(
            Transaction.category_id.notin_(transfer_cat_ids)
        )

    # Real income (excluding transfers)
    income = db.execute(
        select(
            func.coalesce(
                func.sum(
                    case(
                        (Transaction.amount_cents > 0, Transaction.amount_cents),
                        else_=0,
                    )
                ),
                0,
            )
        )
        .where(*non_transfer_where)
    ).scalar_one()

    # Real spending (excluding transfers)
    spending = db.execute(
        select(
            func.coalesce(
                func.sum(
                    case(
                        (Transaction.amount_cents < 0, func.abs(Transaction.amount_cents)),
                        else_=0,
                    )
                ),
                0,
            )
        )
        .where(*non_transfer_where)
    ).scalar_one()

    # Net of transfers — outflow side minus inflow side. Positive = paydown.
    if not transfer_cat_ids:
        debt_paydown = 0
    else:
        transfer_outflow = db.execute(
            select(
                func.coalesce(
                    func.sum(
                        case(
                            (Transaction.amount_cents < 0, func.abs(Transaction.amount_cents)),
                            else_=0,
                        )
                    ),
                    0,
                )
            )
            .where(
                Transaction.posted_date >= start,
                Transaction.posted_date <= end_inclusive,
                Transaction.category_id.in_(transfer_cat_ids),
            )
        ).scalar_one()
        transfer_inflow = db.execute(
            select(
                func.coalesce(
                    func.sum(
                        case(
                            (Transaction.amount_cents > 0, Transaction.amount_cents),
                            else_=0,
                        )
                    ),
                    0,
                )
            )
            .where(
                Transaction.posted_date >= start,
                Transaction.posted_date <= end_inclusive,
                Transaction.category_id.in_(transfer_cat_ids),
            )
        ).scalar_one()
        debt_paydown = int(transfer_outflow or 0) - int(transfer_inflow or 0)

    return int(income or 0), int(spending or 0), debt_paydown


def _top_spending_categories(
    db: Session,
    start: date,
    end_inclusive: date,
    transfer_cat_ids: set[int],
    limit: int = 5,
) -> list[CategoryDrillIn]:
    """Top ``limit`` outflow categories for the window, excluding transfers.

    "Credit Card Payment" being the top spending category every month
    would be misleading — it's not really spending, it's debt paydown.
    Filter the transfer categories so the user sees genuinely-discretionary
    categories first (Restaurants, Groceries, etc.).
    """
    where_clauses = [
        Transaction.posted_date >= start,
        Transaction.posted_date <= end_inclusive,
        Transaction.amount_cents < 0,
    ]
    if transfer_cat_ids:
        where_clauses.append(Transaction.category_id.notin_(transfer_cat_ids))
    rows = db.execute(
        select(
            Transaction.category_id,
            func.sum(func.abs(Transaction.amount_cents)).label("total"),
            func.count().label("n"),
        )
        .where(*where_clauses)
        .group_by(Transaction.category_id)
        .order_by(func.sum(func.abs(Transaction.amount_cents)).desc())
        .limit(limit)
    ).all()
    if not rows:
        return []
    cat_names = {
        c.id: c.name for c in db.execute(select(Category)).scalars().all()
    }
    return [
        CategoryDrillIn(
            name=cat_names.get(cat_id, "Uncategorized"),
            cents=int(total or 0),
            txn_count=int(n),
        )
        for cat_id, total, n in rows
    ]


# ---------------------------------------------------------------------------
#  Public API
# ---------------------------------------------------------------------------


def compute(db: Session, n_months: int = 12, today: date | None = None) -> AttributionReport:
    """Build the per-month attribution series for the last `n_months`.

    Includes the current partial month — the "running attribution"
    answers the question "what's happened this month so far?".
    """
    end = today or date.today()
    starts = _month_starts(end, n_months)
    transfer_cat_ids = _transfer_category_ids(db)
    out: list[AttributionMonth] = []

    for ms in starts:
        me = _last_day_of_month(ms)
        # For the current month, clip end at today so we don't
        # double-count income/spending that hasn't happened yet.
        effective_end = min(me, end)

        snap_start = _nearest_snapshot(db, ms)
        # End-of-month snapshot for closed months; today's snapshot for
        # the current month. _nearest_snapshot tolerates a ±7d window.
        snap_end_target = me if me <= end else end
        snap_end = _nearest_snapshot(db, snap_end_target)

        nw_start = snap_start.net_cents if snap_start else None
        nw_end = snap_end.net_cents if snap_end else None
        delta = (
            nw_end - nw_start if (nw_start is not None and nw_end is not None) else None
        )

        income, spending, debt_paydown = _income_spending(
            db, ms, effective_end, transfer_cat_ids
        )
        net_cf = income - spending
        # Decomposition: delta = net_cf + debt_paydown + other
        # (debt_paydown is positive when net debt went down — that's a
        # net-worth GAIN, so it adds to delta.)
        other = (
            delta - net_cf - debt_paydown if delta is not None else None
        )

        top_cats = _top_spending_categories(
            db, ms, effective_end, transfer_cat_ids, limit=5
        )

        out.append(
            AttributionMonth(
                month_start=ms,
                month_label=ms.strftime("%b %Y"),
                nw_start_cents=nw_start,
                nw_end_cents=nw_end,
                delta_cents=delta,
                income_cents=income,
                spending_cents=spending,
                net_cash_flow_cents=net_cf,
                debt_paydown_cents=debt_paydown,
                other_cents=other,
                top_spending_categories=top_cats,
            )
        )

    summary = _summary(out)
    return AttributionReport(months=out, summary_text=summary)


def _summary(months: list[AttributionMonth]) -> str:
    """1-2 sentence headline. The dataset is the last N months;
    surface the most-recent-with-data month's delta + driver."""
    if not months:
        return "No attribution data yet."
    # Find the most recent month with a non-null delta.
    explained = [m for m in reversed(months) if m.delta_cents is not None]
    if not explained:
        return (
            "No closed months have NW snapshots at both endpoints yet — "
            "the daily snapshotter needs a couple weeks of history to populate "
            "this view."
        )
    m = explained[0]
    if m.delta_cents is None:
        return ""
    direction = "up" if m.delta_cents >= 0 else "down"
    abs_delta = abs(m.delta_cents) / 100
    abs_other = abs(m.other_cents or 0) / 100
    other_dir = (m.other_cents or 0) >= 0

    if abs_other > abs(m.net_cash_flow_cents):
        # "Other" dominated the move — typically a market gain/loss.
        bit = (
            f" Market gains and other unexplained changes were the bigger driver "
            f"({'+' if other_dir else '−'}${abs_other:,.0f})"
            f" vs. cash flow ({'+' if m.net_cash_flow_cents >= 0 else '−'}"
            f"${abs(m.net_cash_flow_cents)/100:,.0f})."
        )
    else:
        bit = (
            f" Cash flow ({'+' if m.net_cash_flow_cents >= 0 else '−'}"
            f"${abs(m.net_cash_flow_cents)/100:,.0f}) was the bigger driver "
            f"vs. market/other ({'+' if other_dir else '−'}${abs_other:,.0f})."
        )
    return (
        f"Net worth went {direction} ${abs_delta:,.0f} in {m.month_label}.{bit}"
    )


__all__ = [
    "AttributionMonth",
    "AttributionReport",
    "CategoryDrillIn",
    "compute",
]
