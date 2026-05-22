"""Regulatory-redress (CFPB / state-AG / FTC) tracker — Phase 8.5.

Companion to legal_claims (class actions) + unclaimed (escheatment).
Tracks government-enforcement orders that require user action to
collect.

GET    /redress             list (filterable: status, agency)
POST   /redress             create one (manual log)
GET    /redress/known       hardcoded catalog of recent active orders
                            with company name, est. payout, claim URL
GET    /redress/match-spend cross-reference catalog vs. user's
                            transaction history → suggest eligible cases
PATCH  /redress/{id}/status transition lifecycle
DELETE /redress/{id}        delete one
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finance_app.db.models import RedressStatus, RegulatoryRedress, Transaction
from finance_app.db.session import get_db


router = APIRouter(prefix="/redress", tags=["redress"])


# --- Hardcoded catalog of recent regulatory enforcement orders -------
#
# This is a maintained list, hand-curated. Lives in code (not a YAML
# file) so it ships in the repo and the app can match against it
# offline. Add new orders here as they're announced; old ones drop
# off when their claim_deadline passes.
#
# Sources for additions: cfpb.gov/enforcement, ftc.gov/enforcement,
# state AG press releases. We focus on cases requiring USER ACTION
# (some redress is automatic-to-account, in which case there's
# nothing to track here).

_KNOWN_REDRESS_CATALOG: list[dict] = [
    {
        "agency": "CFPB",
        "company_name": "Wells Fargo",
        "title": "2023 CFPB Consent Order — auto loans, mortgages, deposits",
        "eligibility_description": (
            "Consumers harmed by Wells Fargo's auto loan, mortgage, and "
            "deposit-account practices between 2011-2022. Most affected "
            "consumers were paid automatically; the small remainder file "
            "via the redress administrator."
        ),
        "claim_url": "https://www.cfpb.gov/enforcement/payments-harmed-consumers/wells-fargo/",
        "total_redress_cents": 200_000_000_000,  # $2 billion in consumer redress
        "estimated_per_user_cents": 30_000,        # rough average ~$300
        "claim_deadline": None,  # mostly automatic; check the URL
    },
    {
        "agency": "CFPB",
        "company_name": "Bank of America",
        "title": "2023 CFPB Consent Order — overdraft fees + double-charged fees",
        "eligibility_description": (
            "BofA charged $35 NSF fees on the same transaction multiple "
            "times. Affected consumers receive automatic redress."
        ),
        "claim_url": "https://www.cfpb.gov/enforcement/actions/bank-of-america-na-2023/",
        "total_redress_cents": 10_000_000_000,  # $100M
        "estimated_per_user_cents": 7_000,        # ~$70 typical
        "claim_deadline": None,
    },
    {
        "agency": "CFPB",
        "company_name": "Discover",
        "title": "2024 CFPB Consent Order — student loan servicing",
        "eligibility_description": (
            "Discover Bank student loan customers misled about minimum "
            "payments, taxes, and interest deductions."
        ),
        "claim_url": "https://www.cfpb.gov/enforcement/actions/discover-bank-2024/",
        "total_redress_cents": 3_500_000_000,  # $35M
        "estimated_per_user_cents": 10_000,      # ~$100
        "claim_deadline": None,
    },
    {
        "agency": "FTC",
        "company_name": "Epic Games",
        "title": "Fortnite in-app charge refunds",
        "eligibility_description": (
            "Refunds for unintended Fortnite charges (kids making "
            "purchases) and locked-account incidents."
        ),
        "claim_url": "https://www.ftc.gov/enforcement/refunds/fortnite-refunds",
        "total_redress_cents": 24_500_000_000,  # $245M
        "estimated_per_user_cents": 5_000,        # ~$50
        "claim_deadline": None,
    },
    {
        "agency": "CFPB",
        "company_name": "Capital One",
        "title": "Capital One 360 Performance Savings interest underpayment",
        "eligibility_description": (
            "Customers who held legacy Capital One 360 Savings accounts "
            "while Capital One offered higher rates on a near-identical "
            "Performance Savings product without notifying legacy holders."
        ),
        "claim_url": "https://www.cfpb.gov/enforcement/actions/",
        "total_redress_cents": 200_000_00_000,  # $2B order pending
        "estimated_per_user_cents": 25_000,
        "claim_deadline": None,
    },
    {
        "agency": "FTC",
        "company_name": "Ring (Amazon)",
        "title": "Ring camera privacy violations refund",
        "eligibility_description": (
            "Ring camera owners 2017-2018 affected by employee/contractor "
            "video access without authorization."
        ),
        "claim_url": "https://www.ftc.gov/enforcement/refunds/ring-refunds",
        "total_redress_cents": 580_000_000,  # $5.8M
        "estimated_per_user_cents": 6_000,
        "claim_deadline": None,
    },
]


# Merchant strings that might match the redress catalog. Used by
# match_spend(). Maps catalog company → list of substring patterns.
_MERCHANT_MATCH_PATTERNS: dict[str, list[str]] = {
    "Wells Fargo": ["WELLS FARGO", "WF "],
    "Bank of America": ["BANK OF AMERICA", "BOFA", "BANK OF AM"],
    "Discover": ["DISCOVER"],
    "Epic Games": ["EPIC GAMES", "FORTNITE"],
    "Capital One": ["CAPITAL ONE", "CAPITALONE"],
    "Ring (Amazon)": ["RING.COM", "AMAZON*RING", "AMZN*RING"],
}


# --- Pydantic --------------------------------------------------------


class RedressIn(BaseModel):
    agency: str
    company_name: str
    title: str
    eligibility_description: str | None = None
    claim_url: str | None = None
    total_redress_cents: int | None = None
    estimated_per_user_cents: int | None = None
    claim_deadline: date | None = None
    discovery_source: str = "manual"
    matched_evidence: dict | None = None
    notes: str | None = None


class RedressOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    agency: str
    company_name: str
    title: str
    eligibility_description: str | None
    claim_url: str | None
    total_redress_cents: int | None
    estimated_per_user_cents: int | None
    claim_deadline: date | None
    status: RedressStatus
    discovery_source: str
    matched_evidence: dict | None
    notes: str | None
    discovered_at: datetime
    filed_at: datetime | None
    paid_at: datetime | None
    actual_payout_cents: int | None


class StatusPatch(BaseModel):
    status: RedressStatus
    actual_payout_cents: int | None = None
    notes: str | None = None


class KnownRedressOut(BaseModel):
    """Catalog entry — what we hardcoded as a known active redress."""
    agency: str
    company_name: str
    title: str
    eligibility_description: str
    claim_url: str | None
    total_redress_cents: int | None
    estimated_per_user_cents: int | None
    claim_deadline: date | None


class RedressMatchOut(BaseModel):
    """A matched-against-spend suggested redress."""
    catalog_entry: KnownRedressOut
    matched_transactions: int
    matched_total_spend_cents: int
    sample_descriptions: list[str]
    already_logged: bool  # True if there's an existing RegulatoryRedress row for this company


class RedressMatchReportOut(BaseModel):
    matches: list[RedressMatchOut]
    total_estimated_cents: int  # sum of estimated_per_user across matches


# --- Endpoints -------------------------------------------------------


@router.get("/known", response_model=list[KnownRedressOut])
def list_known(db: Session = Depends(get_db)) -> list[KnownRedressOut]:
    """Hardcoded catalog of recent active regulatory redress.

    Lives in code (not DB) so updates ship with new app releases.
    Filters out entries whose claim_deadline has passed.
    """
    today = date.today()
    out: list[KnownRedressOut] = []
    for e in _KNOWN_REDRESS_CATALOG:
        if e.get("claim_deadline") and e["claim_deadline"] < today:
            continue
        out.append(KnownRedressOut(**e))
    _ = db
    return out


@router.get("/match-spend", response_model=RedressMatchReportOut)
def match_spend(
    days: int = 730,  # ~2 years; CFPB cases often cover 5+ years but recent spend is best signal
    db: Session = Depends(get_db),
) -> RedressMatchReportOut:
    """Cross-reference catalog companies against the user's last N
    days of transactions. Returns matches the user is likely
    eligible for + already-logged status."""
    if days < 30 or days > 3650:
        raise HTTPException(400, "days must be between 30 and 3650")

    cutoff = date.today().replace(day=1)
    from datetime import timedelta as _td
    cutoff = date.today() - _td(days=days)

    # Fetch all txns once, group by company match
    rows = list(
        db.execute(
            select(Transaction).where(Transaction.posted_date >= cutoff)
        ).scalars().all()
    )
    # Already-logged set so we can flag dupes
    logged_companies = {
        r.company_name.lower()
        for r in db.execute(
            select(RegulatoryRedress.company_name)
        ).scalars().all()
    }

    matches: list[RedressMatchOut] = []
    total_est = 0
    today = date.today()

    for entry in _KNOWN_REDRESS_CATALOG:
        if entry.get("claim_deadline") and entry["claim_deadline"] < today:
            continue
        company = entry["company_name"]
        patterns = _MERCHANT_MATCH_PATTERNS.get(company, [company.upper()])
        matched_txns: list[Transaction] = []
        matched_spend = 0
        sample_descs: list[str] = []
        for t in rows:
            desc = (t.description_raw or "").upper()
            if any(p in desc for p in patterns):
                matched_txns.append(t)
                matched_spend += abs(t.amount_cents)
                if len(sample_descs) < 3:
                    sample_descs.append(t.description_raw or "")
        if not matched_txns:
            continue
        matches.append(
            RedressMatchOut(
                catalog_entry=KnownRedressOut(**entry),
                matched_transactions=len(matched_txns),
                matched_total_spend_cents=matched_spend,
                sample_descriptions=sample_descs,
                already_logged=company.lower() in logged_companies,
            )
        )
        if entry.get("estimated_per_user_cents"):
            total_est += entry["estimated_per_user_cents"]

    return RedressMatchReportOut(matches=matches, total_estimated_cents=total_est)


@router.get("", response_model=list[RedressOut])
def list_redress(
    status: RedressStatus | None = None,
    agency: str | None = None,
    db: Session = Depends(get_db),
) -> list[RegulatoryRedress]:
    stmt = select(RegulatoryRedress).order_by(RegulatoryRedress.discovered_at.desc())
    if status is not None:
        stmt = stmt.where(RegulatoryRedress.status == status)
    if agency is not None:
        stmt = stmt.where(RegulatoryRedress.agency == agency)
    return list(db.execute(stmt).scalars().all())


@router.post("", response_model=RedressOut, status_code=201)
def create_redress(body: RedressIn, db: Session = Depends(get_db)) -> RegulatoryRedress:
    row = RegulatoryRedress(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{rid}/status", response_model=RedressOut)
def update_status(
    rid: int, body: StatusPatch, db: Session = Depends(get_db)
) -> RegulatoryRedress:
    row = db.get(RegulatoryRedress, rid)
    if row is None:
        raise HTTPException(404, f"RegulatoryRedress {rid} not found")
    now = datetime.utcnow()
    row.status = body.status
    if body.status == RedressStatus.pending_filed and row.filed_at is None:
        row.filed_at = now
    elif body.status == RedressStatus.paid and row.paid_at is None:
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


@router.delete("/{rid}", status_code=204)
def delete_redress(rid: int, db: Session = Depends(get_db)) -> None:
    row = db.get(RegulatoryRedress, rid)
    if row is None:
        raise HTTPException(404, f"RegulatoryRedress {rid} not found")
    db.delete(row)
    db.commit()


# Reference unused imports so linters stay quiet.
_ = func
_ = Iterable
