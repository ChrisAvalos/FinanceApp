"""Card-benefits / use-it-or-lose-it API — Phase 8.3."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from finance_app.benefits import annual_credits_summary
from finance_app.benefits.service import load_card_benefits
from finance_app.db.models import Account, AccountType
from finance_app.db.session import get_db

router = APIRouter(prefix="/benefits", tags=["benefits"])


class CardCreditsRowOut(BaseModel):
    account_id: int
    account_name: str
    profile_name: str
    annual_fee_cents: int
    total_credit_value_cents: int
    benefits: list[dict]
    net_after_fee_cents: int


class BenefitUsageReportOut(BaseModel):
    as_of: date
    rows: list[CardCreditsRowOut]
    unmatched_card_ids: list[int]
    total_face_value_cents: int
    total_annual_fee_cents: int
    net_potential_cents: int


class CardProfileOut(BaseModel):
    """Catalog entry exposed to the UI's manual picker."""
    name: str
    annual_fee_cents: int
    total_credit_value_cents: int
    benefit_count: int


@router.get("/profiles", response_model=list[CardProfileOut])
def list_profiles() -> list[CardProfileOut]:
    """Catalog of card-benefit profiles available for manual binding.

    Returns one row per entry in ``card_benefits.yaml``, sorted by
    annual fee descending so premium cards are surfaced first in the
    Connections-panel picker.
    """
    profiles = sorted(
        load_card_benefits(), key=lambda p: -p.annual_fee_cents
    )
    return [
        CardProfileOut(
            name=p.name,
            annual_fee_cents=p.annual_fee_cents,
            total_credit_value_cents=p.total_annual_credit_value_cents(),
            benefit_count=len(p.benefits),
        )
        for p in profiles
    ]


class CardOverrideIn(BaseModel):
    """Body for the manual-bind-card endpoint."""
    # null clears the override; a profile name binds it.
    card_profile_override: str | None = None


@router.post("/cards/{account_id}/profile-override", response_model=dict)
def set_card_profile_override(
    account_id: int,
    body: CardOverrideIn,
    db: Session = Depends(get_db),
) -> dict:
    """Manually bind a credit-card account to a profile.

    Plaid frequently returns generic names like "CREDIT CARD" that the
    auto-matcher in benefits/service.py can't bind. The user picks a
    profile from the catalog (see ``GET /benefits/profiles``) and we
    store the choice on the Account row. The matcher honors the
    override on every subsequent ``GET /benefits/credits`` call.

    Pass ``card_profile_override: null`` to clear the override and let
    auto-matching take over again.
    """
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(404, "Account not found")
    if account.account_type != AccountType.credit_card:
        raise HTTPException(
            400,
            f"Account {account_id} is {account.account_type.value} — overrides only apply to credit cards.",
        )
    new_value = body.card_profile_override
    if new_value is not None:
        new_value = new_value.strip()
        if new_value:
            # Validate that the chosen profile actually exists in the catalog.
            profiles = load_card_benefits()
            if not any(p.name == new_value for p in profiles):
                raise HTTPException(
                    400,
                    f"Profile {new_value!r} not in catalog. Use GET /benefits/profiles for valid names.",
                )
        else:
            new_value = None
    account.card_profile_override = new_value
    db.commit()
    return {
        "account_id": account_id,
        "card_profile_override": account.card_profile_override,
    }


@router.get("/credits", response_model=BenefitUsageReportOut)
def get_credits(db: Session = Depends(get_db)) -> BenefitUsageReportOut:
    """Per-card use-it-or-lose-it credits + annual-fee math.

    Surfaces the dollar value of bundled benefits per card, ranked
    by net after-fee value. Unmatched cards (no profile in
    ``card_benefits.yaml``) listed separately so the user can request
    them.
    """
    report = annual_credits_summary(db)
    return BenefitUsageReportOut(
        as_of=report.as_of,
        rows=[
            CardCreditsRowOut(
                account_id=r.account_id,
                account_name=r.account_name,
                profile_name=r.profile_name,
                annual_fee_cents=r.annual_fee_cents,
                total_credit_value_cents=r.total_credit_value_cents,
                benefits=r.benefits,
                net_after_fee_cents=r.net_after_fee_cents,
            )
            for r in report.rows
        ],
        unmatched_card_ids=report.unmatched_card_ids,
        total_face_value_cents=report.total_face_value_cents,
        total_annual_fee_cents=report.total_annual_fee_cents,
        net_potential_cents=report.net_potential_cents,
    )
