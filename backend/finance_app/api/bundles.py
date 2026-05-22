"""Bundle-overlap API — Wave E.

Surfaces "you're paying for this perk standalone AND it's bundled with
your existing plan" findings. Read-only listing; the user acts on the
findings manually (cancel + activate via the parent), and the next
sync cycle removes the duplicate row.

Wave E-6 adds ``POST /bundles/scrape-tiers`` which triggers a Playwright
run against the carrier portals (currently just Xfinity), saves the
scraped plan-tier data to a sidecar JSON, and returns a per-site
status. The detector picks up the snapshots automatically on the next
``GET /bundles/overlaps`` call.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from finance_app.bundles import detect_overlaps
from finance_app.db.session import get_db

router = APIRouter(prefix="/bundles", tags=["bundles"])


class BundleOverlapOut(BaseModel):
    """One duplicate-paid finding for the UI."""
    parent_subscription_id: int | None
    parent_label: str
    parent_monthly_cents: int
    perk_subscription_id: int
    perk_merchant: str
    perk_label: str
    perk_monthly_cents: int
    annual_savings_cents: int
    tier_note: str
    confidence: float
    activation_url: str | None
    notes: list[str]
    rationale: str


class BundleOverlapsResponse(BaseModel):
    overlaps: list[BundleOverlapOut]
    total_annual_savings_cents: int
    high_confidence_count: int
    # Server-side computation timestamp — drives the SyncFreshnessChip
    # on the future Bundle Overlaps panel; matches the Wave D-1 pattern.
    generated_at: datetime | None = None


class TierScrapeSiteResultOut(BaseModel):
    site_key: str
    status: str                                # "ok" | "auth_missing" | "no_data" | "error"
    snapshots_saved: int
    plan_summary: list[str]
    error: str | None = None


class TierScrapeResponse(BaseModel):
    sites: list[TierScrapeSiteResultOut]
    total_snapshots: int
    finished_at: datetime


@router.get("/overlaps", response_model=BundleOverlapsResponse)
def get_overlaps(db: Session = Depends(get_db)) -> BundleOverlapsResponse:
    """List every detected bundle overlap, ranked by annual savings."""
    findings = detect_overlaps(db)
    high_conf = sum(1 for f in findings if f.confidence >= 0.8)
    total = sum(f.annual_savings_cents for f in findings)
    return BundleOverlapsResponse(
        overlaps=[
            BundleOverlapOut(
                parent_subscription_id=f.parent_subscription_id,
                parent_label=f.parent_label,
                parent_monthly_cents=f.parent_monthly_cents,
                perk_subscription_id=f.perk_subscription_id,
                perk_merchant=f.perk_merchant,
                perk_label=f.perk_label,
                perk_monthly_cents=f.perk_monthly_cents,
                annual_savings_cents=f.annual_savings_cents,
                tier_note=f.tier_note,
                confidence=f.confidence,
                activation_url=f.activation_url,
                notes=f.notes,
                rationale=f.rationale,
            )
            for f in findings
        ],
        total_annual_savings_cents=total,
        high_confidence_count=high_conf,
        generated_at=datetime.utcnow(),
    )


@router.post("/scrape-tiers", response_model=TierScrapeResponse)
def scrape_tiers() -> TierScrapeResponse:
    """Trigger Playwright runs against every registered carrier portal.

    Synchronous — the call blocks until every site has finished (or
    returned an auth_missing). For Xfinity in particular this typically
    takes 5-15 seconds depending on whether the portal SPA is cold.
    Auth_missing surfaces cleanly so the UI can prompt the user to run
    `python -m finance_app.scrapers.plan_tiers.bootstrap xfinity` once.

    Lazy-imports the coordinator so the API module loads even when
    Playwright isn't installed in the venv.
    """
    try:
        from finance_app.scrapers.plan_tiers.coordinator import run_all
    except ImportError as exc:
        raise HTTPException(
            500,
            f"Plan-tier scrapers unavailable: {exc}. "
            "Run `pip install playwright && python -m playwright install chromium`.",
        ) from exc

    result = run_all()
    return TierScrapeResponse(
        sites=[
            TierScrapeSiteResultOut(
                site_key=s.site_key,
                status=s.status,
                snapshots_saved=s.snapshots_saved,
                plan_summary=s.plan_summary,
                error=s.error,
            )
            for s in result.sites
        ],
        total_snapshots=result.total_snapshots,
        finished_at=datetime.utcnow(),
    )
