"""Card benefits tracker (Phase 8.3).

Most premium-card customers leave hundreds of dollars per year on
the table by failing to use the annual statement credits and
benefits their cards bundle. The Sapphire Reserve $300 travel
credit, Amex Plat $200 airline + $200 hotel + $240 entertainment
+ $200 Uber + $189 CLEAR + $300 Equinox — these add up to $1,000+
per card per year for some users.

This module:

  1. Catalogues each card's benefits in a YAML profile (one entry per
     benefit, with reset cadence — calendar_year / cardholder_year /
     monthly / per_trip / lifetime).
  2. Tracks usage YTD per cardholder via a ``BenefitUsage`` table.
  3. Surfaces "use it or lose it" warnings when a benefit is unused
     and the reset window is approaching.
  4. Computes net rewards − annual fee per card so the user can
     decide whether to keep / downgrade.

Like the rewards optimizer, this is local-data + YAML — edit the
YAML to add new cards / benefits.
"""
from .service import (
    BenefitProfile,
    BenefitUsageReport,
    CardBenefitProfile,
    annual_credits_summary,
    load_card_benefits,
)

__all__ = [
    "BenefitProfile",
    "BenefitUsageReport",
    "CardBenefitProfile",
    "annual_credits_summary",
    "load_card_benefits",
]
