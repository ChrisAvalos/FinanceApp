"""FIRE projection API.

Wraps :mod:`finance_app.fire` with a FastAPI endpoint and seeds
defaults from the user's existing data so the panel can render
something useful before the user touches a single slider:

  - ``starting_cents`` defaults to current net worth (assets − liabilities)
  - ``monthly_savings_cents`` defaults to recent surplus (cash flow)
  - ``annual_spending_cents`` defaults to last 12 months outflow

All three can be overridden per-request via query params, which is
how the frontend's interactive sliders work.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finance_app.db.models import Account, Transaction
from finance_app.db.session import get_db
from finance_app.fire import FireInputs, FireProjection as _FireProjection, simulate

router = APIRouter(prefix="/fire", tags=["fire"])


# -- Pydantic mirrors of the dataclass output (FastAPI doesn't
#    auto-serialize plain dataclasses cleanly across nested types).


class FireInputsOut(BaseModel):
    current_age: int
    target_retirement_age: int
    end_age: int
    starting_cents: int
    monthly_savings_cents: int
    annual_spending_cents: int
    mean_return_pct: float
    std_dev_pct: float
    n_trials: int
    simulation_mode: str
    historical_start_year: int | None = None


class FireYearOut(BaseModel):
    age: int
    p10_cents: int
    p25_cents: int
    p50_cents: int
    p75_cents: int
    p90_cents: int


class FireProjectionOut(BaseModel):
    inputs: FireInputsOut
    fire_number_cents: int
    years: list[FireYearOut]
    median_hit_age: int | None
    p25_hit_age: int | None
    p75_hit_age: int | None
    success_probability_pct: float
    prob_hit_target_by_retirement_pct: float
    safe_withdrawal_rate_pct: float | None
    realized_mean_return_pct: float | None
    realized_std_dev_pct: float | None
    summary_text: str
    # Server-side simulation timestamp — drives the SyncFreshnessChip on
    # the FIRE panel. Populated at response time, not cached.
    generated_at: datetime | None = None
    # Sprint 28 — true when the user's actual starting balance was
    # negative (e.g. credit-card debt > liquid assets) and we clamped
    # it to $0 before running the Monte Carlo simulation. Negative
    # starting balances can't compound forward in any meaningful way;
    # this flag lets the UI surface a "starting from $0 because your
    # net worth is currently negative" note instead of silently
    # misleading the user.
    starting_was_clamped: bool = False
    requested_starting_cents: int = 0


class FireDefaults(BaseModel):
    """Auto-derived starting values for the sliders."""
    starting_cents: int
    monthly_savings_cents: int
    annual_spending_cents: int
    derived_from: dict  # debug provenance for the UI to expose


# -- Helpers ----------------------------------------------------------


def _derive_starting_cents(db: Session) -> int:
    """Sum of current_balance_cents across active accounts.

    Same calc that NetWorthPanel renders. Liabilities are sign-flipped
    in current_balance_cents already, so this is a straight sum.
    """
    rows = db.execute(
        select(func.coalesce(func.sum(Account.current_balance_cents), 0))
        .where(Account.is_active.is_(True))
    ).scalar_one()
    return int(rows or 0)


def _derive_annual_spending_cents(db: Session) -> int:
    """Estimate last-12-month total outflow.

    Outflow = sum of negative-amount transactions over the last 365 days.
    Returns the absolute value (always positive). Excludes income/refund
    categories implicitly because those have positive amounts.

    If the user has under 90 days of history we return a conservative
    placeholder (60_000 cents = $600/mo × 12 = $7200/yr) so the slider
    has somewhere reasonable to start.
    """
    cutoff = date.today() - timedelta(days=365)
    earliest = db.execute(
        select(func.min(Transaction.posted_date))
    ).scalar_one()
    if earliest is None:
        return 7_200_00  # $7,200 floor when there's no history at all
    days_of_history = (date.today() - earliest).days
    if days_of_history < 90:
        return 7_200_00

    # Sum absolute outflow over last 365 days. Use abs(amount_cents)
    # filtered to negative rows so we don't accidentally subtract income.
    total_outflow = db.execute(
        select(
            func.coalesce(
                func.sum(func.abs(Transaction.amount_cents)),
                0,
            )
        )
        .where(
            Transaction.amount_cents < 0,
            Transaction.posted_date >= cutoff,
        )
    ).scalar_one()

    # Annualize if we have less than a year of data.
    days_in_window = min(days_of_history, 365)
    if days_in_window <= 0:
        return 7_200_00
    annualized = int((int(total_outflow or 0) * 365) / days_in_window)
    # Floor at $600/yr so a tiny dataset doesn't break the math.
    return max(annualized, 600_00)


def _derive_monthly_savings_cents(db: Session) -> int:
    """Estimate the user's real monthly net flow (income - spending).

    Anchored on the same canonical figures the Budgets projection uses
    (``monthly_financials``), so FIRE and the projection agree on what
    the user is actually saving each month:

      * income  = the 90-day recurring (Livio payroll) average — the
        dependable baseline, the same field the projector consumes;
      * outflow = the 90-day "real" outflow (catchall transfers,
        savings sweeps and user-flagged one-time spikes excluded).

    The result is SIGNED and intentionally allowed to be negative. If
    the user is currently spending more than they earn, FIRE must show
    that deficit honestly rather than clamping it to $0 and reading
    rosier than the Budgets panel. (Sprint 28 applied the same honesty
    fix to a negative starting balance; this is Finding D, audit
    2026-05-20.)

    The old version summed every transaction over 180 days with no
    account anchoring — a self-transfer into savings counted as a loss,
    which is exactly the cross-panel drift the unified-Chase-basis rule
    exists to kill.
    """
    from finance_app.budgets.monthly_financials import (
        compute_month_income,
        compute_trailing_real_outflow,
    )

    today = date.today()
    month_start = date(today.year, today.month, 1)
    income = compute_month_income(db, month_start).recurring_avg_cents
    outflow = compute_trailing_real_outflow(db)
    return income - outflow


# -- Endpoints --------------------------------------------------------


@router.get("/defaults", response_model=FireDefaults)
def get_defaults(db: Session = Depends(get_db)) -> FireDefaults:
    """Auto-derived starting points for the simulator sliders.

    Frontend calls this on first mount, then lets the user adjust.
    """
    starting = _derive_starting_cents(db)
    spending = _derive_annual_spending_cents(db)
    savings = _derive_monthly_savings_cents(db)
    return FireDefaults(
        starting_cents=starting,
        monthly_savings_cents=savings,
        annual_spending_cents=spending,
        derived_from={
            "starting": "sum(current_balance_cents) across active accounts",
            "spending": "abs(outflow) last 365d, annualized",
            "savings": "90-day recurring income - real outflow (signed; may be negative)",
        },
    )


@router.get("/projection", response_model=FireProjectionOut)
def get_projection(
    current_age: int = Query(..., ge=18, le=99),
    target_retirement_age: int = Query(..., ge=19, le=99),
    end_age: int = 95,
    # Sprint 28 — accept negative starting_cents. Real users with more
    # credit-card debt than liquid assets have a negative net worth
    # (Chris's case today: -$1,065.54). Rejecting that with a raw 422
    # blob — which is what `ge=0` produced — turned the panel into a
    # JSON error wall. We now accept negative values and clamp to 0
    # before simulation (see clamp logic below); the response carries
    # ``starting_was_clamped`` so the UI can show a friendly note.
    starting_cents: int = Query(0),
    # Accept a NEGATIVE monthly savings rate. If the user currently
    # spends more than they earn, FIRE must project that deficit
    # honestly — the simulator handles negative contributions (a balance
    # that reaches $0 stays $0). The old `ge=0` clamp made FIRE read
    # rosier than the Budgets panel; see Finding D, audit 2026-05-20.
    monthly_savings_cents: int = Query(0),
    annual_spending_cents: int = Query(0, ge=0),
    mean_return_pct: float = 5.0,
    std_dev_pct: float = 15.0,
    # Floor at 100 (the simulator's own minimum). Pinned-start-year
    # historical runs only need ~200 trials because they're
    # deterministic — every trial walks the same return path, so
    # we'd just be re-simulating the identical scenario.
    n_trials: int = Query(5_000, ge=100, le=50_000),
    seed: int | None = None,
    simulation_mode: str = "normal",
    historical_start_year: int | None = None,
) -> FireProjectionOut:
    """Run a Monte Carlo simulation with the given inputs.

    Lower default n_trials than the simulator's library default (10k)
    because this is interactive — the user moves a slider and we need
    to respond fast. 5,000 trials are still tight enough for stable
    percentile bands. The frontend can request more if it wants
    higher-fidelity headline numbers.
    """
    # Sprint 28 — clamp negative starting balances to 0 BEFORE building
    # the FireInputs dataclass. The simulator's own validation rejects
    # negatives (correctly — you can't compound a negative balance with
    # market returns), but we still want the rest of the panel to work
    # so the user can move sliders, see "if you start with $X" math,
    # and not stare at a JSON 422.
    requested_starting_cents = starting_cents
    starting_was_clamped = starting_cents < 0
    effective_starting_cents = max(0, starting_cents)

    try:
        inputs = FireInputs(
            current_age=current_age,
            target_retirement_age=target_retirement_age,
            end_age=end_age,
            starting_cents=effective_starting_cents,
            monthly_savings_cents=monthly_savings_cents,
            annual_spending_cents=annual_spending_cents,
            mean_return_pct=mean_return_pct,
            std_dev_pct=std_dev_pct,
            n_trials=n_trials,
            seed=seed,
            simulation_mode=simulation_mode,
            historical_start_year=historical_start_year,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    proj: _FireProjection = simulate(inputs)

    return FireProjectionOut(
        inputs=FireInputsOut(
            current_age=proj.inputs.current_age,
            target_retirement_age=proj.inputs.target_retirement_age,
            end_age=proj.inputs.end_age,
            starting_cents=proj.inputs.starting_cents,
            monthly_savings_cents=proj.inputs.monthly_savings_cents,
            annual_spending_cents=proj.inputs.annual_spending_cents,
            mean_return_pct=proj.inputs.mean_return_pct,
            std_dev_pct=proj.inputs.std_dev_pct,
            n_trials=proj.inputs.n_trials,
            simulation_mode=proj.inputs.simulation_mode,
            historical_start_year=proj.inputs.historical_start_year,
        ),
        fire_number_cents=proj.fire_number_cents,
        years=[
            FireYearOut(
                age=y.age,
                p10_cents=y.p10_cents,
                p25_cents=y.p25_cents,
                p50_cents=y.p50_cents,
                p75_cents=y.p75_cents,
                p90_cents=y.p90_cents,
            )
            for y in proj.years
        ],
        median_hit_age=proj.median_hit_age,
        p25_hit_age=proj.p25_hit_age,
        p75_hit_age=proj.p75_hit_age,
        success_probability_pct=proj.success_probability_pct,
        prob_hit_target_by_retirement_pct=proj.prob_hit_target_by_retirement_pct,
        safe_withdrawal_rate_pct=proj.safe_withdrawal_rate_pct,
        realized_mean_return_pct=proj.realized_mean_return_pct,
        realized_std_dev_pct=proj.realized_std_dev_pct,
        summary_text=proj.summary_text,
        generated_at=datetime.utcnow(),
        starting_was_clamped=starting_was_clamped,
        requested_starting_cents=requested_starting_cents,
    )
