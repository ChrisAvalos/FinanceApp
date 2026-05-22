"""Credit score history, utilization, and opportunity detection.

Why this module exists
----------------------
Chris's goal is to beat Rocket Money etc. on credit ops. Three capabilities:

1. Score tracking over time — manual entry now, Playwright-scraped later.
2. Utilization math per card + aggregate (what's reported vs. what's live).
3. Opportunity detection — CLI candidates, pre-close paydown suggestions.

Every opportunity returns BOTH the "if you act" projection AND the "if you
don't" projection, per Chris's explicit constraint. The app NEVER moves
money — these are recommendations for Chris to execute manually.

Score math caveats
------------------
Score deltas from utilization changes are estimates, not promises. FICO's
algorithm is proprietary and reacts non-linearly around the 30%, 10%, and
1% utilization cliffs. The heuristics below target those cliffs explicitly
and attach a confidence score; don't promote any projection above 0.8
confidence without real score observations to validate.
"""
from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.api.schemas import (
    CreditOpportunitiesResponse,
    CreditOpportunity,
    CreditScoreIn,
    CreditScoreOut,
    RewardsCategoryLeakageOut,
    RewardsLeakageResponse,
    RewardsTxnAnalysisOut,
    UtilizationResponse,
    UtilizationRow,
)
from finance_app.db.models import (
    Account,
    AccountType,
    CreditScoreSnapshot,
    Transaction,
)
from finance_app.db.session import get_db
from finance_app.scrapers.credit_scores.coordinator import (
    ScoreScrapeResult,
    scrape_and_persist,
)

router = APIRouter(prefix="/credit", tags=["credit"])


# ---------- Score history (manual entry for now) ----------

@router.get("/scores", response_model=list[CreditScoreOut])
def list_scores(
    limit: int = 50,
    db: Session = Depends(get_db),
) -> list[CreditScoreOut]:
    rows = db.execute(
        select(CreditScoreSnapshot)
        .order_by(CreditScoreSnapshot.as_of.desc())
        .limit(limit)
    ).scalars().all()
    return [CreditScoreOut.model_validate(r) for r in rows]


@router.post("/scores", response_model=CreditScoreOut)
def add_score(body: CreditScoreIn, db: Session = Depends(get_db)) -> CreditScoreOut:
    # Sanity: some scoring models can't exceed 850; keep permissive (900)
    # in the schema in case a bureau adds a new product, but log surprising values.
    snap = CreditScoreSnapshot(
        score=body.score,
        bureau=body.bureau,
        scoring_model=body.scoring_model,
        as_of=body.as_of,
        source=body.source,
        source_detail=body.source_detail,
        notes=body.notes,
    )
    db.add(snap)
    db.commit()
    db.refresh(snap)
    return CreditScoreOut.model_validate(snap)


@router.delete("/scores/{score_id}", status_code=204)
def delete_score(score_id: int, db: Session = Depends(get_db)) -> None:
    s = db.get(CreditScoreSnapshot, score_id)
    if s is None:
        raise HTTPException(404, f"Score {score_id} not found")
    db.delete(s)
    db.commit()


@router.post("/scores/scrape")
def scrape_scores(db: Session = Depends(get_db)) -> dict:
    """Run the Playwright credit-score scrapers for every configured portal.

    Returns a per-portal summary (rows seen / created / skipped / auth-missing)
    so the UI can show an "X needs login" badge when a session expires.
    Same-day re-runs are no-ops by virtue of the (bureau, scoring_model,
    as_of, source) natural-key dedupe in the persistence layer.

    The daily APScheduler job calls
    :func:`finance_app.scrapers.credit_scores.coordinator.run_daily_score_scrape`
    on the same schedule the legal-claims weekly scrape uses (different
    cadence — see :mod:`finance_app.scheduler`).
    """
    result: ScoreScrapeResult = scrape_and_persist(db)
    return {
        "started_at": result.started_at.isoformat(),
        "finished_at": result.finished_at.isoformat(),
        "summaries": [
            {
                "site_key": s.site_key,
                "name": s.name,
                "rows_seen": s.rows_seen,
                "rows_created": s.rows_created,
                "rows_skipped_existing": s.rows_skipped_existing,
                "auth_missing": s.auth_missing,
                "error": s.error,
            }
            for s in result.summaries
        ],
        "new_scores": result.new_scores,
        "total_new": len(result.new_scores),
    }


# ---------- Utilization ----------

def _next_close_date(close_day: int | None, today: date | None = None) -> date | None:
    """Concrete next statement-close date for a card, given its close day-of-month.

    Handles the day-of-month overflow (Feb has only 28 days) by capping at
    the last valid day of the relevant month — same convention the Account
    model documents.
    """
    if close_day is None:
        return None
    today = today or date.today()
    _, last_of_this_month = monthrange(today.year, today.month)
    effective_close_day = min(close_day, last_of_this_month)
    if today.day <= effective_close_day:
        return date(today.year, today.month, effective_close_day)
    # Close day has passed this month — compute for next month
    if today.month == 12:
        next_year, next_month = today.year + 1, 1
    else:
        next_year, next_month = today.year, today.month + 1
    _, last_of_next_month = monthrange(next_year, next_month)
    next_close = min(close_day, last_of_next_month)
    return date(next_year, next_month, next_close)


def _days_until_close(close_day: int | None, today: date | None = None) -> int | None:
    """Day-count to the next statement-close date. Backward-compat wrapper."""
    nc = _next_close_date(close_day, today)
    if nc is None:
        return None
    today = today or date.today()
    return (nc - today).days


def _load_credit_cards(db: Session) -> list[Account]:
    return db.execute(
        select(Account)
        .where(
            Account.account_type == AccountType.credit_card,
            Account.is_active.is_(True),
            Account.credit_limit_cents.isnot(None),
        )
        .order_by(Account.name)
    ).scalars().all()


@router.get("/utilization", response_model=UtilizationResponse)
def utilization(db: Session = Depends(get_db)) -> UtilizationResponse:
    cards = _load_credit_cards(db)

    rows: list[UtilizationRow] = []
    total_limit = 0
    # NB: this is the absolute amount owed across cards, not a signed
    # net-worth-style balance. The schema field is named
    # ``total_live_balance_cents`` but its consumers (UI util bars,
    # aggregate util %) treat it as a positive owed-amount.
    total_live_balance = 0
    total_reported_balance = 0
    for c in cards:
        limit = c.credit_limit_cents or 0
        # ``current_balance_cents`` is sign-flipped to negative for
        # liability accounts so net-worth math is just a sum across
        # accounts — but utilization is a positive ratio of amount
        # owed / credit limit. abs() the value here so a Chase card
        # with current_balance_cents=-115407 reports as 23.1% util,
        # not -23.1%. ``last_statement_balance_cents`` is stored as a
        # positive by ``sync_liabilities`` so no abs() needed there.
        live_signed = c.current_balance_cents or 0
        live = abs(live_signed)
        reported = c.last_statement_balance_cents or 0
        live_util = (live / limit * 100) if limit > 0 else None
        reported_util = (reported / limit * 100) if limit > 0 else None
        rows.append(
            UtilizationRow(
                account_id=c.id,
                account_name=c.name,
                credit_limit_cents=limit,
                # Pass the signed value through so the UI can render
                # the bar label however it wants. The util % above is
                # already the positive ratio.
                current_balance_cents=live_signed,
                last_statement_balance_cents=reported,
                reported_utilization_pct=round(reported_util, 1) if reported_util is not None else None,
                live_utilization_pct=round(live_util, 1) if live_util is not None else None,
                statement_close_day=c.statement_close_day,
                statement_due_day=c.statement_due_day,
                days_until_close=_days_until_close(c.statement_close_day),
            )
        )
        total_limit += limit
        total_live_balance += live
        total_reported_balance += reported

    agg_reported = (total_reported_balance / total_limit * 100) if total_limit > 0 else None
    agg_live = (total_live_balance / total_limit * 100) if total_limit > 0 else None

    return UtilizationResponse(
        aggregate_reported_utilization_pct=round(agg_reported, 1) if agg_reported is not None else None,
        aggregate_live_utilization_pct=round(agg_live, 1) if agg_live is not None else None,
        total_limit_cents=total_limit,
        total_live_balance_cents=total_live_balance,
        total_reported_balance_cents=total_reported_balance,
        rows=rows,
    )


# ---------- Opportunity detection ----------

# Utilization cliffs that FICO/VS roughly treat as tiers. Dropping ACROSS a
# cliff is where real score movement happens; dropping WITHIN a tier is marginal.
_UTIL_CLIFFS = [1, 10, 30, 50, 75]  # in percent


def _tier_for(pct: float) -> int:
    """Return the cliff tier a given utilization % falls into (higher = worse)."""
    for i, cliff in enumerate(_UTIL_CLIFFS):
        if pct <= cliff:
            return i
    return len(_UTIL_CLIFFS)  # above highest cliff


def _score_delta_estimate(current_pct: float, target_pct: float) -> int:
    """Heuristic score delta when utilization moves from current → target.

    Based on common observations, not FICO internals:
    - Crossing each cliff downward: ~+8 points (compounding slightly)
    - Within-tier movement: ~+2 points per 10% absolute drop
    - Very low utilization (<1% vs 1-10%) is its own bump worth 5
    Confidence is built into the caller; this is the point estimate.
    """
    if current_pct <= target_pct:
        return 0
    current_tier = _tier_for(current_pct)
    target_tier = _tier_for(target_pct)
    cliffs_crossed = current_tier - target_tier
    within_tier_abs = max(0, current_pct - target_pct) - cliffs_crossed * 1  # rough
    delta = cliffs_crossed * 8 + int((within_tier_abs / 10) * 2)
    # Extra bump for hitting <1%
    if target_pct <= 1 < current_pct:
        delta += 5
    return int(delta)


def _cli_opportunity(card: Account, db: Session | None = None) -> CreditOpportunity | None:
    """Flag a card as a CLI (credit-limit-increase) candidate.

    Heuristic gates (all must pass):
      - card has a non-zero limit set
      - reported utilization is meaningfully low (≤20%) — issuers won't
        approve CLIs on cards already showing high util
      - current limit is under $10k (above that, +25% is marginal)
      - account is at least ~6 months old (180+ days of activity).
        Issuers want to see a payment pattern before they raise limits.
        We approximate "age" via the SPAN between earliest and latest
        Transaction on the card. If we have the db handle.

    On a fresh DB without enough history we return None — better to wait
    than coach the user into a denial that'd hard-pull their credit.
    """
    if not card.credit_limit_cents or card.credit_limit_cents == 0:
        return None
    limit = card.credit_limit_cents
    reported = card.last_statement_balance_cents or 0
    reported_util = (reported / limit * 100) if limit > 0 else 0
    if card.last_statement_date is None:
        return None  # no history — don't recommend yet
    if reported_util > 20:
        return None  # requesting CLI with high utilization can backfire
    if limit >= 1_000_000:  # $10,000 in cents — above this, marginal benefit
        return None

    # Age check: at least ~6 months of transaction history on this card.
    # Most issuers (Chase, Amex, Citi) want to see 6mo+ before granting a
    # CLI. We don't track account-open-date directly so we approximate via
    # the span between earliest and latest Transaction. Fail open on db=None
    # (call sites that don't pass db get the legacy looser behavior).
    if db is not None:
        from datetime import timedelta
        from sqlalchemy import func as sa_func
        bounds = db.execute(
            select(
                sa_func.min(Transaction.posted_date).label("first_seen"),
                sa_func.max(Transaction.posted_date).label("last_seen"),
            ).where(Transaction.account_id == card.id)
        ).one()
        first_seen = bounds.first_seen
        last_seen = bounds.last_seen
        if first_seen is None or last_seen is None:
            return None
        if (last_seen - first_seen) < timedelta(days=180):
            return None

    # Projection: if limit goes up 25% and balance stays the same, utilization drops
    new_limit = int(limit * 1.25)
    new_reported_util = (reported / new_limit * 100) if new_limit > 0 else 0
    score_delta = _score_delta_estimate(reported_util, new_reported_util)

    return CreditOpportunity(
        kind="request_cli",
        account_id=card.id,
        account_name=card.name,
        title=f"Request a credit-limit increase on {card.name}",
        rationale=(
            f"Your reported utilization on this card is {reported_util:.1f}% "
            f"(${reported/100:,.0f} on a ${limit/100:,.0f} limit). Issuers will "
            f"often grant a ~25% CLI on a well-used, low-utilization account. "
            f"Higher limit → lower utilization → small score bump, plus more "
            f"headroom before statement close."
        ),
        action_steps=[
            f"Log into {card.name} online or mobile app.",
            "Navigate to Services / Account Services → 'Request Credit Limit Increase'.",
            f"Request ${int(limit * 1.25) / 100:,.0f} (25% bump from ${limit/100:,.0f}).",
            "Most issuers do a SOFT pull for existing-customer CLIs — confirm before submitting.",
            "If asked for income, use current gross; 'reason' = 'better utilization ratio.'",
        ],
        before_state={
            "limit_cents": limit,
            "reported_balance_cents": reported,
            "reported_utilization_pct": round(reported_util, 1),
        },
        projected_after_if_acted={
            "limit_cents": new_limit,
            "reported_balance_cents": reported,
            "reported_utilization_pct": round(new_reported_util, 1),
            "note": "Assumes CLI is granted at +25%; actual granted amount varies.",
        },
        projected_after_if_not_acted={
            "limit_cents": limit,
            "reported_balance_cents": reported,
            "reported_utilization_pct": round(reported_util, 1),
            "note": "Status quo. No downside, just no upside.",
        },
        estimated_score_delta=score_delta,
        confidence=0.55,  # CLIs are not always granted
        urgency_days=None,  # no time pressure
    )


def _paydown_tier_ladder(
    live_cents: int, limit_cents: int
) -> list[dict]:
    """Build the full ladder of paydown options for one card.

    For each FICO cliff strictly below the current utilization, compute:
      - target_pct (1% below the cliff for safety)
      - target_balance_cents
      - paydown_cents (what you'd pay to land there)
      - estimated_score_delta vs. current util

    Plus a "max" rung at <1% utilization (the maximum-score-bump tier).
    Skips rungs costing <$10 (you already crossed that cliff naturally).
    """
    if limit_cents <= 0:
        return []
    live_util = live_cents / limit_cents * 100
    current_tier = _tier_for(live_util)
    rungs: list[dict] = []
    # Add a rung for each cliff DOWN from where we are now. The lowest
    # cliff (1%) lands at target 0.5% which is the max-bump tier — no
    # need for a separate "go even lower" rung.
    seen_targets: set[float] = set()
    for cliff in _UTIL_CLIFFS[:current_tier]:
        target_pct = max(0.5, cliff - 1)  # 1% safety margin under each cliff
        target_balance = int(limit_cents * target_pct / 100)
        paydown = live_cents - target_balance
        if paydown < 1_000:  # <$10 — skip
            continue
        if target_pct in seen_targets:
            continue
        seen_targets.add(target_pct)
        label = (
            "Maximum bump (under 1%)"
            if cliff == 1
            else f"Drop under {cliff}% reported util"
        )
        rungs.append(
            {
                "tier_label": label,
                "cliff_pct": cliff,
                "target_utilization_pct": round(target_pct, 1),
                "target_balance_cents": target_balance,
                "paydown_cents": paydown,
                "estimated_score_delta": _score_delta_estimate(live_util, target_pct),
            }
        )
    # Sort by paydown ascending so the cheapest rung is first — matches
    # how the UI is likely to render the ladder. The "primary" pick in
    # _paydown_opportunity uses score-delta-per-dollar, not list order.
    rungs.sort(key=lambda r: r["paydown_cents"])
    return rungs


def _paydown_opportunity(card: Account) -> CreditOpportunity | None:
    """Suggest paying down before statement-close to cut reported utilization.

    Builds a full tier ladder via :func:`_paydown_tier_ladder` so the user
    sees ALL the options (drop to 30% / drop to 10% / drop under 1%) and
    can pick the one that fits their cash flow. The primary projection
    targets the most aggressive sensible tier (highest score delta per
    dollar paid), but the ``alternatives`` field carries the full ladder.

    Heuristic gates:
      - card has limit AND live balance set
      - close day known
      - live balance > $100 (smaller balances aren't worth optimizing)
    """
    if not card.credit_limit_cents or not card.current_balance_cents:
        return None
    if card.statement_close_day is None:
        return None
    limit = card.credit_limit_cents
    live = card.current_balance_cents
    live_util = (live / limit * 100) if limit > 0 else 0
    if live <= 10_000:  # <$100 live balance — not worth optimizing
        return None

    rungs = _paydown_tier_ladder(live, limit)
    if not rungs:
        return None  # already optimal or paydown too small to matter

    # Primary recommendation = the rung with the best score delta per
    # dollar paid (good headline default — Chris can pick a cheaper rung
    # from alternatives if cash is tight).
    def value_per_dollar(rung: dict) -> float:
        return (rung["estimated_score_delta"] or 0) / max(1, rung["paydown_cents"])

    primary = max(rungs, key=value_per_dollar)
    target_balance = primary["target_balance_cents"]
    target_pct = primary["target_utilization_pct"]
    paydown_cents = primary["paydown_cents"]
    score_delta = primary["estimated_score_delta"]
    days_until_close = _days_until_close(card.statement_close_day) or 0
    close_date = _next_close_date(card.statement_close_day)

    # Pretty rationale referencing the FULL set of options the user can pick.
    if len(rungs) > 1:
        ladder_summary = "; ".join(
            f"${r['paydown_cents']/100:,.0f}→{r['target_utilization_pct']}% (+{r['estimated_score_delta']}pts)"
            for r in rungs
        )
        rationale = (
            f"Current balance ${live/100:,.0f} on ${limit/100:,.0f} limit = "
            f"{live_util:.1f}% utilization. {len(rungs)} tier options before close "
            f"on {close_date.isoformat() if close_date else 'TBD'}: {ladder_summary}. "
            f"The best score-delta-per-dollar option is paying ${paydown_cents/100:,.0f} "
            f"to drop reported util to {target_pct}% (≈{score_delta} pts)."
        )
    else:
        rationale = (
            f"Current balance ${live/100:,.0f} on ${limit/100:,.0f} limit = "
            f"{live_util:.1f}% utilization. Paying ${paydown_cents/100:,.0f} before "
            f"{close_date.isoformat() if close_date else 'close'} drops reported util "
            f"to {target_pct}% (≈{score_delta} pts)."
        )

    return CreditOpportunity(
        kind="paydown_before_close",
        account_id=card.id,
        account_name=card.name,
        title=f"Pay down {card.name} before statement close",
        rationale=rationale,
        action_steps=[
            f"Log into {card.name}. Confirm next statement close is "
            f"{close_date.isoformat() if close_date else 'the ' + str(card.statement_close_day) + 'th'}.",
            f"Recommended: pay ${paydown_cents/100:,.0f} (≈{score_delta} pts).",
            "Or pick a cheaper tier from the alternatives list — each rung "
            "shows paydown amount, projected utilization, and projected score delta.",
            "Time the payment to POST before close (allow 2 business days for ACH).",
            "After close, verify the statement balance reflects the paydown — "
            "that's the number bureaus see.",
        ],
        before_state={
            "live_balance_cents": live,
            "live_utilization_pct": round(live_util, 1),
            "projected_reported_utilization_pct": round(live_util, 1),
        },
        projected_after_if_acted={
            "live_balance_cents": target_balance,
            "live_utilization_pct": round(target_pct, 1),
            "projected_reported_utilization_pct": round(target_pct, 1),
            "tier_label": primary["tier_label"],
            "paydown_cents": paydown_cents,
        },
        projected_after_if_not_acted={
            "live_balance_cents": live,
            "live_utilization_pct": round(live_util, 1),
            "projected_reported_utilization_pct": round(live_util, 1),
            "note": "Current balance will report at close and drag score by the estimated delta.",
        },
        estimated_score_delta=score_delta,
        confidence=0.8,
        urgency_days=days_until_close,
        alternatives=rungs,
        deadline_date=close_date,
    )


@router.get("/opportunities", response_model=CreditOpportunitiesResponse)
def opportunities(db: Session = Depends(get_db)) -> CreditOpportunitiesResponse:
    cards = _load_credit_cards(db)
    ops: list[CreditOpportunity] = []
    for c in cards:
        if (op := _paydown_opportunity(c)) is not None:
            ops.append(op)
        if (op := _cli_opportunity(c, db=db)) is not None:
            ops.append(op)

    # Sort by urgency (soonest first), then score delta (biggest first)
    ops.sort(
        key=lambda o: (
            o.urgency_days if o.urgency_days is not None else 9999,
            -(o.estimated_score_delta or 0),
        )
    )
    return CreditOpportunitiesResponse(
        generated_at=datetime.utcnow(),
        opportunities=ops,
    )


# ---------- Rewards optimizer (Phase 4.4) ----------


@router.get("/rewards-optimizer", response_model=RewardsLeakageResponse)
def rewards_optimizer(
    days: int = 90,
    db: Session = Depends(get_db),
) -> RewardsLeakageResponse:
    """Compute the "wrong-card" rewards leakage report.

    Walks the user's transactions on linked credit cards over the
    trailing ``days`` window. For each transaction, compares the
    rewards earned on the card actually used vs. the rewards Chris
    *could* have earned by routing the same purchase through his
    best-match card for that category. Surfaces the $-value gap
    aggregated by category plus a top-N list of individual misuses.

    Pure deterministic — no LLM, no scraping. Card profiles live in
    ``rewards/card_rewards.yaml``; add new cards by editing that file.
    """
    if days < 1 or days > 365:
        raise HTTPException(400, "days must be between 1 and 365")
    from datetime import timedelta as _td
    from finance_app.rewards import analyze_transactions

    until = date.today()
    since = until - _td(days=days)
    report = analyze_transactions(db, since=since, until=until)

    return RewardsLeakageResponse(
        window_start=report.window_start,
        window_end=report.window_end,
        cards_analyzed=report.cards_analyzed,
        total_spend_cents=report.total_spend_cents,
        total_used_value_cents=report.total_used_value_cents,
        total_best_value_cents=report.total_best_value_cents,
        total_left_on_table_cents=report.total_left_on_table_cents,
        by_category=[
            RewardsCategoryLeakageOut(
                category_slug=c.category_slug,
                category_name=c.category_name,
                total_spend_cents=c.total_spend_cents,
                used_value_cents=c.used_value_cents,
                best_value_cents=c.best_value_cents,
                left_on_table_cents=c.left_on_table_cents,
                transactions=c.transactions,
            )
            for c in report.by_category
        ],
        top_misuses=[
            RewardsTxnAnalysisOut(
                transaction_id=r.transaction_id,
                posted_date=r.posted_date,
                description=r.description,
                amount_cents=r.amount_cents,
                category_slug=r.category_slug,
                used_account_id=r.used_account_id,
                used_account_name=r.used_account_name,
                used_multiplier=r.used_multiplier,
                used_value_cents=r.used_value_cents,
                best_account_id=r.best_account_id,
                best_account_name=r.best_account_name,
                best_multiplier=r.best_multiplier,
                best_value_cents=r.best_value_cents,
                left_on_table_cents=r.left_on_table_cents,
            )
            for r in report.top_misuses
        ],
        unmatched_card_ids=report.unmatched_card_ids,
    )
