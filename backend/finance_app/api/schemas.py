"""Pydantic schemas for API request/response bodies.

Keep these thin — they're the contract between backend and frontend. The TS
client is generated from FastAPI's OpenAPI spec, so every field here becomes
a frontend type automatically.
"""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from finance_app.db.models import (
    AccountType,
    BudgetStatus,
    CategorySource,
    CreditBureau,
    CreditScoringModel,
    GoalContributionSource,
    GoalKind,
    GoalStatus,
    IngestSource,
    InstitutionKind,
    LegalClaimStatus,
    ProofRequirement,
    ScoreSource,
    TransactionStatus,
)


class OrmModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---- Institutions & accounts ----

class InstitutionIn(BaseModel):
    name: str
    kind: InstitutionKind = InstitutionKind.bank
    website: str | None = None
    notes: str | None = None


class InstitutionOut(OrmModel):
    id: int
    name: str
    kind: InstitutionKind
    website: str | None
    notes: str | None


class AccountIn(BaseModel):
    institution_id: int
    name: str
    account_type: AccountType
    mask: str | None = None
    currency: str = "USD"
    credit_limit_cents: int | None = None
    apr_bps: int | None = None
    notes: str | None = None


class AccountOut(OrmModel):
    id: int
    institution_id: int
    institution_name: str | None = None  # populated via JOIN in list_accounts
    name: str
    account_type: AccountType
    mask: str | None
    currency: str
    is_active: bool
    # Live balance in cents. Positive for assets (checking, savings,
    # investments), negative for liabilities (credit cards, loans).
    # Populated by Plaid sync; manual accounts can update via PATCH.
    current_balance_cents: int | None = None
    credit_limit_cents: int | None
    last_statement_balance_cents: int | None = None
    last_statement_date: date | None = None
    statement_close_day: int | None = None
    statement_due_day: int | None = None
    apr_bps: int | None
    # Manual binding for the card-benefits matcher (set on Connections).
    card_profile_override: str | None = None
    # Wave 5 fix F (2026-05-14): freshness signal for the UI. Populated
    # from the parent PlaidItem.last_synced_at when present; null for
    # manual / CSV accounts. UI renders a chip like "Synced 2 hours ago"
    # so the user can tell whether a balance is current or stale.
    last_synced_at: datetime | None = None


# ---- Categories ----

class CategoryOut(OrmModel):
    id: int
    name: str
    slug: str
    parent_id: int | None
    is_discretionary: bool
    icon: str | None


# ---- Transactions ----

class TransactionOut(OrmModel):
    id: int
    account_id: int
    posted_date: date
    amount_cents: int
    currency: str
    status: TransactionStatus
    description_raw: str
    description_clean: str | None
    memo: str | None
    merchant_id: int | None
    category_id: int | None
    category_source: CategorySource
    source: IngestSource
    external_id: str
    created_at: datetime
    # True = user-flagged one-off (medical emergency, car repair). The
    # multi-month projection excludes it; the UI shows a "one-time" badge.
    is_one_time: bool = False


class TransactionFilter(BaseModel):
    account_id: int | None = None
    category_id: int | None = None
    start_date: date | None = None
    end_date: date | None = None
    min_amount_cents: int | None = None
    max_amount_cents: int | None = None
    search: str | None = Field(default=None, description="Case-insensitive substring in description")
    only_uncategorized: bool = False
    limit: int = 200
    offset: int = 0


class TransactionRecategorize(BaseModel):
    category_id: int | None
    merchant_id: int | None = None


class TransactionOneTimeUpdate(BaseModel):
    """Body for POST /transactions/{id}/one-time — toggles the one-time flag.

    A one-time transaction is a non-recurring spike the user does not want
    smeared into the projection's monthly outflow rate.
    """
    is_one_time: bool


# ---- Rules ----

class RuleIn(BaseModel):
    name: str
    pattern: str
    is_regex: bool = False
    category_id: int | None = None
    merchant_id: int | None = None
    priority: int = 100
    min_amount_cents: int | None = None
    max_amount_cents: int | None = None
    is_active: bool = True


class RuleOut(OrmModel):
    id: int
    name: str
    pattern: str
    is_regex: bool
    category_id: int | None
    merchant_id: int | None
    priority: int
    is_active: bool
    is_seed: bool
    min_amount_cents: int | None
    max_amount_cents: int | None
    # Hit-tracking. Lets the rules-management UI show which rules are
    # actually pulling weight vs. dead noise. Maintained best-effort by
    # CategorizationEngine.categorize_all().
    hit_count: int = 0
    last_hit_at: datetime | None = None


# ---- Ingest ----

class IngestCsvResponse(BaseModel):
    batch_id: int
    rows_parsed: int
    rows_created: int
    rows_duplicate: int
    errors: str | None


# ---- Stats ----

class CategoryMonthRow(BaseModel):
    year: int
    month: int
    category_id: int | None
    category_name: str | None
    outflow_cents: int
    inflow_cents: int
    txn_count: int


class SummaryResponse(BaseModel):
    start_date: date
    end_date: date
    total_inflow_cents: int
    total_outflow_cents: int
    net_cents: int
    by_category: list[CategoryMonthRow]
    # Server-side computation timestamp — drives the SyncFreshnessChip on
    # the Overview panel. Populated at response time, not cached.
    generated_at: datetime | None = None


# ---- Month-over-month trend ----

class MonthOutflowCell(BaseModel):
    month_start: date  # first day of the month this cell represents
    outflow_cents: int


class CategoryTrendRow(BaseModel):
    category_id: int | None
    category_name: str | None
    # Parallel array — index i corresponds to months[i] in the response envelope
    outflow_by_month_cents: list[int]
    avg_outflow_cents: int
    # Percent change of the most recent month vs the trailing average of the rest.
    # Positive = spending up, negative = spending down. None if not enough history.
    trend_pct_vs_avg: float | None


class MonthOverMonthResponse(BaseModel):
    months: list[MonthOutflowCell]  # length N; one per month window, ordered oldest → newest
    categories: list[CategoryTrendRow]
    # Server-side computation timestamp — drives the SyncFreshnessChip on
    # the Trends panel. Populated at response time.
    generated_at: datetime | None = None


# ---- Budgets ----

class BudgetIn(BaseModel):
    category_id: int
    month_start: date = Field(description="First day of the budget month (YYYY-MM-01)")
    amount_cents: int = Field(ge=0, description="Positive cents — cap on outflow this month")
    rollover: bool = False
    notes: str | None = None


class BudgetOut(OrmModel):
    id: int
    category_id: int
    month_start: date
    amount_cents: int
    rollover: bool
    notes: str | None


class BudgetRollupRow(BaseModel):
    """One line item in the monthly budget view — budget vs actual."""
    category_id: int
    category_name: str
    budget_cents: int  # cap (this month's amount as configured by user)
    actual_outflow_cents: int  # positive cents, sum of -amount_cents for txns in period
    remaining_cents: int  # effective_budget - actual (can go negative)
    pct_used: float  # 0..∞, 100 = at cap
    status: BudgetStatus
    # Pace projection (Phase 7.3). Linear extrapolation: at the current
    # burn rate, what will the month-end total be? Useful when a user
    # is on day 12 with $300 spent — knowing they'll land at ~$750 vs.
    # their $500 cap is more actionable than "60% used."
    # All fields optional — None on rows where the budget is 0 or the
    # month hasn't elapsed enough to meaningfully extrapolate (< 5%).
    projected_eom_cents: int | None = None
    projected_overage_cents: int | None = None  # negative = projected to come in under
    projected_pct_used: float | None = None  # 0..∞, 100 = at cap
    # Rollover (YNAB-style carry-forward). When a Budget row has
    # ``rollover=True``, prior month's leftover (or overspend) carries
    # into this month's effective budget. Both fields default to 0 for
    # backward compat with non-rollover budgets, so existing clients
    # parsing this response don't break.
    #
    # rollover_in_cents: sum carried in from prior rollover-flagged
    #   month's effective remainder. Positive = unused budget rolled
    #   forward. Negative = prior month overspent and the deficit is
    #   being absorbed here.
    # effective_budget_cents: budget_cents + rollover_in_cents. The
    #   number actually used to compute remaining / pct_used / status
    #   / projection. Defaults to budget_cents on rows without rollover.
    rollover_in_cents: int = 0
    effective_budget_cents: int = 0
    # Sprint M (2026-05-14): parent category info for super-group rollups.
    # Frontend uses these to group leaf-category rows by their parent
    # ("Housing", "Food", etc.) on the donut/bars/treemap views.
    # parent_id == null means the row IS a top-level category (super-group).
    parent_id: int | None = None
    parent_name: str | None = None
    # Catchall categories — Transfer, Credit Card Payment, Investment
    # Contribution, Uncategorized — are not real "spending"; they're
    # internal money movement. The donut / bars / treemap visualizations
    # filter rows where this is true so the chart shows only meaningful
    # outflow categories.
    is_catchall: bool = False
    # Whether the category is discretionary (variable spending — groceries,
    # restaurants, fun) vs non-discretionary ("committed" — rent, utilities,
    # insurance, loans). The Safe-to-Spend / Available-Cash breakdown uses
    # this to itemize the "bills still due" line: committed_remaining is the
    # sum, over NON-discretionary capped rows, of max(0, cap - actual).
    is_discretionary: bool = False


class BudgetRollupResponse(BaseModel):
    month_start: date
    # "Pace" = fraction of the month elapsed (0..1). Drives the warning threshold.
    pace: float
    total_budget_cents: int
    total_actual_cents: int
    rows: list[BudgetRollupRow]
    # Categories that have spending but no budget set — surfacing these so Chris
    # sees his blind spots and can decide to budget them or explicitly ignore.
    unbudgeted_spending: list[BudgetRollupRow]
    # ---- Sprint H additions (2026-05-13) ----
    # 3-month rolling average of ALL positive inflows (Livio payroll +
    # peer transfers + settlement payouts). Shown next to BUDGETED so
    # the user sees what actually came in. Includes outliers because
    # they DID happen historically.
    monthly_income_cents: int = 0
    # 3-month rolling average of recurring payroll wires ONLY (filters
    # out one-off settlement payouts, peer transfers, etc.). This is
    # the number the projector uses for forecasting because one-off
    # windfalls shouldn't be extrapolated as future monthly income.
    recurring_income_cents: int = 0
    # "Real" budget cap (excludes catch-all categories like Transfer and
    # Uncategorized whose huge nominal caps are accounting placeholders,
    # not real spending limits). Used by the UI to show the headline number
    # the user actually plans to spend.
    real_budget_cents: int = 0
    # Auto-detected savings: transfers to savings / investment accounts this
    # month. Shown as a synthetic Savings budget row in the rollup table.
    savings_actual_cents: int = 0
    # Sprint K-1 — split savings by destination. eTrade-bound counts toward
    # the goal target; other (Albert auto-savings, brokerage growth, etc.)
    # is bonus on top.
    savings_actual_etrade_cents: int = 0
    savings_actual_other_cents: int = 0
    # Sum of all goals' monthly target contributions for this month. The
    # frontend shows max(savings_actual, savings_goal_target) as the
    # "savings budget" so the bar doesn't degenerate when actual > goal.
    savings_goal_target_cents: int = 0
    # Per-category MoM delta: { category_id: (this_month_cents, three_mo_avg_cents) }
    # H-4a — drives the "vs 3-mo avg" chip on every row.
    mom_compare: dict[int, tuple[int, int]] = {}
    # Rent attribution flag — IDs of transactions that were time-shifted
    # FORWARD into this month (paid late prior month for this month's rent).
    # Used by the frontend to label them "Paid Apr 30 for May" in the drawer.
    rent_attributed_tx_ids: list[int] = []
    # ---- Sprint I additions (budget-at-a-glance, 2026-05-13) ----
    # "Real" total_actual that matches real_budget_cents — excludes spend in
    # catch-all categories (Transfer, Uncategorized, Credit Card Payment,
    # Investment Contribution) so the headline math is apples-to-apples.
    real_actual_cents: int = 0
    # Committed (non-discretionary) caps total. Sum of caps for categories
    # tagged is_discretionary=False in the DB. Represents bills that WILL
    # happen this month (rent, insurance, utilities, etc.).
    committed_caps_total_cents: int = 0
    # "Safe to spend this month" — the hero anchor. Formula:
    #   safe_to_spend = recurring_income
    #                 - savings_goal_target
    #                 - total_actual_so_far  (everything spent this month)
    #                 - committed_caps_not_yet_paid  (bills still due by EOM)
    # If negative: user is already over their safe-spend budget for the month.
    safe_to_spend_cents: int = 0
    # Detail breakdown for the hero subtitle / debug:
    committed_remaining_cents: int = 0      # bills due by EOM that aren't paid yet
    unbudgeted_actual_cents: int = 0        # sum of spend in unbudgeted categories
    # End-of-month linear-pace projection of TOTAL outflow. Accounts for
    # rent (paid as one-shot, not extrapolated) by separating committed
    # actual from variable actual. Used by the EOM stat card to replace
    # the misleading mid-month snapshot.
    eom_projected_outflow_cents: int = 0
    # EOM net flow = recurring_income - eom_projected_outflow. Negative
    # means you'll end the month spending more than you took in.
    eom_projected_net_flow_cents: int = 0
    # EOM breakdown (2026-05-14): explicit components so the UI can
    # render a transparent "where does this negative come from"
    # explainer. Together with `committed_remaining_cents` (already
    # exposed) and `recurring_income_cents`, these fully describe the
    # EOM projection math:
    #   EOM = income − (committed_actual + committed_remaining
    #                   + variable_eom_estimate)
    committed_actual_cents: int = 0
    variable_actual_cents: int = 0
    variable_eom_estimate_cents: int = 0
    # Trailing 3-mo avg net flow — baseline for the "are you building or
    # burning wealth?" Wealth Pulse card.
    trailing_3mo_net_flow_cents: int = 0
    # Wave 5 fix G (2026-05-14): closes WF 5 ("Did I get paid this week?").
    # The most recent payroll-pattern wire (Livio or any other recurring
    # employer) and how many days ago it landed. Surfaced as a sub-line on
    # the Income stat card.
    latest_paycheck_cents: int | None = None
    latest_paycheck_posted_date: date | None = None
    latest_paycheck_days_ago: int | None = None
    # Wave 5 fix H (2026-05-14): closes WF 8 ("Do I have liquidity?").
    # Live checking balance (savings excluded per harder-truth follow-up).
    liquid_balance_cents: int = 0
    # Forward-looking available cash:
    #   liquid (checking) + expected_remaining_income − committed bills due.
    # This reflects what you'll actually have through end of month, not
    # just a snapshot of "right now."
    available_cash_cents: int = 0
    # Sum of expected paychecks landing between today (exclusive) and the
    # end of this month, derived from your payroll cadence. 0 if no
    # more paychecks expected this month.
    expected_remaining_income_cents: int = 0
    # The next expected paycheck date (heuristic from cadence). Surfaced
    # on the UI so the user knows when the next income arrives.
    next_expected_paycheck_date: date | None = None
    # Sprint O-1 (2026-05-15): the Income card was showing a 90-day
    # trailing Livio average and labelling it "INCOME", which read to
    # the user as "May income". These two fields answer the question
    # the user is actually asking:
    #
    #   month_income_landed_cents       — sum of is_payroll inflows
    #                                     POSTED so far in this month.
    #                                     Matches what your bank app
    #                                     shows for paychecks landed.
    #   month_income_expected_total_cents — landed + still-expected
    #                                       paychecks before EOM.
    #                                       The "what will I make this
    #                                       month" headline number.
    #
    # Both are Livio-only (employer match). Brigit, Labaton, Zelle-
    # from-peers are EXCLUDED on purpose — they aren't recurring income
    # and shouldn't move the headline.
    month_income_landed_cents: int = 0
    month_income_expected_total_cents: int = 0
    # Sprint O-1 follow-up: one-time / windfall income that landed this
    # month (Brigit settlement, Labaton payout, etc.). Surfaced as a
    # secondary line on the Income card so the user sees their TOTAL
    # money-in for the month. NOT included in month_income_expected_total
    # because windfalls aren't expected to recur — adding them to the
    # expected number would over-promise future income.
    month_other_income_landed_cents: int = 0


# ---- Budget templates (copy / fill from average) ----

class BudgetCopyRequest(BaseModel):
    """Copy budgets from one month to another."""
    target_month_start: date = Field(description="Month to copy budgets *into* (YYYY-MM-01)")
    source_month_start: date | None = Field(
        default=None,
        description="Month to copy budgets *from*. Defaults to target − 1 month.",
    )
    overwrite: bool = Field(
        default=False,
        description="If False (default), skip categories that already have a budget in target month.",
    )


class BudgetFillRequest(BaseModel):
    """Fill budgets in a month from the trailing average of category spending."""
    target_month_start: date
    lookback_months: int = Field(default=3, ge=1, le=12, description="How many recent months to average")
    round_up_to_cents: int = Field(
        default=2_500,
        ge=100,
        description="Round each generated cap up to this granularity. Default $25.",
    )
    overwrite: bool = Field(
        default=False,
        description="If False, skip categories that already have a budget in target month.",
    )
    min_avg_cents: int = Field(
        default=500,
        ge=0,
        description=(
            "Skip categories whose trailing avg is below this — avoids creating "
            "$0/$5 noise budgets for categories with one-off charges."
        ),
    )


class BudgetTemplateApplied(BaseModel):
    """Per-row trace of what the template did, so the UI can explain."""
    category_id: int
    category_name: str
    amount_cents: int
    action: str  # "created" | "updated" | "skipped_existing" | "skipped_low_avg"


class BudgetTemplateResponse(BaseModel):
    target_month_start: date
    source_month_start: date | None = None  # only set for copy
    lookback_months: int | None = None  # only set for fill
    created: int
    updated: int
    skipped: int
    rows: list[BudgetTemplateApplied]


# ---- Sprint L — Zero-based assignment ledger (2026-05-14) ----
#
# A unified view of "where does every dollar of income go." Pulls from
# existing budget caps, goal targets, and debt minimums to produce a
# balanced ledger: income = committed + variable + savings + debt +
# unassigned. Unassigned can be negative if you've over-committed; the
# UI surfaces that as a deficit to resolve.

class AssignmentItem(BaseModel):
    """One line in the assignment ledger.

    A row represents a single category, goal, or debt account with a
    planned amount (what you committed to) and an actual amount (what
    happened so far this month). Both are POSITIVE cents — outflows
    are stored as magnitudes here for UI simplicity.
    """
    kind: str  # "committed" | "variable" | "savings" | "debt" | "unbudgeted_actual"
    label: str
    planned_cents: int = 0
    actual_cents: int = 0
    category_id: int | None = None
    goal_id: int | None = None
    account_id: int | None = None
    # For committed bills — flag set when this month's outflow exceeds
    # ~80% of cap (likely paid). UI uses it to dim the row.
    is_paid: bool = False
    # Sprint M-4 (2026-05-14): super-group parent for the "Group by
    # category" view toggle. Null for items that don't have a parent
    # category (savings goals, debt accounts, or top-level categories).
    parent_id: int | None = None
    parent_name: str | None = None


class AssignmentGroup(BaseModel):
    """One of the 4 top-level groups in the ledger.

    Groups: committed (non-discretionary bills), variable (discretionary
    caps), savings (goal contributions), debt (paydown). Plus a fifth
    pseudo-group `unbudgeted_actual` for spend that escaped the plan.
    """
    kind: str
    label: str
    planned_cents: int = 0
    actual_cents: int = 0
    items: list[AssignmentItem] = []


class MonthHistorySummary(BaseModel):
    """One row of the 3-month drift strip.

    Per-month totals split by kind. Lets the UI render a small chart of
    'were you over or under on each kind, each month' so habit patterns
    become visible.
    """
    month_start: date
    income_cents: int
    planned_cents: int
    actual_cents: int
    # {"committed": {"planned": 316200, "actual": 284750}, "variable": {...}, ...}
    by_kind: dict[str, dict[str, int]] = {}


class AssignmentLedgerResponse(BaseModel):
    """The full zero-based assignment ledger for one month."""
    month_start: date
    # Recurring payroll income (Livio-only filter, same as the rollup).
    # This is the number every assignment is balanced against.
    income_cents: int
    # Non-recurring inflows (Dave, Venmo, settlements) — info only,
    # not counted in the assignment balance because they aren't reliable.
    irregular_income_cents: int = 0
    groups: list[AssignmentGroup]
    # Sum of planned_cents across all groups (excludes unbudgeted_actual).
    total_planned_cents: int
    # Sum of actual_cents across all groups (includes unbudgeted_actual).
    total_actual_cents: int
    # income − total_planned. Positive = surplus to assign;
    # negative = over-committed, need to trim.
    unassigned_cents: int
    # Last 3 months for drift visualization.
    history: list[MonthHistorySummary] = []


# ---- L-4: Rebalance suggestions (2026-05-14) ----
#
# When the assignment ledger shows surplus or deficit, the user clicks
# the unassigned chip and gets a ranked list of "what should I do with
# this" options. Each suggestion comes with an apply payload the
# frontend turns into a single mutation (or a multi-PATCH batch).

class RebalancePatchBudget(BaseModel):
    """A single Budget cap PATCH the frontend should issue."""
    category_id: int
    category_name: str
    current_cap_cents: int
    new_cap_cents: int


class RebalanceApply(BaseModel):
    """Apply payload — describes a frontend-side mutation.

    Variants:
      * ``noop`` — close the modal, no mutation. Used for "hold as buffer."
      * ``patch_budgets_multi`` — issue PATCH /budgets/{id} for each
        item in ``budget_patches``. Used for crush-debt and pad-overcap.
      * ``set_goal_funding_rate`` — POST a new monthly_cents to the
        goal endpoint; backend will compute the right target_date.
    """
    kind: str
    budget_patches: list[RebalancePatchBudget] = []
    goal_id: int | None = None
    goal_new_monthly_cents: int | None = None


class RebalanceSuggestion(BaseModel):
    rank: int
    # Stable id so the frontend can track which one was applied
    # (e.g. for telemetry or a "you just did this" confirmation).
    kind: str  # "crush_debt" | "fund_savings" | "pad_over_cap" | "split" | "hold"
    title: str
    description: str
    # One-line summary of the projected impact ("Clears CC in 1.4 mo").
    impact_text: str
    apply: RebalanceApply | None = None


class RebalanceSuggestionsResponse(BaseModel):
    month_start: date
    # The current unassigned amount the suggestions are addressing.
    # Positive = surplus (allocate); negative = deficit (trim).
    unassigned_cents: int
    suggestions: list[RebalanceSuggestion]


class GoalFundingRateIn(BaseModel):
    """Set a goal's effective monthly contribution rate. Backend
    recomputes target_date to keep total_amount on track."""
    monthly_cents: int = Field(..., gt=0)


# ---- Credit scores ----

class CreditScoreIn(BaseModel):
    score: int = Field(ge=300, le=900)
    bureau: CreditBureau
    scoring_model: CreditScoringModel = CreditScoringModel.fico8
    as_of: date
    source: ScoreSource = ScoreSource.manual
    source_detail: str | None = None
    notes: str | None = None


class CreditScoreOut(OrmModel):
    id: int
    score: int
    bureau: CreditBureau
    scoring_model: CreditScoringModel
    as_of: date
    source: ScoreSource
    source_detail: str | None
    notes: str | None


# ---- Credit utilization ----

class UtilizationRow(BaseModel):
    account_id: int
    account_name: str
    credit_limit_cents: int
    current_balance_cents: int  # live balance (0 if not tracked)
    last_statement_balance_cents: int  # what the bureau saw
    # Utilization reported to bureaus at last close (the number that moves your score)
    reported_utilization_pct: float | None
    # Live utilization right now (what WILL get reported if statement closes today)
    live_utilization_pct: float | None
    statement_close_day: int | None
    statement_due_day: int | None
    days_until_close: int | None  # null if close day isn't set


class UtilizationResponse(BaseModel):
    # Sum of current balances / sum of limits across all tracked credit cards
    aggregate_reported_utilization_pct: float | None
    aggregate_live_utilization_pct: float | None
    total_limit_cents: int
    total_live_balance_cents: int
    total_reported_balance_cents: int
    rows: list[UtilizationRow]


# ---- Credit opportunities ----

class CreditOpportunity(BaseModel):
    """A suggested action for improving credit score or limits.

    Every opportunity carries a before/after analysis per Chris's explicit
    constraint: show what happens if he acts, what happens if he doesn't,
    and how confident we are. No money moves — this is a recommendation, not
    an action.
    """
    kind: str  # "request_cli", "paydown_before_close", "dispute_utilization_spike", ...
    account_id: int | None
    account_name: str | None
    title: str
    rationale: str
    # Plain-English step-by-step the user can follow
    action_steps: list[str]
    # Quantitative model of the decision
    before_state: dict  # e.g. {"utilization_pct": 38, "score_estimate": 720}
    projected_after_if_acted: dict
    projected_after_if_not_acted: dict
    estimated_score_delta: int | None  # signed int: +12, -5, etc.
    confidence: float  # 0..1
    urgency_days: int | None  # how soon to act (statement-close countdowns)
    # Optional tier-ladder. When the action has multiple sensible levels
    # (pay $X to drop to 30% / pay $Y to drop to 10% / pay $Z to drop
    # under 1%), each rung is a dict with at least: tier_label,
    # paydown_cents, projected_utilization_pct, estimated_score_delta.
    # The primary projected_after_if_acted reflects the most-recommended
    # tier; alternatives lets the UI show the full ladder so Chris
    # can pick. Set to None for opportunities without tiers (CLI requests).
    alternatives: list[dict] | None = None
    # Concrete deadline rather than just a day count. ISO date when set.
    deadline_date: date | None = None


class CreditOpportunitiesResponse(BaseModel):
    generated_at: datetime
    opportunities: list[CreditOpportunity]


# ---- Rewards optimizer (Phase 4.4) ----

class RewardsTxnAnalysisOut(BaseModel):
    transaction_id: int
    posted_date: date
    description: str
    amount_cents: int
    category_slug: str | None
    used_account_id: int
    used_account_name: str
    used_multiplier: float
    used_value_cents: int
    best_account_id: int | None
    best_account_name: str | None
    best_multiplier: float
    best_value_cents: int
    left_on_table_cents: int


class RewardsCategoryLeakageOut(BaseModel):
    category_slug: str
    category_name: str
    total_spend_cents: int
    used_value_cents: int
    best_value_cents: int
    left_on_table_cents: int
    transactions: int


class RewardsLeakageResponse(BaseModel):
    """The "you left $X on the table" report.

    Matched cards: every linked credit card we found a profile for.
    Unmatched cards (e.g. obscure store cards) are listed by id so the
    UI can show "we don't have rewards data for these — add a profile
    in card_rewards.yaml if you want them analyzed."
    """
    window_start: date
    window_end: date
    cards_analyzed: int
    total_spend_cents: int
    total_used_value_cents: int
    total_best_value_cents: int
    total_left_on_table_cents: int
    by_category: list[RewardsCategoryLeakageOut]
    top_misuses: list[RewardsTxnAnalysisOut]
    unmatched_card_ids: list[int]


# ---- Legal claims (class-action settlements) ----

class LegalClaimIn(BaseModel):
    """Body for creating a legal claim row.

    All quasi-optional fields default to None so the manual-entry form can
    submit just the essentials (name, source_url) and fill in the rest later.

    ``proof_status`` defaults to ``unknown`` rather than ``not_required`` —
    pre-F.2 we defaulted to "Quick" which polluted the no-proof bucket with
    items the form-submitter hadn't actually verified.
    """
    name: str
    source_url: str
    administrator: str | None = None
    case_number: str | None = None
    description: str | None = None
    eligibility: str | None = None
    proof_status: ProofRequirement = ProofRequirement.unknown
    estimated_payout_cents: int | None = Field(default=None, ge=0)
    claim_deadline: date | None = None
    payout_date: date | None = None
    notes: str | None = None
    source: str = "manual"
    # Comma-separated postal codes ("CA,FL") or "nationwide". Defaulting
    # to nationwide is the safe choice — listings without explicit
    # state limits should be visible everywhere.
    state_eligibility: str = "nationwide"


class LegalClaimUpdate(BaseModel):
    """Patch body — every field optional. Status transitions go through here.

    When status flips to ``claimed`` or ``paid`` the API stamps the
    corresponding ``claimed_at`` / ``paid_at`` timestamp server-side; clients
    don't need to send them.
    """
    name: str | None = None
    source_url: str | None = None
    administrator: str | None = None
    case_number: str | None = None
    description: str | None = None
    eligibility: str | None = None
    proof_status: ProofRequirement | None = None
    estimated_payout_cents: int | None = Field(default=None, ge=0)
    claim_deadline: date | None = None
    payout_date: date | None = None
    status: LegalClaimStatus | None = None
    actual_payout_cents: int | None = Field(default=None, ge=0)
    notes: str | None = None
    state_eligibility: str | None = None


class LegalClaimOut(OrmModel):
    id: int
    name: str
    source_url: str
    administrator: str | None
    case_number: str | None
    description: str | None
    eligibility: str | None
    proof_status: ProofRequirement
    estimated_payout_cents: int | None
    claim_deadline: date | None
    payout_date: date | None
    status: LegalClaimStatus
    claimed_at: datetime | None
    paid_at: datetime | None
    actual_payout_cents: int | None
    notes: str | None
    source: str
    state_eligibility: str
    # Derived field — true iff claim_deadline is in the past. Computed on
    # the fly by the API so the database stays a single source of truth.
    is_expired: bool
    days_until_deadline: int | None  # negative means past, None if no deadline


class LegalClaimStats(BaseModel):
    """High-level counters for the dashboard header card."""
    total_count: int
    available_count: int
    claimed_count: int
    paid_count: int
    dismissed_count: int
    expired_count: int  # available rows whose deadline has passed
    # Sum of estimated_payout_cents across rows still in `available` status
    # whose deadline hasn't passed — "money on the table".
    pending_potential_cents: int
    # Sum of actual_payout_cents across rows in `paid` status — money
    # actually received. Lifetime, not period-bound.
    collected_cents: int
    # Three-way split for the hero tabs.
    available_quick_count: int       # proof_status == not_required
    available_with_proof_count: int  # proof_status == required
    available_unknown_count: int     # proof_status == unknown — needs human triage
    # Per-state breakdown for the Settlemate-style filter chips.
    # Keys are 2-char state codes; "nationwide" is reported as its own
    # bucket. Counts include only non-expired available claims so the
    # chips reflect what's actionable right now.
    counts_by_state: dict[str, int] = {}


# ---- Legal claim scraper run results ----

class ScraperRunSummary(BaseModel):
    """Per-source breakdown of a single scrape run."""
    source: str  # e.g. "topclassactions" or "classaction_org"
    rows_seen: int
    rows_created: int
    rows_updated: int
    rows_skipped: int  # already exist and unchanged
    error: str | None = None  # set if the source blew up; partial work is kept


class ScraperRunResponse(BaseModel):
    started_at: datetime
    finished_at: datetime
    summaries: list[ScraperRunSummary]
    total_created: int
    total_updated: int


# ---- Goals (Phase D) ----

class GoalIn(BaseModel):
    """Create-or-update payload. ``current_amount_cents`` is omitted —
    progress is mutated only via /contribute or auto-derived; clients
    can't set it directly to avoid drift between the cache and the
    contribution table."""
    name: str
    kind: GoalKind = GoalKind.general_savings
    target_amount_cents: int
    target_date: date | None = None
    priority: int = 5
    status: GoalStatus = GoalStatus.active
    linked_account_id: int | None = None
    linked_debt_account_id: int | None = None
    notes: str | None = None


class GoalOut(OrmModel):
    id: int
    name: str
    kind: GoalKind
    target_amount_cents: int
    current_amount_cents: int
    # Wave 5 fix A (2026-05-14): when the goal is linked to a real account
    # (e.g. eTrade Premium Savings), the account's *live balance* is a
    # truer measure of progress than the manual-contribution cache. This
    # field surfaces that — clients should prefer it for "are we on track"
    # UI like Goal Pace. Falls back to current_amount_cents if no link.
    effective_current_amount_cents: int | None = None
    target_date: date | None
    priority: int
    status: GoalStatus
    linked_account_id: int | None
    linked_debt_account_id: int | None
    notes: str | None
    created_at: datetime
    updated_at: datetime | None = None


class GoalContributionIn(BaseModel):
    """Record (don't execute) a contribution toward a goal."""
    amount_cents: int = Field(..., gt=0, description="Positive cents — money applied toward the goal")
    contributed_at: date
    source: GoalContributionSource = GoalContributionSource.manual
    transaction_id: int | None = None
    notes: str | None = None


class GoalContributionOut(OrmModel):
    id: int
    goal_id: int
    amount_cents: int
    contributed_at: date
    source: GoalContributionSource
    transaction_id: int | None
    notes: str | None
    created_at: datetime


# ---- Savings: surplus + suggestions (Phase D) ----

class HistoricalBreakdownOut(BaseModel):
    window_start: date
    window_end: date
    inflows_cents: int
    outflows_cents: int
    surplus_cents: int
    n_inflow_txns: int
    n_outflow_txns: int


class ForecastBreakdownOut(BaseModel):
    window_start: date
    window_end: date
    projected_income_cents: int
    fixed_obligations_cents: int
    variable_spend_cents: int
    surplus_cents: int
    n_active_subscriptions: int
    n_variable_outflow_txns: int


class SurplusSnapshotOut(BaseModel):
    as_of: date
    mode_requested: str  # "historical" | "forecast" | "both"
    historical: HistoricalBreakdownOut | None = None
    forecast: ForecastBreakdownOut | None = None
    notes: list[str] = Field(default_factory=list)


class BeforeAfterOut(BaseModel):
    label: str
    current_cents: int
    if_act_cents: int
    if_dont_act_cents: int
    summary: str


class SuggestionOut(BaseModel):
    kind: str  # "allocate_to_goal" | "cancel_subscription" | "debt_payoff_avalanche" | "debt_payoff_snowball"
    title: str
    body: str
    estimated_savings_cents: int
    confidence: float
    goal_id: int | None = None
    subscription_id: int | None = None
    account_id: int | None = None
    before_after: list[BeforeAfterOut] = Field(default_factory=list)
    # Free-form per-suggestion metadata (strategy name, annualized
    # savings, etc.) — varies by suggestion kind.
    extra: dict = Field(default_factory=dict)


class SuggestionBundleOut(BaseModel):
    """The full savings-suggestions payload: allocations for surplus,
    cancellation candidates, and debt-payoff strategies, plus notes."""
    as_of: date
    surplus_mode: str
    surplus_cents: int
    allocations: list[SuggestionOut] = Field(default_factory=list)
    cancellations: list[SuggestionOut] = Field(default_factory=list)
    debt_strategies: list[SuggestionOut] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
