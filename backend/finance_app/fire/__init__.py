"""FIRE / retirement Monte Carlo simulator.

Models the question "given your current net worth + savings rate +
return assumptions, where does your portfolio land each year, and
what's the probability you can stop working at age N?"

Approach: Monte Carlo with a configurable number of trials. Each trial
simulates year-by-year balance evolution under either:

  - **normal mode** — returns drawn IID from Gaussian(mean, std_dev).
    Fast, easy to reason about. Underestimates path-dependence
    (sequence-of-returns risk) because each year is independent.
  - **historical mode** — bootstrap a contiguous slice from real
    S&P-500 real-return history. Preserves the autocorrelation
    structure (a bad year is often followed by a recovery; long
    booms exist). This is the model that surfaces sequence-of-
    returns risk: retiring into 1973-1974 is genuinely worse than
    retiring into 1995-1996 even if average returns over the
    period match.

Two simulation phases regardless of mode:

  - **Accumulation** (current_age → retirement_age): balance grows by
    return draw and gets monthly_savings*12 added.
  - **Drawdown** (retirement_age → end_age): balance still gets the
    return draw but loses annual_spending each year.

The FIRE number is computed via the 4% rule (annual_spending × 25).
The "you ran out of money" floor clips negative balances at 0 — we
report what fraction of trials avoided that fate as the success
probability.

Returns are interpreted as REAL (post-inflation), so dollar amounts
in inputs and outputs are in today's purchasing power. Default
mean_return_pct=5.0 reflects ~ historical S&P 500 real return; default
std_dev_pct=15.0 reflects ~ historical S&P 500 volatility.

No numpy: pure-Python loops. ~1M operations for 10K trials × 60 years
runs in ~0.5s on a laptop, which is fine for an interactive endpoint.
"""
from __future__ import annotations

import random
import statistics
from dataclasses import dataclass, field


# Historical S&P 500 real annual returns (nominal minus CPI), 1928-2023.
# Source: Aswath Damodaran's NYU dataset, rounded to 4 decimals. Real
# returns matter for FIRE math because we want to compare future
# purchasing power to today's spending — nominal returns are noisier
# and inflation-dependent. Mean ≈ 0.067 (6.7% real), std ≈ 0.18.
#
# Used by simulation_mode="historical" — each trial picks a random
# contiguous slice of length n_years (with wraparound) from this list.
_SP500_REAL_RETURNS: tuple[float, ...] = (
    0.4377, -0.0830, -0.2748, -0.4716, -0.0744,  # 1928-32
     0.4694,  0.0166,  0.4760,  0.3207, -0.3501,  # 1933-37
     0.2926, -0.0178, -0.0938, -0.1774, -0.0822,  # 1938-42
     0.2273,  0.1928,  0.3081, -0.0834,  0.0276,  # 1943-47
     0.0419,  0.1961,  0.2953,  0.1574,  0.1842,  # 1948-52
    -0.0186,  0.5279,  0.3098,  0.0599, -0.1265,  # 1953-57
     0.4117,  0.1014, -0.0229,  0.2521, -0.1199,  # 1958-62
     0.1823,  0.1411,  0.0907, -0.1382,  0.1786,  # 1963-67
     0.0734, -0.1432, -0.0142,  0.0911,  0.1481,  # 1968-72
    -0.2238, -0.3552,  0.2701,  0.1727,  0.0136,  # 1973-77
    -0.0166, -0.0107,  0.1944, -0.1293,  0.1531,  # 1978-82
     0.1734,  0.0156,  0.2724,  0.1620, -0.0119,  # 1983-87
     0.1186,  0.2632, -0.1098,  0.2627,  0.0507,  # 1988-92
     0.0726, -0.0141,  0.3408,  0.1924,  0.2778,  # 1993-97
     0.2495,  0.1627, -0.1196, -0.1430, -0.2469,  # 1998-2002
     0.2622,  0.0747,  0.0142,  0.1273,  0.0240,  # 2003-07
    -0.3690,  0.1979,  0.1325,  0.0211,  0.1394,  # 2008-12
     0.2961,  0.1218,  0.0024,  0.1133,  0.1745,  # 2013-17
    -0.0625,  0.2937,  0.1559,  0.2104, -0.1939,  # 2018-22
     0.2196,                                      # 2023
)


def _historical_mean_return() -> float:
    """Mean of the embedded S&P real-return series. Used as the
    "informational" mean shown to the UI when the user picks
    historical mode (so they don't see a stale 5% default)."""
    return statistics.fmean(_SP500_REAL_RETURNS)


def _historical_std() -> float:
    return statistics.stdev(_SP500_REAL_RETURNS)


_HISTORICAL_FIRST_YEAR = 1928  # corresponds to _SP500_REAL_RETURNS[0]


def _draw_historical_path(
    n_years: int,
    rng: random.Random,
    pinned_year: int | None = None,
) -> list[float]:
    """Sample a contiguous block of length n_years from the historical
    series, with wraparound. Preserves real-world year-to-year
    autocorrelation (a recession year often followed by recovery).

    When ``pinned_year`` is provided, EVERY trial starts at that year
    (collapsing the Monte Carlo to a deterministic walk). Useful for
    "what if I retired into 1973?" stress tests — sequence-of-returns
    risk in its purest form. The percentile bands collapse to a single
    line in this mode, which is the point.
    """
    src = _SP500_REAL_RETURNS
    n_src = len(src)
    if pinned_year is not None:
        start = max(0, min(n_src - 1, pinned_year - _HISTORICAL_FIRST_YEAR))
    else:
        start = rng.randrange(n_src)
    return [src[(start + i) % n_src] for i in range(n_years)]


@dataclass
class FireInputs:
    """All assumptions feeding the simulator. Cents-denominated where applicable."""

    current_age: int
    target_retirement_age: int
    end_age: int = 95
    starting_cents: int = 0
    monthly_savings_cents: int = 0
    annual_spending_cents: int = 0  # FIRE number = this × 25; also the drawdown rate
    mean_return_pct: float = 5.0    # real (post-inflation); ignored in historical mode
    std_dev_pct: float = 15.0       # ignored in historical mode
    n_trials: int = 10_000
    seed: int | None = None
    # "normal" — IID Gaussian draws (the original model). Fast, no
    # sequence-of-returns risk modeled.
    # "historical" — bootstrap from S&P 500 real-return history.
    # Slower and ignores mean_return_pct/std_dev_pct, but captures
    # path-dependence: retiring into 1973-1974 looks genuinely
    # different from retiring into 1995-1996.
    simulation_mode: str = "normal"
    # Optional: pin the starting year for historical mode. When set,
    # every trial starts at the same year — useful for retirement-into-
    # 1973 / 2000 / 1987 stress scenarios. Ignored in "normal" mode.
    historical_start_year: int | None = None

    def __post_init__(self) -> None:
        if self.target_retirement_age < self.current_age:
            raise ValueError("target_retirement_age must be ≥ current_age")
        if self.end_age <= self.target_retirement_age:
            raise ValueError("end_age must be > target_retirement_age")
        if self.n_trials < 100:
            # Below 100 trials, percentiles are too noisy to mean anything.
            raise ValueError("n_trials must be ≥ 100")
        if self.simulation_mode not in {"normal", "historical"}:
            raise ValueError(
                f"simulation_mode must be 'normal' or 'historical', got {self.simulation_mode!r}"
            )
        if self.historical_start_year is not None:
            last_year = _HISTORICAL_FIRST_YEAR + len(_SP500_REAL_RETURNS) - 1
            if not (_HISTORICAL_FIRST_YEAR <= self.historical_start_year <= last_year):
                raise ValueError(
                    f"historical_start_year must be in [{_HISTORICAL_FIRST_YEAR}, {last_year}]"
                )


@dataclass
class FireYearProjection:
    """Percentile distribution of portfolio value at one age."""
    age: int
    p10_cents: int
    p25_cents: int
    p50_cents: int
    p75_cents: int
    p90_cents: int


@dataclass
class FireProjection:
    """Full simulator output."""
    inputs: FireInputs
    fire_number_cents: int
    years: list[FireYearProjection] = field(default_factory=list)

    # Headline numbers — null/None when not applicable.
    median_hit_age: int | None = None       # first age where p50 ≥ fire_number
    p25_hit_age: int | None = None          # conservative — pessimistic 25th %ile
    p75_hit_age: int | None = None          # optimistic — top 25th %ile
    success_probability_pct: float = 0.0    # % trials with balance > 0 at end_age
    prob_hit_target_by_retirement_pct: float = 0.0  # % trials at fire_number by retirement
    # Safe withdrawal rate: highest fixed annual withdrawal (as % of
    # portfolio at retirement) that ≥95% of trials survive to end_age.
    # Computed by binary-search on a frozen snapshot of the trial paths
    # at retirement age. Only meaningful when there's a drawdown phase
    # (i.e. retirement_age < end_age).
    safe_withdrawal_rate_pct: float | None = None
    # Informational: mean & std of returns actually realized in the
    # simulation. Useful when historical mode is in play and the user
    # is wondering "what was the effective mean?"
    realized_mean_return_pct: float | None = None
    realized_std_dev_pct: float | None = None
    summary_text: str = ""


def _percentile(sorted_vals: list[int], pct: float) -> int:
    """Linear-interp percentile. ``sorted_vals`` must already be sorted asc."""
    if not sorted_vals:
        return 0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    # Numpy-style linear interpolation. Index = pct/100 * (n-1).
    idx = (pct / 100.0) * (len(sorted_vals) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = idx - lo
    return int(sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac)


def simulate(inputs: FireInputs) -> FireProjection:
    """Run the Monte Carlo and return per-year percentile bands.

    Pure-Python implementation. For 10K trials × 60 years, runs in
    ~0.5s on a modern laptop. The hot loop is intentionally flat (no
    function calls in the inner step) so CPython's interpreter
    overhead doesn't dominate.
    """
    rng = random.Random(inputs.seed) if inputs.seed is not None else random.Random()

    fire_number = inputs.annual_spending_cents * 25  # 4% rule

    n_years = inputs.end_age - inputs.current_age + 1
    # balances[year_idx][trial_idx] — column-major would be faster but
    # row-major is simpler and the operation we do most (sort one
    # year's column to compute percentiles) is the same cost either way.
    # Use a flat list-of-lists; pre-allocate rows to avoid re-grow.
    per_year_balances: list[list[int]] = [
        [0] * inputs.n_trials for _ in range(n_years)
    ]

    annual_savings = inputs.monthly_savings_cents * 12
    mean_return = inputs.mean_return_pct / 100.0
    std_dev = inputs.std_dev_pct / 100.0
    retirement_age = inputs.target_retirement_age
    annual_spending = inputs.annual_spending_cents
    is_historical = inputs.simulation_mode == "historical"

    success_count = 0
    hit_target_count = 0
    # Snapshot of each trial's balance at retirement_age — needed for
    # the safe-withdrawal-rate post-process. We also keep the full
    # return path of each trial so SWR can re-simulate the drawdown
    # phase under different withdrawal rates without re-rolling RNG.
    retirement_idx = retirement_age - inputs.current_age
    drawdown_returns_per_trial: list[list[float]] = []
    retirement_balance_per_trial: list[int] = []
    # Aggregate realized-return stats for reporting back to UI.
    return_sum = 0.0
    return_sq_sum = 0.0
    return_n = 0

    for trial in range(inputs.n_trials):
        balance = inputs.starting_cents
        # Pre-draw the return path for this trial so historical mode
        # samples a single contiguous block (vs. one IID sample per year).
        if is_historical:
            return_path = _draw_historical_path(
                n_years, rng, pinned_year=inputs.historical_start_year
            )
        else:
            return_path = [rng.gauss(mean_return, std_dev) for _ in range(n_years)]

        for year_idx in range(n_years):
            age = inputs.current_age + year_idx
            ret = return_path[year_idx]
            return_sum += ret
            return_sq_sum += ret * ret
            return_n += 1
            balance = int(balance * (1.0 + ret))
            if age < retirement_age:
                balance += annual_savings
            else:
                balance -= annual_spending
            if balance < 0:
                balance = 0
            per_year_balances[year_idx][trial] = balance
            if age == retirement_age and balance >= fire_number:
                hit_target_count += 1
        if balance > 0:
            success_count += 1
        # Stash data for SWR computation: balance at retirement, and
        # the post-retirement return path (used to re-run drawdown
        # phase under different withdrawal rates).
        retirement_balance_per_trial.append(per_year_balances[retirement_idx][trial])
        drawdown_returns_per_trial.append(return_path[retirement_idx + 1:])

    # Compute percentile bands per year. Sort once per year, then
    # extract the five percentiles we care about.
    years_out: list[FireYearProjection] = []
    median_hit_age: int | None = None
    p25_hit_age: int | None = None
    p75_hit_age: int | None = None
    for year_idx, col in enumerate(per_year_balances):
        col.sort()
        age = inputs.current_age + year_idx
        p10 = _percentile(col, 10)
        p25 = _percentile(col, 25)
        p50 = _percentile(col, 50)
        p75 = _percentile(col, 75)
        p90 = _percentile(col, 90)
        years_out.append(
            FireYearProjection(
                age=age,
                p10_cents=p10,
                p25_cents=p25,
                p50_cents=p50,
                p75_cents=p75,
                p90_cents=p90,
            )
        )
        # Track first crossing of FIRE number for each percentile track.
        if median_hit_age is None and p50 >= fire_number:
            median_hit_age = age
        if p25_hit_age is None and p25 >= fire_number:
            p25_hit_age = age
        if p75_hit_age is None and p75 >= fire_number:
            p75_hit_age = age

    success_prob = 100.0 * success_count / inputs.n_trials
    target_prob = 100.0 * hit_target_count / inputs.n_trials

    # Safe withdrawal rate — find the highest withdrawal rate where
    # ≥95% of trials still have money at end_age. Binary search over
    # rates in 0.5% increments for speed; re-simulate drawdown phase
    # using the stashed return paths for each trial.
    swr_pct: float | None = None
    if retirement_age < inputs.end_age and retirement_balance_per_trial:
        swr_pct = _solve_safe_withdrawal_rate(
            retirement_balances=retirement_balance_per_trial,
            drawdown_returns=drawdown_returns_per_trial,
            target_survival_pct=95.0,
        )

    realized_mean = (return_sum / return_n) * 100.0 if return_n else None
    if return_n > 1:
        var = (return_sq_sum / return_n) - (return_sum / return_n) ** 2
        realized_std = (max(var, 0.0) ** 0.5) * 100.0
    else:
        realized_std = None

    summary = _summary_text(
        fire_number_cents=fire_number,
        median_hit_age=median_hit_age,
        retirement_age=retirement_age,
        target_prob=target_prob,
        success_prob=success_prob,
        years=years_out,
        swr_pct=swr_pct,
        mode=inputs.simulation_mode,
    )

    return FireProjection(
        inputs=inputs,
        fire_number_cents=fire_number,
        years=years_out,
        median_hit_age=median_hit_age,
        p25_hit_age=p25_hit_age,
        p75_hit_age=p75_hit_age,
        success_probability_pct=round(success_prob, 1),
        prob_hit_target_by_retirement_pct=round(target_prob, 1),
        safe_withdrawal_rate_pct=(
            round(swr_pct, 2) if swr_pct is not None else None
        ),
        realized_mean_return_pct=(
            round(realized_mean, 2) if realized_mean is not None else None
        ),
        realized_std_dev_pct=(
            round(realized_std, 2) if realized_std is not None else None
        ),
        summary_text=summary,
    )


def _solve_safe_withdrawal_rate(
    retirement_balances: list[int],
    drawdown_returns: list[list[float]],
    target_survival_pct: float = 95.0,
    rate_min_pct: float = 1.0,
    rate_max_pct: float = 10.0,
    step_pct: float = 0.25,
) -> float | None:
    """Find the highest withdrawal rate (% of retirement balance per year)
    that ≥ ``target_survival_pct``% of trials survive to end-of-drawdown.

    Re-simulates the drawdown phase under each candidate rate using the
    pre-stashed return paths — no fresh RNG, so results are deterministic
    given the same Monte Carlo run.

    Returns the rate as a percent (e.g. 4.25 means 4.25%/yr). Linear
    sweep in 0.25% steps from rate_min to rate_max — that's coarse but
    matches industry convention (Trinity Study reports SWR in 0.5%
    increments anyway). Returns None if NO rate in the range achieves
    target survival.
    """
    n_trials = len(retirement_balances)
    if n_trials == 0:
        return None

    # Sweep from highest rate down — first rate that survives is the SWR.
    rate = rate_max_pct
    best: float | None = None
    while rate >= rate_min_pct:
        survive = 0
        rate_frac = rate / 100.0
        for trial_idx in range(n_trials):
            start_bal = retirement_balances[trial_idx]
            withdraw = start_bal * rate_frac
            balance = float(start_bal)
            for ret in drawdown_returns[trial_idx]:
                balance = balance * (1.0 + ret) - withdraw
                if balance <= 0:
                    balance = 0.0
                    break
            if balance > 0:
                survive += 1
        survival_pct = 100.0 * survive / n_trials
        if survival_pct >= target_survival_pct:
            best = rate
            break
        rate -= step_pct
    return best


def _summary_text(
    fire_number_cents: int,
    median_hit_age: int | None,
    retirement_age: int,
    target_prob: float,
    success_prob: float,
    years: list[FireYearProjection],
    swr_pct: float | None = None,
    mode: str = "normal",
) -> str:
    """Compose a 1–3 sentence headline summarizing the trajectory.

    Tone: factual, no cheerleading. The numbers speak for themselves.
    """
    fire_dollars = fire_number_cents / 100
    bits: list[str] = []
    if median_hit_age is not None:
        if median_hit_age <= retirement_age:
            bits.append(
                f"On the median path, you hit your ${fire_dollars:,.0f} "
                f"FIRE number at age {median_hit_age} — "
                f"{retirement_age - median_hit_age} years before your target."
            )
        else:
            bits.append(
                f"On the median path, you hit your ${fire_dollars:,.0f} "
                f"FIRE number at age {median_hit_age}, "
                f"{median_hit_age - retirement_age} years past your target."
            )
    else:
        end_p50 = years[-1].p50_cents / 100 if years else 0
        bits.append(
            f"The median path doesn't reach ${fire_dollars:,.0f} by age "
            f"{years[-1].age if years else '?'} (ends near ${end_p50:,.0f}). "
            f"Increase savings, push retirement, or accept lower spending."
        )
    bits.append(
        f"{target_prob:.0f}% of trials hit the target by retirement; "
        f"{success_prob:.0f}% still have money at age {years[-1].age if years else '?'}."
    )
    if swr_pct is not None:
        bits.append(
            f"95%-survival safe withdrawal rate ≈ {swr_pct:.2f}%/yr."
        )
    if mode == "historical":
        bits.append(
            "Using historical S&P 500 sequence sampling — sequence-of-returns "
            "risk is modeled (vs. IID Gaussian)."
        )
    return " ".join(bits)


# Re-export the public surface so callers can do
# ``from finance_app.fire import simulate, FireInputs``.
__all__ = [
    "FireInputs",
    "FireProjection",
    "FireYearProjection",
    "simulate",
]
