"""Tax-time export (Phase 7.4).

Annual roll-up of every transaction grouped by tax bucket. The output
is what you'd hand to your CPA, or feed into TurboTax/FreeTaxUSA's
import flow when they support custom CSVs.

Tax buckets are mapped from category slugs via :data:`TAX_BUCKETS`
below — edit that table to add buckets or re-map categories. We pick
this layer (rather than adding a ``tax_bucket`` column to Category)
because tax categories aren't 1:1 with spending categories — e.g.
"food.restaurants" is never a tax write-off for most people, but
"food.restaurants" attended in a business context is. The user can
override with manual flags when they want a non-default bucket.
"""
from .service import (
    TAX_BUCKETS,
    AnnualTaxReport,
    BucketRollup,
    build_annual_tax_report,
    render_csv,
)

__all__ = [
    "TAX_BUCKETS",
    "AnnualTaxReport",
    "BucketRollup",
    "build_annual_tax_report",
    "render_csv",
]
