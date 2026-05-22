"""Card-benefit profile loader + use-it-or-lose-it summary.

Two public surfaces:

  * ``load_card_benefits(path=None)`` — returns a list of
    :class:`CardBenefitProfile`. Cached at module level.
  * ``annual_credits_summary(db, today=None)`` — given the user's
    linked credit cards, computes per-card net rewards − annual fee
    using card profiles + (eventually) BenefitUsage rows. For now,
    surfaces what's CLAIMABLE this calendar year so the user can see
    "you have $300 in untouched Sapphire Reserve travel credit
    expiring December 31."

Usage tracking is intentionally simple: we don't try to auto-detect
whether a Doordash transaction "used" the DashPass credit (Plaid
data is too coarse). The user logs usage via the API as they
remember, and the dashboard surfaces the declared coverage — pretty
much like the retention attempts log.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import yaml

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import Account, AccountType


@dataclass(frozen=True)
class BenefitProfile:
    """One yearly-resetting card perk."""
    name: str
    value_cents: int | None  # null when value isn't a fixed $-amount
    reset: str               # "calendar_year" | "cardholder_year" | "monthly" | etc
    how_to_use: str
    typical_redemption: str


@dataclass(frozen=True)
class CardBenefitProfile:
    """Aggregate card profile — fee + list of benefits."""
    name: str
    name_patterns: tuple[str, ...]
    annual_fee_cents: int
    benefits: tuple[BenefitProfile, ...]

    def matches(self, account_name: str) -> bool:
        if not account_name:
            return False
        n = account_name.lower()
        return any(p.lower() in n for p in self.name_patterns)

    def total_annual_credit_value_cents(self) -> int:
        """Sum of all numeric-valued benefits (skip null-value perks)."""
        return sum(b.value_cents for b in self.benefits if b.value_cents)


_DEFAULT_YAML_PATH = Path(__file__).parent / "card_benefits.yaml"

_loaded: list[CardBenefitProfile] | None = None


def load_card_benefits(path: Path | None = None) -> list[CardBenefitProfile]:
    global _loaded
    if path is None and _loaded is not None:
        return _loaded
    target = path or _DEFAULT_YAML_PATH
    # encoding="utf-8" is mandatory: YAML contains em-dashes and non-ASCII
    # punctuation. Default Path.read_text() uses OS locale (cp1252 on
    # Windows) which mangles those bytes into mojibake.
    raw = yaml.safe_load(target.read_text(encoding="utf-8")) or []
    profiles: list[CardBenefitProfile] = []
    for entry in raw:
        benefits = tuple(
            BenefitProfile(
                name=b["name"],
                value_cents=b.get("value_cents"),
                reset=b.get("reset", "calendar_year"),
                how_to_use=b.get("how_to_use", ""),
                typical_redemption=b.get("typical_redemption", ""),
            )
            for b in entry.get("benefits", [])
        )
        profiles.append(
            CardBenefitProfile(
                name=entry["name"],
                name_patterns=tuple(entry.get("name_patterns") or []),
                annual_fee_cents=int(entry.get("annual_fee_cents", 0)),
                benefits=benefits,
            )
        )
    if path is None:
        _loaded = profiles
    return profiles


@dataclass
class CardCreditsRow:
    """Per-card row in the annual-credits dashboard."""
    account_id: int
    account_name: str
    profile_name: str
    annual_fee_cents: int
    total_credit_value_cents: int
    benefits: list[dict] = field(default_factory=list)
    net_after_fee_cents: int = 0  # total_credit_value − fee


@dataclass
class BenefitUsageReport:
    """Top-level dashboard structure."""
    as_of: date
    rows: list[CardCreditsRow] = field(default_factory=list)
    unmatched_card_ids: list[int] = field(default_factory=list)
    total_face_value_cents: int = 0
    total_annual_fee_cents: int = 0
    net_potential_cents: int = 0  # face value − total fees


def annual_credits_summary(
    db: Session, *, today: date | None = None
) -> BenefitUsageReport:
    """For each linked credit card, surface the bundled-benefit roll-up.

    The dashboard pulls "what could you save this year if you used
    every credit your cards bundle." Pair with `BenefitUsage` rows
    (when the user logs usage) to subtract claimed-already from
    still-claimable.
    """
    today = today or date.today()
    profiles = load_card_benefits()
    cards = list(
        db.execute(
            select(Account).where(Account.account_type == AccountType.credit_card)
        ).scalars().all()
    )

    rows: list[CardCreditsRow] = []
    unmatched: list[int] = []
    total_face = 0
    total_fee = 0

    for card in cards:
        match: CardBenefitProfile | None = None
        # Manual override wins. Plaid often returns generic "CREDIT
        # CARD" as the account name; if the user picked a profile on
        # the Connections panel we honor that here before fuzzy
        # matching against name_patterns.
        override = (card.card_profile_override or "").strip()
        if override:
            for p in profiles:
                if p.name == override:
                    match = p
                    break
        if match is None:
            for p in profiles:
                if p.matches(card.name):
                    match = p
                    break
        if match is None:
            unmatched.append(card.id)
            continue
        face = match.total_annual_credit_value_cents()
        net = face - match.annual_fee_cents
        rows.append(
            CardCreditsRow(
                account_id=card.id,
                account_name=card.name,
                profile_name=match.name,
                annual_fee_cents=match.annual_fee_cents,
                total_credit_value_cents=face,
                benefits=[
                    {
                        "name": b.name,
                        "value_cents": b.value_cents,
                        "reset": b.reset,
                        "how_to_use": b.how_to_use,
                        "typical_redemption": b.typical_redemption,
                    }
                    for b in match.benefits
                ],
                net_after_fee_cents=net,
            )
        )
        total_face += face
        total_fee += match.annual_fee_cents

    rows.sort(key=lambda r: r.net_after_fee_cents, reverse=True)
    return BenefitUsageReport(
        as_of=today,
        rows=rows,
        unmatched_card_ids=unmatched,
        total_face_value_cents=total_face,
        total_annual_fee_cents=total_fee,
        net_potential_cents=total_face - total_fee,
    )
