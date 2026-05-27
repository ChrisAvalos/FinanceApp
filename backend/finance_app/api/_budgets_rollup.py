"""Rollup endpoint and its siblings (project / recommendations / eom-detail).

Holds the largest piece of the budgets API: the monthly rollup view plus
the three endpoints that share its local pydantic models (projection,
recommendations, EOM detail).
"""
from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta

from fastapi import Depends
from pydantic import BaseModel, Field as PydField
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.api._budgets_helpers import (
    _effective_goal_current_cents,
    _find_rent_like_txns,
    _is_catchall_cat,
    _is_payroll_desc,
    _is_savings_outflow_desc,
    _month_bounds,
    _normalize_month_start,
    _RENT_SHIFT_DAY_CUTOFF,
)
from finance_app.api.schemas import (
    BudgetRollupResponse,
    BudgetRollupRow,
)
from finance_app.budgets.monthly_financials import compute_month_income
from finance_app.db.models import (
    Account,
    AccountType,
    Budget,
    BudgetStatus,
    Category,
    Goal,
    GoalStatus,
    Transaction,
)
from finance_app.db.session import get_db


# ---------- Monthly rollup ----------

def _classify(actual_cents: int, budget_cents: int, pace: float) -> BudgetStatus:
    """Status = warning if running ahead of pace, over if above cap, else on_track.

    Using pace gives us an "are we burning too fast?" signal mid-month, not just
    the naive "did we exceed 80%?" heuristic. Example: 50% of cap used on day 10
    of a 30-day month (pace=0.33) is a WARNING — we'd extrapolate to 150% by
    month-end — even though 50 < 80.
    """
    if budget_cents <= 0:
        return BudgetStatus.on_track
    if actual_cents > budget_cents:
        return BudgetStatus.over
    used_ratio = actual_cents / budget_cents
    if pace > 0 and used_ratio / pace >= 1.2 and used_ratio >= 0.5:
        return BudgetStatus.warning
    if used_ratio >= 0.95:
        return BudgetStatus.warning
    return BudgetStatus.on_track




def _month_pace(month_start: date, today: date | None = None) -> float:
    """Fraction of the month that has elapsed — 0..1. Future months: 0. Past: 1."""
    today = today or date.today()
    first, last = _month_bounds(month_start)
    if today < first:
        return 0.0
    if today > last:
        return 1.0
    elapsed = (today - first).days + 1
    total = (last - first).days + 1
    return elapsed / total


def _category_outflow_in_month(db: Session, category_id: int, ms: date) -> int:
    """Sum of outflow (positive cents) for one category within the month.

    Lifted out of :func:`rollup` so the rollover walker can call it for
    arbitrary prior months without rebuilding the aggregate-by-category
    map for every month it visits.
    """
    first, last = _month_bounds(ms)
    val = db.execute(
        select(
            func.sum(
                case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
            )
        )
        .where(Transaction.category_id == category_id)
        .where(Transaction.posted_date >= first)
        .where(Transaction.posted_date <= last)
    ).scalar()
    return int(val or 0)


def _rollover_in_for(
    db: Session,
    category_id: int,
    ms: date,
    *,
    max_lookback: int = 12,
    cache: dict[tuple[int, str], int] | None = None,
) -> int:
    """Walk back through rollover-flagged budgets to compute carried-in cents.

    Recursive: this month's rollover-in = prior month's effective remainder
    (its budget + ITS rollover-in − its actual spend), provided the prior
    month's Budget had ``rollover=True``. The chain breaks at the first
    prior month with no Budget for the category, or with rollover=False.

    ``max_lookback`` caps the walk at 12 months so a misconfigured chain
    can't cause unbounded recursion (it shouldn't anyway since each step
    moves a month earlier, but defense in depth is cheap).

    ``cache`` memoizes per-category-per-month so a single rollup request
    doesn't recompute prior months for two siblings rolling forward
    independently.
    """
    if max_lookback <= 0:
        return 0
    if cache is None:
        cache = {}
    cache_key = (category_id, ms.isoformat())
    if cache_key in cache:
        return cache[cache_key]

    prior_ms = _normalize_month_start(date(ms.year, ms.month, 1) - timedelta(days=1))
    prior_budget = (
        db.execute(
            select(Budget)
            .where(Budget.category_id == category_id)
            .where(Budget.month_start == prior_ms)
        )
        .scalars()
        .first()
    )
    if prior_budget is None or not prior_budget.rollover:
        cache[cache_key] = 0
        return 0

    # Recurse: prior month's own rollover-in feeds its effective budget.
    prior_rollover_in = _rollover_in_for(
        db,
        category_id,
        prior_ms,
        max_lookback=max_lookback - 1,
        cache=cache,
    )
    prior_actual = _category_outflow_in_month(db, category_id, prior_ms)
    prior_effective = prior_budget.amount_cents + prior_rollover_in
    prior_remainder = prior_effective - prior_actual
    cache[cache_key] = prior_remainder
    return prior_remainder


def rollup(
    month_start: date,
    db: Session = Depends(get_db),
) -> BudgetRollupResponse:
    """Budget vs actual per category for the given month.

    - ``rows``: categories that have a Budget for this month (whether or not
      there's spending).
    - ``unbudgeted_spending``: categories with spending but NO budget — the
      blind-spot list. Same shape as rows but with budget_cents=0.

    Rollover support: rows with ``rollover=True`` carry the prior
    rollover-flagged month's effective remainder forward into
    ``rollover_in_cents``. ``effective_budget_cents`` is the number used
    to compute remaining / status / projection.
    """
    ms = _normalize_month_start(month_start)
    first, last = _month_bounds(ms)
    pace = _month_pace(ms)

    # Sprint M (2026-05-14): build a category lookup once so every row
    # can include parent_id + parent_name without N+1 queries. Used by
    # the donut / bars / treemap views to roll up to super-groups.
    all_cats_list = db.execute(select(Category)).scalars().all()
    cat_by_id: dict[int, Category] = {c.id: c for c in all_cats_list}

    def _parent_info(cat_id: int | None) -> tuple[int | None, str | None]:
        if cat_id is None:
            return None, None
        cat = cat_by_id.get(cat_id)
        if cat is None or cat.parent_id is None:
            return None, None
        parent = cat_by_id.get(cat.parent_id)
        if parent is None:
            return None, None
        return parent.id, parent.name

    # Sprint H-2 — rent attribution window. We "borrow" rent-category txns
    # posted on the LAST `_RENT_SHIFT_DAY_CUTOFF`..end-of-prior-month days
    # into this month's rollup, AND simultaneously drop the same shifted
    # txns from prior month's rollup. The prior-month drop is handled by
    # any subsequent call asking for prior_ms — the rollup function is
    # stateless so a request for April will skip the Apr 30 rent txn and a
    # request for May will pick it up. The two outputs are internally
    # consistent.
    prior_ms_start = (first - timedelta(days=1)).replace(day=_RENT_SHIFT_DAY_CUTOFF)
    prior_ms_end = first - timedelta(days=1)

    # 1. Aggregate outflow per category within the month window — but
    # exclude rent-category txns from the FIRST part of the month so we
    # can re-attribute them. (Doesn't actually do that yet — splits below.)
    outflow_expr = func.sum(
        case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
    ).label("outflow")
    spend_rows = db.execute(
        select(
            Transaction.category_id,
            Category.name.label("category_name"),
            outflow_expr,
        )
        .join(Category, Category.id == Transaction.category_id, isouter=True)
        .where(
            Transaction.posted_date >= first,
            Transaction.posted_date <= last,
        )
        .group_by(Transaction.category_id, Category.name)
    ).all()
    # Drop categories whose outflow nets to 0 — those are income or transfer
    # categories that show up in the GROUP BY but don't represent spending.
    # Without this filter, "Salary" appears in the Unbudgeted spending list
    # at $0.00, which is misleading. Found 2026-04-27 in the first UI test.
    spend_by_cat: dict[int | None, tuple[str | None, int]] = {
        r.category_id: (r.category_name, int(r.outflow or 0))
        for r in spend_rows
        if int(r.outflow or 0) > 0
    }

    # Sprint H-2 — find rent-like txns posted in the last few days of the
    # prior month and SHIFT them into this month's rollup. The
    # `_find_rent_like_txns` helper handles BOTH categorized rent and
    # miscategorized recurring large outflows (so Chris's Zelle to his
    # landlord — tagged "Transfer" by Plaid — still gets attributed).
    rent_attributed_tx_ids: list[int] = []
    # Always attribute under the canonical "Rent / Mortgage" category
    # name regardless of where the txn was actually filed. That way the
    # rent-row in the rollup shows the consolidated truth: $2075 of rent
    # paid, not "$0 of rent paid + $2075 hidden under Transfer."
    rent_canonical_cat = db.execute(
        select(Category).where(
            func.lower(Category.name).in_(("rent / mortgage", "rent/mortgage", "rent", "mortgage"))
        )
    ).scalars().first()
    rent_target_cat_id = rent_canonical_cat.id if rent_canonical_cat else None
    rent_target_cat_name = rent_canonical_cat.name if rent_canonical_cat else "Rent / Mortgage"

    prior_rent_txns = _find_rent_like_txns(
        db, start_date=prior_ms_start, end_date=prior_ms_end
    )
    for tx in prior_rent_txns:
        amt = -tx.amount_cents
        target_id = rent_target_cat_id if rent_target_cat_id is not None else tx.category_id
        target_name = rent_target_cat_name
        prev = spend_by_cat.get(target_id, (target_name, 0))
        spend_by_cat[target_id] = (target_name, prev[1] + amt)
        rent_attributed_tx_ids.append(tx.id)

    # Mirror correction: REMOVE rent-like txns that POSTED in the current
    # month on day >= _RENT_SHIFT_DAY_CUTOFF — those belong to next month.
    # `first` is always day=1 (normalized at the top of the function).
    current_late_rent_window_start = first.replace(day=_RENT_SHIFT_DAY_CUTOFF)
    if current_late_rent_window_start <= last:
        current_late_rent_txns = _find_rent_like_txns(
            db, start_date=current_late_rent_window_start, end_date=last
        )
        for tx in current_late_rent_txns:
            amt = -tx.amount_cents
            cat_id_to_decrement = tx.category_id
            if cat_id_to_decrement is None:
                continue
            prev = spend_by_cat.get(cat_id_to_decrement)
            if prev is None:
                continue
            new_amt = max(0, prev[1] - amt)
            spend_by_cat[cat_id_to_decrement] = (prev[0], new_amt)

    # 2. Load budgets for this month
    budget_rows = db.execute(
        select(Budget, Category)
        .join(Category, Category.id == Budget.category_id)
        .where(Budget.month_start == ms)
        .order_by(Category.name)
    ).all()

    rows: list[BudgetRollupRow] = []
    covered_cat_ids: set[int] = set()
    total_budget = 0
    total_actual = 0
    rollover_cache: dict[tuple[int, str], int] = {}
    for budget, cat in budget_rows:
        covered_cat_ids.add(cat.id)
        actual = spend_by_cat.get(cat.id, (cat.name, 0))[1]
        rollover_in = (
            _rollover_in_for(db, cat.id, ms, cache=rollover_cache)
            if budget.rollover
            else 0
        )
        effective_budget = budget.amount_cents + rollover_in
        remaining = effective_budget - actual
        pct_used = (actual / effective_budget * 100) if effective_budget > 0 else 0.0
        # Pace projection (Phase 7.3). Linear extrapolation:
        #   projected_eom = actual / pace  (assuming the user keeps spending
        #   at the same rate they have so far this month).
        # Skip when pace < 0.05 (less than ~1.5 days into the month — too
        # noisy to extrapolate) or effective budget is zero (no comparator).
        proj_eom: int | None = None
        proj_overage: int | None = None
        proj_pct: float | None = None
        if effective_budget > 0 and pace >= 0.05:
            proj_eom = int(round(actual / pace))
            proj_overage = proj_eom - effective_budget
            proj_pct = round(proj_eom / effective_budget * 100, 1)
        _pid, _pname = _parent_info(cat.id)
        rows.append(
            BudgetRollupRow(
                category_id=cat.id,
                category_name=cat.name,
                budget_cents=budget.amount_cents,
                actual_outflow_cents=actual,
                remaining_cents=remaining,
                pct_used=round(pct_used, 1),
                status=_classify(actual, effective_budget, pace),
                projected_eom_cents=proj_eom,
                projected_overage_cents=proj_overage,
                projected_pct_used=proj_pct,
                rollover_in_cents=rollover_in,
                effective_budget_cents=effective_budget,
                parent_id=_pid,
                parent_name=_pname,
                is_catchall=_is_catchall_cat(cat.name),
                is_discretionary=bool(cat.is_discretionary),
            )
        )
        # ``total_budget`` reflects the headline number (sum of effective
        # budgets including rollovers). UI shows the rollover delta so the
        # user can see "you have $X more to spend this month thanks to
        # under-spend in prior months".
        total_budget += effective_budget
        total_actual += actual

    # 3. Spend that falls outside any budgeted category
    unbudgeted: list[BudgetRollupRow] = []
    for cat_id, (cat_name, outflow) in spend_by_cat.items():
        if cat_id in covered_cat_ids:
            continue
        if cat_id is None:
            unbudgeted.append(
                BudgetRollupRow(
                    category_id=0,
                    category_name="(Uncategorized)",
                    budget_cents=0,
                    actual_outflow_cents=outflow,
                    remaining_cents=-outflow,
                    pct_used=0.0,
                    status=BudgetStatus.on_track,
                )
            )
            continue
        _pid_u, _pname_u = _parent_info(cat_id)
        unbudgeted.append(
            BudgetRollupRow(
                category_id=cat_id,
                category_name=cat_name or "(Unknown)",
                budget_cents=0,
                parent_id=_pid_u,
                parent_name=_pname_u,
                is_catchall=_is_catchall_cat(cat_name or ""),
                actual_outflow_cents=outflow,
                remaining_cents=-outflow,
                pct_used=0.0,
                status=BudgetStatus.on_track,
            )
        )
    unbudgeted.sort(key=lambda r: r.actual_outflow_cents, reverse=True)

    # ----------------------------------------------------------------------
    # Sprint H additions
    # ----------------------------------------------------------------------

    # Sprint O-2 — every income figure for this month comes from the ONE
    # canonical computation (`compute_month_income`), the same module the
    # assignment-ledger and projection now read. Before this, rollup
    # re-derived income inline and the four surfaces drifted (the Budgets
    # page showed income as both $7,240 and $7,159 at once).
    #
    # `_mfi` carries every figure; the individual names below are kept so
    # the rest of this function and the response model are untouched:
    #   * monthly_income_cents   — ALL positive inflows, 90-day average
    #     (peer transfers + windfalls included). The "took-home" headline.
    #   * recurring_income_cents — Livio payroll only, 90-day average.
    #     Used by the projector so one-off windfalls aren't extrapolated.
    _mfi = compute_month_income(db, ms)
    monthly_income_cents = _mfi.all_inflow_avg_cents
    recurring_income_cents = _mfi.recurring_avg_cents

    # H-1 — "real" budget total: drop catch-all category caps from the
    # headline. Transfer + Uncategorized + Credit Card Payment + Investment
    # Contribution all have huge nominal caps that don't represent planned
    # spending in any meaningful sense.
    real_budget = 0
    for r in rows:
        if not _is_catchall_cat(r.category_name):
            real_budget += r.effective_budget_cents or r.budget_cents

    # H-3a — auto-detect transfers to savings/investment accounts as
    # "savings actual." We look for OUTFLOWS from non-savings accounts
    # whose category name contains "transfer" + "savings" OR txns whose
    # description matches a recognized internal-transfer pattern. Cleanest
    # signal: an outflow that lands the SAME DAY as an equal-magnitude
    # inflow into a savings or investment account.
    # Sprint K-1 + K-2 — split savings into "goal-bound" (eTrade, linked to
    # the user's main savings goal) and "other" (Albert auto-savings,
    # supplementary brokerages). Also use balance-growth via BalanceSnapshot
    # as a fallback for accounts where the scraper updates balance
    # without creating a transaction row (Albert Sprint-43 case).
    from finance_app.db.models import BalanceSnapshot as _BalanceSnapshot

    savings_accounts = db.execute(
        select(Account).where(
            Account.account_type.in_([AccountType.savings, AccountType.investment])
        )
    ).scalars().all()
    savings_account_ids = {a.id for a in savings_accounts}

    # Identify the "goal-bound" account: linked_account_id on the highest-
    # priority active savings goal. Fall back to "Premium Savings" by name
    # if no goal is linked yet (so Chris's eTrade is auto-detected).
    goal_linked_account_ids: set[int] = set()
    primary_savings_goal = db.execute(
        select(Goal)
        .where(Goal.status == GoalStatus.active)
        .where(Goal.target_amount_cents > 0)
        .where(Goal.linked_account_id.is_not(None))
        .order_by(Goal.priority.asc())
    ).scalars().first()
    if primary_savings_goal is not None and primary_savings_goal.linked_account_id:
        goal_linked_account_ids.add(primary_savings_goal.linked_account_id)

    def _savings_for_account(acct: Account) -> int:
        """Return THIS-MONTH dollars NET-saved into `acct`.

        Wave 5 fix B (2026-05-14): the prior version summed only positive
        inflows ("gross"), so April's eTrade activity ($400 in + $400 out)
        reported $400 saved when the actual net change was ~$0.

        Now we compute NET (inflows - outflows) on the txn side, and clamp
        to >= 0 (a negative net means money LEFT the savings account this
        month, which we surface as "no savings this month" rather than
        subtracting from another account's savings).

        We still take max(net_txn_sum, balance_growth) for the Albert case
        where the scraper updates current_balance without writing txns.
        """
        # Net txn-sum: ALL transactions this month (inflows + outflows).
        # Positives = deposits, negatives = withdrawals; sum gives the net.
        net_txn = db.execute(
            select(func.coalesce(func.sum(Transaction.amount_cents), 0))
            .where(Transaction.account_id == acct.id)
            .where(Transaction.posted_date >= first)
            .where(Transaction.posted_date <= last)
        ).scalar() or 0
        net_txn = max(0, int(net_txn))

        # Balance-growth: current_balance - latest snapshot before month_start.
        # If no snapshot exists, growth is unknown — fall back to net_txn.
        pre_snap = db.execute(
            select(_BalanceSnapshot)
            .where(_BalanceSnapshot.account_id == acct.id)
            .where(_BalanceSnapshot.as_of < first)
            .order_by(_BalanceSnapshot.as_of.desc())
        ).scalars().first()
        growth = None
        if pre_snap is not None and acct.current_balance_cents is not None:
            growth = (acct.current_balance_cents or 0) - pre_snap.balance_cents

        # Take the max — both are sane "net" estimates of this-month delta.
        candidates = [net_txn]
        if growth is not None:
            candidates.append(max(0, growth))
        return max(0, max(candidates))

    savings_actual = 0
    savings_actual_etrade = 0       # K-1: goal-bound
    savings_actual_other = 0        # K-1: bonus / Albert auto-savings
    for acct in savings_accounts:
        amt = _savings_for_account(acct)
        savings_actual += amt
        if acct.id in goal_linked_account_ids:
            savings_actual_etrade += amt
        else:
            savings_actual_other += amt

    # Sprint K-4 — third detection path: scan checking-side outflows for
    # known self-transfer-to-savings patterns (Albert EDI PYMNTS, etc.).
    # This catches the case where the destination account isn't synced
    # via Plaid (Albert is Playwright-scraped per Sprint 43) so neither
    # txn-sum nor balance-growth detection picks it up.
    #
    # Anti-double-count: skip if balance-growth on Albert accounts
    # already exceeds the outflow total (means the inflow side IS being
    # tracked some other way and we'd be double-counting).
    self_transfer_outflow_total = 0
    if savings_account_ids:
        outflow_rows = db.execute(
            select(Transaction)
            .where(Transaction.amount_cents < 0)
            .where(Transaction.account_id.notin_(savings_account_ids))
            .where(Transaction.posted_date >= first)
            .where(Transaction.posted_date <= last)
        ).scalars().all()
        for tx in outflow_rows:
            if _is_savings_outflow_desc(tx):
                self_transfer_outflow_total += -tx.amount_cents
        # Only count if not already captured by balance-growth/txn-sum.
        # Heuristic: if savings_actual_other == 0 (no other detection
        # caught anything), the outflows are the ONLY signal we have.
        if self_transfer_outflow_total > 0 and savings_actual_other == 0:
            savings_actual_other += self_transfer_outflow_total
            savings_actual += self_transfer_outflow_total

    # H-3b — sum of all active goals' "needed monthly" contributions.
    # Same formula as the recommender uses for goal recs.
    today = date.today()
    active_goals = db.execute(
        select(Goal)
        .where(Goal.status == GoalStatus.active)
        .where(Goal.target_amount_cents > 0)
    ).scalars().all()
    # Wave 5 follow-up (2026-05-14) — FIXED target rate, not adaptive.
    #
    # The original code computed (remaining_gap / months_left), which
    # decreases as progress accumulates. User feedback: that framing is
    # confusing ("I set $400/mo as my habit and want to see $400/mo").
    # New framing: use the ORIGINAL plan rate (target_amount / total
    # planned months from goal creation to deadline). For Chris's
    # $9,600 / 24mo goal, this always reads $400/mo regardless of
    # current progress — until the goal is hit and contribution drops
    # to $0.
    savings_goal_target = 0
    for g in active_goals:
        # Skip if already hit — no further monthly contribution needed.
        eff_current = _effective_goal_current_cents(g, db)
        if eff_current >= g.target_amount_cents:
            continue
        # Total planned months = goal creation date → target date. This
        # is the user's original "I want $X by Y" commitment; the
        # contribution rate stays anchored to that plan, not adjusted
        # by what they've already saved.
        if g.target_date is None:
            total_months = 24  # fallback for goals with no deadline
        else:
            created_date = (
                g.created_at.date() if hasattr(g.created_at, "date") else g.created_at
            )
            total_months = max(
                1,
                (g.target_date.year - created_date.year) * 12
                + (g.target_date.month - created_date.month),
            )
        savings_goal_target += g.target_amount_cents // total_months

    # H-4a — month-over-month per-category comparison. Compute 3-mo trailing
    # average per category, return a {cat_id: (this_month_cents, three_mo_avg_cents)}
    # map the UI uses to render a colored delta chip.
    three_mo_start = (first - timedelta(days=1)).replace(day=1)
    three_mo_start = (three_mo_start - timedelta(days=1)).replace(day=1)
    three_mo_start = (three_mo_start - timedelta(days=1)).replace(day=1)
    three_mo_end = first - timedelta(days=1)
    three_mo_rows = db.execute(
        select(
            Transaction.category_id,
            func.sum(case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)).label("outflow"),
        )
        .where(Transaction.posted_date >= three_mo_start)
        .where(Transaction.posted_date <= three_mo_end)
        .group_by(Transaction.category_id)
    ).all()
    three_mo_outflow_by_cat: dict[int, int] = {}
    for r in three_mo_rows:
        if r.category_id is None:
            continue
        if not r.outflow:
            continue
        three_mo_outflow_by_cat[r.category_id] = int(r.outflow)

    # H-2 follow-up: re-attribute rent-like outflows in the 3-mo window
    # so the MoM chip on rent isn't comparing $233 (Trojan Storage only)
    # to $2,336 (Trojan + rent attribution). We move all rent-like txns
    # under their actual original category INTO the canonical rent
    # category id so the avg includes them.
    if rent_target_cat_id is not None:
        historical_rent_txns = _find_rent_like_txns(
            db, start_date=three_mo_start, end_date=three_mo_end
        )
        rent_total = 0
        for tx in historical_rent_txns:
            amt = -tx.amount_cents
            rent_total += amt
            if tx.category_id is not None and tx.category_id != rent_target_cat_id:
                # Subtract from the original category's 3-mo sum so we
                # don't double-count this txn under both buckets.
                existing = three_mo_outflow_by_cat.get(tx.category_id, 0)
                three_mo_outflow_by_cat[tx.category_id] = max(0, existing - amt)
        # Re-attribute the total under the canonical rent category.
        # Add to the existing total (don't overwrite — the original
        # category 12 outflow of Trojan Storage is still legitimately
        # rent-like and already counted, so we add the rest).
        # Actually simpler: rebuild rent's value from rent_total which
        # is now the canonical truth.
        if rent_total > 0:
            three_mo_outflow_by_cat[rent_target_cat_id] = rent_total

    three_mo_avg_by_cat: dict[int, int] = {
        k: v // 3 for k, v in three_mo_outflow_by_cat.items()
    }

    mom_compare: dict[int, tuple[int, int]] = {}
    seen_cats: set[int] = set()
    for row in rows:
        if row.category_id is None:
            continue
        seen_cats.add(row.category_id)
        avg3 = three_mo_avg_by_cat.get(row.category_id, 0)
        mom_compare[row.category_id] = (row.actual_outflow_cents, avg3)
    for row in unbudgeted:
        if row.category_id is None or row.category_id in seen_cats:
            continue
        seen_cats.add(row.category_id)
        avg3 = three_mo_avg_by_cat.get(row.category_id, 0)
        mom_compare[row.category_id] = (row.actual_outflow_cents, avg3)

    # ----------------------------------------------------------------------
    # Sprint I — "Safe to spend this month" math + EOM projection
    # ----------------------------------------------------------------------
    #
    # Trust-hole fix: the prior +$417 "Remaining" headline was inconsistent
    # (real_budget excluded catchalls but total_actual didn't, and unbudgeted
    # spend was invisible). The Sprint I math fixes all 3 sub-bugs:
    #   1. real_actual_cents — matches real_budget's exclusion list
    #   2. safe_to_spend subtracts unbudgeted explicitly
    #   3. eom_projected_outflow extrapolates variable spend, not just snapshot
    #
    # Why split committed vs variable: committed bills (rent, insurance,
    # internet) are one-shot monthly hits — extrapolating them by pace
    # would double-count. Variable spending (groceries, restaurants) DOES
    # scale linearly so pace-based EOM projection is fair there.

    # 1. real_actual_cents — apples-to-apples with real_budget.
    real_actual = 0
    for r in rows:
        if not _is_catchall_cat(r.category_name):
            real_actual += r.actual_outflow_cents
    for u in unbudgeted:
        if not _is_catchall_cat(u.category_name):
            real_actual += u.actual_outflow_cents

    # 2. committed_caps_total — sum of caps in non-discretionary categories.
    # Pulls is_discretionary from the Category table.
    committed_caps_total = 0
    committed_actual = 0
    variable_actual = 0
    committed_remaining = 0
    for r in rows:
        # Look up the Category to read is_discretionary. We already loaded
        # them via budget_rows but didn't keep the cat objects in `rows`.
        cat = db.get(Category, r.category_id)
        if cat is None:
            continue
        if _is_catchall_cat(cat.name):
            # Catchalls don't count toward committed bills regardless of flag.
            continue
        if not cat.is_discretionary:
            committed_caps_total += r.budget_cents
            committed_actual += r.actual_outflow_cents
            # If we've paid less than cap, remainder is still due this month.
            committed_remaining += max(0, r.budget_cents - r.actual_outflow_cents)
        else:
            variable_actual += r.actual_outflow_cents

    # Unbudgeted spend is always variable by definition (no cap, so it's
    # not a planned recurring bill).
    unbudgeted_actual = sum(u.actual_outflow_cents for u in unbudgeted)
    variable_actual += unbudgeted_actual

    # 3+4. safe_to_spend and eom_projected_net_flow moved Sprint O-1
    # (2026-05-15) to AFTER the paycheck-history block below. The hero
    # math needs month_income_expected_total_cents (the actual May total),
    # not recurring_income_cents (the 90-day trailing avg). variable_actual,
    # committed_actual, committed_remaining are all already computed by
    # this point so they're in scope when safe_to_spend is finally
    # evaluated below.

    # variable_eom_estimate still needs to be computed BEFORE the 3-mo
    # block (no — actually it doesn't, but keeping it here is cheap and
    # symmetrical with the moved safe_to_spend).
    if pace > 0.05:
        variable_eom_estimate = int(round(variable_actual / pace))
    else:
        # Too early in month to extrapolate variable — use raw.
        variable_eom_estimate = variable_actual
    eom_projected_outflow = (
        committed_actual + committed_remaining + variable_eom_estimate
    )

    # 5. Trailing 3-mo avg net flow — Wealth Pulse baseline.
    # Approximation: 3-mo income avg − 3-mo outflow avg. Income uses
    # recurring formula (same Livio-only filter for apples-to-apples).
    three_mo_income_rows = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents > 0)
        .where(Transaction.posted_date >= three_mo_start)
        .where(Transaction.posted_date <= three_mo_end)
    ).scalars().all()
    three_mo_recurring_income = sum(
        tx.amount_cents for tx in three_mo_income_rows if _is_payroll_desc(tx)
    )
    # Sprint K-5 — exclude self-transfer outflows (Albert EDI etc.) from
    # the 3-mo outflow sum. They're savings, not spending — counting them
    # as outflow makes the trailing net flow look worse than reality and
    # the Wealth Pulse card mis-frames Albert auto-saves as "burning."
    # Load all outflows then filter; SQL-side LIKE would work too but
    # the description-match logic is already in Python.
    three_mo_outflow_rows = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= three_mo_start)
        .where(Transaction.posted_date <= three_mo_end)
    ).scalars().all()
    three_mo_outflow_total = sum(
        -tx.amount_cents
        for tx in three_mo_outflow_rows
        if not _is_savings_outflow_desc(tx)
    )
    trailing_3mo_net_flow = (three_mo_recurring_income - int(three_mo_outflow_total)) // 3

    # Wave 5 fix G (2026-05-14) — closes WF 5 ("Did I get paid this week?").
    # Find the most-recent payroll-pattern inflow (matches _is_payroll_desc).
    # We scan inflows over the last 90 days; usually the answer is within
    # the last 14, but extending to 90 catches gaps and long-delayed wires.
    paycheck_lookback_start = today - timedelta(days=90)
    paycheck_rows = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents > 0)
        .where(Transaction.posted_date >= paycheck_lookback_start)
        .where(Transaction.posted_date <= today)
        .order_by(Transaction.posted_date.desc())
    ).scalars().all()
    payroll_history = [tx for tx in paycheck_rows if _is_payroll_desc(tx)]
    latest_paycheck_cents: int | None = None
    latest_paycheck_posted_date = None
    latest_paycheck_days_ago: int | None = None
    if payroll_history:
        latest = payroll_history[0]
        latest_paycheck_cents = int(latest.amount_cents)
        latest_paycheck_posted_date = latest.posted_date
        latest_paycheck_days_ago = (today - latest.posted_date).days

    # Sprint O-2 — paycheck cadence (typical-per-month, median-gap next
    # paycheck), expected-remaining income, the month's landed / expected
    # total, and windfalls all come from `compute_month_income` (`_mfi`,
    # computed near the top of this function). That math used to live
    # here inline; it now lives in one module so the ledger, projection
    # and rollup can't disagree on income.
    #
    # `payroll_history` above is still computed locally — it feeds the
    # "did I get paid this week?" latest-paycheck chip, which is a
    # different question than "what will I earn this month."
    expected_remaining_income = _mfi.expected_remaining_cents
    next_expected_paycheck_date = _mfi.next_paycheck_date
    month_income_landed = _mfi.landed_cents
    month_income_expected_total = _mfi.expected_total_cents
    month_other_income_landed = _mfi.other_income_cents

    # ----------------------------------------------------------------
    # safe_to_spend and EOM net flow — moved here in Sprint O-1
    # (2026-05-15) so the hero anchors to the actual May expected
    # income, not the 90-day trailing avg. Prior placement (just after
    # variable_actual was computed) had no access to month_income_*
    # because the paycheck block ran later.
    #
    # Fallback: if for some reason month_income_expected_total is 0
    # (new install, no payroll history), drop back to the 90-day avg
    # so the hero doesn't show wildly wrong numbers.
    # ----------------------------------------------------------------
    income_for_safe = (
        month_income_expected_total
        if month_income_expected_total > 0
        else recurring_income_cents
    )

    safe_to_spend = (
        income_for_safe
        - savings_goal_target
        - committed_actual
        - variable_actual
        - committed_remaining
    )

    # EOM projection: same income source for symmetry with the hero.
    eom_projected_net_flow = income_for_safe - eom_projected_outflow

    # Wave 5 fix H + harder-truth follow-up (2026-05-14) — closes WF 8.
    #
    # Originally summed checking + savings as "liquid," but user feedback:
    # counting savings as available misleads — savings holds *goal money*,
    # not spending money. Switched to checking-only.
    #
    # Follow-up (2026-05-14 evening): also include expected paychecks
    # that haven't landed yet this month. The "true" available-cash math
    # is forward-looking: starting from current checking, add expected
    # income through end of month, subtract bills still due. That gives
    # a real liquidity number.
    liquid_accts = db.execute(
        select(Account).where(
            Account.is_active.is_(True),
            Account.account_type == AccountType.checking,
        )
    ).scalars().all()
    liquid_balance = sum(
        int(a.current_balance_cents or 0) for a in liquid_accts
    )
    available_cash = (
        liquid_balance + expected_remaining_income - committed_remaining
    )

    return BudgetRollupResponse(
        month_start=ms,
        pace=round(pace, 3),
        total_budget_cents=total_budget,
        total_actual_cents=total_actual,
        rows=rows,
        unbudgeted_spending=unbudgeted,
        monthly_income_cents=monthly_income_cents,
        recurring_income_cents=recurring_income_cents,
        real_budget_cents=real_budget,
        savings_actual_cents=savings_actual,
        savings_actual_etrade_cents=savings_actual_etrade,
        savings_actual_other_cents=savings_actual_other,
        savings_goal_target_cents=savings_goal_target,
        mom_compare=mom_compare,
        rent_attributed_tx_ids=rent_attributed_tx_ids,
        # Sprint I additions
        real_actual_cents=real_actual,
        committed_caps_total_cents=committed_caps_total,
        safe_to_spend_cents=safe_to_spend,
        committed_remaining_cents=committed_remaining,
        unbudgeted_actual_cents=unbudgeted_actual,
        eom_projected_outflow_cents=eom_projected_outflow,
        eom_projected_net_flow_cents=eom_projected_net_flow,
        committed_actual_cents=committed_actual,
        variable_actual_cents=variable_actual,
        variable_eom_estimate_cents=variable_eom_estimate,
        trailing_3mo_net_flow_cents=trailing_3mo_net_flow,
        latest_paycheck_cents=latest_paycheck_cents,
        latest_paycheck_posted_date=latest_paycheck_posted_date,
        latest_paycheck_days_ago=latest_paycheck_days_ago,
        liquid_balance_cents=liquid_balance,
        available_cash_cents=available_cash,
        expected_remaining_income_cents=expected_remaining_income,
        next_expected_paycheck_date=next_expected_paycheck_date,
        month_income_landed_cents=month_income_landed,
        month_income_expected_total_cents=month_income_expected_total,
        month_other_income_landed_cents=month_other_income_landed,
    )


# ----------------------------------------------------------------------
#  G-2 — Projection endpoint
# ----------------------------------------------------------------------


class ProjectionPointOut(BaseModel):
    month_index: int
    checking_cents: int
    savings_cents: int
    investment_cents: int
    net_cents: int
    income_cents: int
    outflow_cents: int


class CategoryBaselineOut(BaseModel):
    """Per-category baseline so the UI can render the what-if sliders.

    `monthly_cents` is the user's ACTUAL 3-month rolling spend in this
    category — that's what the override math diffs against. If the
    user has set a budget cap that differs, it's surfaced separately
    as `budget_cap_cents` so the slider UI can show "your cap: $X" as
    a reference marker.
    """
    id: int
    name: str
    monthly_cents: int
    budget_cap_cents: int = 0


class ProjectionRequest(BaseModel):
    """POST body — empty means status-quo projection over the default window."""
    months: int = PydField(24, ge=1, le=120)
    # Optional what-if knobs. Each value REPLACES the baseline for that
    # category in the projection's outflow math. Missing categories use
    # their status-quo monthly_cents.
    category_overrides: dict[int, int] | None = None
    # G-11 — per-goal monthly investment contribution. Keyed by goal_id.
    # The projector sums these into the total checking → investment
    # sweep. Goals are still loaded server-side from the Goals table;
    # this map only carries the amount the user wants to contribute to
    # each goal in the scenario.
    goal_contributions: dict[int, int] | None = None
    # Legacy field — kept for backwards compat with the G-6 single-slider
    # UI. If `goal_contributions` is provided, it takes precedence; this
    # field becomes a fallback total sweep when no per-goal map is sent.
    monthly_investment_contribution_cents: int = 0
    # When True, returns a separate `baseline_points` series with the
    # status-quo projection alongside the override series. Useful for
    # drawing both as overlaid lines in the chart.
    include_baseline: bool = True


class GoalBaselineOut(BaseModel):
    """G-11 — per-goal baseline for the multi-goal slider UI."""
    id: int
    name: str
    target_amount_cents: int
    current_amount_cents: int
    target_date: date | None
    months_left: int | None
    needed_monthly_cents: int


class ProjectionResponse(BaseModel):
    months: int
    investment_apy: float
    checking_cap_cents: int
    # The scenario the request asked for (with overrides applied).
    scenario_points: list[ProjectionPointOut]
    # Status-quo projection (no overrides), when include_baseline=True.
    baseline_points: list[ProjectionPointOut] | None = None
    # ---- Sprint J-1a: Optimistic projection ----
    # Pace-aware EOM extrapolation of THIS month's spending, projected
    # forward. Conservative line (baseline) uses 90-day rolling avg —
    # honest about the past but inflated by rent-timing artifacts.
    # Optimistic line answers "if every future month plays out like
    # this one is currently pacing." Together they bracket the range.
    optimistic_points: list[ProjectionPointOut] | None = None
    monthly_outflow_cents_optimistic: int | None = None
    # Echo back the inputs the projector used so the UI can show them
    # under the chart ("Assumes $X/mo income, $Y/mo outflow, 7% return").
    monthly_income_cents: int
    monthly_outflow_cents_baseline: int
    monthly_outflow_cents_scenario: int
    starting_checking_cents: int
    starting_savings_cents: int
    starting_investment_cents: int
    starting_net_cents: int
    liability_cents: int
    # Per-category baseline for slider construction.
    categories: list[CategoryBaselineOut]
    # G-11 — per-goal baseline. UI renders one slider per active goal.
    goals: list[GoalBaselineOut] = []
    # Headline impact figure — net flow over the projection window
    # (scenario - baseline). Positive means the scenario saves more.
    scenario_vs_baseline_net_cents: int


def project_budgets(
    body: ProjectionRequest,
    db: Session = Depends(get_db),
) -> ProjectionResponse:
    """Project balances forward N months. The default scenario is
    status-quo; pass `category_overrides` to model what-if cuts/raises.

    Returns:
        scenario_points: month-by-month balances under the requested
          override scheme.
        baseline_points: month-by-month balances if nothing changes
          (only when include_baseline=True). Used by the UI to draw
          a comparison line.
        categories: per-category baseline so the UI can render sliders
          starting at the user's current budget for each.
        scenario_vs_baseline_net_cents: positive when the scenario
          ends with more cash than the baseline; drives the headline
          "$X more saved over 24 months" copy.
    """
    from finance_app.budgets.projector import (
        apply_overrides,
        gather_inputs,
        project,
    )

    today = date.today()
    ms = _normalize_month_start(today)
    inputs = gather_inputs(db, ms)
    overrides = body.category_overrides or {}
    scenario_outflow_cents = apply_overrides(
        inputs["monthly_outflow_cents"],
        inputs["category_baseline"],
        overrides,
    )

    # G-11 — sum per-goal contributions OR fall back to the legacy
    # single-slider field. Per-goal takes precedence when both are sent.
    if body.goal_contributions:
        total_investment_contrib = sum(
            max(0, v) for v in body.goal_contributions.values()
        )
    else:
        total_investment_contrib = max(0, body.monthly_investment_contribution_cents)

    # Scenario run — with overrides applied.
    scenario = project(
        months=body.months,
        start=inputs["start"],
        monthly_income_cents=inputs["monthly_income_cents"],
        monthly_outflow_cents=scenario_outflow_cents,
        liability_cents=inputs["liability_cents"],
        monthly_investment_contribution_cents=total_investment_contrib,
    )

    baseline_response = None
    baseline_net_at_end = scenario.points[-1].net_cents
    if body.include_baseline:
        baseline = project(
            months=body.months,
            start=inputs["start"],
            monthly_income_cents=inputs["monthly_income_cents"],
            monthly_outflow_cents=inputs["monthly_outflow_cents"],
            liability_cents=inputs["liability_cents"],
            monthly_investment_contribution_cents=0,
        )
        baseline_response = [
            ProjectionPointOut(**p.__dict__) for p in baseline.points
        ]
        baseline_net_at_end = baseline.points[-1].net_cents

    # Sprint J-1a — also run the optimistic projection (pace-aware EOM
    # extrapolation of THIS month's spending). Only when the user asked
    # for the baseline too; otherwise the chart only renders the
    # scenario line and the extra projection would be wasted compute.
    optimistic_response = None
    optimistic_outflow = inputs.get("optimistic_monthly_outflow_cents", 0)
    if body.include_baseline and optimistic_outflow > 0:
        optimistic = project(
            months=body.months,
            start=inputs["start"],
            monthly_income_cents=inputs["monthly_income_cents"],
            monthly_outflow_cents=optimistic_outflow,
            liability_cents=inputs["liability_cents"],
            monthly_investment_contribution_cents=0,
        )
        optimistic_response = [
            ProjectionPointOut(**p.__dict__) for p in optimistic.points
        ]

    scenario_net_at_end = scenario.points[-1].net_cents

    categories_out = [
        CategoryBaselineOut(**c) for c in inputs["category_baseline"].values()
    ]
    categories_out.sort(key=lambda c: -c.monthly_cents)

    # G-11 — load active goals so the UI can render per-goal sliders.
    from finance_app.db.models import Goal as _Goal

    goals_query = db.execute(
        select(_Goal)
        .where(_Goal.target_amount_cents > 0)
    ).scalars().all()
    goals_out: list[GoalBaselineOut] = []
    for g in goals_query:
        # Only surface goals whose target is in the future and there's
        # still a gap to close — completed or expired goals shouldn't
        # show up as sliders.
        if g.target_date is None or g.target_date <= today:
            continue
        # Wave 5 fix A: use linked-account balance when present.
        eff_current = _effective_goal_current_cents(g, db)
        gap = g.target_amount_cents - eff_current
        if gap <= 0:
            continue
        months_left = (g.target_date.year - today.year) * 12 + (g.target_date.month - today.month)
        months_left = max(1, months_left)
        needed = max(0, gap // months_left)
        goals_out.append(GoalBaselineOut(
            id=g.id,
            name=g.name,
            target_amount_cents=g.target_amount_cents,
            current_amount_cents=eff_current,
            target_date=g.target_date,
            months_left=months_left,
            needed_monthly_cents=needed,
        ))
    goals_out.sort(key=lambda g: g.needed_monthly_cents, reverse=True)

    return ProjectionResponse(
        months=body.months,
        investment_apy=scenario.investment_apy,
        checking_cap_cents=scenario.checking_cap_cents,
        scenario_points=[ProjectionPointOut(**p.__dict__) for p in scenario.points],
        baseline_points=baseline_response,
        optimistic_points=optimistic_response,
        monthly_outflow_cents_optimistic=optimistic_outflow if optimistic_outflow > 0 else None,
        monthly_income_cents=inputs["monthly_income_cents"],
        monthly_outflow_cents_baseline=inputs["monthly_outflow_cents"],
        monthly_outflow_cents_scenario=scenario_outflow_cents,
        starting_checking_cents=inputs["start"].checking_cents,
        starting_savings_cents=inputs["start"].savings_cents,
        starting_investment_cents=inputs["start"].investment_cents,
        starting_net_cents=inputs["start"].total_cents - inputs["liability_cents"],
        liability_cents=inputs["liability_cents"],
        categories=categories_out,
        goals=goals_out,
        scenario_vs_baseline_net_cents=scenario_net_at_end - baseline_net_at_end,
    )






# ----------------------------------------------------------------------
#  G-4 — Recommendations endpoint
# ----------------------------------------------------------------------


class RecommendationApplyOut(BaseModel):
    category_overrides: dict[int, int] = {}
    # G-11 — per-goal contribution map. UI merges into its global state.
    goal_contributions: dict[int, int] = {}
    monthly_investment_contribution_cents: int = 0


class RecommendationOut(BaseModel):
    kind: str
    title: str
    body: str
    expected_monthly_impact_cents: int
    priority: float
    apply: RecommendationApplyOut | None = None
    meta: dict = {}


class RecommendationsResponse(BaseModel):
    recommendations: list[RecommendationOut]
    total_potential_monthly_savings_cents: int
    total_potential_annual_savings_cents: int


def get_recommendations(db: Session = Depends(get_db)) -> RecommendationsResponse:
    """Return the budget recommendations + their cumulative headline savings."""
    from finance_app.budgets.recommender import gather_recommendations

    recs = gather_recommendations(db)
    out_recs: list[RecommendationOut] = []
    total_monthly = 0
    for r in recs:
        d = r.as_dict()
        apply_out = None
        if d["apply"]:
            apply_out = RecommendationApplyOut(
                category_overrides=d["apply"]["category_overrides"],
                goal_contributions=d["apply"].get("goal_contributions", {}),
                monthly_investment_contribution_cents=d["apply"]["monthly_investment_contribution_cents"],
            )
        out_recs.append(RecommendationOut(
            kind=d["kind"],
            title=d["title"],
            body=d["body"],
            expected_monthly_impact_cents=d["expected_monthly_impact_cents"],
            priority=d["priority"],
            apply=apply_out,
            meta=d["meta"],
        ))
        # Only count savings recs toward the headline. Goal-driven recs
        # increase outflow toward the goal - they're not "found money"
        # in the same sense.
        if r.kind in ("overspend", "bundle_dup", "yield_shift", "store_swap"):
            total_monthly += r.expected_monthly_impact_cents

    return RecommendationsResponse(
        recommendations=out_recs,
        total_potential_monthly_savings_cents=total_monthly,
        total_potential_annual_savings_cents=total_monthly * 12,
    )


# ----------------------------------------------------------------------
#  EOM detail — itemised backing for the "Where does the EOM projection
#  come from?" card.
#
#  The card already receives the full rollup (every per-category row with
#  its projected_eom), so it itemises the committed-headroom and variable
#  components itself. This endpoint supplies only the two things the
#  rollup CANNOT give it:
#    * the upcoming paycheck(s) this calendar month — the rollup's
#      effective-month income math reports "0 remaining" because a wire
#      posting on/after the 28th is bucketed into next month;
#    * the credit-card debt actually taken on this month — concrete,
#      auditable charges-minus-payments, the answer to "if I'm projected
#      negative, how much card debt is that really?"
# ----------------------------------------------------------------------


class EomIncomeItem(BaseModel):
    """One paycheck still expected before month-end."""
    on_date: date
    label: str
    amount_cents: int            # signed (+ inflow)


class EomCreditCardOut(BaseModel):
    """Credit-card debt actually accrued this calendar month."""
    account_name: str
    current_balance_cents: int        # negative = balance owed
    charges_mtd_cents: int            # positive magnitude of new charges
    payments_mtd_cents: int           # positive magnitude of payments made
    net_debt_change_mtd_cents: int    # charges - payments; positive = took on debt


class EomDetailResponse(BaseModel):
    month_start: date
    today: date
    last_day: date
    # Upcoming paychecks that will post before month-end (calendar basis).
    expected_income: list[EomIncomeItem]
    # Credit-card debt accrued this month. None if there is no card account.
    credit_card: EomCreditCardOut | None


def eom_detail(
    month_start: date,
    db: Session = Depends(get_db),
) -> EomDetailResponse:
    """Itemised backing for the EOM-projection card.

    Supplies the two pieces the rollup cannot: the upcoming paycheck(s)
    this calendar month, and the credit-card debt taken on so far.
    """
    ms = _normalize_month_start(month_start)
    today = date.today()
    last_dom = monthrange(ms.year, ms.month)[1]
    last_day = date(ms.year, ms.month, last_dom)

    # ---- Paychecks still expected this month ----
    # Sourced from `compute_month_income` — the ONE canonical income
    # module — NOT from the cash-flow forecaster. Chris is paid
    # semi-monthly (the 1st and the 15th); the wire for the 1st routinely
    # lands a few days early, on the 28th-31st of the PRIOR month.
    # `compute_month_income`'s effective-month rule handles that (a
    # day>=28 wire counts toward next month), so it correctly knows both
    # of a month's paychecks and what — if anything — is still expected.
    # The cash-flow forecaster steps a flat day-gap and wrongly projects
    # an end-of-month "paycheck" that is really next month's 1st; using
    # it here invented a phantom paycheck.
    expected_income: list[EomIncomeItem] = []
    mfi = compute_month_income(db, ms)
    if (
        mfi.expected_remaining_cents > 0
        and mfi.next_paycheck_date is not None
        and ms <= mfi.next_paycheck_date <= last_day
    ):
        expected_income.append(
            EomIncomeItem(
                on_date=mfi.next_paycheck_date,
                label="Expected paycheck",
                amount_cents=mfi.expected_remaining_cents,
            )
        )

    # ---- Credit-card debt taken on this month ----
    # Concrete and auditable: on a credit-card account a purchase posts as
    # a negative amount (balance grows more negative) and a payment posts
    # positive. Net debt change MTD = charges - payments.
    credit_card: EomCreditCardOut | None = None
    cc_accounts = db.execute(
        select(Account).where(Account.account_type == AccountType.credit_card)
    ).scalars().all()
    if cc_accounts:
        cc_ids = [a.id for a in cc_accounts]
        cc_txns = db.execute(
            select(Transaction)
            .where(Transaction.account_id.in_(cc_ids))
            .where(Transaction.posted_date >= ms)
            .where(Transaction.posted_date <= last_day)
        ).scalars().all()
        charges = sum(-int(t.amount_cents) for t in cc_txns if t.amount_cents < 0)
        payments = sum(int(t.amount_cents) for t in cc_txns if t.amount_cents > 0)
        current_balance = sum(int(a.current_balance_cents or 0) for a in cc_accounts)
        name = (
            cc_accounts[0].name
            if len(cc_accounts) == 1
            else f"{len(cc_accounts)} credit cards"
        )
        credit_card = EomCreditCardOut(
            account_name=name,
            current_balance_cents=current_balance,
            charges_mtd_cents=charges,
            payments_mtd_cents=payments,
            net_debt_change_mtd_cents=charges - payments,
        )

    return EomDetailResponse(
        month_start=ms,
        today=today,
        last_day=last_day,
        expected_income=expected_income,
        credit_card=credit_card,
    )
