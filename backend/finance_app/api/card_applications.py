"""Card-application + welcome-bonus tracker API — Phase 8.2.

GET    /card-applications              list (filterable: status, issuer)
POST   /card-applications              create (research / planning a new app)
GET    /card-applications/eligibility  Chase 5/24 + Amex lifetime status
PATCH  /card-applications/{id}/status  transition lifecycle
PATCH  /card-applications/{id}/spend   log progress toward minimum-spend
PATCH  /card-applications/{id}         edit fields
DELETE /card-applications/{id}         delete one

Eligibility surface
-------------------
Chase's 5/24 rule says: if you've opened 5+ new credit cards (any
issuer) in the trailing 24 months, Chase will deny most consumer
applications. We compute this by walking ``CardApplication`` rows
where ``approved_at`` is within the last 24 months and
``counts_toward_5_24`` is True. Business cards from non-Chase issuers
mostly DO count toward your 5/24 (despite the name) because they
typically appear on your personal credit report.

Amex's once-per-lifetime rule: each individual card's welcome bonus
is one-shot. We compute eligibility per card_name by checking whether
any prior application for the same name+issuer reached
``bonus_posted`` status, and whether
``bonus_lifetime_eligible_at`` (if the user logged a future-eligible
date based on a CFPB / class-action settlement clarification) has
passed.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.card_applications import iter_best_bonuses_ranked
from finance_app.db.models import CardApplication, CardApplicationStatus
from finance_app.db.session import get_db


router = APIRouter(prefix="/card-applications", tags=["card-applications"])


# ----- Best-bonus catalog --------------------------------------------


class BestBonusOut(BaseModel):
    card_name: str
    issuer: str
    bonus_points: int
    bonus_dollar_value_cents: int
    minimum_spend_cents: int
    minimum_spend_months: int
    annual_fee_cents: int
    counts_toward_5_24: bool
    chase_5_24_friendly: bool
    notes: str
    product_url: str
    # Derived: is the user under 5/24 right now? Computed per-request
    # from the user's CardApplication history. UI uses this to grey out
    # Chase consumer entries when the user is already at/over 5/24.
    user_eligible_5_24: bool = True


def _compute_user_5_24(db: Session) -> tuple[int, bool]:
    """Return (count_in_window, under_threshold)."""
    cutoff = date.today() - timedelta(days=730)  # 24 months
    rows = db.execute(
        select(CardApplication).where(
            CardApplication.counts_toward_5_24.is_(True),
            CardApplication.approved_at.is_not(None),
        )
    ).scalars().all()
    count = sum(1 for r in rows if r.approved_at and r.approved_at >= cutoff)
    return count, count < 5


@router.get("/best-bonuses", response_model=list[BestBonusOut])
def list_best_bonuses(
    chase_5_24_only: bool = False,
    db: Session = Depends(get_db),
) -> list[BestBonusOut]:
    """Curated catalog of top welcome bonuses, ranked by $-equivalent.

    Surfaces inside the Card applications panel as a "consider applying
    for" sidebar so the panel has content even when the user has zero
    rows in their personal application history.

    ``chase_5_24_only=true`` filters to 5/24-eligible cards (most are;
    some business cards aren't subject to it).

    Each entry is enriched with ``user_eligible_5_24`` based on the
    user's actual application history, so Chase consumer entries are
    correctly flagged when the user is already over the threshold.
    """
    _, under_5_24 = _compute_user_5_24(db)
    out: list[BestBonusOut] = []
    for b in iter_best_bonuses_ranked(filter_chase_5_24=chase_5_24_only or None):
        # If the user is OVER 5/24, mark Chase consumer cards as ineligible.
        # Business cards from Chase don't count against the user — they
        # have counts_toward_5_24=False — but they still need <5/24 to be
        # APPROVED for a Chase business card. So both halves of the rule.
        eligible = under_5_24 if b.issuer == "Chase" else True
        out.append(
            BestBonusOut(
                card_name=b.card_name,
                issuer=b.issuer,
                bonus_points=b.bonus_points,
                bonus_dollar_value_cents=b.bonus_dollar_value_cents,
                minimum_spend_cents=b.minimum_spend_cents,
                minimum_spend_months=b.minimum_spend_months,
                annual_fee_cents=b.annual_fee_cents,
                counts_toward_5_24=b.counts_toward_5_24,
                chase_5_24_friendly=b.chase_5_24_friendly,
                notes=b.notes,
                product_url=b.product_url,
                user_eligible_5_24=eligible,
            )
        )
    return out


# ----- Pydantic ------------------------------------------------------


class CardApplicationIn(BaseModel):
    issuer: str
    card_name: str
    status: CardApplicationStatus = CardApplicationStatus.planning
    account_id: int | None = None
    bonus_value_cents: int | None = None
    bonus_points: int | None = None
    minimum_spend_cents: int | None = None
    minimum_spend_window_days: int | None = None
    spend_to_date_cents: int = 0
    minimum_spend_deadline: date | None = None
    counts_toward_5_24: bool = True
    bonus_lifetime_eligible_at: date | None = None
    annual_fee_cents: int | None = None
    first_year_fee_waived: bool = False
    notes: str | None = None


class CardApplicationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    issuer: str
    card_name: str
    status: CardApplicationStatus
    account_id: int | None
    bonus_value_cents: int | None
    bonus_points: int | None
    minimum_spend_cents: int | None
    minimum_spend_window_days: int | None
    spend_to_date_cents: int
    minimum_spend_deadline: date | None
    counts_toward_5_24: bool
    bonus_lifetime_eligible_at: date | None
    annual_fee_cents: int | None
    first_year_fee_waived: bool
    notes: str | None
    applied_at: datetime | None
    approved_at: datetime | None
    bonus_earned_at: datetime | None
    bonus_posted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class StatusPatch(BaseModel):
    status: CardApplicationStatus
    notes: str | None = None


class SpendPatch(BaseModel):
    additional_spend_cents: int


class EligibilityChase524Out(BaseModel):
    """Chase 5/24 status."""
    cards_opened_in_window: int
    window_start: date
    window_end: date
    is_under_5_24: bool
    cards: list[dict]
    notes: str


class EligibilityAmexLifetimeOut(BaseModel):
    """Amex once-per-lifetime status, per card-name."""
    card_name: str
    bonus_already_earned: bool
    earliest_eligible_again: date | None
    last_earned_at: datetime | None


class EligibilityReportOut(BaseModel):
    chase_5_24: EligibilityChase524Out
    amex_lifetime: list[EligibilityAmexLifetimeOut]


# ----- Endpoints -----------------------------------------------------


@router.get("", response_model=list[CardApplicationOut])
def list_applications(
    status: CardApplicationStatus | None = None,
    issuer: str | None = None,
    db: Session = Depends(get_db),
) -> list[CardApplication]:
    stmt = select(CardApplication).order_by(CardApplication.created_at.desc())
    if status is not None:
        stmt = stmt.where(CardApplication.status == status)
    if issuer is not None:
        stmt = stmt.where(CardApplication.issuer == issuer)
    return list(db.execute(stmt).scalars().all())


@router.post("", response_model=CardApplicationOut, status_code=201)
def create_application(
    body: CardApplicationIn, db: Session = Depends(get_db)
) -> CardApplication:
    row = CardApplication(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{aid}/status", response_model=CardApplicationOut)
def update_status(
    aid: int, body: StatusPatch, db: Session = Depends(get_db)
) -> CardApplication:
    """Transition status. Stamps the appropriate timestamp + may set deadline."""
    row = db.get(CardApplication, aid)
    if row is None:
        raise HTTPException(404, f"CardApplication {aid} not found")
    now = datetime.utcnow()
    row.status = body.status
    if body.status == CardApplicationStatus.applied and row.applied_at is None:
        row.applied_at = now
    elif body.status == CardApplicationStatus.approved and row.approved_at is None:
        row.approved_at = now
        # Set the bonus deadline now that the clock has started.
        if (
            row.minimum_spend_window_days
            and row.minimum_spend_deadline is None
        ):
            row.minimum_spend_deadline = (
                now.date() + timedelta(days=row.minimum_spend_window_days)
            )
    elif (
        body.status == CardApplicationStatus.bonus_earned
        and row.bonus_earned_at is None
    ):
        row.bonus_earned_at = now
    elif (
        body.status == CardApplicationStatus.bonus_posted
        and row.bonus_posted_at is None
    ):
        row.bonus_posted_at = now
    if body.notes:
        existing = row.notes or ""
        sep = "\n\n" if existing else ""
        row.notes = f"{existing}{sep}[{now.isoformat()}Z] {body.notes}"
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{aid}/spend", response_model=CardApplicationOut)
def log_spend(
    aid: int, body: SpendPatch, db: Session = Depends(get_db)
) -> CardApplication:
    """Add to ``spend_to_date_cents``. Auto-flips to bonus_earned if the minimum is hit."""
    row = db.get(CardApplication, aid)
    if row is None:
        raise HTTPException(404, f"CardApplication {aid} not found")
    row.spend_to_date_cents += body.additional_spend_cents
    if (
        row.minimum_spend_cents
        and row.spend_to_date_cents >= row.minimum_spend_cents
        and row.status == CardApplicationStatus.approved
    ):
        row.status = CardApplicationStatus.bonus_earned
        row.bonus_earned_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{aid}", response_model=CardApplicationOut)
def update_application(
    aid: int, body: CardApplicationIn, db: Session = Depends(get_db)
) -> CardApplication:
    row = db.get(CardApplication, aid)
    if row is None:
        raise HTTPException(404, f"CardApplication {aid} not found")
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{aid}", status_code=204)
def delete_application(aid: int, db: Session = Depends(get_db)) -> None:
    row = db.get(CardApplication, aid)
    if row is None:
        raise HTTPException(404, f"CardApplication {aid} not found")
    db.delete(row)
    db.commit()


@router.get("/eligibility", response_model=EligibilityReportOut)
def eligibility(db: Session = Depends(get_db)) -> EligibilityReportOut:
    """Compute Chase 5/24 + Amex once-per-lifetime per known card.

    The Chase 5/24 calculation is conservative — counts every approved
    application within the trailing 24 months whose
    ``counts_toward_5_24=True``. Business cards from non-Chase issuers
    default to True because they typically appear on personal credit
    reports; the user can flip individual rows.
    """
    today = date.today()
    window_start = today - timedelta(days=24 * 30)  # ~24 months

    apps = list(db.execute(select(CardApplication)).scalars().all())

    # 5/24
    cards_in_window = [
        a
        for a in apps
        if a.approved_at is not None
        and a.approved_at.date() >= window_start
        and a.counts_toward_5_24
    ]
    chase = EligibilityChase524Out(
        cards_opened_in_window=len(cards_in_window),
        window_start=window_start,
        window_end=today,
        is_under_5_24=len(cards_in_window) < 5,
        cards=[
            {
                "issuer": a.issuer,
                "card_name": a.card_name,
                "approved_at": a.approved_at.isoformat() if a.approved_at else None,
            }
            for a in cards_in_window
        ],
        notes=(
            "Chase will deny most personal-card applications when this count "
            "is ≥ 5. Some Chase business cards (Ink Business series) don't "
            "count toward 5/24 themselves but you must still be UNDER 5/24 "
            "to be approved for them."
        ),
    )

    # Amex lifetime — group by (issuer='Amex', card_name) and find the
    # most recent bonus_posted entry.
    amex_apps = [
        a
        for a in apps
        if a.issuer.lower().strip() in ("amex", "american express")
    ]
    by_card: dict[str, list[CardApplication]] = {}
    for a in amex_apps:
        by_card.setdefault(a.card_name, []).append(a)
    amex_out: list[EligibilityAmexLifetimeOut] = []
    for card_name, group in by_card.items():
        earned = [g for g in group if g.bonus_posted_at is not None]
        already = bool(earned)
        last = (
            max(earned, key=lambda g: g.bonus_posted_at).bonus_posted_at
            if earned
            else None
        )
        next_eligible = max(
            (g.bonus_lifetime_eligible_at for g in group if g.bonus_lifetime_eligible_at),
            default=None,
        )
        amex_out.append(
            EligibilityAmexLifetimeOut(
                card_name=card_name,
                bonus_already_earned=already,
                earliest_eligible_again=next_eligible,
                last_earned_at=last,
            )
        )

    return EligibilityReportOut(chase_5_24=chase, amex_lifetime=amex_out)
