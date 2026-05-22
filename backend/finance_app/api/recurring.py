"""Recurring-bills detection.

The Budgets panel needs an at-a-glance list of every fixed monthly
expense — rent, utilities, subscriptions, student loans, insurance —
with three columns the user asked for:

    1. Amount (monthlyized: a $300 quarterly bill shows as $100/mo)
    2. Bank description (what shows up in the transaction history)
    3. What it is (merchant name + category)

Detection strategy
------------------
Pull every outflow in the last 180 days, group by ``merchant_id`` (or,
when none exists, by the first ~25 chars of ``description_clean``).
For each group with >= 3 occurrences:

  - Compute the gaps (days) between consecutive transactions.
  - Take the median gap. If it falls in one of our known cadences
    (~weekly / biweekly / monthly / quarterly / semi-annual / annual),
    it's recurring.
  - Compute the typical amount = median of the magnitudes.
  - Project a monthly-equivalent: amount * (30 / median_gap_days).

Catchalls (Transfer, Uncategorized, Credit Card Payment, Investment
Contribution) are dropped — they're internal money movement, not bills.

This module is deliberately isolated from ``api/budgets.py`` because
that file has had repeated write-truncation issues; keeping recurring-
bills here means we never touch it for this feature.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from statistics import median

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.budgets.monthly_financials import (
    SPEND_ACCOUNT_TYPES,
    account_ids_for,
)
from finance_app.db.models import Budget, Category, Merchant, Transaction
from finance_app.db.session import get_db
from finance_app.enrichment import is_catchall
from finance_app.util.txn_dedup import merchant_group_key

router = APIRouter(prefix="/budgets", tags=["budgets"])


# ---------- cadence buckets ----------
#
# Each cadence has a target median-gap (days) and an acceptable spread.
# Anything that falls inside one of these brackets is a recurring bill.
# Order matters: we pick the FIRST match, so weekly comes before monthly.
_CADENCES: tuple[tuple[str, int, int, int], ...] = (
    # (label,        min_gap, max_gap, days_per_period for monthlyization)
    ("weekly",          5,    9,   7),
    ("biweekly",       12,   17,  14),
    ("monthly",        25,   35,  30),
    ("bimonthly",      55,   65,  60),
    ("quarterly",      80,  100,  91),
    ("semiannual",    160,  200, 182),
    ("annual",        330,  400, 365),
)

# Variance gate — a group's amount stddev / mean must be below this to
# count as a fixed bill. Set permissively (0.30 = within ~30% spread)
# because some bills swing — utility bills vary seasonally, subscription
# auto-renewals sometimes step up.
_MAX_AMOUNT_CV = 0.30

# Minimum count to consider something recurring. Three samples gives us
# two gaps which is enough to detect cadence reliably.
_MIN_OCCURRENCES = 3


@dataclass(frozen=True)
class _Group:
    """Internal: a merchant-or-description bucket of similar outflows."""
    key: str  # the grouping key (merchant_id stringified, or desc prefix)
    txns: list[Transaction]
    merchant: Merchant | None
    category: Category | None


def _group_outflows(
    db: Session,
    txns: list[Transaction],
) -> list[_Group]:
    """Bucket outflows by merchant_id (preferred) or description prefix.

    Loading merchants + categories once and joining in Python rather
    than running a per-row SELECT — there are typically <50 merchants
    in play so this is cheap.
    """
    merchants_by_id: dict[int, Merchant] = {
        m.id: m
        for m in db.execute(select(Merchant)).scalars().all()
    }
    categories_by_id: dict[int, Category] = {
        c.id: c
        for c in db.execute(select(Category)).scalars().all()
    }

    buckets: dict[str, list[Transaction]] = {}
    keys_meta: dict[str, tuple[Merchant | None, Category | None]] = {}
    for tx in txns:
        if tx.amount_cents >= 0:
            continue   # skip inflows
        # Skip catchalls — they aren't bills.
        cat = categories_by_id.get(tx.category_id) if tx.category_id else None
        if is_catchall(cat.name if cat else None):
            continue

        if tx.merchant_id is not None:
            key = f"m:{tx.merchant_id}"
            merchant = merchants_by_id.get(tx.merchant_id)
        else:
            # No merchant id — derive a stable grouping key from the
            # RAW description (the cleaned one is unreliable: the
            # cleaner mangled the same gym into "Movementg" on three
            # charges and "Movement Mountain Vie" on a fourth, which
            # split one merchant into two buckets and made the gym
            # vanish). merchant_group_key takes the first 2 significant
            # tokens of the raw string — stable across a merchant's
            # charges, specific enough to keep distinct merchants apart.
            key_token = merchant_group_key(tx.description_raw or "")
            if len(key_token) < 3:
                continue
            key = f"d:{key_token}"
            merchant = None

        buckets.setdefault(key, []).append(tx)
        keys_meta.setdefault(key, (merchant, cat))

    return [
        _Group(
            key=k,
            txns=sorted(v, key=lambda t: t.posted_date),
            merchant=keys_meta[k][0],
            category=keys_meta[k][1],
        )
        for k, v in buckets.items()
        if len(v) >= _MIN_OCCURRENCES
    ]


def _classify_cadence(median_gap_days: int) -> tuple[str, int] | None:
    """Map a median gap to a known cadence. Returns (label, days_in_period)
    so callers can monthlyize the typical amount."""
    for label, lo, hi, period in _CADENCES:
        if lo <= median_gap_days <= hi:
            return (label, period)
    return None


def _amount_cv(magnitudes: list[int]) -> float:
    """Coefficient of variation = stddev / mean. Used to gate "is this a
    fixed bill?" — high CV means the amount swings too much."""
    if not magnitudes:
        return 0.0
    m = sum(magnitudes) / len(magnitudes)
    if m == 0:
        return 0.0
    variance = sum((x - m) ** 2 for x in magnitudes) / len(magnitudes)
    return (variance ** 0.5) / m


# Cadences that a TRUE fixed bill can have. Rent, insurance, loans,
# utilities, subscriptions bill monthly or less often — never weekly or
# biweekly. A weekly/biweekly rhythm is the signature of habitual
# spending (the coffee run, the commute fill-up), not an obligation.
_FIXED_BILL_CADENCES: frozenset[str] = frozenset(
    {"monthly", "bimonthly", "quarterly", "semiannual", "annual"}
)

# Amount-stability ceiling for the FIXED classification. Looser than a
# subscription's exact-to-the-cent stability because utilities swing
# seasonally (PG&E summer vs winter). Above this, the charge is too
# swingy to call a fixed obligation.
_FIXED_BILL_MAX_CV = 0.45


# ---------- response models ----------

class RecurringBillOut(BaseModel):
    """One recurring expense as the UI sees it."""
    key: str
    description_raw: str          # what the bank shows
    description_clean: str | None
    merchant_name: str | None     # the friendly label, if known
    category_id: int | None
    category_name: str | None
    typical_amount_cents: int     # median magnitude per occurrence
    monthly_equivalent_cents: int # amount normalized to a 30-day month
    cadence: str                  # "monthly", "weekly", ...
    last_seen_date: date
    occurrence_count: int
    # "fixed"    — a true obligation: monthly+ cadence, stable amount,
    #              non-discretionary category. Counts toward the
    #              fixed-bills total the discretionary math subtracts.
    # "variable" — recurs on a rhythm but is habitual spending
    #              (coffee, gas, groceries). Belongs in the variable
    #              budget, NOT the fixed-bills total.
    kind: str


class RecurringBillsResponse(BaseModel):
    window_start: date
    window_end: date
    # True fixed bills only — rent, utilities, subs, loans, insurance.
    bills: list[RecurringBillOut]
    # Habitual recurring spending — surfaced separately so the user
    # sees the pattern, but it does NOT inflate the fixed total.
    variable_recurring: list[RecurringBillOut]
    # Sum of monthly_equivalent across FIXED bills only — this is the
    # number the discretionary-pool math subtracts from income.
    total_monthly_cents: int
    # Sum across the variable-recurring patterns, for display.
    total_variable_monthly_cents: int


# ---------- endpoint ----------

@router.get("/recurring-bills", response_model=RecurringBillsResponse)
def list_recurring_bills(
    lookback_days: int = 180,
    db: Session = Depends(get_db),
) -> RecurringBillsResponse:
    """Detect every recurring outflow and report it.

    Bills are returned sorted by ``monthly_equivalent_cents`` descending
    so the most expensive obligations are at the top — that's almost
    always what the user wants to see first.
    """
    window_end = date.today()
    window_start = window_end - timedelta(days=lookback_days)

    # Anchored on the transaction conduits — checking + credit card. A
    # recurring outflow on a savings/investment account is an automated
    # transfer (an auto-save), not a bill.
    spend_account_ids = account_ids_for(db, SPEND_ACCOUNT_TYPES)
    outflows = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= window_start)
        .where(Transaction.posted_date <= window_end)
        .where(Transaction.account_id.in_(spend_account_ids))
    ).scalars().all()

    groups = _group_outflows(db, outflows)

    fixed: list[RecurringBillOut] = []
    variable: list[RecurringBillOut] = []
    for g in groups:
        # Gaps between consecutive postings, in days.
        dates = [t.posted_date for t in g.txns]
        gaps = [
            (dates[i + 1] - dates[i]).days
            for i in range(len(dates) - 1)
            if (dates[i + 1] - dates[i]).days > 0
        ]
        if not gaps:
            continue
        median_gap = int(median(gaps))

        cadence = _classify_cadence(median_gap)
        if cadence is None:
            continue
        cadence_label, period_days = cadence

        # Staleness gate: if the most recent occurrence is older than
        # ~1.5x the cadence period, this bill has LAPSED — a cancelled
        # subscription, a paid-off loan/lease. It's no longer an active
        # recurring expense, so drop it entirely. ``dates`` is sorted
        # ascending, so dates[-1] is the latest occurrence. 1.5x gives
        # a full half-cycle of grace before we call something dead, so
        # a merely-late bill isn't wrongly dropped.
        days_since_last = (window_end - dates[-1]).days
        if days_since_last > period_days * 1.5:
            continue

        magnitudes = [abs(t.amount_cents) for t in g.txns]
        cv = _amount_cv(magnitudes)

        typical_cents = int(median(magnitudes))
        monthly_equiv = int(round(typical_cents * 30 / period_days))

        # ----- fixed vs variable classification -----
        # A TRUE fixed bill is defined by PREDICTABILITY, not by whether
        # you could theoretically cancel it. Two signals:
        #   1. Cadence is monthly or longer. A weekly/biweekly rhythm is
        #      the signature of habitual spending (the coffee run, the
        #      commute fill-up), never a billed obligation.
        #   2. The amount is stable (CV under the ceiling). Rent, the
        #      gym, Netflix, a lease payment — all hit the same number
        #      every period. Groceries / gas / restaurants swing wildly.
        #
        # We deliberately do NOT gate on the category's discretionary
        # flag: a gym membership is discretionary (you could quit) but
        # it's still a FIXED bill — a known monthly number you'd want
        # the discretionary math to account for. Predictability, not
        # cancellability, is what makes something a fixed bill.
        is_fixed = (
            cadence_label in _FIXED_BILL_CADENCES
            and cv <= _FIXED_BILL_MAX_CV
        )

        last_tx = g.txns[-1]
        row = RecurringBillOut(
            key=g.key,
            description_raw=last_tx.description_raw or "",
            description_clean=last_tx.description_clean,
            merchant_name=g.merchant.name if g.merchant else None,
            category_id=g.category.id if g.category else None,
            category_name=g.category.name if g.category else None,
            typical_amount_cents=typical_cents,
            monthly_equivalent_cents=monthly_equiv,
            cadence=cadence_label,
            last_seen_date=last_tx.posted_date,
            occurrence_count=len(g.txns),
            kind="fixed" if is_fixed else "variable",
        )
        (fixed if is_fixed else variable).append(row)
    fixed.sort(key=lambda b: b.monthly_equivalent_cents, reverse=True)
    variable.sort(key=lambda b: b.monthly_equivalent_cents, reverse=True)

    return RecurringBillsResponse(
        window_start=window_start,
        window_end=window_end,
        bills=fixed,
        variable_recurring=variable,
        total_monthly_cents=sum(b.monthly_equivalent_cents for b in fixed),
        total_variable_monthly_cents=sum(
            b.monthly_equivalent_cents for b in variable
        ),
    )


# ---------- Sprint P: adopt detected bills into The Plan ----------
#
# The "Fixed monthly bills" card shows what's *detected* recurring; The
# Plan's "Committed" group shows the budget caps the user has *set*.
# Sprint O labelled them as two lenses; Sprint P makes the gap fixable:
# one click turns a detected bill into a budget line so The Plan reflects
# the obligation.
#
# A category can hold several detected bills (Hulu + Netflix both land in
# "Streaming"), and budgets are per-category — so the target cap for a
# category is the SUM of every FIXED bill detected in it. The cap is only
# ever RAISED to cover that sum, never lowered: a cap the user set higher
# on purpose (headroom) is left alone. This makes the endpoint idempotent
# — calling it twice changes nothing the second time.


class AdoptRecurringRequest(BaseModel):
    month_start: date
    # Which categories to adopt. None = every category that has detected
    # fixed bills (the "Budget all detected bills" bulk action). A
    # single-element list is the per-row "Budget this" button.
    category_ids: list[int] | None = None


class AdoptedCategory(BaseModel):
    """One category's before/after, so the UI can report what it did."""
    category_id: int
    category_name: str | None
    # Sum of monthly-equivalent across every FIXED bill in this category.
    detected_total_cents: int
    previous_cap_cents: int
    new_cap_cents: int
    changed: bool


class AdoptRecurringResponse(BaseModel):
    month_start: date
    categories: list[AdoptedCategory]
    # Sum of (new_cap - previous_cap) across the categories that changed —
    # "you just budgeted $X of bills."
    total_added_cents: int


@router.post("/recurring-bills/adopt", response_model=AdoptRecurringResponse)
def adopt_recurring_bills(
    body: AdoptRecurringRequest,
    db: Session = Depends(get_db),
) -> AdoptRecurringResponse:
    """Create / raise budget caps so detected fixed bills land in The Plan.

    For each category in scope, the target cap is the sum of the
    monthly-equivalent amounts of every FIXED recurring bill detected in
    it. The existing cap is raised to that target only when it's lower;
    an already-sufficient cap is left untouched.
    """
    ms = body.month_start.replace(day=1)

    # Reuse the detector verbatim — single source of truth for "what
    # recurs." We only consume the FIXED bills (``.bills``); habitual
    # variable patterns don't belong in the Committed group.
    detected = list_recurring_bills(db=db)

    detected_by_cat: dict[int, int] = {}
    name_by_cat: dict[int, str | None] = {}
    for bill in detected.bills:
        if bill.category_id is None:
            continue  # can't budget an uncategorized bill
        detected_by_cat[bill.category_id] = (
            detected_by_cat.get(bill.category_id, 0)
            + bill.monthly_equivalent_cents
        )
        name_by_cat[bill.category_id] = bill.category_name

    if body.category_ids is None:
        target_ids = list(detected_by_cat.keys())
    else:
        target_ids = body.category_ids

    existing_budgets = {
        b.category_id: b
        for b in db.execute(
            select(Budget).where(Budget.month_start == ms)
        ).scalars().all()
    }

    results: list[AdoptedCategory] = []
    total_added = 0
    for cat_id in target_ids:
        detected_total = detected_by_cat.get(cat_id, 0)
        if detected_total <= 0:
            continue  # nothing detected here — nothing to adopt
        existing = existing_budgets.get(cat_id)
        previous = int(existing.amount_cents) if existing is not None else 0
        new_cap = max(previous, detected_total)
        changed = new_cap != previous
        if changed:
            if existing is not None:
                existing.amount_cents = new_cap
            else:
                db.add(
                    Budget(
                        category_id=cat_id,
                        month_start=ms,
                        amount_cents=new_cap,
                    )
                )
            total_added += new_cap - previous
        results.append(
            AdoptedCategory(
                category_id=cat_id,
                category_name=name_by_cat.get(cat_id),
                detected_total_cents=detected_total,
                previous_cap_cents=previous,
                new_cap_cents=new_cap,
                changed=changed,
            )
        )

    db.commit()
    return AdoptRecurringResponse(
        month_start=ms,
        categories=results,
        total_added_cents=total_added,
    )
