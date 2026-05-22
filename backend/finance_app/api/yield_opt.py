"""HYSA / T-bill yield-arbitrage suggester — Phase 8.4.

Most personal-finance apps surface "you have $X in checking" without
the obvious follow-up: "and you're earning $0 on it while a HYSA
would earn $Y/yr." This endpoint computes that delta directly and
suggests specific products.

Rate environment
----------------
Rates change weekly. We have two sources for "fresh" numbers:

  * The hardcoded ``_HYSA_OPTIONS`` / ``_TBILL_OPTIONS`` below — kept
    intentionally conservative and updated by hand when rates move.
  * A live snapshot from FRED / Treasury.gov via :mod:`yield_rates`
    refreshed daily by the scheduler. When present, we PATCH the
    T-bill APYs in the constants table with the live values so the
    user sees today's number, not a 6-month-old hardcoded one.

The HYSA list stays hardcoded — competitive HYSA rates come from
individual banks' marketing copy and don't have a clean public feed.
The Treasury yield is the closest fair benchmark, and we surface it
via ``hysa_top_apy_estimate`` on the live snapshot.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Account, AccountType
from finance_app.db.session import get_db
from finance_app.networth.service import _latest_balance_per_account


router = APIRouter(prefix="/yield-opt", tags=["yield-optimization"])


# Conservative reference rates as of 2026-04-27. Edit when rates move
# materially; we'd rather under-promise than over.
class _RateProduct(BaseModel):
    name: str
    apy_pct: float
    minimum_cents: int
    fdic_insured: bool
    notes: str
    open_url: str


_HYSA_OPTIONS: list[_RateProduct] = [
    _RateProduct(
        name="Marcus by Goldman Sachs",
        apy_pct=4.40,
        minimum_cents=0,
        fdic_insured=True,
        notes="$0 minimum, no fees, easy ACH transfers, no debit card.",
        open_url="https://www.marcus.com/us/en/savings",
    ),
    _RateProduct(
        name="Ally Bank Online Savings",
        apy_pct=4.35,
        minimum_cents=0,
        fdic_insured=True,
        notes="$0 minimum, can hold buckets for goal-style sub-saving inside one account.",
        open_url="https://www.ally.com/bank/online-savings-account/",
    ),
    _RateProduct(
        name="CIT Bank Platinum Savings",
        apy_pct=4.55,
        minimum_cents=500_000,  # $5,000 minimum for top tier
        fdic_insured=True,
        notes="$5,000 minimum for the top APY tier; below that, rate drops to ~0.25%.",
        open_url="https://www.bankoncit.com/Platinum-Savings",
    ),
    _RateProduct(
        name="Discover Online Savings",
        apy_pct=4.25,
        minimum_cents=0,
        fdic_insured=True,
        notes="$0 minimum, no fees, links to Discover It cashback rewards.",
        open_url="https://www.discover.com/online-banking/savings-account/",
    ),
]

_TBILL_OPTIONS: list[_RateProduct] = [
    _RateProduct(
        name="4-week Treasury Bill",
        apy_pct=4.55,
        minimum_cents=10_000,  # $100 minimum at TreasuryDirect
        fdic_insured=False,
        notes="State income-tax exempt. Rolls over weekly; effectively a HYSA you control.",
        open_url="https://www.treasurydirect.gov/savings-bonds/buy/",
    ),
    _RateProduct(
        name="13-week Treasury Bill",
        apy_pct=4.65,
        minimum_cents=10_000,
        fdic_insured=False,
        notes="State income-tax exempt. Better yield than 4w; locks for 13 weeks.",
        open_url="https://www.treasurydirect.gov/savings-bonds/buy/",
    ),
    _RateProduct(
        name="6-month Treasury Bill",
        apy_pct=4.70,
        minimum_cents=10_000,
        fdic_insured=False,
        notes="State income-tax exempt. Best yield for cash you don't touch for 6mo.",
        open_url="https://www.treasurydirect.gov/savings-bonds/buy/",
    ),
]

# Conservative yield baseline for a Big-4 bank checking account (Chase /
# BofA / Wells / Citi). Real rates are 0.01-0.05%. Round to 0.01%
# because that's the median user experience.
_BASELINE_CHECKING_APY_PCT = 0.01


# Liquid asset types we'll evaluate for arbitrage.
_LIQUID_TYPES = {AccountType.checking, AccountType.savings, AccountType.cash}


class _AccountAnalysis(BaseModel):
    account_id: int
    account_name: str
    balance_cents: int
    current_apy_pct: float
    current_yearly_earnings_cents: int


class YieldArbProductOut(BaseModel):
    name: str
    apy_pct: float
    minimum_cents: int
    fdic_insured: bool
    notes: str
    open_url: str
    yearly_earnings_at_balance_cents: int
    delta_vs_current_cents: int


class YieldArbAccountOut(BaseModel):
    account: _AccountAnalysis
    hysa_alternatives: list[YieldArbProductOut]
    tbill_alternatives: list[YieldArbProductOut]
    best_alternative_name: str | None
    best_yearly_delta_cents: int
    qualifies_for_arb: bool  # True if balance > $1k AND delta > $20/yr


class YieldArbReportOut(BaseModel):
    as_of: date
    accounts: list[YieldArbAccountOut]
    total_idle_balance_cents: int
    total_yearly_potential_delta_cents: int
    summary_text: str


def _patched_tbill_options() -> list[_RateProduct]:
    """Apply the live FRED/Treasury yield snapshot to the hardcoded
    T-bill list. Falls through to the hardcoded values when the
    snapshot is missing or stale.

    Constructs a fresh list every call so each request reflects the
    most-recently-cached snapshot (the cache file is rewritten daily
    by the scheduler).
    """
    # Lazy + defensive import — yield_rates is a new module and we don't
    # want any import or runtime error there to 500 the whole panel.
    try:
        from finance_app.yield_rates import cached_rates
        snap = cached_rates()
    except Exception:  # noqa: BLE001
        snap = None
    if snap is None:
        return _TBILL_OPTIONS
    # Map our 3 hardcoded T-bill durations to the FRED series.
    field_by_index = ["tbill_4wk_apy", "tbill_13wk_apy", "tbill_26wk_apy"]
    out: list[_RateProduct] = []
    for hardcoded, field in zip(_TBILL_OPTIONS, field_by_index):
        live_apy = getattr(snap, field, None)
        if live_apy is None or live_apy <= 0:
            out.append(hardcoded)
            continue
        notes = (
            f"{hardcoded.notes} Live yield via {snap.source} "
            f"(fetched {snap.fetched_at[:10]})."
        )
        out.append(
            _RateProduct(
                name=hardcoded.name,
                apy_pct=round(live_apy, 2),
                minimum_cents=hardcoded.minimum_cents,
                fdic_insured=hardcoded.fdic_insured,
                notes=notes,
                open_url=hardcoded.open_url,
            )
        )
    return out


@router.get("/report", response_model=YieldArbReportOut)
def get_report(db: Session = Depends(get_db)) -> YieldArbReportOut:
    """Per-account yield-arbitrage analysis: how much money you're
    leaving on the table by holding cash in low-yield accounts."""
    cards = list(
        db.execute(
            select(Account).where(Account.account_type.in_(_LIQUID_TYPES))
        ).scalars().all()
    )
    latest = _latest_balance_per_account(db)
    # Live T-bill rates if we have a fresh snapshot — else hardcoded.
    tbill_options = _patched_tbill_options()

    out_accounts: list[YieldArbAccountOut] = []
    total_balance = 0
    total_delta = 0

    for c in cards:
        bal = latest.get(c.id, c.current_balance_cents or 0)
        if bal is None or bal <= 0:
            continue
        # Heuristic: if it's labeled "savings", assume the user picked
        # a HYSA and use a higher baseline. Otherwise assume mega-bank
        # checking at 0.01%.
        if c.account_type == AccountType.savings:
            current_apy = 4.0  # generous default; tighten later if user logs actual
        else:
            current_apy = _BASELINE_CHECKING_APY_PCT

        current_earnings = int(bal * current_apy / 100)

        def _alts(options: list[_RateProduct]) -> list[YieldArbProductOut]:
            out: list[YieldArbProductOut] = []
            for o in options:
                if bal < o.minimum_cents:
                    continue
                yearly = int(bal * o.apy_pct / 100)
                out.append(
                    YieldArbProductOut(
                        name=o.name,
                        apy_pct=o.apy_pct,
                        minimum_cents=o.minimum_cents,
                        fdic_insured=o.fdic_insured,
                        notes=o.notes,
                        open_url=o.open_url,
                        yearly_earnings_at_balance_cents=yearly,
                        delta_vs_current_cents=yearly - current_earnings,
                    )
                )
            out.sort(key=lambda p: p.delta_vs_current_cents, reverse=True)
            return out

        hysa_alts = _alts(_HYSA_OPTIONS)
        tbill_alts = _alts(tbill_options)
        all_alts = sorted(
            hysa_alts + tbill_alts, key=lambda p: p.delta_vs_current_cents, reverse=True
        )
        best = all_alts[0] if all_alts else None
        delta = best.delta_vs_current_cents if best else 0
        # Qualify only if there's enough balance + delta to bother. <$20/yr
        # gain isn't worth the friction of opening an account.
        qualifies = bal >= 100_000 and delta >= 2_000

        out_accounts.append(
            YieldArbAccountOut(
                account=_AccountAnalysis(
                    account_id=c.id,
                    account_name=c.name,
                    balance_cents=bal,
                    current_apy_pct=current_apy,
                    current_yearly_earnings_cents=current_earnings,
                ),
                hysa_alternatives=hysa_alts,
                tbill_alternatives=tbill_alts,
                best_alternative_name=best.name if best else None,
                best_yearly_delta_cents=delta,
                qualifies_for_arb=qualifies,
            )
        )
        total_balance += bal
        if qualifies:
            total_delta += delta

    if total_delta > 0:
        summary_text = (
            f"You have ${total_balance/100:,.0f} in liquid accounts. "
            f"Moving idle cash to the highest-yield options would "
            f"earn ~${total_delta/100:,.0f}/yr more than your current "
            f"setup. Top pick: rolling cash into a HYSA or T-bill ladder "
            f"at the rates listed below."
        )
    else:
        summary_text = (
            f"Your ${total_balance/100:,.0f} in liquid accounts is "
            f"already earning at-or-near best-available rates, OR the "
            f"balances are too small for switching to be worth the "
            f"friction. No suggested action."
        )

    return YieldArbReportOut(
        as_of=date.today(),
        accounts=out_accounts,
        total_idle_balance_cents=total_balance,
        total_yearly_potential_delta_cents=total_delta,
        summary_text=summary_text,
    )
