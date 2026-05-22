"""Savings + suggestions endpoints (Phase D).

Read-only — these endpoints never mutate state. The suggestion engine
composes recommendations on the fly from the current ledger; we don't
persist them in the Suggestion table here. (The Suggestion table is for
*acted-upon* suggestions if/when we want to track outcomes; v0.2 just
returns fresh computations on each request.)

Surface area:
* GET /savings/surplus?mode=historical|forecast|both     — surplus snapshot
* GET /savings/suggestions?mode=historical|forecast      — full bundle
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from finance_app.api.schemas import (
    BeforeAfterOut,
    ForecastBreakdownOut,
    HistoricalBreakdownOut,
    SuggestionBundleOut,
    SuggestionOut,
    SurplusSnapshotOut,
)
from finance_app.db.session import get_db
from finance_app.savings.suggestions import (
    Suggestion,
    SuggestionBundle,
    build_suggestions,
)
from finance_app.savings.surplus import (
    ForecastBreakdown,
    HistoricalBreakdown,
    SurplusMode,
    SurplusSnapshot,
    compute_surplus,
)

router = APIRouter(prefix="/savings", tags=["savings"])


# ---------- Marshallers ----------

def _hist_out(h: HistoricalBreakdown) -> HistoricalBreakdownOut:
    return HistoricalBreakdownOut(
        window_start=h.window_start,
        window_end=h.window_end,
        inflows_cents=h.inflows_cents,
        outflows_cents=h.outflows_cents,
        surplus_cents=h.surplus_cents,
        n_inflow_txns=h.n_inflow_txns,
        n_outflow_txns=h.n_outflow_txns,
    )


def _fcst_out(f: ForecastBreakdown) -> ForecastBreakdownOut:
    return ForecastBreakdownOut(
        window_start=f.window_start,
        window_end=f.window_end,
        projected_income_cents=f.projected_income_cents,
        fixed_obligations_cents=f.fixed_obligations_cents,
        variable_spend_cents=f.variable_spend_cents,
        surplus_cents=f.surplus_cents,
        n_active_subscriptions=f.n_active_subscriptions,
        n_variable_outflow_txns=f.n_variable_outflow_txns,
    )


def _snap_out(s: SurplusSnapshot) -> SurplusSnapshotOut:
    return SurplusSnapshotOut(
        as_of=s.as_of,
        mode_requested=s.mode_requested,
        historical=_hist_out(s.historical) if s.historical else None,
        forecast=_fcst_out(s.forecast) if s.forecast else None,
        notes=list(s.notes),
    )


def _suggestion_out(s: Suggestion) -> SuggestionOut:
    return SuggestionOut(
        kind=s.kind,
        title=s.title,
        body=s.body,
        estimated_savings_cents=s.estimated_savings_cents,
        confidence=s.confidence,
        goal_id=s.goal_id,
        subscription_id=s.subscription_id,
        account_id=s.account_id,
        before_after=[
            BeforeAfterOut(
                label=ba.label,
                current_cents=ba.current_cents,
                if_act_cents=ba.if_act_cents,
                if_dont_act_cents=ba.if_dont_act_cents,
                summary=ba.summary,
            )
            for ba in s.before_after
        ],
        extra=dict(s.extra),
    )


def _bundle_out(b: SuggestionBundle) -> SuggestionBundleOut:
    return SuggestionBundleOut(
        as_of=b.as_of,
        surplus_mode=b.surplus_mode,
        surplus_cents=b.surplus_cents,
        allocations=[_suggestion_out(s) for s in b.allocations],
        cancellations=[_suggestion_out(s) for s in b.cancellations],
        debt_strategies=[_suggestion_out(s) for s in b.debt_strategies],
        notes=list(b.notes),
    )


# ---------- Endpoints ----------

@router.get("/surplus", response_model=SurplusSnapshotOut)
def get_surplus(
    mode: SurplusMode = Query("both", description='"historical", "forecast", or "both"'),
    db: Session = Depends(get_db),
) -> SurplusSnapshotOut:
    """Return the surplus snapshot under the requested mode(s).

    Default ``both`` so the UI gets both numbers in one round-trip; the
    toggle is then a client-side concern.
    """
    snap = compute_surplus(db, mode=mode, today=date.today())
    return _snap_out(snap)


@router.get("/suggestions", response_model=SuggestionBundleOut)
def get_suggestions(
    mode: SurplusMode = Query("historical", description='"historical" or "forecast" — anchor for allocations'),
    db: Session = Depends(get_db),
) -> SuggestionBundleOut:
    """Return the full suggestion bundle anchored to ONE surplus mode.

    Mode here is single (not "both") because allocation math against two
    different surplus numbers in the same response is more confusing than
    helpful. UI passes ``historical`` by default; toggling re-fetches.
    """
    if mode == "both":
        # Be lenient: collapse "both" to "historical" — the UI shouldn't send
        # this but we don't want to 422 if it slips through.
        mode = "historical"
    bundle = build_suggestions(db, mode=mode, today=date.today())
    return _bundle_out(bundle)
