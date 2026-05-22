"""Weekly insights narrator (Phase 5.3).

Produces a 3-5 sentence plain-English summary of the user's week:
spending changes, new subs, utilization status, opportunity recap.
Optionally generated via local Ollama for nicer prose; falls back to
a deterministic templater when Ollama isn't reachable so the feature
always produces something useful.

Usage from a router::

    from finance_app.insights import build_weekly_digest, render_digest
    digest = build_weekly_digest(db, today=date.today())
    text = render_digest(digest)  # tries Ollama, falls back to template
"""
from .annual_review import (
    AnnualReview,
    CategoryYearTotal,
    ScoreTrajectory,
    TopPurchase,
    build_annual_review,
)
from .narrator import (
    WeeklyDigest,
    build_weekly_digest,
    render_digest,
    render_template,
)

__all__ = [
    "AnnualReview",
    "CategoryYearTotal",
    "ScoreTrajectory",
    "TopPurchase",
    "WeeklyDigest",
    "build_annual_review",
    "build_weekly_digest",
    "render_digest",
    "render_template",
]
