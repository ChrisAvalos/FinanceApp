"""Class-action settlements (Phase F).

Manual CRUD for now — the user adds rows by hand from sites like
TopClassActions, ClassAction.org, or aggregator newsletters. A scraper
will land here in a follow-up; the data model is already shaped for it
(``source`` column, URL-based dedupe).

This router is intentionally tiny:
* GET ``/legal-claims`` with light filters (status, proof, deadline window)
* POST ``/legal-claims`` to create
* PATCH ``/legal-claims/{id}`` for status transitions + edits
* DELETE ``/legal-claims/{id}`` (hard delete; "I clicked add by mistake")
* GET ``/legal-claims/stats`` for the dashboard header counters

No money moves. We surface, summarise, and remind — Chris files claims himself.
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from finance_app.api.schemas import (
    LegalClaimIn,
    LegalClaimOut,
    LegalClaimStats,
    LegalClaimUpdate,
    ScraperRunResponse,
)
from finance_app.db.models import LegalClaim, LegalClaimStatus, ProofRequirement
from finance_app.db.session import get_db
from finance_app.scrapers.legal_claims import default_scrapers, run_scrapers
from finance_app.scrapers.legal_claims.state_parser import (
    matches_state,
    split_state_codes,
)

router = APIRouter(prefix="/legal-claims", tags=["legal-claims"])


# ---------- Helpers ----------

def _to_out(row: LegalClaim, today: date | None = None) -> LegalClaimOut:
    """Materialize the derived fields the DB doesn't store.

    ``is_expired`` and ``days_until_deadline`` come from comparing the
    deadline to "today" — pulled out of the ORM layer so the column stays
    dumb and the badge logic stays consistent across endpoints.
    """
    today = today or date.today()
    days_left: int | None = None
    expired = False
    if row.claim_deadline is not None:
        days_left = (row.claim_deadline - today).days
        # A claim expires once its deadline is strictly in the past, but
        # only matters for rows that haven't been claimed/paid yet.
        if days_left < 0 and row.status == LegalClaimStatus.available:
            expired = True
    return LegalClaimOut(
        id=row.id,
        name=row.name,
        source_url=row.source_url,
        administrator=row.administrator,
        case_number=row.case_number,
        description=row.description,
        eligibility=row.eligibility,
        proof_status=row.proof_status,
        estimated_payout_cents=row.estimated_payout_cents,
        claim_deadline=row.claim_deadline,
        payout_date=row.payout_date,
        status=row.status,
        claimed_at=row.claimed_at,
        paid_at=row.paid_at,
        actual_payout_cents=row.actual_payout_cents,
        notes=row.notes,
        source=row.source,
        state_eligibility=row.state_eligibility or "nationwide",
        is_expired=expired,
        days_until_deadline=days_left,
    )


# ---------- CRUD ----------

@router.get("", response_model=list[LegalClaimOut])
def list_claims(
    status: LegalClaimStatus | None = None,
    proof_status: ProofRequirement | None = None,
    include_expired: bool = True,
    state: str | None = None,
    db: Session = Depends(get_db),
) -> list[LegalClaimOut]:
    """List claims sorted by deadline (soonest first), nulls last.

    Default behaviour returns everything so the UI tabs can filter
    client-side without round-trips. Pass narrow filters when scripting.

    ``state`` accepts a 2-char postal code (``CA``, ``FL``, etc.). The
    filter matches both nationwide claims AND claims explicitly tagged
    for that state — Settlemate's UX. Set to None / omit to skip the
    state filter entirely. The string ``"nationwide"`` matches only
    nationwide claims (useful for "Top matches, ranked" cohort).
    """
    stmt = select(LegalClaim)
    if status is not None:
        stmt = stmt.where(LegalClaim.status == status)
    if proof_status is not None:
        stmt = stmt.where(LegalClaim.proof_status == proof_status)
    # NULLs LAST on deadline — undated claims get pushed to the bottom of
    # the list rather than dominating it (SQLite sorts NULLs first by default).
    stmt = stmt.order_by(
        LegalClaim.claim_deadline.is_(None),
        LegalClaim.claim_deadline.asc(),
        LegalClaim.id.asc(),
    )
    rows = db.execute(stmt).scalars().all()
    today = date.today()
    out = [_to_out(r, today) for r in rows]
    if not include_expired:
        out = [c for c in out if not c.is_expired]
    # State filter — applied in Python to keep the SQL simple. Volumes
    # are tiny (< 1k rows even after months of scraping) so this is fine.
    if state:
        normalized = state.strip()
        if normalized.lower() == "nationwide":
            out = [c for c in out if c.state_eligibility == "nationwide"]
        else:
            target = normalized.upper()
            out = [c for c in out if matches_state(c.state_eligibility, target)]
    return out


@router.post("", response_model=LegalClaimOut, status_code=201)
def create_claim(body: LegalClaimIn, db: Session = Depends(get_db)) -> LegalClaimOut:
    row = LegalClaim(
        name=body.name.strip(),
        source_url=body.source_url.strip(),
        administrator=body.administrator,
        case_number=body.case_number,
        description=body.description,
        eligibility=body.eligibility,
        proof_status=body.proof_status,
        estimated_payout_cents=body.estimated_payout_cents,
        claim_deadline=body.claim_deadline,
        payout_date=body.payout_date,
        notes=body.notes,
        source=body.source,
        status=LegalClaimStatus.available,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Duplicate source_url — surface a clean error rather than a 500.
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A claim with source_url={body.source_url!r} already exists.",
        )
    db.refresh(row)
    return _to_out(row)


@router.patch("/{claim_id}", response_model=LegalClaimOut)
def update_claim(
    claim_id: int,
    body: LegalClaimUpdate,
    db: Session = Depends(get_db),
) -> LegalClaimOut:
    row = db.get(LegalClaim, claim_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Legal claim not found")

    # Apply only the fields the client actually sent. `model_dump(exclude_unset=True)`
    # is the Pydantic-v2 way to distinguish "wasn't in the body" from "was
    # explicitly set to None."
    patch = body.model_dump(exclude_unset=True)

    new_status = patch.pop("status", None)
    for k, v in patch.items():
        setattr(row, k, v)

    # Status transitions stamp timestamps so the UI can show "claimed 3d ago".
    # We only stamp on *transition into* the state — re-PATCHing the same
    # status shouldn't reset the clock.
    now = datetime.utcnow()
    if new_status is not None and new_status != row.status:
        if new_status == LegalClaimStatus.claimed and row.claimed_at is None:
            row.claimed_at = now
        if new_status == LegalClaimStatus.paid and row.paid_at is None:
            row.paid_at = now
        row.status = new_status

    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/{claim_id}", status_code=204)
def delete_claim(claim_id: int, db: Session = Depends(get_db)) -> None:
    row = db.get(LegalClaim, claim_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Legal claim not found")
    db.delete(row)
    db.commit()


# ---------- Stats ----------

@router.get("/stats", response_model=LegalClaimStats)
def claim_stats(
    state: str | None = None,
    db: Session = Depends(get_db),
) -> LegalClaimStats:
    """Header-card counters. One query, computed in Python — the table is small.

    "Pending potential" only sums *non-expired available* rows, because
    money on a deadline-blown claim is no longer on the table.

    Sprint 34 — accepts the same ``state`` filter as the list endpoint.
    Without this, clicking the California chip on the panel left the
    four big stat cards stuck at global totals (Pending $526.17 even
    though California-only might be $40). The audit flagged this as
    UX wart #6 carry-over from the prior audit. Filter is applied
    to ``rows`` BEFORE the per-status partitioning so every downstream
    counter reflects the selected scope.
    """
    rows = list(db.execute(select(LegalClaim)).scalars().all())
    if state:
        normalized = state.strip()
        if normalized.lower() == "nationwide":
            rows = [r for r in rows if (r.state_eligibility or "nationwide") == "nationwide"]
        else:
            target = normalized.upper()
            rows = [
                r for r in rows
                if matches_state(r.state_eligibility or "nationwide", target)
            ]
    today = date.today()

    available = [r for r in rows if r.status == LegalClaimStatus.available]
    claimed = [r for r in rows if r.status == LegalClaimStatus.claimed]
    paid = [r for r in rows if r.status == LegalClaimStatus.paid]
    dismissed = [r for r in rows if r.status == LegalClaimStatus.dismissed]

    expired = [
        r for r in available
        if r.claim_deadline is not None and r.claim_deadline < today
    ]
    live_available = [r for r in available if r not in expired]

    pending_potential = sum(
        (r.estimated_payout_cents or 0) for r in live_available
    )
    collected = sum((r.actual_payout_cents or 0) for r in paid)

    # Per-state counts on live available rows. Each claim contributes
    # to every state in its state_eligibility list — a "CA,FL,TX" claim
    # adds 1 to each of those three buckets. ``"nationwide"`` is its
    # own bucket so the UI can render "Nationwide (124) · CA (31) · ..."
    # without double-counting; the UI does the math of "show me everything
    # that applies to me in CA" by combining nationwide + CA.
    counts_by_state: dict[str, int] = {}
    for r in live_available:
        codes = split_state_codes(r.state_eligibility or "nationwide")
        if not codes:
            counts_by_state["nationwide"] = counts_by_state.get("nationwide", 0) + 1
        else:
            for c in codes:
                counts_by_state[c] = counts_by_state.get(c, 0) + 1

    # 3-way proof split on live (non-expired) available rows. Rows whose proof
    # requirement we don't know yet (scraper couldn't decide) end up in their
    # own bucket so the UI can prompt the user to triage them rather than
    # silently lumping them with the "Quick" or "Needs proof" piles.
    return LegalClaimStats(
        total_count=len(rows),
        available_count=len(available),
        claimed_count=len(claimed),
        paid_count=len(paid),
        dismissed_count=len(dismissed),
        expired_count=len(expired),
        pending_potential_cents=pending_potential,
        collected_cents=collected,
        available_quick_count=sum(
            1 for r in live_available if r.proof_status == ProofRequirement.not_required
        ),
        available_with_proof_count=sum(
            1 for r in live_available if r.proof_status == ProofRequirement.required
        ),
        available_unknown_count=sum(
            1 for r in live_available if r.proof_status == ProofRequirement.unknown
        ),
        counts_by_state=counts_by_state,
    )


# ---------- Scrape ----------

@router.post("/scrape", response_model=ScraperRunResponse)
def scrape_now(db: Session = Depends(get_db)) -> ScraperRunResponse:
    """Run every configured scraper synchronously. Returns the per-source summary.

    Synchronous on purpose — the run takes a few seconds against ~30
    detail pages, well inside a normal HTTP timeout, and the UI shows
    a "Scraping…" spinner while it's in flight. Pushing this to a
    queue would be more complexity than it's worth at this scale.

    The scheduler job calls ``run_scrapers`` directly, not through
    this endpoint, so this is purely a user-facing "run now" trigger.
    """
    return run_scrapers(db, default_scrapers())
