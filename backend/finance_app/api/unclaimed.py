"""Unclaimed property API — Phase 8.1.

GET    /unclaimed                 list all (filterable: status, state)
POST   /unclaimed                 create a record (manual log of a search match)
GET    /unclaimed/stats           aggregates: pending $, claimed $, paid $
PATCH  /unclaimed/{id}/status     transition status (found → claimed → paid)
PATCH  /unclaimed/{id}            edit fields
DELETE /unclaimed/{id}            delete one
GET    /unclaimed/search-tips     return a structured guide for self-search

The scraper-driven discovery flow lives in
``scrapers/unclaimed_property/`` and uses the same Playwright auth-state
pattern as the offer / score scrapers. Until that's bootstrapped, the
manual entry path is fully usable on its own.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.db.models import UnclaimedProperty, UnclaimedPropertyStatus
from finance_app.db.session import get_db

router = APIRouter(prefix="/unclaimed", tags=["unclaimed"])


# -- Pydantic ----------------------------------------------------------


class UnclaimedIn(BaseModel):
    state: str  # 2-char US state code or "federal"
    holder_name: str | None = None
    owner_name: str
    last_known_address: str | None = None
    claim_id: str | None = None
    property_type: str | None = None
    estimated_value_cents: int | None = None
    claim_url: str | None = None
    source: str = "manual"
    notes: str | None = None


class UnclaimedOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    state: str
    holder_name: str | None
    owner_name: str
    last_known_address: str | None
    claim_id: str | None
    property_type: str | None
    estimated_value_cents: int | None
    status: UnclaimedPropertyStatus
    claim_url: str | None
    source: str
    notes: str | None
    discovered_at: datetime
    claimed_at: datetime | None
    paid_at: datetime | None
    actual_payout_cents: int | None


class StatusPatch(BaseModel):
    status: UnclaimedPropertyStatus
    actual_payout_cents: int | None = None
    notes: str | None = None


class UnclaimedStatsOut(BaseModel):
    """Roll-up for the money-on-the-table dashboard."""
    total_count: int
    found_count: int
    claimed_count: int
    paid_count: int
    rejected_count: int
    dismissed_count: int
    estimated_pending_cents: int  # sum of estimated_value over found+claimed
    actual_collected_cents: int   # sum of actual_payout over paid


class SearchTipsOut(BaseModel):
    """Self-search guide. Plain JSON the UI renders as a checklist."""
    intro: str
    federal_resources: list[dict]
    state_resources: list[dict]
    name_variants_to_try: list[str]
    addresses_to_try: list[str]


# -- Endpoints ---------------------------------------------------------


@router.get("", response_model=list[UnclaimedOut])
def list_unclaimed(
    status: UnclaimedPropertyStatus | None = None,
    state: str | None = None,
    limit: int = 200,
    db: Session = Depends(get_db),
) -> list[UnclaimedProperty]:
    stmt = select(UnclaimedProperty).order_by(UnclaimedProperty.discovered_at.desc()).limit(limit)
    if status is not None:
        stmt = stmt.where(UnclaimedProperty.status == status)
    if state is not None:
        stmt = stmt.where(UnclaimedProperty.state == state)
    return list(db.execute(stmt).scalars().all())


@router.post("", response_model=UnclaimedOut, status_code=201)
def create_unclaimed(body: UnclaimedIn, db: Session = Depends(get_db)) -> UnclaimedProperty:
    """Log a match you found by searching MissingMoney.com or a state portal."""
    row = UnclaimedProperty(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/stats", response_model=UnclaimedStatsOut)
def get_stats(db: Session = Depends(get_db)) -> UnclaimedStatsOut:
    """Roll-up for the money-on-the-table dashboard."""
    rows = list(db.execute(select(UnclaimedProperty)).scalars().all())
    by_status: dict = {s.value: 0 for s in UnclaimedPropertyStatus}
    pending = 0
    collected = 0
    for r in rows:
        by_status[r.status.value] = by_status.get(r.status.value, 0) + 1
        if r.status in (
            UnclaimedPropertyStatus.found,
            UnclaimedPropertyStatus.claimed,
        ):
            pending += r.estimated_value_cents or 0
        if r.status == UnclaimedPropertyStatus.paid:
            collected += r.actual_payout_cents or r.estimated_value_cents or 0
    return UnclaimedStatsOut(
        total_count=len(rows),
        found_count=by_status.get("found", 0),
        claimed_count=by_status.get("claimed", 0),
        paid_count=by_status.get("paid", 0),
        rejected_count=by_status.get("rejected", 0),
        dismissed_count=by_status.get("dismissed", 0),
        estimated_pending_cents=pending,
        actual_collected_cents=collected,
    )


@router.patch("/{uid}/status", response_model=UnclaimedOut)
def update_status(
    uid: int,
    body: StatusPatch,
    db: Session = Depends(get_db),
) -> UnclaimedProperty:
    """Transition status. Stamps the appropriate timestamp."""
    row = db.get(UnclaimedProperty, uid)
    if row is None:
        raise HTTPException(404, f"UnclaimedProperty {uid} not found")
    now = datetime.utcnow()
    row.status = body.status
    if body.status == UnclaimedPropertyStatus.claimed and row.claimed_at is None:
        row.claimed_at = now
    elif body.status == UnclaimedPropertyStatus.paid and row.paid_at is None:
        row.paid_at = now
        if body.actual_payout_cents is not None:
            row.actual_payout_cents = body.actual_payout_cents
    if body.notes:
        existing = row.notes or ""
        sep = "\n\n" if existing else ""
        row.notes = f"{existing}{sep}[{now.isoformat()}Z] {body.notes}"
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{uid}", response_model=UnclaimedOut)
def update_record(
    uid: int,
    body: UnclaimedIn,
    db: Session = Depends(get_db),
) -> UnclaimedProperty:
    """Edit fields on an existing record. Doesn't change status."""
    row = db.get(UnclaimedProperty, uid)
    if row is None:
        raise HTTPException(404, f"UnclaimedProperty {uid} not found")
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{uid}", status_code=204)
def delete_record(uid: int, db: Session = Depends(get_db)) -> None:
    row = db.get(UnclaimedProperty, uid)
    if row is None:
        raise HTTPException(404, f"UnclaimedProperty {uid} not found")
    db.delete(row)
    db.commit()


@router.get("/search-tips", response_model=SearchTipsOut)
def get_search_tips(db: Session = Depends(get_db)) -> SearchTipsOut:
    """Structured guide the UI renders as a search checklist.

    We surface federal + state resources, name + address variants the
    user may want to try (current + past addresses help — accounts get
    reported by your address-on-file at the time the property was
    abandoned, which can be 5-10 years ago).
    """
    federal = [
        {
            "name": "MissingMoney.com",
            "url": "https://www.missingmoney.com",
            "what": "NAUPA's national aggregator of state unclaimed-property databases. Free.",
        },
        {
            "name": "IRS Where's My Refund",
            "url": "https://www.irs.gov/refunds",
            "what": "Old federal tax refunds — IRS holds for ~3 years before forfeit.",
        },
        {
            "name": "TreasuryHunt.gov",
            "url": "https://www.treasuryhunt.gov",
            "what": "Old paper savings bonds that matured and weren't redeemed.",
        },
        {
            "name": "PBGC pension search",
            "url": "https://www.pbgc.gov/wr/find-an-unclaimed-pension",
            "what": "Old defined-benefit pensions you might be vested in.",
        },
        {
            "name": "National Registry of Unclaimed Retirement Benefits",
            "url": "https://unclaimedretirementbenefits.com/",
            "what": "Old 401(k) plans from past employers. Free search.",
        },
        {
            "name": "FDIC unclaimed deposits",
            "url": "https://closedbanks.fdic.gov/funds/",
            "what": "Money owed to depositors of failed banks.",
        },
        {
            "name": "VA benefits self-check",
            "url": "https://www.va.gov/health-care/eligibility/",
            "what": "VA benefits not currently being collected.",
        },
    ]
    states = [
        # We surface a few high-population states explicitly because their
        # in-state portals often have richer data than NAUPA's aggregator.
        {"state": "CA", "url": "https://ucpi.sco.ca.gov/", "name": "California State Controller"},
        {"state": "NY", "url": "https://www.osc.state.ny.us/unclaimed-funds", "name": "NY Office of State Comptroller"},
        {"state": "TX", "url": "https://www.claimittexas.gov/", "name": "Texas Comptroller — ClaimItTexas"},
        {"state": "FL", "url": "https://www.fltreasurehunt.gov/", "name": "FL Department of Financial Services"},
        {"state": "IL", "url": "https://icash.illinoistreasurer.gov/", "name": "IL Treasurer — ICash"},
        {"state": "PA", "url": "https://www.patreasury.gov/unclaimed-property/", "name": "PA Treasury"},
        {"state": "OH", "url": "https://www.com.ohio.gov/unfd/", "name": "OH Department of Commerce"},
        {"state": "GA", "url": "https://gaclaims.unclaimedproperty.com/", "name": "GA Department of Revenue"},
        {"state": "NC", "url": "https://nccash.com/", "name": "NC State Treasurer — NCCash"},
        {"state": "MI", "url": "https://unclaimedproperty.michigan.gov/", "name": "Michigan Treasury"},
    ]
    intro = (
        "Most people have $80–200 sitting in state unclaimed-property "
        "databases. Some have thousands. Search starts with your name(s), "
        "current and past addresses. The state databases were populated by "
        "businesses that had your money but lost contact — a security "
        "deposit at a utility you closed years ago, an uncashed check from "
        "an old employer, dividends on stock you forgot about. The funds "
        "are held in trust until you claim them."
    )
    name_variants = [
        "Full legal name",
        "Common nickname (Chris vs Christopher)",
        "Middle name + last",
        "Last name only (some portals support)",
        "Maiden name (if you've changed names)",
    ]
    addresses = [
        "Current address",
        "Last 2-3 prior addresses (states report by address-on-file at time of escheatment)",
        "Old college addresses if you went to school 10+ years ago",
        "Old work addresses if you ever had a paycheck mailed",
    ]
    # Reference db so static-checkers don't flag it; future versions can
    # surface user-history-aware tips ("we noticed you had an address in
    # NY 2019-2022 — search there too").
    _ = db
    return SearchTipsOut(
        intro=intro,
        federal_resources=federal,
        state_resources=states,
        name_variants_to_try=name_variants,
        addresses_to_try=addresses,
    )


# Ref so unused-import warnings stay quiet.
_ = case
_ = func
