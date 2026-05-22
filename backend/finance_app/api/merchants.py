"""Per-merchant deep-dive (Phase 7.5).

Given a merchant string (the raw description, normalized), return:
  - lifetime spend totals + transaction count
  - average per visit + median per visit
  - month-by-month breakdown (last 24 months)
  - all transactions sorted newest first (paginated)
  - any subscription detected for this merchant
  - any active offers tied to this merchant
  - the category we have it filed under (so the user can re-categorize fast)

The merchant key is the UPPER-CASED, whitespace-stripped description.
We don't try to be clever about resolving "WHOLE FOODS MARKET #2" and
"WHOLE FOODS MARKET #345" into one merchant — that's the
MerchantAlias job. Here we just match exact normalized strings.
"""
from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Category,
    Offer,
    Subscription,
    Transaction,
)
from finance_app.db.session import get_db

router = APIRouter(prefix="/merchants", tags=["merchants"])


import re as _re


def _normalize(s: str) -> str:
    return (s or "").upper().strip()


# Filler tokens we strip when tokenizing a user-supplied merchant query.
# These are Plaid's payment-channel prefixes + common postfix noise
# (state codes, last-4 card digits, dates) that don't help identify
# the merchant but bloat the search string.
_DROP_TOKENS = {
    "POS", "DEBIT", "PURCHASE", "PMT", "PAYMENT", "WEB", "ID",
    "ACH", "ORIG", "CO", "NAME", "DESCR", "PPD", "TYP", "INST", "XFER",
    "EDI", "PYMNTS", "PYMTS", "SEC", "IND", "RECEIVED", "ENTRY",
}


def _extract_merchant_tokens(query: str) -> list[str]:
    """Split a raw user query into substantive merchant tokens.

    "POS DEBIT XFINITY MOBILE PA 4824" → ["XFINITY", "MOBILE"]
    "AMAZON" → ["AMAZON"]
    "" → []

    Strips Plaid envelope prefixes, last-4 card digits, dates, state
    codes, and other noise so the search can match the same merchant
    across description variants.
    """
    s = (query or "").upper()
    # Remove anything that looks like a date suffix (MM/DD or YY/MM/DD).
    s = _re.sub(r"\d{1,2}/\d{1,2}(?:/\d{2,4})?", " ", s)
    # Remove standalone numbers (card last-4, transaction IDs, etc.).
    s = _re.sub(r"\b\d{2,}\b", " ", s)
    # Strip punctuation.
    s = _re.sub(r"[^A-Z\s]+", " ", s)
    tokens = [t for t in s.split() if t and t not in _DROP_TOKENS and len(t) > 1]
    # Drop trailing 2-letter "state code" if present (CA, NY, TX, etc.)
    if tokens and len(tokens[-1]) == 2:
        tokens = tokens[:-1]
    return tokens


# ---- Pydantic ----


class MerchantMonthlySpend(BaseModel):
    month_start: date
    total_cents: int
    txn_count: int


class MerchantTxnOut(BaseModel):
    id: int
    posted_date: date
    amount_cents: int
    category_id: int | None
    description_raw: str
    account_id: int


class MerchantSubOut(BaseModel):
    id: int
    name: str
    subscription_type: str
    status: str
    last_amount_cents: int | None
    confidence_score: float | None


class MerchantOfferOut(BaseModel):
    id: int
    title: str
    source: str
    reward_type: str | None
    reward_value_bps: int | None


class MerchantDetailOut(BaseModel):
    """Everything we know about one merchant."""
    merchant: str  # the normalized key
    display_name: str  # the description as the user actually saw it
    transactions: int
    lifetime_spend_cents: int
    avg_per_visit_cents: int
    median_per_visit_cents: int
    first_seen: date | None
    last_seen: date | None
    primary_category: str | None
    primary_category_id: int | None
    monthly_breakdown: list[MerchantMonthlySpend]
    recent_transactions: list[MerchantTxnOut]
    related_subscription: MerchantSubOut | None
    related_offers: list[MerchantOfferOut]


class MerchantListItem(BaseModel):
    """One row in the top-merchants list. Lightweight so the panel
    can show 50+ merchants without each one needing a separate
    detail-fetch round-trip."""
    description: str           # normalized merchant key for the detail lookup
    display_name: str          # cleanest variant of the description seen
    lifetime_spend_cents: int
    txn_count: int
    last_seen: date | None
    primary_category_id: int | None
    primary_category_name: str | None


class MerchantListOut(BaseModel):
    merchants: list[MerchantListItem]
    total: int


@router.get("", response_model=MerchantListOut)
def list_merchants(
    search: str | None = Query(None, description="Optional substring filter; matches against the cleaned description"),
    limit: int = Query(50, ge=1, le=500),
    months: int = Query(24, ge=1, le=120),
    db: Session = Depends(get_db),
) -> MerchantListOut:
    """Top merchants by lifetime outflow over the last ``months`` months.

    Used by the Merchants panel's empty-state browse list — Sprint 25.
    Before this, the panel required users to *know* what to type, which
    made it useless for browsing. Now they get a sorted list to click
    on plus an optional substring filter.

    Implementation notes:
    * We group by ``description_clean`` (the canonicalized merchant
      string the row normalizer writes), falling back to the raw
      description when ``description_clean`` is null. That collapses
      "WALMART #1234" and "WALMART SUPERCENTER" into one row.
    * Filter is a case-insensitive LIKE on the grouped key. Cheap on
      SQLite; we cap at ``limit`` rows so result-set blow-up isn't a
      concern even for users with thousands of distinct merchants.
    * Primary category = the most-recent non-null category_id for that
      merchant. Cosmetic; the detail endpoint computes the same.
    """
    cutoff = date.today() - timedelta(days=months * 31)
    merchant_col = func.coalesce(
        Transaction.description_clean, Transaction.description_raw
    )

    base = (
        select(
            merchant_col.label("merchant"),
            func.sum(func.abs(Transaction.amount_cents)).label("lifetime"),
            func.count().label("n"),
            func.max(Transaction.posted_date).label("last_seen"),
        )
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= cutoff)
        .group_by(merchant_col)
        .order_by(func.sum(func.abs(Transaction.amount_cents)).desc())
    )
    if search:
        # Match against the GROUPED key (case-insensitive substring).
        # Strip Plaid envelope tokens off the user's input first so a
        # query like "POS DEBIT XFINITY" doesn't end up looking for
        # "POS" / "DEBIT" inside merchant strings.
        tokens = _extract_merchant_tokens(search) or [search.upper()]
        for tok in tokens:
            base = base.where(func.upper(merchant_col).like(f"%{tok}%"))

    rows = list(db.execute(base.limit(limit)).all())

    if not rows:
        return MerchantListOut(merchants=[], total=0)

    # Bulk-fetch primary categories: get most-recent non-null category_id
    # per merchant in a single round-trip rather than N detail queries.
    descriptions = [r.merchant for r in rows if r.merchant]
    cat_lookup: dict[str, tuple[int, str]] = {}
    if descriptions:
        # Most recent posted_date per (merchant, category) — then pick
        # the merchant's row with the latest date among non-null cats.
        # Simpler: walk all matching txns ordered desc, take first hit.
        sub_rows = db.execute(
            select(merchant_col, Transaction.category_id, Transaction.posted_date)
            .where(Transaction.amount_cents < 0)
            .where(Transaction.category_id.is_not(None))
            .where(merchant_col.in_(descriptions))
            .order_by(Transaction.posted_date.desc())
        ).all()
        # Resolve category names in one pass.
        cat_ids = {r.category_id for r in sub_rows if r.category_id is not None}
        cat_names = {
            c.id: c.name
            for c in db.execute(
                select(Category).where(Category.id.in_(cat_ids))
            ).scalars().all()
        } if cat_ids else {}
        for r in sub_rows:
            if r[0] in cat_lookup:
                continue  # already have the most-recent for this merchant
            cat_lookup[r[0]] = (r.category_id, cat_names.get(r.category_id, ""))

    out: list[MerchantListItem] = []
    for r in rows:
        desc = r.merchant or ""
        cat_id, cat_name = cat_lookup.get(desc, (None, None))
        out.append(
            MerchantListItem(
                description=desc.upper().strip(),
                display_name=desc,
                lifetime_spend_cents=int(r.lifetime or 0),
                txn_count=int(r.n or 0),
                last_seen=r.last_seen,
                primary_category_id=cat_id,
                primary_category_name=cat_name or None,
            )
        )
    return MerchantListOut(merchants=out, total=len(out))


@router.get("/{merchant_key}", response_model=MerchantDetailOut)
def get_merchant_detail(
    merchant_key: str,
    months: int = Query(24, ge=1, le=120),
    txn_limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
) -> MerchantDetailOut:
    """All-things-this-merchant view for the dashboard deep-dive panel."""
    key = _normalize(merchant_key)
    if not key:
        raise HTTPException(400, "merchant_key cannot be empty")

    # Sprint 14 — token-based search instead of exact-match. The input
    # might be "XFINITY MOBILE" (clean) or "POS DEBIT XFINITY MOBILE
    # PA 4824" (full Plaid description with envelope + card suffix);
    # either should find ALL XFINITY MOBILE transactions across every
    # description variant. Extract the substantive merchant tokens
    # from the input, then require every one of them to appear in the
    # transaction's description.
    tokens = _extract_merchant_tokens(merchant_key)
    if not tokens:
        # Caller passed nothing identifiable — fall back to the old
        # exact-match behavior so the endpoint still works for callers
        # that pre-tokenized their own input.
        stmt = (
            select(Transaction)
            .where(func.upper(func.trim(Transaction.description_raw)) == key)
            .where(Transaction.amount_cents < 0)
            .order_by(Transaction.posted_date.desc())
        )
    else:
        stmt = (
            select(Transaction)
            .where(Transaction.amount_cents < 0)
            .order_by(Transaction.posted_date.desc())
        )
        for tok in tokens:
            stmt = stmt.where(
                func.upper(Transaction.description_raw).like(f"%{tok}%")
            )

    txns = list(db.execute(stmt).scalars().all())
    if not txns:
        raise HTTPException(
            404,
            f"No transactions match {merchant_key!r} "
            f"(tokens tried: {tokens or [key]})",
        )

    cents_amounts = [-t.amount_cents for t in txns]
    lifetime = sum(cents_amounts)
    avg_per_visit = lifetime // len(txns) if txns else 0
    median_per_visit = int(statistics.median(cents_amounts)) if cents_amounts else 0

    # Primary category = most-recent non-null category_id.
    primary_cat_id: int | None = None
    primary_cat_name: str | None = None
    for t in txns:
        if t.category_id is not None:
            primary_cat_id = t.category_id
            cat = db.get(Category, t.category_id)
            primary_cat_name = cat.name if cat else None
            break

    # Monthly breakdown for last ``months`` months.
    cutoff = date.today() - timedelta(days=months * 31)
    by_month: dict[date, list[int]] = defaultdict(list)
    for t in txns:
        if t.posted_date < cutoff:
            continue
        month_key = date(t.posted_date.year, t.posted_date.month, 1)
        by_month[month_key].append(-t.amount_cents)
    monthly_breakdown = [
        MerchantMonthlySpend(
            month_start=m,
            total_cents=sum(by_month[m]),
            txn_count=len(by_month[m]),
        )
        for m in sorted(by_month.keys())
    ]

    recent = [
        MerchantTxnOut(
            id=t.id,
            posted_date=t.posted_date,
            amount_cents=t.amount_cents,
            category_id=t.category_id,
            description_raw=t.description_raw or "",
            account_id=t.account_id,
        )
        for t in txns[:txn_limit]
    ]

    # Related subscription. Subscription.name is roughly the merchant
    # display name; match loosely on the merchant string being a
    # substring of either.
    sub_row = db.execute(
        select(Subscription)
        .where(
            (func.upper(Subscription.name).like(f"%{key.split()[0]}%"))
            if key.split()
            else (Subscription.id == -1)
        )
        .limit(1)
    ).scalar_one_or_none()
    sub_out = (
        MerchantSubOut(
            id=sub_row.id,
            name=sub_row.name,
            subscription_type=sub_row.subscription_type.value,
            status=sub_row.status.value,
            last_amount_cents=sub_row.last_amount_cents,
            confidence_score=sub_row.confidence_score,
        )
        if sub_row is not None
        else None
    )

    # Related offers — match offer title against the normalized key.
    offers = list(
        db.execute(
            select(Offer).where(func.upper(Offer.title).contains(key.split()[0] if key.split() else ""))
        ).scalars().all()
    )
    offer_outs = [
        MerchantOfferOut(
            id=o.id,
            title=o.title,
            source=o.source,
            reward_type=o.reward_type,
            reward_value_bps=o.reward_value_bps,
        )
        for o in offers
    ]

    return MerchantDetailOut(
        merchant=key,
        display_name=txns[0].description_raw or key,
        transactions=len(txns),
        lifetime_spend_cents=lifetime,
        avg_per_visit_cents=avg_per_visit,
        median_per_visit_cents=median_per_visit,
        first_seen=txns[-1].posted_date,
        last_seen=txns[0].posted_date,
        primary_category=primary_cat_name,
        primary_category_id=primary_cat_id,
        monthly_breakdown=monthly_breakdown,
        recent_transactions=recent,
        related_subscription=sub_out,
        related_offers=offer_outs,
    )


# ``case`` import was for a potential future query — keep it referenced
# so a linter doesn't flag the unused import. (Will become real once we
# add per-month aggregates pushed down to SQL instead of in Python.)
_ = case
