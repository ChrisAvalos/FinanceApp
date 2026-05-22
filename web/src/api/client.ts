/**
 * Thin API client. Types are generated from the backend's OpenAPI spec via
 * `npm run gen:types` (produces src/api/types.ts). Until then we hand-roll
 * the few shapes we need.
 */

export type AccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "loan"
  | "mortgage"
  | "investment"
  | "money_market"
  | "other";

export interface Account {
  id: number;
  institution_id: number;
  // Friendly institution name from JOIN. May be missing on older API
  // responses cached client-side.
  institution_name?: string | null;
  name: string;
  account_type: AccountType;
  mask: string | null;
  currency: string;
  is_active: boolean;
  // Live balance — positive for assets (checking / savings / brokerage
  // cash), negative for liabilities (credit cards / loans). Null when
  // we haven't synced a balance yet (manual-entry accounts).
  current_balance_cents?: number | null;
  credit_limit_cents: number | null;
  last_statement_balance_cents?: number | null;
  last_statement_date?: string | null;
  statement_close_day?: number | null;
  statement_due_day?: number | null;
  apr_bps: number | null;
  /** User-bound card-benefits profile name. Null when auto-matching is in
   *  use. Set via Connections → "What card is this?" picker. */
  card_profile_override?: string | null;
  /** Wave 5 fix F: ISO timestamp of the last successful Plaid sync for
   *  the parent PlaidItem. Null for manual/CSV accounts or accounts on
   *  an item that hasn't synced yet. UI renders a "Synced X ago" chip. */
  last_synced_at?: string | null;
}

export interface Transaction {
  id: number;
  account_id: number;
  posted_date: string;
  amount_cents: number;
  currency: string;
  status: "posted" | "pending";
  description_raw: string;
  description_clean: string | null;
  memo: string | null;
  merchant_id: number | null;
  category_id: number | null;
  category_source: "rule" | "manual" | "llm" | "default" | "unset";
  source: string;
  external_id: string;
  created_at: string;
  /** True = user-flagged one-off (medical emergency, car repair, a big
   *  one-time purchase). The multi-month projection excludes it from the
   *  rolling outflow rate so a single spike is not extrapolated forward. */
  is_one_time: boolean;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  is_discretionary: boolean;
  icon: string | null;
}

export interface CategoryMonthRow {
  year: number;
  month: number;
  category_id: number | null;
  category_name: string | null;
  outflow_cents: number;
  inflow_cents: number;
  txn_count: number;
}

export interface Summary {
  start_date: string;
  end_date: string;
  total_inflow_cents: number;
  total_outflow_cents: number;
  net_cents: number;
  by_category: CategoryMonthRow[];
  /** Server-side computation timestamp — drives the SyncFreshnessChip on
   *  the Overview panel. May be null on cached responses from older API. */
  generated_at?: string | null;
}

export type SubscriptionStatus =
  | "active"
  | "paused"
  | "suspected"
  | "cancelled"
  | "dismissed";

export type SubscriptionType =
  | "streaming"
  | "saas"
  | "news_media"
  | "utilities"
  | "internet"
  | "telecom"
  | "insurance"
  | "fitness"
  | "storage"
  | "gaming"
  | "other"
  | "unknown";

export interface Subscription {
  id: number;
  name: string;
  merchant_id: number | null;
  amount_cents: number;
  cadence_days: number;
  next_expected_date: string | null;
  status: SubscriptionStatus;
  usage_score: number | null;
  notes: string | null;
  // Phase B fields
  subscription_type: SubscriptionType;
  confidence_score: number | null;
  is_user_confirmed: boolean;
  last_amount_cents: number | null;
  prior_amount_cents: number | null;
  price_change_date: string | null;
  n_occurrences: number | null;
  cadence_label: string | null;
  is_variable_amount: boolean;
  // Phase F — composite-charge unmasking
  is_composite?: boolean;
  parent_subscription_id?: number | null;
  // Sprint 9 — for composite rows: "bundle" (Apple App Store etc.,
  // has children to declare) or "usage" (Anthropic API etc., flat
  // meter with no children). Drives whether the UNMASK badge renders.
  composite_kind?: string | null;
}

export interface CompositeUnmaskResponse {
  parent: Subscription;
  children: Subscription[];
  aggregator_label: string | null;
  hint_questions: string[];
  declared_total_cents: number;
  parent_total_cents: number;
  unaccounted_cents: number;
}

export interface CompositeChildIn {
  name: string;
  amount_cents: number;
  subscription_type?: SubscriptionType;
  notes?: string;
}

export interface SubscriptionTypeBreakdown {
  subscription_type: SubscriptionType;
  count: number;
  monthly_cost_cents: number;
  annual_cost_cents: number;
}

export interface SubscriptionStats {
  total_count: number;
  confirmed_count: number;
  needs_review_count: number;
  monthly_cost_cents: number;
  annual_cost_cents: number;
  by_type: SubscriptionTypeBreakdown[];
  price_change_count: number;
}

export interface PromoApplyResult {
  scanned: number;
  price_changes_applied: number;
  promos_seen: number;
  trials_ending: number;
  unlinked: number;
  notes: string[];
}

// Phase F-6 — active prompts on the Subscriptions panel.
// Each prompt is one ranked question the engine wants the user to
// answer. The frontend dispatches `kind` to a mutation; once the
// underlying state changes the prompt drops off the next refresh.
export interface PromptAction {
  label: string;
  // Stable dispatch keys: "confirm_sub" | "dismiss_sub"
  // | "open_unmask_modal" | "set_not_composite"
  kind: string;
}

export interface SubscriptionPrompt {
  id: string; // stable, e.g. "confirm-sub-42"
  kind: string; // "confirm_sub" | "unmask_composite"
  subscription_id: number;
  title: string;
  body: string;
  primary: PromptAction;
  secondary: PromptAction | null;
  priority: number;
}

export interface SubscriptionPromptsResponse {
  prompts: SubscriptionPrompt[];
  total: number;
  generated_at: string | null;
}

// Sprint 5 — Unmask suggestions. Each suggestion is a clickable chip
// in the UnmaskModal that pre-fills the line-item form. Cross-
// referenced against the service catalog + Gmail signals.
export interface UnmaskSuggestionEvidence {
  subject: string | null;
  snippet: string | null;
  received_at: string; // ISO datetime
  from_domain: string;
  label: string;
}

export interface UnmaskSuggestion {
  id: string;
  name: string;
  amount_cents: number; // negative — matches Subscription sign convention
  confidence: number; // 0..1
  reason: string;
  notes: string | null;
  // Sprint 6 — Gmail content signal backing this guess, if any.
  // When present, the chip can show the subject/date of the email
  // that proves the user has this service.
  evidence: UnmaskSuggestionEvidence | null;
}

export interface UnmaskSuggestionsResponse {
  suggestions: UnmaskSuggestion[];
  generated_at: string | null;
}

export interface PlaidStatus {
  configured: boolean;
  env: string;
  client_id_present: boolean;
  secret_present: boolean;
}

export type PlaidItemStatus = "good" | "login_required" | "error";

export interface PlaidItem {
  id: number;
  plaid_item_id: string;
  institution_id: number;
  plaid_institution_id: string | null;
  // Friendly name from our Institution table (e.g. "Chase"). Optional
  // because older /api/plaid/items responses cached client-side won't
  // have this field.
  institution_name?: string | null;
  status: PlaidItemStatus;
  last_synced_at: string | null;
  last_error: string | null;
  granted_products: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlaidSyncResult {
  added: number;
  modified: number;
  removed: number;
  cursor_advanced: number;
}

export interface PlaidSchedule {
  enabled: boolean;
  interval_hours: number;
  next_run_time: string | null;
  running: boolean;
}

/* ----------------------------- Gmail ----------------------------------- */

export type ParserOutcome = "parsed" | "ignored" | "failed" | "duplicate";

export interface GmailStatus {
  configured: boolean;
  authorized: boolean;
  deps_installed: boolean;
  credentials_path: string;
  token_path: string;
  scopes: string[];
  last_sync_at: string | null;
  total_messages: number;
  total_parsed: number;
  total_failed: number;
}

export interface GmailSyncResult {
  fetched: number;
  new: number;
  parsed: number;
  ignored: number;
  failed: number;
  transactions_created: number;
  bills_seen: number;
  offers_seen: number;
  reports_seen: number;
  per_parser: Record<string, number>;
}

export interface GmailMessage {
  id: number;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  from_address: string;
  from_domain: string;
  subject: string | null;
  received_at: string;
  snippet: string | null;
  parser_name: string | null;
  parser_outcome: ParserOutcome;
  parser_error: string | null;
  transaction_id: number | null;
  extra: Record<string, unknown> | null;
  created_at: string;
}

export interface GmailParser {
  name: string;
  label: string;
  from_domains: string[];
  subject_patterns: string[];
  kind: string;
  priority: number;
  match_count: number;
}

/* ----------------------------- Budgets --------------------------------- */

export type BudgetStatus = "on_track" | "warning" | "over";

export interface Budget {
  id: number;
  category_id: number;
  month_start: string; // YYYY-MM-01
  amount_cents: number;
  rollover: boolean;
  notes: string | null;
}

export interface EomIncomeItem {
  /** ISO yyyy-mm-dd of the expected paycheck. */
  on_date: string;
  label: string;
  /** Signed cents (positive = inflow). */
  amount_cents: number;
}

export interface EomCreditCard {
  account_name: string;
  /** Negative = balance owed. */
  current_balance_cents: number;
  /** Positive magnitude of new charges this month. */
  charges_mtd_cents: number;
  /** Positive magnitude of payments made this month. */
  payments_mtd_cents: number;
  /** charges - payments. Positive = took on debt this month. */
  net_debt_change_mtd_cents: number;
}

export interface EomDetail {
  month_start: string;
  today: string;
  last_day: string;
  expected_income: EomIncomeItem[];
  credit_card: EomCreditCard | null;
}

export interface BudgetRollupRow {
  category_id: number;
  category_name: string;
  budget_cents: number;
  actual_outflow_cents: number;
  remaining_cents: number;
  pct_used: number;
  status: BudgetStatus;
  // Phase 7.3 — pace projection extension. Optional because old rollup
  // responses cached client-side won't have these fields.
  projected_eom_cents?: number | null;
  projected_overage_cents?: number | null;
  projected_pct_used?: number | null;
  // Rollover (YNAB-style carry-forward). Server returns 0 for rows
  // without rollover; old API responses won't have the field at all,
  // hence optional.
  rollover_in_cents?: number;
  effective_budget_cents?: number;
  /** Sprint M (2026-05-14) — super-group rollup. The Donut/Bars/Treemap
   *  views group leaf rows by parent_id ("Housing", "Food", etc.).
   *  Null on rows that ARE top-level categories. */
  parent_id?: number | null;
  parent_name?: string | null;
  /** Catchall categories (Transfer, Credit Card Payment, Investment
   *  Contribution, Uncategorized) are internal money movement, not
   *  real spending. Donut/Bars/Treemap filter these out. */
  is_catchall?: boolean;
  /** Discretionary (variable spending) vs non-discretionary ("committed"
   *  — rent, utilities, insurance). The Safe-to-Spend / Available-Cash
   *  breakdown itemizes "bills still due" from the non-catchall,
   *  non-discretionary capped rows that still have budget left. */
  is_discretionary?: boolean;
}

export interface BudgetRollup {
  month_start: string;
  pace: number; // 0..1
  total_budget_cents: number;
  total_actual_cents: number;
  rows: BudgetRollupRow[];
  unbudgeted_spending: BudgetRollupRow[];
  // ---- Sprint H (2026-05-13): Income/savings/MoM/rent-attribution ----
  monthly_income_cents?: number;
  /** Sprint H follow-up — recurring payroll-only avg (Livio wires). Used for projections. */
  recurring_income_cents?: number;
  real_budget_cents?: number;
  // ---- Sprint I additions (budget-at-a-glance) ----
  /** Apples-to-apples actual that matches real_budget (excludes catchalls). */
  real_actual_cents?: number;
  /** Sum of caps in non-discretionary categories. */
  committed_caps_total_cents?: number;
  /** Hero anchor — money left to spend this month after savings + bills + already-spent. */
  safe_to_spend_cents?: number;
  /** Bills due by EOM that aren't paid yet. */
  committed_remaining_cents?: number;
  /** Spend in unbudgeted categories. */
  unbudgeted_actual_cents?: number;
  /** Pace-aware EOM total outflow projection. */
  eom_projected_outflow_cents?: number;
  /** EOM net flow = recurring_income - eom_projected_outflow. */
  eom_projected_net_flow_cents?: number;
  /** EOM breakdown components — together with committed_remaining and
   *  recurring_income, fully describe the EOM math. */
  committed_actual_cents?: number;
  variable_actual_cents?: number;
  variable_eom_estimate_cents?: number;
  /** Trailing 3-mo avg net flow for Wealth Pulse baseline. */
  trailing_3mo_net_flow_cents?: number;
  /** Wave 5 fix G — most recent payroll-pattern inflow (last Livio paycheck). */
  latest_paycheck_cents?: number | null;
  latest_paycheck_posted_date?: string | null;
  latest_paycheck_days_ago?: number | null;
  /** Wave 5 fix H — checking-only liquid balance. */
  liquid_balance_cents?: number;
  /** Forward-looking: liquid + expected_remaining_income − bills due. */
  available_cash_cents?: number;
  /** Expected paychecks landing in (today, end_of_month]. */
  expected_remaining_income_cents?: number;
  /** Next expected paycheck date (ISO yyyy-mm-dd). */
  next_expected_paycheck_date?: string | null;
  /** Sprint O-1 — Livio paychecks whose effective month is the requested
   *  month, summed. Matches what your bank app shows landed THIS month. */
  month_income_landed_cents?: number;
  /** Sprint O-1 — month_income_landed_cents + expected_remaining_income_cents.
   *  The "what will I make in May" headline number. */
  month_income_expected_total_cents?: number;
  /** Sprint O-1 follow-up — windfalls / settlements landed this month
   *  (Brigit, Labaton, etc.). Surfaced as a "+ $X other income" line
   *  on the Income card. NOT included in expected_total. */
  month_other_income_landed_cents?: number;
  savings_actual_cents?: number;
  /** Sprint K-1 — eTrade-bound savings (counts toward the goal target). */
  savings_actual_etrade_cents?: number;
  /** Sprint K-1 — bonus savings (Albert auto-save, brokerage growth, etc.). */
  savings_actual_other_cents?: number;
  savings_goal_target_cents?: number;
  /** {category_id: [this_month_cents, three_mo_avg_cents]} */
  mom_compare?: Record<string, [number, number]>;
  rent_attributed_tx_ids?: number[];
}

/* ------------------------------------------------------------------ */
/*  Sprint L — Zero-based assignment ledger                             */
/* ------------------------------------------------------------------ */

export type AssignmentKind =
  | "committed"
  | "variable"
  | "savings"
  | "debt"
  | "unbudgeted_actual";

export interface AssignmentItem {
  kind: AssignmentKind;
  label: string;
  planned_cents: number;
  actual_cents: number;
  category_id: number | null;
  goal_id: number | null;
  account_id: number | null;
  is_paid: boolean;
  /** Sprint M-4 — super-group parent for the "Group by category" toggle. */
  parent_id?: number | null;
  parent_name?: string | null;
}

export interface AssignmentGroup {
  kind: AssignmentKind;
  label: string;
  planned_cents: number;
  actual_cents: number;
  items: AssignmentItem[];
}

export interface MonthHistorySummary {
  month_start: string;
  income_cents: number;
  planned_cents: number;
  actual_cents: number;
  by_kind: Record<string, { planned: number; actual: number }>;
}

export interface AssignmentLedger {
  month_start: string;
  income_cents: number;
  irregular_income_cents: number;
  groups: AssignmentGroup[];
  total_planned_cents: number;
  total_actual_cents: number;
  /** Positive = surplus to assign; negative = over-committed. */
  unassigned_cents: number;
  /** Last 3 months for drift visualization. */
  history: MonthHistorySummary[];
}

/* ------------------------------------------------------------------ */
/*  Sprint L-4 — Rebalance suggestions (one-click surplus allocations) */
/* ------------------------------------------------------------------ */

export interface RebalancePatchBudget {
  category_id: number;
  category_name: string;
  current_cap_cents: number;
  new_cap_cents: number;
}

export interface RebalanceApply {
  /** "noop" | "patch_budgets_multi" | "set_goal_funding_rate" */
  kind: string;
  budget_patches: RebalancePatchBudget[];
  goal_id: number | null;
  goal_new_monthly_cents: number | null;
}

export interface RebalanceSuggestion {
  rank: number;
  kind: string;
  title: string;
  description: string;
  impact_text: string;
  apply: RebalanceApply | null;
}

export interface RebalanceSuggestionsResponse {
  month_start: string;
  unassigned_cents: number;
  suggestions: RebalanceSuggestion[];
}

/* ------------------------------------------------------------------ */
/*  Sprint O-2 — Recurring bills (rent / subs / utilities / loans)      */
/* ------------------------------------------------------------------ */

export interface RecurringBill {
  /** Stable group key (merchant id or description prefix). */
  key: string;
  /** Raw bank description from the most-recent occurrence. */
  description_raw: string;
  /** Cleaned description if Plaid provided one. */
  description_clean: string | null;
  /** Friendly merchant name when known. */
  merchant_name: string | null;
  category_id: number | null;
  category_name: string | null;
  /** Median magnitude of one occurrence (cents). */
  typical_amount_cents: number;
  /** typical_amount_cents normalized to a 30-day month. A quarterly $300
   *  bill shows here as ~$100/mo so the totals add up cleanly. */
  monthly_equivalent_cents: number;
  /** "weekly" | "biweekly" | "monthly" | "bimonthly" | "quarterly" |
   *  "semiannual" | "annual". */
  cadence: string;
  last_seen_date: string;          // ISO yyyy-mm-dd
  occurrence_count: number;
  /** "fixed" — true obligation (counts toward the fixed total).
   *  "variable" — habitual recurring spending (belongs in the
   *  variable budget, NOT the fixed total). */
  kind: "fixed" | "variable";
}

export interface RecurringBillsResponse {
  window_start: string;
  window_end: string;
  /** True fixed bills only. */
  bills: RecurringBill[];
  /** Habitual recurring spending — recurs on a rhythm but the amount
   *  swings or the category is discretionary (coffee, gas, groceries). */
  variable_recurring: RecurringBill[];
  /** Sum of monthly_equivalent_cents across FIXED bills — the number
   *  the discretionary-pool calc subtracts from income. */
  total_monthly_cents: number;
  /** Sum across the variable-recurring patterns, for display. */
  total_variable_monthly_cents: number;
}

/** Sprint P — one category's before/after when adopting detected bills
 *  into The Plan as budget caps. */
export interface AdoptedCategory {
  category_id: number;
  category_name: string | null;
  /** Sum of monthly-equivalent across every fixed bill in this category. */
  detected_total_cents: number;
  previous_cap_cents: number;
  new_cap_cents: number;
  /** True when the cap was raised; false when it already covered the bills. */
  changed: boolean;
}

export interface AdoptRecurringResponse {
  month_start: string;
  categories: AdoptedCategory[];
  /** Sum of (new − previous) across categories that changed. */
  total_added_cents: number;
}

/* ------------------------------------------------------------------ */
/*  Sprint Q-3 — similarity-based category suggestions                  */
/* ------------------------------------------------------------------ */

export interface CategorySuggestion {
  txn_id: number;
  category_id: number;
  category_name: string;
  /** 0..1 — fraction of this merchant's historical votes for the
   *  winning category. 1.0 = unanimous. */
  score: number;
  /** How many already-categorized transactions voted. */
  sample_count: number;
}

export interface CategorySuggestionsResponse {
  suggestions: CategorySuggestion[];
}

/* ------------------------------------------------------------------ */
/*  Wave G — Budget projection                                          */
/* ------------------------------------------------------------------ */

export interface ProjectionPoint {
  month_index: number;
  checking_cents: number;
  savings_cents: number;
  investment_cents: number;
  net_cents: number;
  income_cents: number;
  outflow_cents: number;
}

export interface CategoryBaseline {
  id: number;
  name: string;
  monthly_cents: number;
  budget_cap_cents?: number;
}

/** Wave G-11 — per-goal baseline for the multi-goal slider UI. */
export interface GoalBaseline {
  id: number;
  name: string;
  target_amount_cents: number;
  current_amount_cents: number;
  target_date: string | null;
  months_left: number | null;
  needed_monthly_cents: number;
}

export interface ProjectionResponse {
  months: number;
  investment_apy: number;
  checking_cap_cents: number;
  scenario_points: ProjectionPoint[];
  baseline_points: ProjectionPoint[] | null;
  /** Sprint J-1a — pace-aware EOM-extrapolation projection (optimistic line).
   *  When present, render alongside baseline_points as a range view. */
  optimistic_points?: ProjectionPoint[] | null;
  monthly_outflow_cents_optimistic?: number | null;
  monthly_income_cents: number;
  monthly_outflow_cents_baseline: number;
  monthly_outflow_cents_scenario: number;
  starting_checking_cents: number;
  starting_savings_cents: number;
  starting_investment_cents: number;
  starting_net_cents: number;
  liability_cents: number;
  categories: CategoryBaseline[];
  /** G-11 — per-goal baselines for the multi-goal slider UI. */
  goals?: GoalBaseline[];
  scenario_vs_baseline_net_cents: number;
}

export interface ProjectionRequest {
  months?: number;
  category_overrides?: Record<number, number>;
  /** G-11 — per-goal monthly contribution map (goal_id → cents). */
  goal_contributions?: Record<number, number>;
  /** Legacy scalar — only used when goal_contributions is unset. */
  monthly_investment_contribution_cents?: number;
  include_baseline?: boolean;
}

export type BudgetRecommendationKind = "overspend" | "goal" | "bundle_dup" | "yield_shift";

export interface BudgetRecommendationApply {
  category_overrides: Record<number, number>;
  /** G-11 — per-goal contribution map. */
  goal_contributions: Record<number, number>;
  monthly_investment_contribution_cents: number;
}

export interface BudgetRecommendation {
  kind: BudgetRecommendationKind | string;
  title: string;
  body: string;
  expected_monthly_impact_cents: number;
  priority: number;
  apply: BudgetRecommendationApply | null;
  meta: Record<string, unknown>;
}

export interface BudgetRecommendationsResponse {
  recommendations: BudgetRecommendation[];
  total_potential_monthly_savings_cents: number;
  total_potential_annual_savings_cents: number;
}

export interface BudgetUpsertPayload {
  category_id: number;
  month_start: string;
  amount_cents: number;
  rollover?: boolean;
  notes?: string | null;
}

export type BudgetTemplateAction =
  | "created"
  | "updated"
  | "skipped_existing"
  | "skipped_low_avg";

export interface BudgetTemplateApplied {
  category_id: number;
  category_name: string;
  amount_cents: number;
  action: BudgetTemplateAction;
}

export interface BudgetTemplateResult {
  target_month_start: string;
  source_month_start: string | null;
  lookback_months: number | null;
  created: number;
  updated: number;
  skipped: number;
  rows: BudgetTemplateApplied[];
}

export interface BudgetCopyPayload {
  target_month_start: string;
  source_month_start?: string | null;
  overwrite?: boolean;
}

export interface BudgetFillPayload {
  target_month_start: string;
  lookback_months?: number;
  round_up_to_cents?: number;
  overwrite?: boolean;
  min_avg_cents?: number;
}

/* ----------------------------- Month-over-month ------------------------- */

export interface MonthOutflowCell {
  month_start: string;
  outflow_cents: number;
}

export interface CategoryTrendRow {
  category_id: number | null;
  category_name: string | null;
  outflow_by_month_cents: number[];
  avg_outflow_cents: number;
  trend_pct_vs_avg: number | null;
}

export interface MonthOverMonth {
  months: MonthOutflowCell[];
  categories: CategoryTrendRow[];
  /** Server-side computation timestamp — drives the SyncFreshnessChip on
   *  the Trends panel. */
  generated_at?: string | null;
}

/* ----------------------------- Credit ---------------------------------- */

export type CreditBureau = "experian" | "equifax" | "transunion";
export type CreditScoringModel =
  | "fico8"
  | "fico9"
  | "fico10"
  | "vantagescore3"
  | "vantagescore4"
  | "other";
export type ScoreSource = "manual" | "plaid" | "experian_api" | "playwright";

export interface CreditScore {
  id: number;
  score: number;
  bureau: CreditBureau;
  scoring_model: CreditScoringModel;
  as_of: string;
  source: ScoreSource;
  source_detail: string | null;
  notes: string | null;
}

export interface CreditScoreIn {
  score: number;
  bureau: CreditBureau;
  scoring_model?: CreditScoringModel;
  as_of: string;
  source?: ScoreSource;
  source_detail?: string | null;
  notes?: string | null;
}

export interface UtilizationRow {
  account_id: number;
  account_name: string;
  credit_limit_cents: number;
  current_balance_cents: number;
  last_statement_balance_cents: number;
  reported_utilization_pct: number | null;
  live_utilization_pct: number | null;
  statement_close_day: number | null;
  statement_due_day: number | null;
  days_until_close: number | null;
}

export interface UtilizationResponse {
  aggregate_reported_utilization_pct: number | null;
  aggregate_live_utilization_pct: number | null;
  total_limit_cents: number;
  total_live_balance_cents: number;
  total_reported_balance_cents: number;
  rows: UtilizationRow[];
}

export interface CreditOpportunity {
  kind: string;
  account_id: number | null;
  account_name: string | null;
  title: string;
  rationale: string;
  action_steps: string[];
  before_state: Record<string, number | string | null>;
  projected_after_if_acted: Record<string, number | string | null>;
  projected_after_if_not_acted: Record<string, number | string | null>;
  estimated_score_delta: number | null;
  confidence: number;
  urgency_days: number | null;
}

export interface CreditOpportunitiesResponse {
  generated_at: string;
  opportunities: CreditOpportunity[];
}

/* ----------------------------- Legal claims --------------------------- */

export type LegalClaimStatus = "available" | "claimed" | "paid" | "dismissed";

// 3-state proof requirement. `unknown` is the scraper's default when its
// heuristic can't decide — surfaced in its own UI tab so Chris can triage.
export type ProofRequirement = "not_required" | "required" | "unknown";

export interface LegalClaim {
  id: number;
  name: string;
  source_url: string;
  administrator: string | null;
  case_number: string | null;
  description: string | null;
  eligibility: string | null;
  proof_status: ProofRequirement;
  estimated_payout_cents: number | null;
  claim_deadline: string | null;
  payout_date: string | null;
  status: LegalClaimStatus;
  claimed_at: string | null;
  paid_at: string | null;
  actual_payout_cents: number | null;
  notes: string | null;
  source: string;
  state_eligibility: string;  // "nationwide" | "CA" | "CA,FL"
  is_expired: boolean;
  days_until_deadline: number | null;
}

export interface LegalClaimIn {
  name: string;
  source_url: string;
  administrator?: string | null;
  case_number?: string | null;
  description?: string | null;
  eligibility?: string | null;
  proof_status?: ProofRequirement;
  estimated_payout_cents?: number | null;
  claim_deadline?: string | null;
  payout_date?: string | null;
  notes?: string | null;
  source?: string;
  state_eligibility?: string;
}

export interface LegalClaimUpdate {
  name?: string;
  source_url?: string;
  administrator?: string | null;
  case_number?: string | null;
  description?: string | null;
  eligibility?: string | null;
  proof_status?: ProofRequirement;
  estimated_payout_cents?: number | null;
  claim_deadline?: string | null;
  payout_date?: string | null;
  status?: LegalClaimStatus;
  actual_payout_cents?: number | null;
  notes?: string | null;
}

export interface LegalClaimStats {
  total_count: number;
  available_count: number;
  claimed_count: number;
  paid_count: number;
  dismissed_count: number;
  expired_count: number;
  pending_potential_cents: number;
  collected_cents: number;
  // 3-way split of live (non-expired) available rows by proof_status.
  available_quick_count: number;       // not_required
  available_with_proof_count: number;  // required
  available_unknown_count: number;     // unknown — needs triage
  // Per-state breakdown for Settlemate-style filter chips. Keys are
  // 2-char postal codes; "nationwide" is its own bucket. A claim
  // covering CA+FL contributes to BOTH the CA and FL counts (and
  // doesn't show up under "nationwide").
  counts_by_state: Record<string, number>;
}

/* --- Scraper run results --- */

export interface ScraperRunSummary {
  source: string;
  rows_seen: number;
  rows_created: number;
  rows_updated: number;
  rows_skipped: number;
  error: string | null;
}

export interface ScraperRunResponse {
  started_at: string;
  finished_at: string;
  summaries: ScraperRunSummary[];
  total_created: number;
  total_updated: number;
}

// ---- Goals & Savings (Phase D) ----

export type GoalKind =
  | "emergency_fund"
  | "general_savings"
  | "specific_savings"
  | "debt_payoff";

export type GoalStatus = "active" | "achieved" | "paused" | "archived";

export type GoalContributionSource = "manual" | "transfer_record" | "debt_payment";

export interface Goal {
  id: number;
  name: string;
  kind: GoalKind;
  target_amount_cents: number;
  current_amount_cents: number;
  // Wave 5 fix A (2026-05-14): server-derived "true progress" — uses linked
  // account balance when one is set, otherwise falls back to current_amount_cents.
  // Clients should prefer this for "on track" UI (Goal Pace, sliders).
  effective_current_amount_cents: number | null;
  target_date: string | null; // YYYY-MM-DD
  priority: number;
  status: GoalStatus;
  linked_account_id: number | null;
  linked_debt_account_id: number | null;
  notes: string | null;
  created_at: string; // ISO
  updated_at: string | null;
}

export interface GoalIn {
  name: string;
  kind?: GoalKind;
  target_amount_cents: number;
  target_date?: string | null;
  priority?: number;
  status?: GoalStatus;
  linked_account_id?: number | null;
  linked_debt_account_id?: number | null;
  notes?: string | null;
}

export interface GoalContribution {
  id: number;
  goal_id: number;
  amount_cents: number;
  contributed_at: string;
  source: GoalContributionSource;
  transaction_id: number | null;
  notes: string | null;
  created_at: string;
}

export interface GoalContributionIn {
  amount_cents: number;
  contributed_at: string; // YYYY-MM-DD
  source?: GoalContributionSource;
  transaction_id?: number | null;
  notes?: string | null;
}

export type SurplusMode = "historical" | "forecast" | "both";

export interface HistoricalBreakdown {
  window_start: string;
  window_end: string;
  inflows_cents: number;
  outflows_cents: number;
  surplus_cents: number;
  n_inflow_txns: number;
  n_outflow_txns: number;
}

export interface ForecastBreakdown {
  window_start: string;
  window_end: string;
  projected_income_cents: number;
  fixed_obligations_cents: number;
  variable_spend_cents: number;
  surplus_cents: number;
  n_active_subscriptions: number;
  n_variable_outflow_txns: number;
}

export interface SurplusSnapshot {
  as_of: string;
  mode_requested: string;
  historical: HistoricalBreakdown | null;
  forecast: ForecastBreakdown | null;
  notes: string[];
}

export type SuggestionKind =
  | "allocate_to_goal"
  | "cancel_subscription"
  | "debt_payoff_avalanche"
  | "debt_payoff_snowball";

export interface BeforeAfter {
  label: string;
  current_cents: number;
  if_act_cents: number;
  if_dont_act_cents: number;
  summary: string;
}

export interface Suggestion {
  kind: SuggestionKind;
  title: string;
  body: string;
  estimated_savings_cents: number;
  confidence: number;
  goal_id: number | null;
  subscription_id: number | null;
  account_id: number | null;
  before_after: BeforeAfter[];
  extra: Record<string, unknown>;
}

export interface SuggestionBundle {
  as_of: string;
  surplus_mode: string;
  surplus_cents: number;
  allocations: Suggestion[];
  cancellations: Suggestion[];
  debt_strategies: Suggestion[];
  notes: string[];
}


async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // FastAPI puts the human-readable reason in `detail` on the JSON body.
    // Try to surface that instead of the bare HTTP status line — a "503 Service
    // Unavailable" toast is useless; the body usually says "Gmail is not
    // authorized yet — POST /gmail/authorize first" or similar.
    let detail: string | null = null;
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const body = (await res.clone().json()) as { detail?: unknown };
        if (typeof body?.detail === "string") detail = body.detail;
        else if (body?.detail) detail = JSON.stringify(body.detail);
      } else {
        const text = (await res.clone().text()).trim();
        if (text) detail = text.slice(0, 500);
      }
    } catch {
      /* fall through — best-effort body parse */
    }
    const status = `${res.status} ${res.statusText}`;
    throw new Error(detail ? `${status} — ${detail}` : status);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Money-on-the-Table aggregator (Phase 8.6)                          */
/* ------------------------------------------------------------------ */

export type MoneyOnTableSourceKind =
  | "unclaimed_property"
  | "class_action"
  | "regulatory_redress"
  | "card_benefit"
  | "yield_arb"
  | "sub_cancel"
  // (other kinds may show up as the catalog grows — keep the type
  // open-ended so the UI doesn't blow up on unknown kinds)
  | (string & {});

export interface MoneyOnTableOpportunity {
  source_kind: MoneyOnTableSourceKind;
  source_id: number | null;
  title: string;
  description: string;
  estimated_cents: number | null;
  effort_minutes: number;
  value_per_minute_cents: number | null;
  action_url: string | null;
  action_label: string;
  deadline: string | null;
  urgency_days: number | null;
  confidence: number;
}

export interface MoneyOnTableReport {
  as_of: string;
  opportunities: MoneyOnTableOpportunity[];
  total_claimable_cents: number;
  total_savings_cents: number;
  counts_by_kind: Record<string, number>;
  summary_text: string;
}

/* Daily Moves — companion to MoneyOnTableReport, sliced + ranked
 * for the "what should I do RIGHT NOW?" daily action surface. */
export interface DailyMove extends MoneyOnTableOpportunity {
  priority_score: number;
  is_urgent: boolean;
}

export interface DailyMovesReport {
  as_of: string;
  moves: DailyMove[];
  total_potential_cents: number;
  total_minutes: number;
  items_remaining: number;
  urgent_count: number;
  headline: string;
  /** Consecutive distinct days the user marked at least one move
   *  done, ending today (or yesterday with 1-day grace). 0 if no
   *  moves have ever been completed or last completion was > 1 day ago. */
  current_streak_days: number;
  /** All-time best run of consecutive days with a "done" action. */
  longest_streak_days: number;
}

export interface DailyMoveActionRecord {
  id: number;
  source_kind: string;
  source_id: number | null;
  source_key: string | null;
  action: "done" | "snoozed" | "dismissed";
  snoozed_until: string | null;
  notes: string | null;
  actioned_at: string;
}

/* FIRE / retirement Monte Carlo projection */
export type FireSimulationMode = "normal" | "historical";

export interface FireInputs {
  current_age: number;
  target_retirement_age: number;
  end_age: number;
  starting_cents: number;
  monthly_savings_cents: number;
  annual_spending_cents: number;
  mean_return_pct: number;
  std_dev_pct: number;
  n_trials: number;
  simulation_mode: FireSimulationMode;
  /** When set in historical mode: pin every trial to this start year.
   * Useful for retiring-into-1973 / 2000 / 1987 stress scenarios. */
  historical_start_year: number | null;
}

export interface FireYear {
  age: number;
  p10_cents: number;
  p25_cents: number;
  p50_cents: number;
  p75_cents: number;
  p90_cents: number;
}

export interface FireProjection {
  inputs: FireInputs;
  fire_number_cents: number;
  years: FireYear[];
  median_hit_age: number | null;
  p25_hit_age: number | null;
  p75_hit_age: number | null;
  success_probability_pct: number;
  prob_hit_target_by_retirement_pct: number;
  safe_withdrawal_rate_pct: number | null;
  realized_mean_return_pct: number | null;
  realized_std_dev_pct: number | null;
  summary_text: string;
  /** Server-side simulation timestamp — drives the SyncFreshnessChip
   *  on the FIRE panel. */
  generated_at?: string | null;
  /** Sprint 28 — true when the user's actual starting balance was
   *  negative and the simulator clamped it to $0 before running. The
   *  panel renders a friendly "negative net worth" note when this is
   *  set instead of silently misleading. */
  starting_was_clamped?: boolean;
  /** The original (possibly negative) starting_cents the client sent.
   *  Used to display "you asked for -$X" in the clamp note. */
  requested_starting_cents?: number;
}

export interface FireDefaults {
  starting_cents: number;
  monthly_savings_cents: number;
  annual_spending_cents: number;
  derived_from: Record<string, string>;
}

/* Conversational AI chat — Smart Feature #3 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface ChatAskOut {
  answer: string;
  ollama_available: boolean;
  used_context_kb: number;
  /** "tool_use" — LLM-planned tool calls. "context" — single-shot prompt. */
  mode: "tool_use" | "context";
  tool_calls: ChatToolCall[];
  error: string | null;
}

export interface ChatStatus {
  ollama_available: boolean;
  model: string;
  base_url: string;
}

/* Net-worth attribution — Smart Feature #4 */
export interface AttributionCategory {
  name: string;
  cents: number;
  txn_count: number;
}

export interface AttributionMonth {
  month_start: string;          // ISO YYYY-MM-DD (first of month)
  month_label: string;          // "Oct 2025"
  nw_start_cents: number | null;
  nw_end_cents: number | null;
  delta_cents: number | null;
  income_cents: number;
  spending_cents: number;
  net_cash_flow_cents: number;
  /** Net of transfer rows. Positive = paid down debt this month.
   * NB: when both sides of a credit-card payment are linked, this
   * nets to ~0 — non-zero values surface asymmetric linkage. */
  debt_paydown_cents: number;
  other_cents: number | null;
  top_spending_categories: AttributionCategory[];
}

export interface AttributionReport {
  months: AttributionMonth[];
  summary_text: string;
  /** Server-side computation timestamp — drives the SyncFreshnessChip
   *  on the Attribution panel. */
  generated_at?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Unclaimed property                                                  */
/* ------------------------------------------------------------------ */

export type UnclaimedStatus = "found" | "claimed" | "paid" | "rejected" | "dismissed";

export interface UnclaimedRecord {
  id: number;
  state: string;
  holder_name: string | null;
  owner_name: string;
  last_known_address: string | null;
  claim_id: string | null;
  property_type: string | null;
  estimated_value_cents: number | null;
  status: UnclaimedStatus;
  claim_url: string | null;
  source: string;
  notes: string | null;
  discovered_at: string;
  claimed_at: string | null;
  paid_at: string | null;
  actual_payout_cents: number | null;
}

export interface UnclaimedIn {
  state: string;
  holder_name?: string | null;
  owner_name: string;
  last_known_address?: string | null;
  claim_id?: string | null;
  property_type?: string | null;
  estimated_value_cents?: number | null;
  claim_url?: string | null;
  source?: string;
  notes?: string | null;
}

export interface UnclaimedStats {
  total_count: number;
  found_count: number;
  claimed_count: number;
  paid_count: number;
  rejected_count: number;
  dismissed_count: number;
  estimated_pending_cents: number;
  actual_collected_cents: number;
}

export interface UnclaimedSearchTips {
  intro: string;
  federal_resources: { name: string; url: string; what: string }[];
  state_resources: { state: string; url: string; name: string }[];
  name_variants_to_try: string[];
  addresses_to_try: string[];
}

/* ------------------------------------------------------------------ */
/*  Card benefits (use-it-or-lose-it credits)                           */
/* ------------------------------------------------------------------ */

export interface CardBenefitRow {
  account_id: number;
  account_name: string;
  profile_name: string;
  annual_fee_cents: number;
  total_credit_value_cents: number;
  benefits: { name: string; value_cents: number; cadence?: string; notes?: string; activation_url?: string }[];
  net_after_fee_cents: number;
}

export interface CardBenefitReport {
  as_of: string;
  rows: CardBenefitRow[];
  unmatched_card_ids: number[];
  total_face_value_cents: number;
  total_annual_fee_cents: number;
  net_potential_cents: number;
}

/* ------------------------------------------------------------------ */
/*  Yield-arb                                                           */
/* ------------------------------------------------------------------ */

export interface YieldArbProduct {
  name: string;
  apy_pct: number;
  minimum_cents: number;
  fdic_insured: boolean;
  notes: string;
  open_url: string;
  yearly_earnings_at_balance_cents: number;
  delta_vs_current_cents: number;
}

export interface YieldArbAccount {
  account: {
    account_id: number;
    account_name: string;
    balance_cents: number;
    current_apy_pct: number;
    current_yearly_earnings_cents: number;
  };
  hysa_alternatives: YieldArbProduct[];
  tbill_alternatives: YieldArbProduct[];
  best_alternative_name: string | null;
  best_yearly_delta_cents: number;
  qualifies_for_arb: boolean;
}

export interface YieldArbReport {
  as_of: string;
  accounts: YieldArbAccount[];
  total_idle_balance_cents: number;
  total_yearly_potential_delta_cents: number;
  summary_text: string;
}

/* ------------------------------------------------------------------ */
/*  Regulatory redress                                                  */
/* ------------------------------------------------------------------ */

export type RedressStatus =
  | "candidate"
  | "eligible"
  | "pending_filed"
  | "paid"
  | "rejected"
  | "dismissed";

export interface KnownRedress {
  agency: string;
  company_name: string;
  title: string;
  eligibility_description: string;
  claim_url: string | null;
  total_redress_cents: number | null;
  estimated_per_user_cents: number | null;
  claim_deadline: string | null;
}

export interface RedressMatch {
  catalog_entry: KnownRedress;
  matched_transactions: number;
  matched_total_spend_cents: number;
  sample_descriptions: string[];
  already_logged: boolean;
}

export interface RedressMatchReport {
  matches: RedressMatch[];
  total_estimated_cents: number;
}

export interface RedressRecord {
  id: number;
  agency: string;
  company_name: string;
  title: string;
  eligibility_description: string | null;
  claim_url: string | null;
  total_redress_cents: number | null;
  estimated_per_user_cents: number | null;
  claim_deadline: string | null;
  status: RedressStatus;
  discovery_source: string;
  notes: string | null;
  discovered_at: string;
  filed_at: string | null;
  paid_at: string | null;
  actual_payout_cents: number | null;
}

/* ------------------------------------------------------------------ */
/*  Net worth                                                           */
/* ------------------------------------------------------------------ */

export interface NetWorthBreakdownRow {
  account_type: string;
  kind: string;
  total_cents: number;
  accounts: number;
}

export interface NetWorthSummary {
  as_of: string;
  assets_cents: number;
  liabilities_cents: number;
  net_cents: number;
  breakdown: NetWorthBreakdownRow[];
  accounts_with_no_balance: number;
}

export interface NetWorthHistoryPoint {
  as_of: string;
  assets_cents: number;
  liabilities_cents: number;
  net_cents: number;
}

export interface NetWorthHistory {
  series: NetWorthHistoryPoint[];
  earliest: string | null;
  latest: string | null;
  delta_30d_cents: number | null;
  delta_1y_cents: number | null;
}

/* ------------------------------------------------------------------ */
/*  Cash flow                                                           */
/* ------------------------------------------------------------------ */

export interface CashFlowEvent {
  on_date: string;
  kind: string;
  label: string;
  amount_cents: number;
  confidence: number;
  source_id: number | null;
  notes: string | null;
}

export interface DailyForecastPoint {
  on_date: string;
  inflow_cents: number;
  outflow_cents: number;
  net_cents: number;
  running_balance_cents: number;
}

/** Sprint 40 — one annual renewal landing beyond the 30-day window. */
export interface UpcomingAnnual {
  on_date: string;
  label: string;
  amount_cents: number;
  days_out: number;
  confidence: number;
  subscription_id: number | null;
  notes: string | null;
}

export interface UpcomingAnnualsResponse {
  window_start: string;
  window_end: string;
  events: UpcomingAnnual[];
  total_outflow_cents: number;
  generated_at?: string | null;
}

export interface CashFlowForecast {
  window_start: string;
  window_end: string;
  starting_balance_cents: number;
  paycheck_cadence_days: number | null;
  paycheck_cadence_confidence: number;
  events: CashFlowEvent[];
  daily: DailyForecastPoint[];
  crunch_days: string[];
  /** Server-side computation timestamp — drives the SyncFreshnessChip
   *  on the Cash Flow panel. */
  generated_at?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Holdings                                                            */
/* ------------------------------------------------------------------ */

export type SecurityType = "equity" | "etf" | "mutual_fund" | "crypto" | "bond" | "other";

export interface Security {
  id: number;
  ticker: string | null;
  name: string;
  security_type: SecurityType;
  cusip: string | null;
  isin: string | null;
  latest_price_cents: number | null;
  latest_price_at: string | null;
}

export interface HoldingDetail {
  id: number;
  account_id: number;
  account_name: string;
  security_id: number;
  security_ticker: string | null;
  security_name: string;
  security_type: SecurityType;
  quantity: number;
  latest_price_cents: number | null;
  cost_basis_cents: number | null;
  current_value_cents: number;
  unrealized_gain_cents: number | null;
  unrealized_gain_pct: number | null;
  as_of: string;
}

export interface AllocationSlice {
  security_type: string;
  total_value_cents: number;
  pct: number;
}

export interface Portfolio {
  as_of: string;
  total_value_cents: number;
  total_cost_basis_cents: number;
  total_unrealized_gain_cents: number;
  total_unrealized_gain_pct: number;
  holdings_count: number;
  accounts_count: number;
  allocation_by_type: AllocationSlice[];
  top_holdings: HoldingDetail[];
}

/* ------------------------------------------------------------------ */
/*  HSA receipt bank                                                    */
/* ------------------------------------------------------------------ */

export type HsaReceiptStatus = "saved" | "reimbursed" | "voided";

export interface HsaReceipt {
  id: number;
  expense_date: string;
  amount_cents: number;
  description: string;
  expense_category: string | null;
  provider_name: string | null;
  payment_method: string | null;
  transaction_id: number | null;
  receipt_path: string | null;
  status: HsaReceiptStatus;
  reimbursed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface HsaReceiptIn {
  expense_date: string;
  amount_cents: number;
  description: string;
  expense_category?: string | null;
  provider_name?: string | null;
  payment_method?: string | null;
  transaction_id?: number | null;
  receipt_path?: string | null;
  notes?: string | null;
}

export interface HsaSummary {
  total_receipts: number;
  saved_count: number;
  saved_total_cents: number;
  reimbursed_total_cents: number;
  voided_count: number;
  earliest_saved_date: string | null;
  latest_saved_date: string | null;
  projected_at_30yr_7pct_cents: number;
  summary_text: string;
}

/* ------------------------------------------------------------------ */
/*  Anomaly                                                             */
/* ------------------------------------------------------------------ */

export interface AnomalyRow {
  transaction_id: number;
  posted_date: string;
  description: string;
  amount_cents: number;
  category_id: number | null;
  category_name: string | null;
  baseline_mean_cents: number;
  baseline_stddev_cents: number;
  sigma: number;
  rationale: string;
}

export interface AnomalyScan {
  window_start: string;
  window_end: string;
  threshold_sigma: number;
  transactions_scanned: number;
  anomalies: AnomalyRow[];
  notifications_created: number;
  /** Server-side scan timestamp — drives the SyncFreshnessChip on the
   *  Unusual Transactions panel. */
  generated_at?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Heatmap                                                             */
/* ------------------------------------------------------------------ */

export interface HeatmapDay {
  on_date: string;
  day_of_week: number;
  total_outflow_cents: number;
  total_inflow_cents: number;
  txn_count: number;
}

export interface HeatmapStats {
  total_days: number;
  days_with_spend: number;
  busiest_day_of_week: number;
  busiest_dow_avg_cents: number;
  quietest_day_of_week: number;
  quietest_dow_avg_cents: number;
  weekend_avg_cents: number;
  weekday_avg_cents: number;
  biggest_single_day_cents: number;
  biggest_single_day: string | null;
}

export interface Heatmap {
  window_start: string;
  window_end: string;
  days: HeatmapDay[];
  stats: HeatmapStats;
  /** Server-side computation timestamp — drives the SyncFreshnessChip
   *  on the Heatmap panel. */
  generated_at?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Offers (Chase / Amex)                                               */
/* ------------------------------------------------------------------ */

export interface ScrapedOffer {
  site_key: string;
  merchant_name: string;
  title: string;
  reward_type: string;
  reward_value_bps: number | null;
  reward_cap_cents: number | null;
  minimum_spend_cents: number | null;
  expires_at: string | null;
  activation_url: string | null;
  raw_text: string;
}

export interface OfferMatch {
  offer: ScrapedOffer;
  estimated_monthly_value_cents: number;
  confidence: number;
  matched_txn_count_90d: number;
  matched_spend_90d_cents: number;
  rationale: string;
}

export interface OfferScrapeSummary {
  site_key: string;
  name: string;
  rows_seen: number;
  rows_created: number;
  rows_updated: number;
  auth_missing: boolean;
  error: string | null;
}

export interface OfferScrapeResponse {
  started_at: string;
  finished_at: string;
  summaries: OfferScrapeSummary[];
  matches: OfferMatch[];
  total_estimated_value_cents: number;
}

/** Lifecycle state for a persisted Offer row. Mirrors the backend
 *  OfferStatus enum in db/models.py. */
export type OfferStatus =
  | "available"
  | "activated"
  | "redeemed"
  | "expired"
  | "dismissed";

/** Persisted offer row, returned by GET /api/offers. */
export interface PersistedOffer {
  id: number;
  title: string;
  description: string | null;
  source: string;
  reward_type: string | null;
  reward_value_bps: number | null;
  reward_cap_cents: number | null;
  minimum_spend_cents: number | null;
  activation_url: string | null;
  expires_on: string | null;
  status: OfferStatus;
  estimated_value_cents: number | null;
  merchant_name: string | null;
  expires_in_days: number | null;
  created_at: string;
  updated_at: string;
}

/** Per-portal readiness summary, fed into the status strip. */
export interface OfferPortalStatus {
  site_key: string;
  name: string;
  auth_state_present: boolean;
  auth_state_age_days: number | null;
  auth_state_path: string;
  bootstrap_command: string;
}

/** GET /api/offers/status payload — portal readiness + scoreboard. */
export interface OffersStatus {
  portals: OfferPortalStatus[];
  total_offers: number;
  available_offers: number;
  activated_offers: number;
  expiring_within_7_days: number;
}

/* ------------------------------------------------------------------ */
/*  Card applications (5/24, sign-up bonuses)                           */
/* ------------------------------------------------------------------ */

export type CardApplicationStatus =
  | "planning"
  | "applied"
  | "approved"
  | "denied"
  | "spending"
  | "bonus_earned"
  | "bonus_posted"
  | "closed"
  | "cancelled";

export interface CardApplication {
  id: number;
  issuer: string;
  card_name: string;
  status: CardApplicationStatus;
  account_id: number | null;
  bonus_value_cents: number | null;
  bonus_points: number | null;
  minimum_spend_cents: number | null;
  minimum_spend_window_days: number | null;
  spend_to_date_cents: number;
  minimum_spend_deadline: string | null;
  counts_toward_5_24: boolean;
  bonus_lifetime_eligible_at: string | null;
  annual_fee_cents: number | null;
  first_year_fee_waived: boolean;
  notes: string | null;
  applied_at: string | null;
  approved_at: string | null;
  bonus_earned_at: string | null;
  bonus_posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EligibilityChase524 {
  cards_opened_in_window: number;
  window_start: string;
  window_end: string;
  is_under_5_24: boolean;
  cards: { card_name: string; issuer: string; approved_at: string | null }[];
  notes: string;
}

export interface EligibilityAmexLifetime {
  card_name: string;
  bonus_already_earned: boolean;
  earliest_eligible_again: string | null;
  last_earned_at: string | null;
}

export interface EligibilityReport {
  chase_5_24: EligibilityChase524;
  amex_lifetime: EligibilityAmexLifetime[];
}

/* ------------------------------------------------------------------ */
/*  Merchant deep-dive                                                  */
/* ------------------------------------------------------------------ */

export interface MerchantMonthlySpend {
  month_start: string;
  total_cents: number;
  txn_count: number;
}

export interface MerchantTxn {
  id: number;
  posted_date: string;
  amount_cents: number;
  category_id: number | null;
  description_raw: string;
  account_id: number;
}

export interface MerchantSub {
  id: number;
  name: string;
  subscription_type: string;
  status: string;
  last_amount_cents: number | null;
  confidence_score: number | null;
}

export interface MerchantOffer {
  id: number;
  title: string;
  source: string;
  reward_type: string | null;
  reward_value_bps: number | null;
}

export interface MerchantDetail {
  merchant: string;
  display_name: string;
  transactions: number;
  lifetime_spend_cents: number;
  avg_per_visit_cents: number;
  median_per_visit_cents: number;
  first_seen: string | null;
  last_seen: string | null;
  primary_category: string | null;
  primary_category_id: number | null;
  monthly_breakdown: MerchantMonthlySpend[];
  recent_transactions: MerchantTxn[];
  related_subscription: MerchantSub | null;
  related_offers: MerchantOffer[];
}

/* ------------------------------------------------------------------ */
/*  Tax                                                                 */
/* ------------------------------------------------------------------ */

export interface TaxBucketRollup {
  bucket: string;
  total_cents: number;
  txn_count: number;
}

export interface TaxReport {
  year: number;
  by_bucket: TaxBucketRollup[];
  untagged_total_cents: number;
  untagged_txn_count: number;
  untagged_top_categories: [string, number][];
  grand_total_outflow_cents: number;
  grand_total_inflow_cents: number;
  /** Server-side roll-up timestamp — drives the SyncFreshnessChip on
   *  the Tax Export panel. */
  generated_at?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Notifications                                                       */
/* ------------------------------------------------------------------ */

/** Coarse bucket for visual grouping. Backend derives this from `kind`
 *  via the _KIND_META table in api/notifications.py. Unknown kinds get
 *  "system" (lowest priority).
 */
export type NotificationCategory =
  | "security"
  | "money"
  | "opportunity"
  | "system";

export interface AppNotification {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
  read_at: string | null;
  /** Visual bucket — populated server-side, see _KIND_META map. */
  category: NotificationCategory;
  /** Section hash to drop the user into when they click the row, e.g.
   *  "anomaly", "subscriptions". null = no drill-in (system rows). */
  link: string | null;
}

/* ------------------------------------------------------------------ */
/*  Receipts (Phase 10 Slice A)                                         */
/* ------------------------------------------------------------------ */

export type ReceiptStatus = "pending" | "parsed" | "failed" | "manual";

export interface ReceiptItem {
  id: number;
  receipt_id: number;
  raw_line: string;
  name: string | null;
  brand: string | null;
  quantity_units: number;
  unit_label: string | null;
  unit_price_cents: number | null;
  line_total_cents: number | null;
  discount_cents: number | null;
  sku: string | null;
  canonical_key: string | null;
  item_category: string | null;
}

export interface Receipt {
  id: number;
  image_path: string | null;
  merchant: string | null;
  purchase_date: string | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  status: ReceiptStatus;
  transaction_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ReceiptCouponStatus = "available" | "used" | "expired" | "dismissed";

export interface ReceiptCoupon {
  id: number;
  receipt_id: number;
  title: string;
  code: string | null;
  redemption_url: string | null;
  estimated_value_cents: number | null;
  merchant: string | null;
  expires_at: string | null;
  status: ReceiptCouponStatus;
  raw_text: string | null;
  notes: string | null;
  created_at: string;
  used_at: string | null;
}

export interface ReceiptDetail extends Receipt {
  raw_text: string | null;
  items: ReceiptItem[];
  coupons: ReceiptCoupon[];
}

export interface ReceiptIngestResult {
  receipt_id: number;
  status: ReceiptStatus;
  items_added: number;
  coupons_added: number;
  warnings: string[];
}

export interface OcrStatus {
  available: boolean;
  install_hint: string | null;
}

/** Sprint 49 — Ollama vision-model OCR readiness probe.
 *  Two-flag shape because the Ollama server can be up while the
 *  vision model itself isn't pulled yet (the user has to
 *  `ollama pull llama3.2-vision` once, ~8GB). The UI shows different
 *  install hints for each state. */
export interface VisionOcrStatus {
  ollama_running: boolean;
  vision_model_pulled: boolean;
  model_name: string;
  install_hint: string | null;
}

/* ------------------------------------------------------------------ */
/*  Shopping patterns (Phase 10 Slice B)                                */
/* ------------------------------------------------------------------ */

export type RecurringPurchaseStatus = "active" | "inactive" | "dismissed";

export interface RecurringPurchase {
  id: number;
  canonical_name: string;
  primary_merchant: string | null;
  primary_sku: string | null;
  typical_unit_price_cents: number | null;
  typical_line_total_cents: number | null;
  typical_quantity_units: number | null;
  unit_label: string | null;
  cadence_days: number | null;
  occurrence_count: number;
  first_purchased_at: string | null;
  last_purchased_at: string | null;
  confidence_score: number;
  category: string | null;
  status: RecurringPurchaseStatus;
  name_locked: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Derived
  next_expected_at: string | null;
  annualized_cost_cents: number | null;
  cadence_label: string | null;
}

export interface DetectRunResult {
  created: number;
  updated: number;
  deactivated: number;
  skipped_dismissed: number;
  total_active: number;
}

export interface MerchantRollupRow {
  merchant_key: string;
  display_name: string;
  transaction_count: number;
  monthly_avg_cents: number;
  median_per_visit_cents: number;
  cadence_days: number | null;
  last_seen: string | null;
  total_lifetime_cents: number;
  primary_category_id: number | null;
  primary_category_name: string | null;
}

/* ------------------------------------------------------------------ */
/*  Deals (Phase 10 Slice D)                                            */
/* ------------------------------------------------------------------ */

export type PriceObservationSource =
  | "manual"
  | "scraper:walmart"
  | "scraper:target"
  | "scraper:costco"
  | "scraper:amazon_fresh"
  | "scraper:kroger"
  | "email";

export interface DealOpportunity {
  pattern_id: number;
  pattern_name: string;
  pattern_merchant: string | null;
  baseline_cents: number;
  deal_merchant: string;
  deal_price_cents: number;
  savings_cents: number;
  savings_pct: number;
  observed_at: string;
  product_url: string | null;
  annual_savings_cents: number | null;
}

export interface PriceObservation {
  id: number;
  recurring_purchase_id: number;
  merchant: string;
  price_cents: number;
  observed_at: string;
  source: PriceObservationSource;
  in_stock: boolean;
  product_url: string | null;
  notes: string | null;
  created_at: string;
}

export interface DealScraperStatus {
  name: string;
  requires_auth: boolean;
  auth_missing: boolean;
}

export interface DealScraperRunSummary {
  name: string;
  queries_attempted: number;
  rows_created: number;
  rows_skipped: number;
  auth_missing: boolean;
  error: string | null;
}

export interface DealScrapeResult {
  started_at: string;
  finished_at: string;
  patterns_scanned: number;
  summaries: DealScraperRunSummary[];
  total_observations_created: number;
}

/* ------------------------------------------------------------------ */
/*  Canonical products (Phase 10 Slice E)                               */
/* ------------------------------------------------------------------ */

export interface CanonicalProduct {
  id: number;
  name: string;
  brand: string | null;
  category: string | null;
  size_value: number | null;
  size_unit: string | null;
  form: string | null;
  normalized_key: string;
  primary_upc: string | null;
  name_locked: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Derived
  receipt_item_count: number;
  recurring_pattern_count: number;
  observation_count: number;
  merchants: string[];
}

export interface LinkedReceiptItem {
  receipt_item_id: number;
  receipt_id: number;
  merchant: string | null;
  purchase_date: string | null;
  name: string | null;
  raw_line: string;
  line_total_cents: number | null;
  quantity_units: number;
}

export interface CanonicalProductDetail extends CanonicalProduct {
  linked_items: LinkedReceiptItem[];
  linked_patterns: {
    id: number;
    canonical_name: string;
    primary_merchant: string | null;
    cadence_days: number | null;
    occurrence_count: number;
    typical_line_total_cents: number | null;
  }[];
}

export interface CanonicalizeRunResult {
  items_processed: number;
  items_linked: number;
  patterns_processed: number;
  patterns_linked: number;
  canonicals_created: number;
}

/* ------------------------------------------------------------------ */
/*  Bundles (Wave E)                                                    */
/* ------------------------------------------------------------------ */

export interface BundleOverlap {
  parent_subscription_id: number | null;
  parent_label: string;
  parent_monthly_cents: number;
  perk_subscription_id: number;
  perk_merchant: string;
  perk_label: string;
  perk_monthly_cents: number;
  annual_savings_cents: number;
  tier_note: string;
  confidence: number;
  activation_url: string | null;
  notes: string[];
  rationale: string;
}

export interface BundleOverlapsResponse {
  overlaps: BundleOverlap[];
  total_annual_savings_cents: number;
  high_confidence_count: number;
  generated_at?: string | null;
}

// Sprint 22 — subscription MoM growth alerts.
export interface SubscriptionTrendAlert {
  subscription_id: number;
  subscription_name: string;
  growth_ratio: number;
  growth_pct: number;
  recent_avg_cents: number;
  baseline_avg_cents: number;
  months_observed: number;
  headline: string;
}

export interface SubscriptionTrendsResponse {
  alerts: SubscriptionTrendAlert[];
  /** Sprint 24 — fastest-growing subs even when no alert clears the
   *  20% / 6-month threshold. Shown in a calmer "preview" banner. */
  top_movers: SubscriptionTrendAlert[];
  total_monthly_delta_cents: number;
  generated_at?: string | null;
}

export interface TierScrapeSiteResult {
  site_key: string;
  /** "ok" | "auth_missing" | "no_data" | "error" */
  status: string;
  snapshots_saved: number;
  plan_summary: string[];
  error?: string | null;
}

export interface TierScrapeResponse {
  sites: TierScrapeSiteResult[];
  total_snapshots: number;
  finished_at: string;
}

export const api = {
  listTransactions: (params: Record<string, string | number | boolean | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return fetch(`/api/transactions?${qs}`).then(json<Transaction[]>);
  },
  bundleOverlaps: () =>
    fetch("/api/bundles/overlaps").then(json<BundleOverlapsResponse>),
  /** Sprint 22 — subscriptions whose 3-month avg outflow has grown
   *  meaningfully above their trailing 12-month baseline. Returns
   *  alerts sorted by growth ratio (biggest grower first). */
  subscriptionTrends: () =>
    fetch("/api/subscriptions/trends").then(json<SubscriptionTrendsResponse>),
  /** Wave E-6 — trigger the Playwright run against carrier portals
   *  (currently just Xfinity). Returns per-site status; UI should
   *  surface auth_missing as a "run bootstrap once" prompt. */
  scrapePlanTiers: () =>
    fetch("/api/bundles/scrape-tiers", { method: "POST" }).then(json<TierScrapeResponse>),
  listCategories: () => fetch("/api/categories").then(json<Category[]>),
  /** Sprint M-5 — drag-and-drop re-parent. parent_id null = top-level. */
  reparentCategory: (categoryId: number, parent_id: number | null) =>
    fetch(`/api/categories/${categoryId}/parent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id }),
    }).then(json<Category>),
  /** Create a new category. parent_id null = top-level. The slug is
   *  derived server-side from the name + parent. */
  createCategory: (body: {
    name: string;
    parent_id?: number | null;
    is_discretionary?: boolean;
    icon?: string | null;
  }) =>
    fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Category>),
  summary: () => fetch("/api/stats/summary").then(json<Summary>),
  runCategorization: () =>
    fetch("/api/rules/run", { method: "POST" }).then(json<Record<string, number>>),
  /** Bulk-categorize triage list: top uncategorized merchant patterns
   *  with a sample row + outflow size + txn count. Backs the wizard
   *  on the Transactions panel that lets the user tag the long tail
   *  in one pass instead of row-by-row. */
  uncategorizedGroups: (params: { min_txn_count?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.min_txn_count != null)
      qs.set("min_txn_count", String(params.min_txn_count));
    if (params.limit != null) qs.set("limit", String(params.limit));
    const tail = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/rules/uncategorized-groups${tail}`).then(
      json<
        Array<{
          pattern: string;
          sample_description: string;
          txn_count: number;
          total_outflow_cents: number;
        }>
      >,
    );
  },
  /** Bulk-create rules from N (pattern, category_id) pairs. Returns a
   *  summary: rules_created, rules_updated, txns_tagged after re-run. */
  bulkRulesFromPatterns: (
    items: Array<{ pattern: string; category_id: number }>,
  ) =>
    fetch("/api/rules/bulk-from-patterns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    }).then(
      json<{
        rules_created: number;
        rules_updated: number;
        txns_tagged: number;
      }>,
    ),
  /** Inline "categorize this" — applies the picked category to the
   *  originating transaction AND creates a non-seed rule that will catch
   *  the same merchant on every future row. Returns the rule + the count
   *  of rows that now match. */
  ruleFromTransaction: (body: {
    transaction_id: number;
    category_id: number;
    pattern_override?: string;
    name_override?: string;
  }) =>
    fetch("/api/rules/from-transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(
      json<{
        rule_id: number;
        pattern: string;
        category_slug: string;
        txns_now_matching: number;
        counts: Record<string, number>;
      }>,
    ),
  /** Fire every detector + scraper in sequence — the "lights everything up"
   *  button. Returns per-task status so the UI can render a progress list. */
  primeRun: () =>
    fetch("/api/prime/run", { method: "POST" }).then(
      json<{
        summary: { ok: number; error: number; total: number };
        tasks: Array<{
          name: string;
          status: "ok" | "error";
          result?: unknown;
          error?: string;
        }>;
      }>,
    ),
  listSubscriptions: (params: {
    status?: SubscriptionStatus;
    subscription_type?: SubscriptionType;
    confirmed_only?: boolean;
  } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return fetch(`/api/subscriptions?${qs}`).then(json<Subscription[]>);
  },
  detectSubscriptions: () =>
    fetch("/api/subscriptions/detect", { method: "POST" }).then(json<Record<string, number>>),
  subscriptionStats: (confirmed_only = false) =>
    fetch(`/api/subscriptions/stats?confirmed_only=${confirmed_only}`).then(
      json<SubscriptionStats>
    ),
  listSubscriptionPriceChanges: () =>
    fetch("/api/subscriptions/price-changes").then(json<Subscription[]>),
  listSubscriptionPrompts: () =>
    fetch("/api/subscriptions/prompts").then(json<SubscriptionPromptsResponse>),
  unmaskSuggestions: (id: number) =>
    fetch(`/api/subscriptions/${id}/unmask-suggestions`).then(
      json<UnmaskSuggestionsResponse>,
    ),
  confirmSubscription: (id: number) =>
    fetch(`/api/subscriptions/${id}/confirm`, { method: "POST" }).then(json<Subscription>),
  dismissSubscription: (id: number) =>
    fetch(`/api/subscriptions/${id}/dismiss`, { method: "POST" }).then(json<Subscription>),
  /** Manually add a subscription the detector can't see yet (e.g. only
   *  one charge so far, below the recurrence threshold). The new row is
   *  active + user-confirmed immediately. */
  createSubscription: (body: {
    name: string;
    amount_cents: number;
    cadence_days?: number;
    subscription_type?: SubscriptionType;
    notes?: string | null;
  }) =>
    fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Subscription>),
  /** Sprint 25 — top merchants by lifetime outflow, optionally
   *  filtered by substring. Backs the Merchants panel's empty-state
   *  browse list so users don't have to *know* what to type. */
  listMerchants: (params: { search?: string; limit?: number; months?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.months != null) qs.set("months", String(params.months));
    const tail = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/merchants${tail}`).then(
      json<{
        merchants: Array<{
          description: string;
          display_name: string;
          lifetime_spend_cents: number;
          txn_count: number;
          last_seen: string | null;
          primary_category_id: number | null;
          primary_category_name: string | null;
        }>;
        total: number;
      }>,
    );
  },
  /** Sprint 23a — set monthly price for a subscription. Used by the
   *  needs-price prompt when LLM discovery couldn't extract a $ amount
   *  from the source Gmail snippet. monthly_cents is unsigned; the
   *  backend stores it as negative (outflow convention). */
  setSubscriptionPrice: (
    id: number,
    monthly_cents: number,
    cadence_label?: string,
  ) =>
    fetch(`/api/subscriptions/${id}/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_cents, cadence_label: cadence_label ?? null }),
    }).then(json<Subscription>),
  setSubscriptionStatus: (id: number, status: SubscriptionStatus) =>
    fetch(`/api/subscriptions/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).then(json<Subscription>),
  setSubscriptionType: (id: number, subscription_type: SubscriptionType) =>
    fetch(`/api/subscriptions/${id}/type`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription_type }),
    }).then(json<Subscription>),
  applySubscriptionPromos: () =>
    fetch("/api/subscriptions/apply-promos", { method: "POST" }).then(json<PromoApplyResult>),
  deleteSubscription: (id: number) =>
    fetch(`/api/subscriptions/${id}`, { method: "DELETE" }).then(() => undefined),

  // Phase F — composite-charge unmasking
  /** Snapshot of a composite parent + its declared children + UX hints. */
  unmaskSubscription: (id: number) =>
    fetch(`/api/subscriptions/${id}/unmask`).then(json<CompositeUnmaskResponse>),
  /** Add a manually-declared line item inside a composite parent. */
  addCompositeChild: (id: number, payload: CompositeChildIn) =>
    fetch(`/api/subscriptions/${id}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<Subscription>),
  /** Toggle the composite flag on a subscription row. */
  setCompositeFlag: (id: number, is_composite: boolean) =>
    fetch(`/api/subscriptions/${id}/composite?is_composite=${is_composite}`, {
      method: "POST",
    }).then(json<Subscription>),

  // Plaid
  plaidStatus: () => fetch("/api/plaid/status").then(json<PlaidStatus>),
  plaidListItems: () => fetch("/api/plaid/items").then(json<PlaidItem[]>),
  plaidCreateLinkToken: () =>
    fetch("/api/plaid/link-token", { method: "POST" }).then(json<{ link_token: string }>),
  /** Sprint 42 — create a Plaid Link token in UPDATE MODE for an
   *  existing item. Opens the Plaid Link account-selection screen
   *  pre-bound to the item so the user can add (or remove) which of
   *  their bank's accounts to share. Fixes the "only shared checking,
   *  where's my savings?" scenario without a remove + re-add. */
  plaidCreateUpdateLinkToken: (item_id: number) =>
    fetch(`/api/plaid/items/${item_id}/update-link-token`, {
      method: "POST",
    }).then(json<{ link_token: string }>),
  /** Sprint 46 — first-run setup checklist. Returns the status of
   *  every one-time-setup step (Plaid linked, Gmail OAuth done,
   *  Receipts uploaded, Ollama running, Card-offer scrapers
   *  bootstrapped, Albert scraper bootstrapped) so Overview can
   *  render a coherent "what's left to do" list. */
  setupStatus: () =>
    fetch("/api/setup/status").then(
      json<{
        items: Array<{
          key: string;
          title: string;
          detail: string;
          status: "done" | "partial" | "todo";
          action_hash: string;
          action_label: string;
        }>;
        completed: number;
        total: number;
      }>,
    ),
  /** Sprint 43 — run all registered balance scrapers (Albert, etc.)
   *  on demand. Returns per-site counts + auth-state-missing list.
   *  The UI surfaces the auth-missing entries as "run bootstrap"
   *  guidance rather than 5xx-ing. */
  runBalanceScrapers: () =>
    fetch("/api/balance-scrapers/run", { method: "POST" }).then(
      json<{
        sites_attempted: number;
        sites_succeeded: number;
        sites_auth_missing: string[];
        sites_failed: Array<{ site: string; error: string }>;
        balances_written: number;
        accounts_created: number;
        ran_at: string;
      }>,
    ),
  plaidExchange: (public_token: string) =>
    fetch("/api/plaid/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_token }),
    }).then(json<PlaidItem>),
  plaidSyncItem: (item_id: number) =>
    fetch(`/api/plaid/sync/${item_id}`, { method: "POST" }).then(json<PlaidSyncResult>),
  plaidSyncAll: () =>
    fetch("/api/plaid/sync-all", { method: "POST" }).then(
      json<{ synced_at: string; item_count: number; items: Record<string, unknown> }>
    ),
  plaidDeleteItem: (item_id: number) =>
    fetch(`/api/plaid/items/${item_id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  plaidSchedule: () => fetch("/api/plaid/schedule").then(json<PlaidSchedule>),
  plaidSandboxPublicToken: (institution_id = "ins_109508") =>
    fetch("/api/plaid/sandbox/public-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ institution_id }),
    }).then(json<{ public_token: string }>),

  // Gmail
  gmailStatus: () => fetch("/api/gmail/status").then(json<GmailStatus>),
  gmailAuthorize: () =>
    fetch("/api/gmail/authorize", { method: "POST" }).then(
      json<{ authorized: boolean; message: string }>
    ),
  gmailSync: (opts: { newer_than_days?: number; extra_filters?: string; max_results?: number } = {}) =>
    fetch("/api/gmail/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }).then(json<GmailSyncResult>),
  gmailListMessages: (
    params: { outcome?: ParserOutcome; parser?: string; domain?: string; limit?: number; offset?: number } = {}
  ) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return fetch(`/api/gmail/messages?${qs}`).then(json<GmailMessage[]>);
  },
  gmailListParsers: () => fetch("/api/gmail/parsers").then(json<GmailParser[]>),

  // Accounts
  listAccounts: () => fetch("/api/accounts").then(json<Account[]>),

  // Budgets
  listBudgets: (month_start?: string) => {
    const qs = month_start ? `?month_start=${month_start}` : "";
    return fetch(`/api/budgets${qs}`).then(json<Budget[]>);
  },
  upsertBudget: (payload: BudgetUpsertPayload) =>
    fetch("/api/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<Budget>),
  deleteBudget: (id: number) =>
    fetch(`/api/budgets/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  budgetRollup: (month_start: string) =>
    fetch(`/api/budgets/rollup?month_start=${month_start}`).then(json<BudgetRollup>),
  /** Itemised backing for the EOM-projection card: the upcoming
   *  paycheck(s) this calendar month + the credit-card debt taken on
   *  so far. The card derives every other line from the rollup. */
  eomDetail: (month_start: string) =>
    fetch(`/api/budgets/eom-detail?month_start=${month_start}`).then(json<EomDetail>),
  /** Sprint L — zero-based assignment ledger. Every dollar of income gets
   *  a job; the response groups commitments by kind, surfaces "unassigned"
   *  (positive=surplus, negative=overcommitted), and includes 3-month
   *  drift history. */
  budgetAssignmentLedger: (month_start: string) =>
    fetch(`/api/budgets/assignment-ledger?month_start=${month_start}`).then(
      json<AssignmentLedger>,
    ),
  /** Sprint L-4 — ranked allocation suggestions for the current
   *  unassigned amount. Each suggestion has an Apply payload the UI
   *  turns into one or more PATCH calls. */
  budgetRebalanceSuggestions: (month_start: string) =>
    fetch(
      `/api/budgets/rebalance-suggestions?month_start=${month_start}`,
    ).then(json<RebalanceSuggestionsResponse>),
  /** Sprint O-2 — every recurring outflow (rent, utilities, subs,
   *  student loans, insurance...) detected by cadence + amount-variance
   *  analysis over the last 180 days. Sorted by monthly_equivalent
   *  descending — biggest obligations first. */
  recurringBills: () =>
    fetch(`/api/budgets/recurring-bills`).then(json<RecurringBillsResponse>),
  /** Sprint P — turn detected fixed bills into Plan budget lines. Pass
   *  category_ids for the per-row "Budget this" button, or omit them for
   *  the "Budget all detected bills" bulk action. Each category's cap is
   *  raised to cover its detected bills, never lowered. */
  adoptRecurringBills: (body: {
    month_start: string;
    category_ids?: number[] | null;
  }) =>
    fetch(`/api/budgets/recurring-bills/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<AdoptRecurringResponse>),
  /** Sprint Q-1 — drop a transaction into a new category. Used by the
   *  CategorizePanel drag-drop. Backend marks category_source = manual
   *  so the row stops looking like a "guess" everywhere it shows up. */
  recategorizeTransaction: (
    txnId: number,
    body: { category_id: number; merchant_id?: number | null },
  ) =>
    fetch(`/api/transactions/${txnId}/recategorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Transaction>),
  /** One-time-spend flag. Marks (or clears) a transaction as a
   *  non-recurring spike — a medical emergency, a car repair, a big
   *  one-off purchase — so the multi-month projection stops smearing it
   *  into the monthly outflow rate it extrapolates forward. */
  setTransactionOneTime: (txnId: number, isOneTime: boolean) =>
    fetch(`/api/transactions/${txnId}/one-time`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_one_time: isOneTime }),
    }).then(json<Transaction>),
  /** Sprint Q-2 — "teach the machine" categorization. Recategorizes the
   *  transaction AND creates a priority-230 merchant rule derived from
   *  its description, then cascades that rule over still-uncategorized
   *  rows. Used by the CategorizePanel DRAG action (a drag is an
   *  explicit "this merchant belongs here" signal worth a rule; a
   *  plain badge-confirm is not). Returns how many txns the new rule
   *  now matches so the UI can surface "+N siblings auto-placed". */
  createRuleFromTransaction: (body: {
    transaction_id: number;
    category_id: number;
  }) =>
    fetch(`/api/rules/from-transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(
      json<{
        rule_id: number;
        pattern: string;
        category_slug: string;
        txns_now_matching: number;
        counts: Record<string, number>;
      }>,
    ),
  /** Sprint Q-3 — per-transaction category guesses for everything
   *  currently uncategorized, derived from how the user has filed the
   *  same merchant before. Only returns suggestions where there's a
   *  historical match; brand-new merchants are omitted. */
  categorySuggestions: () =>
    fetch(`/api/transactions/category-suggestions`).then(
      json<CategorySuggestionsResponse>,
    ),
  /** Sprint L-4 — set a goal's effective monthly funding rate. Backend
   *  recomputes target_date so the same target_amount lands at the
   *  new rate. */
  goalSetFundingRate: (goalId: number, monthly_cents: number) =>
    fetch(`/api/goals/${goalId}/set-funding-rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_cents }),
    }).then(json<Goal>),
  /** Wave G — balance projection out to N months. Empty body = status-quo;
   *  pass `category_overrides` (cat_id → new monthly cents) for what-if. */
  budgetProject: (body: ProjectionRequest = {}) =>
    fetch("/api/budgets/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<ProjectionResponse>),
  /** Wave G — ranked budget recommendations across 4 signals
   *  (overspend, goal, bundle_dup, yield_shift). Each rec has an
   *  optional `apply` payload the UI passes to budgetProject for the
   *  what-if scenario. */
  budgetRecommendations: () =>
    fetch("/api/budgets/recommendations").then(json<BudgetRecommendationsResponse>),
  budgetCopyFromPrior: (payload: BudgetCopyPayload) =>
    fetch("/api/budgets/copy-from-prior", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<BudgetTemplateResult>),
  budgetFillFromAverage: (payload: BudgetFillPayload) =>
    fetch("/api/budgets/fill-from-average", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<BudgetTemplateResult>),

  // Month-over-month
  monthOverMonth: (months = 6) =>
    fetch(`/api/stats/month-over-month?months=${months}`).then(json<MonthOverMonth>),

  // Credit
  listCreditScores: (limit = 50) =>
    fetch(`/api/credit/scores?limit=${limit}`).then(json<CreditScore[]>),
  addCreditScore: (payload: CreditScoreIn) =>
    fetch("/api/credit/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<CreditScore>),
  deleteCreditScore: (id: number) =>
    fetch(`/api/credit/scores/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  creditUtilization: () =>
    fetch("/api/credit/utilization").then(json<UtilizationResponse>),
  creditOpportunities: () =>
    fetch("/api/credit/opportunities").then(json<CreditOpportunitiesResponse>),

  // Legal claims
  listLegalClaims: (
    params: {
      status?: LegalClaimStatus;
      proof_status?: ProofRequirement;
      include_expired?: boolean;
      // 2-letter postal code (CA / FL / TX) or the literal "nationwide".
      // Omit to skip the state filter entirely.
      state?: string;
    } = {}
  ) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/legal-claims${suffix}`).then(json<LegalClaim[]>);
  },
  createLegalClaim: (payload: LegalClaimIn) =>
    fetch("/api/legal-claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<LegalClaim>),
  updateLegalClaim: (id: number, payload: LegalClaimUpdate) =>
    fetch(`/api/legal-claims/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<LegalClaim>),
  deleteLegalClaim: (id: number) =>
    fetch(`/api/legal-claims/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  /** Sprint 34 — accepts an optional state filter so the stat-card
   *  totals reflect the active state chip (California, Nationwide,
   *  etc.) instead of staying at global numbers. */
  legalClaimStats: (params: { state?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.state) qs.set("state", params.state);
    const tail = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/legal-claims/stats${tail}`).then(json<LegalClaimStats>);
  },
  // Trigger an on-demand scrape across all configured sources.
  scrapeLegalClaims: () =>
    fetch("/api/legal-claims/scrape", { method: "POST" }).then(
      json<ScraperRunResponse>
    ),

  // Goals (Phase D)
  listGoals: (params: { kind?: GoalKind; status?: GoalStatus } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/goals${suffix}`).then(json<Goal[]>);
  },
  getGoal: (id: number) => fetch(`/api/goals/${id}`).then(json<Goal>),
  createGoal: (payload: GoalIn) =>
    fetch("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<Goal>),
  updateGoal: (id: number, payload: GoalIn) =>
    fetch(`/api/goals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<Goal>),
  deleteGoal: (id: number) =>
    fetch(`/api/goals/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  contributeToGoal: (id: number, payload: GoalContributionIn) =>
    fetch(`/api/goals/${id}/contribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<GoalContribution>),
  listGoalContributions: (id: number) =>
    fetch(`/api/goals/${id}/contributions`).then(json<GoalContribution[]>),
  deleteGoalContribution: (goalId: number, contribId: number) =>
    fetch(`/api/goals/${goalId}/contributions/${contribId}`, { method: "DELETE" }).then(
      (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      }
    ),

  // Unclaimed property — Phase 8.1
  listUnclaimed: (params: { status?: UnclaimedStatus; state?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/unclaimed${suffix}`).then(json<UnclaimedRecord[]>);
  },
  createUnclaimed: (payload: UnclaimedIn) =>
    fetch("/api/unclaimed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<UnclaimedRecord>),
  unclaimedStats: () => fetch("/api/unclaimed/stats").then(json<UnclaimedStats>),
  unclaimedSearchTips: () => fetch("/api/unclaimed/search-tips").then(json<UnclaimedSearchTips>),
  updateUnclaimedStatus: (id: number, status: UnclaimedStatus, actual_payout_cents?: number, notes?: string) =>
    fetch(`/api/unclaimed/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, actual_payout_cents, notes }),
    }).then(json<UnclaimedRecord>),
  deleteUnclaimed: (id: number) =>
    fetch(`/api/unclaimed/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Card benefits — Phase 8.3
  cardBenefits: () => fetch("/api/benefits/credits").then(json<CardBenefitReport>),
  /** Catalog of available card-benefit profiles for the manual picker
   *  on Connections. */
  cardProfiles: () =>
    fetch("/api/benefits/profiles").then(
      json<
        Array<{
          name: string;
          annual_fee_cents: number;
          total_credit_value_cents: number;
          benefit_count: number;
        }>
      >,
    ),
  /** Bind (or clear) a card-benefits catalog profile to an Account.
   *  Pass profile=null to clear the override. */
  setCardProfileOverride: (accountId: number, profile: string | null) =>
    fetch(`/api/benefits/cards/${accountId}/profile-override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card_profile_override: profile }),
    }).then(json<{ account_id: number; card_profile_override: string | null }>),

  // Yield-arb — Phase 8.4
  yieldArbReport: () => fetch("/api/yield-opt/report").then(json<YieldArbReport>),

  // Regulatory redress — Phase 8.5
  redressKnown: () => fetch("/api/redress/known").then(json<KnownRedress[]>),
  redressMatchSpend: (days = 730) =>
    fetch(`/api/redress/match-spend?days=${days}`).then(json<RedressMatchReport>),
  listRedress: () => fetch("/api/redress").then(json<RedressRecord[]>),
  createRedress: (payload: Partial<RedressRecord> & { agency: string; company_name: string; title: string }) =>
    fetch("/api/redress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<RedressRecord>),
  updateRedressStatus: (id: number, status: RedressStatus, actual_payout_cents?: number, notes?: string) =>
    fetch(`/api/redress/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, actual_payout_cents, notes }),
    }).then(json<RedressRecord>),
  deleteRedress: (id: number) =>
    fetch(`/api/redress/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Net worth — Phase 7.1
  netWorth: () => fetch("/api/networth").then(json<NetWorthSummary>),
  netWorthHistory: (days = 365) =>
    fetch(`/api/networth/history?days=${days}`).then(json<NetWorthHistory>),
  netWorthSnapshot: () =>
    fetch("/api/networth/snapshot", { method: "POST" }).then(json<NetWorthSummary>),

  // Cash flow forecast — Phase 7.2
  cashFlowForecast: (days = 30) =>
    fetch(`/api/cashflow/forecast?days=${days}`).then(json<CashFlowForecast>),
  /** Sprint 40 — annual renewals beyond the standard 30-day forecast,
   *  surfaced on the "Coming up" tab so the user can see Truthly /
   *  ESPN+ / Settlemate charges that would otherwise be invisible. */
  upcomingAnnuals: (days = 365) =>
    fetch(`/api/cashflow/upcoming-annuals?days=${days}`).then(
      json<UpcomingAnnualsResponse>,
    ),

  // Holdings — Phase 9.1
  listSecurities: () => fetch("/api/securities").then(json<Security[]>),
  listHoldings: () => fetch("/api/holdings").then(json<HoldingDetail[]>),
  portfolio: () => fetch("/api/holdings/portfolio").then(json<Portfolio>),
  updateSecurityPrice: (id: number, latest_price_cents: number) =>
    fetch(`/api/securities/${id}/price`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latest_price_cents }),
    }).then(json<Security>),

  // HSA receipts — Phase 9.2
  listHsaReceipts: (status?: HsaReceiptStatus) => {
    const qs = status ? `?status=${status}` : "";
    return fetch(`/api/hsa/receipts${qs}`).then(json<HsaReceipt[]>);
  },
  createHsaReceipt: (payload: HsaReceiptIn) =>
    fetch("/api/hsa/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<HsaReceipt>),
  reimburseHsaReceipt: (id: number, notes?: string) =>
    fetch(`/api/hsa/receipts/${id}/reimburse`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notes ?? null }),
    }).then(json<HsaReceipt>),
  deleteHsaReceipt: (id: number) =>
    fetch(`/api/hsa/receipts/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  hsaSummary: () => fetch("/api/hsa/receipts/summary").then(json<HsaSummary>),

  // Anomaly — Phase 9.3
  anomalyScan: (days = 90, threshold_sigma = 3.0, fire_notifications = false) =>
    fetch(
      `/api/anomaly/scan?days=${days}&threshold_sigma=${threshold_sigma}&fire_notifications=${fire_notifications}`
    ).then(json<AnomalyScan>),

  // Heatmap — Phase 9.4
  heatmapDaily: (days = 90) =>
    fetch(`/api/heatmap/daily?days=${days}`).then(json<Heatmap>),

  // Offers — Phase 5.1
  listOffers: (params?: {
    status?: OfferStatus;
    source?: string;
    expiring_within_days?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.source) q.set("source", params.source);
    if (params?.expiring_within_days != null)
      q.set("expiring_within_days", String(params.expiring_within_days));
    const qs = q.toString();
    return fetch(`/api/offers${qs ? `?${qs}` : ""}`).then(json<PersistedOffer[]>);
  },
  offersStatus: () => fetch("/api/offers/status").then(json<OffersStatus>),
  updateOfferStatus: (id: number, status: OfferStatus) =>
    fetch(`/api/offers/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).then(json<PersistedOffer>),
  scrapeOffers: () =>
    fetch("/api/offers/scrape", { method: "POST" }).then(json<OfferScrapeResponse>),

  // Card applications — Phase 8.2
  listCardApplications: (params: { status?: CardApplicationStatus; issuer?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/card-applications${suffix}`).then(json<CardApplication[]>);
  },
  createCardApplication: (payload: Partial<CardApplication> & { issuer: string; card_name: string }) =>
    fetch("/api/card-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<CardApplication>),
  cardApplicationsEligibility: () =>
    fetch("/api/card-applications/eligibility").then(json<EligibilityReport>),
  /** Curated catalog of top welcome bonuses, ranked by $-value. Each
   *  entry is enriched with ``user_eligible_5_24`` based on the user's
   *  application history so Chase consumer entries are flagged when
   *  the user is already over the threshold. */
  cardApplicationBestBonuses: (chase_5_24_only = false) =>
    fetch(
      `/api/card-applications/best-bonuses${chase_5_24_only ? "?chase_5_24_only=true" : ""}`,
    ).then(
      json<
        Array<{
          card_name: string;
          issuer: string;
          bonus_points: number;
          bonus_dollar_value_cents: number;
          minimum_spend_cents: number;
          minimum_spend_months: number;
          annual_fee_cents: number;
          counts_toward_5_24: boolean;
          chase_5_24_friendly: boolean;
          notes: string;
          product_url: string;
          user_eligible_5_24: boolean;
        }>
      >,
    ),
  updateCardApplicationStatus: (id: number, status: CardApplicationStatus, notes?: string) =>
    fetch(`/api/card-applications/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, notes: notes ?? null }),
    }).then(json<CardApplication>),
  logCardApplicationSpend: (id: number, additional_spend_cents: number) =>
    fetch(`/api/card-applications/${id}/spend`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_spend_cents }),
    }).then(json<CardApplication>),
  deleteCardApplication: (id: number) =>
    fetch(`/api/card-applications/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Merchant deep-dive — Phase 7.5
  merchantDetail: (key: string, months = 24, txn_limit = 50) =>
    fetch(
      `/api/merchants/${encodeURIComponent(key)}?months=${months}&txn_limit=${txn_limit}`
    ).then(json<MerchantDetail>),

  // Tax — Phase 7.4
  taxReport: (year: number) => fetch(`/api/tax/report?year=${year}`).then(json<TaxReport>),
  taxExportCsvUrl: (year: number) => `/api/tax/export.csv?year=${year}`,

  // Notifications — Phase 6
  listNotifications: (only_unread = false, limit = 50) =>
    fetch(`/api/notifications?only_unread=${only_unread}&limit=${limit}`).then(
      json<AppNotification[]>
    ),
  markNotificationRead: (id: number) =>
    fetch(`/api/notifications/${id}/read`, { method: "POST" }).then(json<AppNotification>),
  markAllNotificationsRead: () =>
    fetch("/api/notifications/read-all", { method: "POST" }).then(
      json<{ marked_read: number }>
    ),
  clearReadNotifications: () =>
    fetch("/api/notifications/clear-read", { method: "POST" }).then(
      json<{ cleared: number }>
    ),
  deleteNotification: (id: number) =>
    fetch(`/api/notifications/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Receipts — Phase 10 Slice A
  ocrStatus: () => fetch("/api/receipts/ocr-status").then(json<OcrStatus>),
  listReceipts: (limit = 100) =>
    fetch(`/api/receipts?limit=${limit}`).then(json<Receipt[]>),
  getReceipt: (id: number) => fetch(`/api/receipts/${id}`).then(json<ReceiptDetail>),
  uploadReceipt: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return fetch("/api/receipts/upload", {
      method: "POST",
      body: fd,
    }).then(json<ReceiptIngestResult>);
  },
  parseReceiptText: (text: string) =>
    fetch("/api/receipts/parse-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json<ReceiptIngestResult>),
  reparseReceipt: (id: number) =>
    fetch(`/api/receipts/${id}/reparse`, { method: "POST" }).then(
      json<ReceiptIngestResult>
    ),
  /** Sprint 49 — vision-OCR readiness probe. Drives the "Re-OCR with AI
   *  vision" button: enabled only when both Ollama is running AND the
   *  vision model has been pulled. */
  visionOcrStatus: () =>
    fetch("/api/receipts/vision-ocr-status").then(json<VisionOcrStatus>),
  /** Sprint 49 — re-OCR an existing receipt via the Ollama vision
   *  model. Updates the same receipt row in place (unlike reparse,
   *  which creates a new row). Wipes existing line items + coupons,
   *  replaces them with the vision model's extraction. */
  visionOcrReceipt: (id: number) =>
    fetch(`/api/receipts/${id}/ocr-vision`, { method: "POST" }).then(
      json<ReceiptIngestResult>,
    ),
  patchReceipt: (id: number, payload: Partial<Receipt>) =>
    fetch(`/api/receipts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<Receipt>),
  patchReceiptItem: (id: number, payload: Partial<ReceiptItem>) =>
    fetch(`/api/receipts/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<ReceiptItem>),
  deleteReceiptItem: (id: number) =>
    fetch(`/api/receipts/items/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  deleteReceipt: (id: number) =>
    fetch(`/api/receipts/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Shopping patterns — Slice B (recurring purchases + merchant rollup)
  listRecurringPurchases: (params: { status?: RecurringPurchaseStatus; category?: string; merchant?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/shopping-patterns${suffix}`).then(json<RecurringPurchase[]>);
  },
  detectRecurringPurchases: () =>
    fetch("/api/shopping-patterns/detect", { method: "POST" }).then(json<DetectRunResult>),
  merchantRollup: (days = 365, min_transactions = 3) =>
    fetch(`/api/shopping-patterns/merchant-rollup?days=${days}&min_transactions=${min_transactions}`).then(
      json<MerchantRollupRow[]>
    ),
  patchRecurringPurchase: (id: number, payload: Partial<RecurringPurchase>) =>
    fetch(`/api/shopping-patterns/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<RecurringPurchase>),
  deleteRecurringPurchase: (id: number) =>
    fetch(`/api/shopping-patterns/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Canonical products — Slice E
  listCanonicalProducts: (params: { q?: string; brand?: string; category?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/canonical-products${suffix}`).then(json<CanonicalProduct[]>);
  },
  getCanonicalProduct: (id: number) =>
    fetch(`/api/canonical-products/${id}`).then(json<CanonicalProductDetail>),
  createCanonicalProduct: (payload: Partial<CanonicalProduct> & { name: string }) =>
    fetch("/api/canonical-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<CanonicalProduct>),
  patchCanonicalProduct: (id: number, payload: Partial<CanonicalProduct>) =>
    fetch(`/api/canonical-products/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<CanonicalProduct>),
  deleteCanonicalProduct: (id: number) =>
    fetch(`/api/canonical-products/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),
  runCanonicalize: () =>
    fetch("/api/canonical-products/canonicalize", { method: "POST" }).then(
      json<CanonicalizeRunResult>
    ),
  mergeCanonicalProducts: (keep_id: number, drop_id: number) =>
    fetch("/api/canonical-products/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep_id, drop_id }),
    }).then(json<CanonicalProduct>),

  // Deals — Slice D (cross-store price observations + deal detection)
  listDeals: (threshold = 0.15, window_days = 30) =>
    fetch(`/api/deals?threshold=${threshold}&window_days=${window_days}`).then(
      json<DealOpportunity[]>
    ),
  scanDeals: () =>
    fetch("/api/deals/scan", { method: "POST" }).then(json<DealScrapeResult>),
  dealScraperStatus: () =>
    fetch("/api/deals/scraper-status").then(json<DealScraperStatus[]>),
  listDealObservations: (params: { recurring_purchase_id?: number; merchant?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/deals/observations${suffix}`).then(json<PriceObservation[]>);
  },
  createDealObservation: (payload: {
    recurring_purchase_id: number;
    merchant: string;
    price_cents: number;
    observed_at?: string;
    in_stock?: boolean;
    product_url?: string;
    notes?: string;
  }) =>
    fetch("/api/deals/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<PriceObservation>),
  deleteDealObservation: (id: number) =>
    fetch(`/api/deals/observations/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Receipt coupons — Slice C
  listReceiptCoupons: (status?: ReceiptCouponStatus) => {
    const qs = status ? `?status=${status}` : "";
    return fetch(`/api/receipts/coupons${qs}`).then(json<ReceiptCoupon[]>);
  },
  patchReceiptCoupon: (id: number, payload: Partial<ReceiptCoupon>) =>
    fetch(`/api/receipts/coupons/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<ReceiptCoupon>),
  deleteReceiptCoupon: (id: number) =>
    fetch(`/api/receipts/coupons/${id}`, { method: "DELETE" }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    }),

  // Money on the table — Phase 8.6 unified ranked-by-ROI dashboard.
  // Pulls every claim/save/earn opportunity from every aggregator
  // (unclaimed property, class actions, regulatory redress, card
  // benefits, yield-arb, sub-cancel) into one queue.
  moneyOnTable: () =>
    fetch("/api/money-on-table/report").then(json<MoneyOnTableReport>),
  // Daily Moves — top-N urgency-ranked slice of the same upstream data.
  // Companion to moneyOnTable; lighter and action-oriented.
  dailyMoves: (limit = 5) =>
    fetch(`/api/money-on-table/today?limit=${limit}`).then(json<DailyMovesReport>),
  // Mark a move as done / snoozed / dismissed. Server stores in
  // daily_move_actions; the queue filters out actioned items.
  dailyMoveAction: (body: {
    source_kind: string;
    source_id?: number | null;
    source_key?: string | null;
    action: "done" | "snoozed" | "dismissed";
    snooze_days?: number | null;
    notes?: string | null;
  }) =>
    fetch("/api/money-on-table/today/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    }),
  // Recent actions (for the "recently done" section + undo). Default
  // 14d window matches the backend.
  dailyMoveActions: (days = 14) =>
    fetch(`/api/money-on-table/today/actions?days=${days}`).then(
      json<DailyMoveActionRecord[]>,
    ),
  // Undo a prior action — re-surfaces the opportunity in the queue.
  dailyMoveUndo: (
    source_kind: string,
    source_id: number | null,
    source_key: string | null,
  ) => {
    const qp = new URLSearchParams({ source_kind });
    if (source_id != null) qp.set("source_id", String(source_id));
    if (source_key) qp.set("source_key", source_key);
    return fetch(`/api/money-on-table/today/action?${qp.toString()}`, {
      method: "DELETE",
    }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    });
  },

  // Net-worth attribution — per-month decomposition into income / spending / other
  netWorthAttribution: (months = 12) =>
    fetch(`/api/networth/attribution?months=${months}`).then(json<AttributionReport>),

  // Chat — local Ollama-powered Q&A over user data
  chatStatus: () => fetch("/api/chat/status").then(json<ChatStatus>),
  chatAsk: (question: string, history: ChatTurn[] = []) =>
    fetch("/api/chat/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history }),
    }).then(json<ChatAskOut>),

  // FIRE / retirement Monte Carlo simulator.
  // /defaults: server-derived starting points seeded from the user's
  // current data so the panel renders something sensible on first load.
  fireDefaults: () => fetch("/api/fire/defaults").then(json<FireDefaults>),
  // /projection: run the simulation. All inputs are query params so
  // TanStack Query can cache by key — the slider UI debounces and
  // the backend runs ~5K trials in well under a second.
  fireProjection: (params: {
    current_age: number;
    target_retirement_age: number;
    starting_cents: number;
    monthly_savings_cents: number;
    annual_spending_cents: number;
    end_age?: number;
    mean_return_pct?: number;
    std_dev_pct?: number;
    n_trials?: number;
    seed?: number;
    simulation_mode?: FireSimulationMode;
    historical_start_year?: number | null;
  }) => {
    const qp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qp.set(k, String(v));
    });
    return fetch(`/api/fire/projection?${qp.toString()}`).then(json<FireProjection>);
  },

  // Savings (Phase D)
  surplus: (mode: SurplusMode = "both") =>
    fetch(`/api/savings/surplus?mode=${mode}`).then(json<SurplusSnapshot>),
  suggestions: (mode: SurplusMode = "historical") => {
    // Server's /suggestions endpoint quietly coerces "both" → "historical",
    // but we still default to the right thing here so the URL stays clean.
    const m = mode === "both" ? "historical" : mode;
    return fetch(`/api/savings/suggestions?mode=${m}`).then(json<SuggestionBundle>);
  },
};

export const fmtCents = (c: number) =>
  (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Format a YYYY-MM-01 date string as "April 2026" (long month + year). */
export const fmtMonthLong = (ymd: string) => {
  // Parse the Y-M-D locally to avoid TZ skew — new Date("2026-04-01") is UTC,
  // which renders as "March 2026" in timezones west of UTC. Splitting and
  // constructing with the local constructor keeps the user's intent intact.
  const [y, m] = ymd.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

/** Format a YYYY-MM-01 date string as "Apr '26" (short). */
export const fmtMonthShort = (ymd: string) => {
  const [y, m] = ymd.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
};

/** Build a YYYY-MM-01 string for the first of this month. */
export const currentMonthStart = (today: Date = new Date()): string => {
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
};

/** Shift a YYYY-MM-01 string by ±n months (returning YYYY-MM-01). */
export const shiftMonthStart = (ymd: string, delta: number): string => {
  const [y, m] = ymd.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}-01`;
};
