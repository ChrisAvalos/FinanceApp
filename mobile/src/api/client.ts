/**
 * Mobile-side API client. Mirrors the web app's `web/src/api/client.ts`
 * thin-fetch pattern, but reads the backend base URL from
 * `process.env.EXPO_PUBLIC_API_URL` (set in `mobile/.env`) so the same
 * code can point at any uvicorn instance reachable from the phone —
 * LAN IP for home-WiFi dev, Tailscale hostname for "from anywhere."
 *
 * Phase 10/mobile: extended to cover the headline screens (Money on
 * the Table, Net Worth, Cash Flow, Budgets, Receipts). Types are
 * intentionally narrow — only the fields the mobile screens render.
 * The web client is the source of truth for the full type set.
 */

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
if (!BASE_URL) {
  console.warn(
    "EXPO_PUBLIC_API_URL is not set. Copy .env.example → .env and set it to your PC's reachable URL.",
  );
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---- Shared utilities -----------------------------------------------

export const fmtCents = (c: number): string =>
  (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fmtCentsNoDollar = (c: number): string =>
  (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- Existing types (transactions screen) ----------------------------

export type Transaction = {
  id: number;
  account_id: number;
  posted_date: string;
  amount_cents: number;
  currency: string;
  description_raw: string;
  description_clean: string | null;
  category_id: number | null;
  merchant_id: number | null;
  source: string;
};

export type Category = {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  is_discretionary: boolean;
  icon: string | null;
};

// ---- Money on the Table ---------------------------------------------

export type MoneyOnTableOpportunity = {
  source_kind: string;
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
};

export type MoneyOnTableReport = {
  as_of: string;
  opportunities: MoneyOnTableOpportunity[];
  total_claimable_cents: number;
  total_savings_cents: number;
  counts_by_kind: Record<string, number>;
  summary_text: string;
};

// ---- Net Worth -------------------------------------------------------

export type NetWorthBreakdownRow = {
  account_type: string;
  kind: string;
  total_cents: number;
  accounts: number;
};

export type NetWorthSummary = {
  as_of: string;
  assets_cents: number;
  liabilities_cents: number;
  net_cents: number;
  breakdown: NetWorthBreakdownRow[];
  accounts_with_no_balance: number;
};

export type NetWorthHistory = {
  series: { as_of: string; assets_cents: number; liabilities_cents: number; net_cents: number }[];
  earliest: string | null;
  latest: string | null;
  delta_30d_cents: number | null;
  delta_1y_cents: number | null;
};

// ---- Cash Flow Forecast ---------------------------------------------

export type CashFlowEvent = {
  on_date: string;
  kind: string;
  label: string;
  amount_cents: number;
  confidence: number;
  source_id: number | null;
  notes: string | null;
};

export type DailyForecastPoint = {
  on_date: string;
  inflow_cents: number;
  outflow_cents: number;
  net_cents: number;
  running_balance_cents: number;
};

export type CashFlowForecast = {
  window_start: string;
  window_end: string;
  starting_balance_cents: number;
  paycheck_cadence_days: number | null;
  paycheck_cadence_confidence: number;
  events: CashFlowEvent[];
  daily: DailyForecastPoint[];
  crunch_days: string[];
};

// Wave G — projection + recommendation types. Shape mirrors the web
// types in web/src/api/client.ts; kept in sync manually.
export type ProjectionPoint = {
  month_index: number;
  checking_cents: number;
  savings_cents: number;
  investment_cents: number;
  net_cents: number;
  income_cents: number;
  outflow_cents: number;
};

export type BudgetProjection = {
  months: number;
  investment_apy: number;
  checking_cap_cents: number;
  scenario_points: ProjectionPoint[];
  baseline_points: ProjectionPoint[] | null;
  monthly_income_cents: number;
  monthly_outflow_cents_baseline: number;
  monthly_outflow_cents_scenario: number;
  starting_checking_cents: number;
  starting_savings_cents: number;
  starting_investment_cents: number;
  starting_net_cents: number;
  liability_cents: number;
  categories: Array<{ id: number; name: string; monthly_cents: number; budget_cap_cents: number }>;
  scenario_vs_baseline_net_cents: number;
};

export type BudgetRecommendation = {
  kind: "overspend" | "goal" | "bundle_dup" | "yield_shift" | string;
  title: string;
  body: string;
  expected_monthly_impact_cents: number;
  priority: number;
  apply: {
    category_overrides: Record<number, number>;
    monthly_investment_contribution_cents: number;
  } | null;
  meta: Record<string, unknown>;
};

export type BudgetRecommendationsResponse = {
  recommendations: BudgetRecommendation[];
  total_potential_monthly_savings_cents: number;
  total_potential_annual_savings_cents: number;
};

// Sprint 40 / Sprint 48 (mobile parity) — annual renewals that fall
// beyond the rolling 30-day forecast window. Backed by GET
// /api/cashflow/upcoming-annuals — rendered as a "Coming up" section
// on both web and phone so the user can see Truthly / ESPN+ /
// Settlemate renewals that would otherwise be invisible.
export type UpcomingAnnual = {
  on_date: string;
  label: string;
  amount_cents: number;
  days_out: number;
  confidence: number;
  subscription_id: number | null;
  notes: string | null;
};

export type UpcomingAnnualsResponse = {
  window_start: string;
  window_end: string;
  events: UpcomingAnnual[];
  total_outflow_cents: number;
  generated_at?: string | null;
};

// ---- Budgets --------------------------------------------------------

export type BudgetStatus = "ok" | "watch" | "over_pace" | "over_budget";

export type BudgetRollupRow = {
  category_id: number;
  category_name: string;
  budget_cents: number;          // cap
  actual_outflow_cents: number;  // positive cents
  remaining_cents: number;       // budget - actual; negative when over
  pct_used: number;              // 0..∞, 100 = at cap
  status: BudgetStatus;
  projected_eom_cents: number | null;
  projected_overage_cents: number | null;
  projected_pct_used: number | null;
  // Rollover (YNAB-style carry-forward). Nonzero when the budget for
  // this category in this month has rollover=True and prior rollover-
  // flagged month(s) had a remainder. effective_budget_cents =
  // budget_cents + rollover_in_cents and is what drives status / pct /
  // projection. Both default to 0 server-side for backward compat with
  // older non-rollover rows.
  rollover_in_cents: number;
  effective_budget_cents: number;
};

export type BudgetRollup = {
  month_start: string;
  pace: number;  // 0..1 — fraction of month elapsed
  total_budget_cents: number;
  total_actual_cents: number;
  rows: BudgetRollupRow[];
  unbudgeted_spending: BudgetRollupRow[];
};

// ---- Receipts -------------------------------------------------------

export type ReceiptStatus = "pending" | "parsed" | "failed" | "manual";

export type Receipt = {
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
};

export type ReceiptItem = {
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
};

export type ReceiptCoupon = {
  id: number;
  receipt_id: number;
  title: string;
  code: string | null;
  redemption_url: string | null;
  estimated_value_cents: number | null;
  merchant: string | null;
  expires_at: string | null;
  status: "available" | "used" | "expired" | "dismissed";
  raw_text: string | null;
  notes: string | null;
  created_at: string;
  used_at: string | null;
};

export type ReceiptDetail = Receipt & {
  raw_text: string | null;
  items: ReceiptItem[];
  coupons: ReceiptCoupon[];
};

export type ReceiptIngestResult = {
  receipt_id: number;
  status: ReceiptStatus;
  items_added: number;
  coupons_added: number;
  warnings: string[];
};

// ---- Subscriptions --------------------------------------------------

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

export type Subscription = {
  id: number;
  name: string;
  amount_cents: number;
  cadence_days: number;
  next_expected_date: string | null;
  status: SubscriptionStatus;
  subscription_type: SubscriptionType;
  confidence_score: number | null;
  is_user_confirmed: boolean;
  last_amount_cents: number | null;
  prior_amount_cents: number | null;
  price_change_date: string | null;
  n_occurrences: number | null;
  cadence_label: string | null;
  is_variable_amount: boolean;
  notes: string | null;
};

// Sprint 27 — types for bundle overlap + MoM trend banners on mobile.
// Kept minimal: only the fields the banner components actually read.
export type BundleOverlap = {
  parent_subscription_id: number | null;
  parent_label: string;
  perk_subscription_id: number;
  perk_merchant: string;
  perk_label: string;
  annual_savings_cents: number;
  tier_note: string;
  confidence: number;
};

export type BundleOverlapsResponse = {
  overlaps: BundleOverlap[];
  total_annual_savings_cents: number;
  high_confidence_count: number;
  generated_at?: string | null;
};

export type SubscriptionTrendAlert = {
  subscription_id: number;
  subscription_name: string;
  growth_ratio: number;
  growth_pct: number;
  recent_avg_cents: number;
  baseline_avg_cents: number;
  months_observed: number;
  headline: string;
};

export type SubscriptionTrendsResponse = {
  alerts: SubscriptionTrendAlert[];
  top_movers: SubscriptionTrendAlert[];
  total_monthly_delta_cents: number;
  generated_at?: string | null;
};

export type SubscriptionStats = {
  total_count: number;
  confirmed_count: number;
  needs_review_count: number;
  monthly_cost_cents: number;
  annual_cost_cents: number;
  price_change_count: number;
};

// ---- Goals ----------------------------------------------------------

export type GoalKind =
  | "general_savings"
  | "emergency_fund"
  | "vacation"
  | "down_payment"
  | "purchase"
  | "debt_payoff";

export type GoalStatus = "active" | "achieved" | "paused" | "archived";

export type Goal = {
  id: number;
  name: string;
  kind: GoalKind;
  target_amount_cents: number;
  current_amount_cents: number;
  target_date: string | null;
  priority: number;
  status: GoalStatus;
  notes: string | null;
};

export type SurplusSnapshot = {
  as_of: string;
  mode_requested: string;
  historical: {
    window_start: string;
    window_end: string;
    inflows_cents: number;
    outflows_cents: number;
    surplus_cents: number;
  } | null;
  forecast: {
    window_start: string;
    window_end: string;
    projected_income_cents: number;
    fixed_obligations_cents: number;
    variable_spend_cents: number;
    surplus_cents: number;
  } | null;
  notes: string[];
};

export type SuggestionKind =
  | "allocate_to_goal"
  | "cancel_subscription"
  | "debt_payoff_avalanche"
  | "debt_payoff_snowball";

export type Suggestion = {
  kind: SuggestionKind;
  title: string;
  body: string;
  estimated_savings_cents: number;
  confidence: number;
  goal_id: number | null;
  subscription_id: number | null;
};

export type SuggestionBundle = {
  as_of: string;
  surplus_cents: number;
  allocations: Suggestion[];
  cancellations: Suggestion[];
  debt_strategies: Suggestion[];
};

// ---- Deals ----------------------------------------------------------

export type DealOpportunity = {
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
};

export type RecurringPurchaseLite = {
  id: number;
  canonical_name: string;
  primary_merchant: string | null;
  cadence_days: number | null;
  status: "active" | "inactive" | "dismissed";
};

export type PriceObservation = {
  id: number;
  recurring_purchase_id: number;
  merchant: string;
  price_cents: number;
  observed_at: string;
  source: string;
  in_stock: boolean;
  product_url: string | null;
  notes: string | null;
  created_at: string;
};

export type DealScraperStatus = {
  name: string;
  requires_auth: boolean;
  auth_missing: boolean;
};

// ---- Legal claims ---------------------------------------------------

export type LegalClaimStatus = "available" | "claimed" | "paid" | "dismissed";
export type ProofRequirement = "not_required" | "required" | "unknown";

export type LegalClaim = {
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
  status: LegalClaimStatus;
  source: string;
  state_eligibility: string;
  actual_payout_cents: number | null;
  is_expired: boolean;
  days_until_deadline: number | null;
};

export type LegalClaimStats = {
  total_count: number;
  available_count: number;
  claimed_count: number;
  paid_count: number;
  dismissed_count: number;
  expired_count: number;
  pending_potential_cents: number;
  collected_cents: number;
  available_quick_count: number;
  available_with_proof_count: number;
  available_unknown_count: number;
  counts_by_state: Record<string, number>;
};

// ---- Month-over-month trends ---------------------------------------

export type MonthOutflowCell = {
  month_start: string;
  outflow_cents: number;
};

export type CategoryTrendRow = {
  category_id: number | null;
  category_name: string | null;
  outflow_by_month_cents: number[];
  avg_outflow_cents: number;
  trend_pct_vs_avg: number | null;
};

export type MonthOverMonth = {
  months: MonthOutflowCell[];
  categories: CategoryTrendRow[];
};

// ---- Credit ---------------------------------------------------------

export type CreditBureau = "experian" | "transunion" | "equifax";

export type CreditScore = {
  id: number;
  score: number;
  bureau: CreditBureau;
  scoring_model: string;
  as_of: string;
  source: string;
  source_detail: string | null;
  notes: string | null;
};

export type UtilizationRow = {
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
};

export type UtilizationResponse = {
  aggregate_reported_utilization_pct: number | null;
  aggregate_live_utilization_pct: number | null;
  total_limit_cents: number;
  total_live_balance_cents: number;
  total_reported_balance_cents: number;
  rows: UtilizationRow[];
};

export type CreditOpportunity = {
  kind: string;
  account_id: number | null;
  account_name: string | null;
  title: string;
  rationale: string;
  action_steps: string[];
  estimated_score_delta: number | null;
  confidence: number;
  urgency_days: number | null;
};

export type CreditOpportunitiesResponse = {
  generated_at: string;
  opportunities: CreditOpportunity[];
};

// ---- Anomaly --------------------------------------------------------

export type AnomalyRow = {
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
};

export type AnomalyScan = {
  window_start: string;
  window_end: string;
  threshold_sigma: number;
  transactions_scanned: number;
  anomalies: AnomalyRow[];
  notifications_created: number;
};

// ---- Heatmap --------------------------------------------------------

export type HeatmapDay = {
  on_date: string;
  day_of_week: number;
  total_outflow_cents: number;
  total_inflow_cents: number;
  txn_count: number;
};

export type HeatmapStats = {
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
};

export type Heatmap = {
  window_start: string;
  window_end: string;
  days: HeatmapDay[];
  stats: HeatmapStats;
};

// ---- Notifications --------------------------------------------------

export type AppNotification = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
  read_at: string | null;
};

// ---- Unclaimed property ---------------------------------------------

export type UnclaimedStatus = "found" | "claimed" | "paid" | "rejected" | "dismissed";

export type UnclaimedRecord = {
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
};

export type UnclaimedStats = {
  total_count: number;
  found_count: number;
  claimed_count: number;
  paid_count: number;
  rejected_count: number;
  dismissed_count: number;
  estimated_pending_cents: number;
  actual_collected_cents: number;
};

export type UnclaimedSearchTips = {
  intro: string;
  federal_resources: { name: string; url: string; what: string }[];
  state_resources: { state: string; url: string; name: string }[];
  name_variants_to_try: string[];
  addresses_to_try: string[];
};

// ---- Card benefits --------------------------------------------------

export type CardBenefitRow = {
  account_id: number;
  account_name: string;
  profile_name: string;
  annual_fee_cents: number;
  total_credit_value_cents: number;
  benefits: { name: string; value_cents: number; cadence?: string; notes?: string; activation_url?: string }[];
  net_after_fee_cents: number;
};

export type CardBenefitReport = {
  as_of: string;
  rows: CardBenefitRow[];
  unmatched_card_ids: number[];
  total_face_value_cents: number;
  total_annual_fee_cents: number;
  net_potential_cents: number;
};

// ---- Yield arbitrage ------------------------------------------------

export type YieldArbProduct = {
  name: string;
  apy_pct: number;
  minimum_cents: number;
  fdic_insured: boolean;
  notes: string;
  open_url: string;
  yearly_earnings_at_balance_cents: number;
  delta_vs_current_cents: number;
};

export type YieldArbAccount = {
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
};

export type YieldArbReport = {
  as_of: string;
  accounts: YieldArbAccount[];
  total_idle_balance_cents: number;
  total_yearly_potential_delta_cents: number;
  summary_text: string;
};

// ---- Regulatory redress ---------------------------------------------

export type RedressStatus =
  | "candidate"
  | "eligible"
  | "pending_filed"
  | "paid"
  | "rejected"
  | "dismissed";

export type KnownRedress = {
  agency: string;
  company_name: string;
  title: string;
  eligibility_description: string;
  claim_url: string | null;
  total_redress_cents: number | null;
  estimated_per_user_cents: number | null;
  claim_deadline: string | null;
};

export type RedressMatch = {
  catalog_entry: KnownRedress;
  matched_transactions: number;
  matched_total_spend_cents: number;
  sample_descriptions: string[];
  already_logged: boolean;
};

export type RedressMatchReport = {
  matches: RedressMatch[];
  total_estimated_cents: number;
};

export type RedressRecord = {
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
};

// ---- Holdings -------------------------------------------------------

export type SecurityType = "equity" | "etf" | "mutual_fund" | "crypto" | "bond" | "other";

export type Security = {
  id: number;
  ticker: string | null;
  name: string;
  security_type: SecurityType;
  cusip: string | null;
  isin: string | null;
  latest_price_cents: number | null;
  latest_price_at: string | null;
};

export type HoldingDetail = {
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
};

export type AllocationSlice = {
  security_type: string;
  total_value_cents: number;
  pct: number;
};

export type Portfolio = {
  as_of: string;
  total_value_cents: number;
  total_cost_basis_cents: number;
  total_unrealized_gain_cents: number;
  total_unrealized_gain_pct: number;
  holdings_count: number;
  accounts_count: number;
  allocation_by_type: AllocationSlice[];
  top_holdings: HoldingDetail[];
};

// ---- HSA ------------------------------------------------------------

export type HsaReceiptStatus = "saved" | "reimbursed" | "voided";

export type HsaReceipt = {
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
};

export type HsaReceiptIn = {
  expense_date: string;
  amount_cents: number;
  description: string;
  expense_category?: string | null;
  provider_name?: string | null;
  payment_method?: string | null;
  transaction_id?: number | null;
  receipt_path?: string | null;
  notes?: string | null;
};

export type HsaSummary = {
  total_receipts: number;
  saved_count: number;
  saved_total_cents: number;
  reimbursed_total_cents: number;
  voided_count: number;
  earliest_saved_date: string | null;
  latest_saved_date: string | null;
  projected_at_30yr_7pct_cents: number;
  summary_text: string;
};

// ---- Offers (Chase / Amex) ------------------------------------------

export type ScrapedOffer = {
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
};

export type OfferMatch = {
  offer: ScrapedOffer;
  estimated_monthly_value_cents: number;
  confidence: number;
  matched_txn_count_90d: number;
  matched_spend_90d_cents: number;
  rationale: string;
};

export type OfferScrapeSummary = {
  site_key: string;
  name: string;
  rows_seen: number;
  rows_created: number;
  rows_updated: number;
  auth_missing: boolean;
  error: string | null;
};

export type OfferScrapeResponse = {
  started_at: string;
  finished_at: string;
  summaries: OfferScrapeSummary[];
  matches: OfferMatch[];
  total_estimated_value_cents: number;
};

// ---- Card applications ----------------------------------------------

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

export type CardApplication = {
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
};

export type EligibilityChase524 = {
  cards_opened_in_window: number;
  window_start: string;
  window_end: string;
  is_under_5_24: boolean;
  cards: { card_name: string; issuer: string; approved_at: string | null }[];
  notes: string;
};

export type EligibilityAmexLifetime = {
  card_name: string;
  bonus_already_earned: boolean;
  earliest_eligible_again: string | null;
  last_earned_at: string | null;
};

export type EligibilityReport = {
  chase_5_24: EligibilityChase524;
  amex_lifetime: EligibilityAmexLifetime[];
};

// ---- Merchant deep-dive ---------------------------------------------

export type MerchantMonthlySpend = {
  month_start: string;
  total_cents: number;
  txn_count: number;
};

export type MerchantTxn = {
  id: number;
  posted_date: string;
  amount_cents: number;
  category_id: number | null;
  description_raw: string;
  account_id: number;
};

export type MerchantSub = {
  id: number;
  name: string;
  subscription_type: string;
  status: string;
  last_amount_cents: number | null;
  confidence_score: number | null;
};

export type MerchantOffer = {
  id: number;
  title: string;
  source: string;
  reward_type: string | null;
  reward_value_bps: number | null;
};

export type MerchantDetail = {
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
};

export type MerchantRollupRow = {
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
};

// ---- Tax ------------------------------------------------------------

export type TaxBucketRollup = {
  bucket: string;
  total_cents: number;
  txn_count: number;
};

export type TaxReport = {
  year: number;
  by_bucket: TaxBucketRollup[];
  untagged_total_cents: number;
  untagged_txn_count: number;
  untagged_top_categories: [string, number][];
  grand_total_outflow_cents: number;
  grand_total_inflow_cents: number;
};

// ---- Shopping patterns (recurring purchases) ------------------------

export type RecurringPurchaseStatus = "active" | "inactive" | "dismissed";

export type RecurringPurchase = {
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
};

// ---- Canonical products ---------------------------------------------

export type CanonicalProduct = {
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
};

export type LinkedReceiptItem = {
  receipt_item_id: number;
  receipt_id: number;
  merchant: string | null;
  purchase_date: string | null;
  name: string | null;
  raw_line: string;
  line_total_cents: number | null;
  quantity_units: number;
};

export type CanonicalProductDetail = CanonicalProduct & {
  linked_items: LinkedReceiptItem[];
  linked_patterns: {
    id: number;
    canonical_name: string;
    primary_merchant: string | null;
    cadence_days: number | null;
    occurrence_count: number;
    typical_line_total_cents: number | null;
  }[];
};

// ---- Plaid (Connections) --------------------------------------------

export type PlaidStatus = {
  configured: boolean;
  env: string;
  client_id_present: boolean;
  secret_present: boolean;
};

export type PlaidItemStatus = "good" | "login_required" | "error";

export type PlaidItem = {
  id: number;
  plaid_item_id: string;
  institution_id: number;
  plaid_institution_id: string | null;
  // Friendly name from our Institution table (e.g. "Chase"). Optional
  // for backward compat with older API responses.
  institution_name?: string | null;
  status: PlaidItemStatus;
  last_synced_at: string | null;
  last_error: string | null;
  granted_products: string | null;
  created_at: string;
  updated_at: string;
};

export type PlaidSyncResult = {
  added: number;
  modified: number;
  removed: number;
  cursor_advanced: number;
};

export type PlaidSchedule = {
  enabled: boolean;
  interval_hours: number;
  next_run_time: string | null;
  running: boolean;
};

// ---- API surface -----------------------------------------------------

export const api = {
  // Foundation (transactions screen)
  listTransactions: (limit = 50): Promise<Transaction[]> =>
    fetch(`${BASE_URL}/api/transactions?limit=${limit}`).then(json<Transaction[]>),
  listCategories: (): Promise<Category[]> =>
    fetch(`${BASE_URL}/api/categories`).then(json<Category[]>),

  // Money on the Table
  moneyOnTable: (): Promise<MoneyOnTableReport> =>
    fetch(`${BASE_URL}/api/money-on-table/report`).then(json<MoneyOnTableReport>),

  // Net Worth
  netWorth: (): Promise<NetWorthSummary> =>
    fetch(`${BASE_URL}/api/networth`).then(json<NetWorthSummary>),
  netWorthHistory: (days = 365): Promise<NetWorthHistory> =>
    fetch(`${BASE_URL}/api/networth/history?days=${days}`).then(json<NetWorthHistory>),

  // Cash Flow
  cashFlowForecast: (days = 30): Promise<CashFlowForecast> =>
    fetch(`${BASE_URL}/api/cashflow/forecast?days=${days}`).then(json<CashFlowForecast>),

  // Wave G — Budget projection + recommendations (mobile parity for the
  // web Wave G build). Same endpoints; we don't carry the chart-side
  // shape since mobile doesn't render the full line chart yet.
  budgetProject: (body: {
    months?: number;
    category_overrides?: Record<number, number>;
    monthly_investment_contribution_cents?: number;
    include_baseline?: boolean;
  } = {}): Promise<BudgetProjection> =>
    fetch(`${BASE_URL}/api/budgets/project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<BudgetProjection>),
  budgetRecommendations: (): Promise<BudgetRecommendationsResponse> =>
    fetch(`${BASE_URL}/api/budgets/recommendations`).then(json<BudgetRecommendationsResponse>),
  // Sprint 48 — annual renewals 1–12 months out for the "Coming up"
  // section. Defaults to the same 365-day window as the web panel.
  upcomingAnnuals: (days = 365): Promise<UpcomingAnnualsResponse> =>
    fetch(`${BASE_URL}/api/cashflow/upcoming-annuals?days=${days}`).then(
      json<UpcomingAnnualsResponse>,
    ),

  // Budgets
  budgetRollup: (month_start: string): Promise<BudgetRollup> =>
    fetch(`${BASE_URL}/api/budgets/rollup?month_start=${month_start}`).then(json<BudgetRollup>),

  // Subscriptions
  listSubscriptions: (params: { status?: SubscriptionStatus; subscription_type?: SubscriptionType; confirmed_only?: boolean } = {}): Promise<Subscription[]> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`${BASE_URL}/api/subscriptions${suffix}`).then(json<Subscription[]>);
  },
  subscriptionStats: (): Promise<SubscriptionStats> =>
    fetch(`${BASE_URL}/api/subscriptions/stats`).then(json<SubscriptionStats>),
  confirmSubscription: (id: number): Promise<Subscription> =>
    fetch(`${BASE_URL}/api/subscriptions/${id}/confirm`, { method: "POST" }).then(json<Subscription>),
  dismissSubscription: (id: number): Promise<Subscription> =>
    fetch(`${BASE_URL}/api/subscriptions/${id}/dismiss`, { method: "POST" }).then(json<Subscription>),
  /** Sprint 48 — mobile cancel action so the user can claw back recurring
   *  spend from the phone instead of having to switch to web. Same
   *  endpoint the web SubscriptionsPanel uses for the cancelled-status
   *  transition. */
  setSubscriptionStatus: (id: number, status: SubscriptionStatus): Promise<Subscription> =>
    fetch(`${BASE_URL}/api/subscriptions/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).then(json<Subscription>),
  /** Sprint 48 — set the monthly price on an LLM-discovered sub that
   *  came in at $0 (Gmail snippet didn't expose a dollar amount).
   *  Backend stores `monthly_cents` as a negative outflow, but the
   *  endpoint accepts unsigned cents. */
  setSubscriptionPrice: (
    id: number,
    monthly_cents: number,
    cadence_label?: string,
  ): Promise<Subscription> =>
    fetch(`${BASE_URL}/api/subscriptions/${id}/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_cents, cadence_label: cadence_label ?? null }),
    }).then(json<Subscription>),
  /** Sprint 27 — bundle-overlap detector (Wave E) ported to mobile so
   *  the "you're paying twice" banner shows on the phone too. */
  bundleOverlaps: (): Promise<BundleOverlapsResponse> =>
    fetch(`${BASE_URL}/api/bundles/overlaps`).then(json<BundleOverlapsResponse>),
  /** Sprint 27 — MoM growth detector (Sprint 11) + top-movers preview
   *  (Sprint 24) ported to mobile. */
  subscriptionTrends: (): Promise<SubscriptionTrendsResponse> =>
    fetch(`${BASE_URL}/api/subscriptions/trends`).then(json<SubscriptionTrendsResponse>),

  // Goals + savings
  listGoals: (): Promise<Goal[]> =>
    fetch(`${BASE_URL}/api/goals`).then(json<Goal[]>),
  surplus: (): Promise<SurplusSnapshot> =>
    fetch(`${BASE_URL}/api/savings/surplus?mode=both`).then(json<SurplusSnapshot>),
  suggestions: (): Promise<SuggestionBundle> =>
    fetch(`${BASE_URL}/api/savings/suggestions?mode=historical`).then(json<SuggestionBundle>),
  contributeToGoal: (id: number, amount_cents: number, contributed_at: string): Promise<unknown> =>
    fetch(`${BASE_URL}/api/goals/${id}/contribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents, contributed_at, source: "manual" }),
    }).then(json<unknown>),

  // Deals + recurring patterns (for the manual-entry dropdown)
  listDeals: (): Promise<DealOpportunity[]> =>
    fetch(`${BASE_URL}/api/deals`).then(json<DealOpportunity[]>),
  listRecurringPurchases: (): Promise<RecurringPurchaseLite[]> =>
    fetch(`${BASE_URL}/api/shopping-patterns?status=active`).then(json<RecurringPurchaseLite[]>),
  listPriceObservations: (limit = 50): Promise<PriceObservation[]> =>
    fetch(`${BASE_URL}/api/deals/observations?limit=${limit}`).then(json<PriceObservation[]>),
  createPriceObservation: (payload: {
    recurring_purchase_id: number;
    merchant: string;
    price_cents: number;
    observed_at?: string;
    in_stock?: boolean;
    notes?: string;
  }): Promise<PriceObservation> =>
    fetch(`${BASE_URL}/api/deals/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<PriceObservation>),
  dealScraperStatus: (): Promise<DealScraperStatus[]> =>
    fetch(`${BASE_URL}/api/deals/scraper-status`).then(json<DealScraperStatus[]>),

  // Legal claims (Settlemate-style)
  listLegalClaims: (params: { state?: string; status?: LegalClaimStatus; proof_status?: ProofRequirement; include_expired?: boolean } = {}): Promise<LegalClaim[]> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`${BASE_URL}/api/legal-claims${suffix}`).then(json<LegalClaim[]>);
  },
  legalClaimStats: (): Promise<LegalClaimStats> =>
    fetch(`${BASE_URL}/api/legal-claims/stats`).then(json<LegalClaimStats>),
  updateLegalClaim: (id: number, payload: Partial<LegalClaim>): Promise<LegalClaim> =>
    fetch(`${BASE_URL}/api/legal-claims/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<LegalClaim>),

  // Trends — month-over-month
  monthOverMonth: (months = 6): Promise<MonthOverMonth> =>
    fetch(`${BASE_URL}/api/stats/month-over-month?months=${months}`).then(json<MonthOverMonth>),

  // Credit
  listCreditScores: (limit = 50): Promise<CreditScore[]> =>
    fetch(`${BASE_URL}/api/credit/scores?limit=${limit}`).then(json<CreditScore[]>),
  creditUtilization: (): Promise<UtilizationResponse> =>
    fetch(`${BASE_URL}/api/credit/utilization`).then(json<UtilizationResponse>),
  creditOpportunities: (): Promise<CreditOpportunitiesResponse> =>
    fetch(`${BASE_URL}/api/credit/opportunities`).then(json<CreditOpportunitiesResponse>),

  // Anomaly detection
  anomalyScan: (days = 90, threshold_sigma = 3.0): Promise<AnomalyScan> =>
    fetch(
      `${BASE_URL}/api/anomaly/scan?days=${days}&threshold_sigma=${threshold_sigma}&fire_notifications=false`,
    ).then(json<AnomalyScan>),

  // Heatmap
  heatmapDaily: (days = 90): Promise<Heatmap> =>
    fetch(`${BASE_URL}/api/heatmap/daily?days=${days}`).then(json<Heatmap>),

  // Notifications
  listNotifications: (only_unread = false, limit = 50): Promise<AppNotification[]> =>
    fetch(`${BASE_URL}/api/notifications?only_unread=${only_unread}&limit=${limit}`).then(
      json<AppNotification[]>,
    ),
  markNotificationRead: (id: number): Promise<AppNotification> =>
    fetch(`${BASE_URL}/api/notifications/${id}/read`, { method: "POST" }).then(
      json<AppNotification>,
    ),
  markAllNotificationsRead: (): Promise<{ marked_read: number }> =>
    fetch(`${BASE_URL}/api/notifications/read-all`, { method: "POST" }).then(
      json<{ marked_read: number }>,
    ),
  deleteNotification: (id: number): Promise<void> =>
    fetch(`${BASE_URL}/api/notifications/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),

  // Receipts
  listReceipts: (limit = 50): Promise<Receipt[]> =>
    fetch(`${BASE_URL}/api/receipts?limit=${limit}`).then(json<Receipt[]>),
  getReceipt: (id: number): Promise<ReceiptDetail> =>
    fetch(`${BASE_URL}/api/receipts/${id}`).then(json<ReceiptDetail>),
  parseReceiptText: (text: string): Promise<ReceiptIngestResult> =>
    fetch(`${BASE_URL}/api/receipts/parse-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json<ReceiptIngestResult>),
  /**
   * Upload a receipt image as multipart/form-data. The backend OCRs it
   * via pytesseract and parses line items + coupons.
   *
   * React Native's FormData handles file refs as
   * ``{ uri, name, type }`` objects — no Blob needed. The uri can be
   * an asset URI from expo-image-picker (file://...).
   */
  uploadReceipt: (asset: {
    uri: string;
    name?: string;
    type?: string;
  }): Promise<ReceiptIngestResult> => {
    const form = new FormData();
    // RN's FormData requires casting the file ref through `any` because
    // the type defs assume web Blob/File semantics.
    form.append("file", {
      uri: asset.uri,
      name: asset.name || "receipt.jpg",
      type: asset.type || "image/jpeg",
    } as unknown as Blob);
    return fetch(`${BASE_URL}/api/receipts/upload`, {
      method: "POST",
      body: form,
      // Don't set Content-Type — RN computes the multipart boundary itself.
    }).then(json<ReceiptIngestResult>);
  },
  deleteReceipt: (id: number): Promise<void> =>
    fetch(`${BASE_URL}/api/receipts/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),

  // Unclaimed property
  listUnclaimed: (params: { status?: UnclaimedStatus; state?: string; limit?: number } = {}): Promise<UnclaimedRecord[]> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`${BASE_URL}/api/unclaimed${suffix}`).then(json<UnclaimedRecord[]>);
  },
  unclaimedStats: (): Promise<UnclaimedStats> =>
    fetch(`${BASE_URL}/api/unclaimed/stats`).then(json<UnclaimedStats>),
  unclaimedSearchTips: (): Promise<UnclaimedSearchTips> =>
    fetch(`${BASE_URL}/api/unclaimed/search-tips`).then(json<UnclaimedSearchTips>),
  updateUnclaimedStatus: (
    id: number,
    status: UnclaimedStatus,
    actual_payout_cents?: number,
    notes?: string,
  ): Promise<UnclaimedRecord> =>
    fetch(`${BASE_URL}/api/unclaimed/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, actual_payout_cents, notes }),
    }).then(json<UnclaimedRecord>),

  // Card benefits
  cardBenefits: (): Promise<CardBenefitReport> =>
    fetch(`${BASE_URL}/api/benefits/credits`).then(json<CardBenefitReport>),

  // Yield arbitrage
  yieldArbReport: (): Promise<YieldArbReport> =>
    fetch(`${BASE_URL}/api/yield-opt/report`).then(json<YieldArbReport>),

  // Regulatory redress
  redressKnown: (): Promise<KnownRedress[]> =>
    fetch(`${BASE_URL}/api/redress/known`).then(json<KnownRedress[]>),
  redressMatchSpend: (days = 730): Promise<RedressMatchReport> =>
    fetch(`${BASE_URL}/api/redress/match-spend?days=${days}`).then(json<RedressMatchReport>),
  listRedress: (): Promise<RedressRecord[]> =>
    fetch(`${BASE_URL}/api/redress`).then(json<RedressRecord[]>),
  updateRedressStatus: (
    id: number,
    status: RedressStatus,
    actual_payout_cents?: number,
    notes?: string,
  ): Promise<RedressRecord> =>
    fetch(`${BASE_URL}/api/redress/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, actual_payout_cents, notes }),
    }).then(json<RedressRecord>),

  // Holdings (investment tracking)
  listSecurities: (): Promise<Security[]> =>
    fetch(`${BASE_URL}/api/securities`).then(json<Security[]>),
  listHoldings: (): Promise<HoldingDetail[]> =>
    fetch(`${BASE_URL}/api/holdings`).then(json<HoldingDetail[]>),
  portfolio: (): Promise<Portfolio> =>
    fetch(`${BASE_URL}/api/holdings/portfolio`).then(json<Portfolio>),
  updateSecurityPrice: (id: number, latest_price_cents: number): Promise<Security> =>
    fetch(`${BASE_URL}/api/securities/${id}/price`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latest_price_cents }),
    }).then(json<Security>),

  // HSA receipt bank
  listHsaReceipts: (status?: HsaReceiptStatus): Promise<HsaReceipt[]> => {
    const qs = status ? `?status=${status}` : "";
    return fetch(`${BASE_URL}/api/hsa/receipts${qs}`).then(json<HsaReceipt[]>);
  },
  createHsaReceipt: (payload: HsaReceiptIn): Promise<HsaReceipt> =>
    fetch(`${BASE_URL}/api/hsa/receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<HsaReceipt>),
  reimburseHsaReceipt: (id: number, notes?: string): Promise<HsaReceipt> =>
    // Backend route is PATCH (not POST) — see backend/finance_app/api/hsa.py L101.
    fetch(`${BASE_URL}/api/hsa/receipts/${id}/reimburse`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notes ?? null }),
    }).then(json<HsaReceipt>),
  deleteHsaReceipt: (id: number): Promise<void> =>
    fetch(`${BASE_URL}/api/hsa/receipts/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),
  hsaSummary: (): Promise<HsaSummary> =>
    fetch(`${BASE_URL}/api/hsa/receipts/summary`).then(json<HsaSummary>),

  // Offers (Chase / Amex)
  scrapeOffers: (): Promise<OfferScrapeResponse> =>
    fetch(`${BASE_URL}/api/offers/scrape`, { method: "POST" }).then(json<OfferScrapeResponse>),

  // Card applications (5/24, sign-up bonuses)
  listCardApplications: (params: { status?: CardApplicationStatus; issuer?: string } = {}): Promise<CardApplication[]> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`${BASE_URL}/api/card-applications${suffix}`).then(json<CardApplication[]>);
  },
  cardApplicationsEligibility: (): Promise<EligibilityReport> =>
    fetch(`${BASE_URL}/api/card-applications/eligibility`).then(json<EligibilityReport>),
  updateCardApplicationStatus: (
    id: number,
    status: CardApplicationStatus,
    notes?: string,
  ): Promise<CardApplication> =>
    fetch(`${BASE_URL}/api/card-applications/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, notes }),
    }).then(json<CardApplication>),
  logCardApplicationSpend: (id: number, additional_spend_cents: number): Promise<CardApplication> =>
    // Backend route is PATCH (not POST) — see backend/finance_app/api/card_applications.py L194.
    fetch(`${BASE_URL}/api/card-applications/${id}/spend`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_spend_cents }),
    }).then(json<CardApplication>),

  // Merchants (deep-dive + rollup)
  merchantDetail: (key: string, months = 24, txn_limit = 50): Promise<MerchantDetail> =>
    fetch(
      `${BASE_URL}/api/merchants/${encodeURIComponent(key)}?months=${months}&txn_limit=${txn_limit}`,
    ).then(json<MerchantDetail>),
  // The merchant rollup actually lives under /shopping-patterns/merchant-rollup
  // (not /merchants/rollup — that would collide with the dynamic
  // /merchants/{merchant_key} handler). Mirrors the web client.
  merchantRollup: (days = 365, min_transactions = 3): Promise<MerchantRollupRow[]> =>
    fetch(
      `${BASE_URL}/api/shopping-patterns/merchant-rollup?days=${days}&min_transactions=${min_transactions}`,
    ).then(json<MerchantRollupRow[]>),

  // Tax
  taxReport: (year: number): Promise<TaxReport> =>
    fetch(`${BASE_URL}/api/tax/report?year=${year}`).then(json<TaxReport>),
  taxExportCsvUrl: (year: number): string => `${BASE_URL}/api/tax/export.csv?year=${year}`,

  // Shopping patterns (fuller form than the lite list above)
  listRecurringPurchasesFull: (params: { status?: RecurringPurchaseStatus; category?: string; merchant?: string } = {}): Promise<RecurringPurchase[]> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`${BASE_URL}/api/shopping-patterns${suffix}`).then(json<RecurringPurchase[]>);
  },
  patchRecurringPurchase: (id: number, payload: Partial<RecurringPurchase>): Promise<RecurringPurchase> =>
    fetch(`${BASE_URL}/api/shopping-patterns/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<RecurringPurchase>),

  // Canonical products
  listCanonicalProducts: (params: { q?: string; brand?: string; category?: string } = {}): Promise<CanonicalProduct[]> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`${BASE_URL}/api/canonical-products${suffix}`).then(json<CanonicalProduct[]>);
  },
  getCanonicalProduct: (id: number): Promise<CanonicalProductDetail> =>
    fetch(`${BASE_URL}/api/canonical-products/${id}`).then(json<CanonicalProductDetail>),

  // Plaid (Connections screen)
  plaidStatus: (): Promise<PlaidStatus> =>
    fetch(`${BASE_URL}/api/plaid/status`).then(json<PlaidStatus>),
  plaidListItems: (): Promise<PlaidItem[]> =>
    fetch(`${BASE_URL}/api/plaid/items`).then(json<PlaidItem[]>),
  // Backend route is /plaid/sync/{item_id} (not /plaid/items/{id}/sync) —
  // see backend/finance_app/api/plaid.py L188.
  plaidSyncItem: (item_id: number): Promise<PlaidSyncResult> =>
    fetch(`${BASE_URL}/api/plaid/sync/${item_id}`, { method: "POST" }).then(json<PlaidSyncResult>),
  // SyncAllResult shape comes from plaid.py L85: synced_at + item_count +
  // a per-item map of sync results (each with added/modified/removed/cursor).
  plaidSyncAll: (): Promise<{ synced_at: string; item_count: number; items: Record<string, PlaidSyncResult> }> =>
    fetch(`${BASE_URL}/api/plaid/sync-all`, { method: "POST" }).then(
      json<{ synced_at: string; item_count: number; items: Record<string, PlaidSyncResult> }>,
    ),
  plaidSchedule: (): Promise<PlaidSchedule> =>
    fetch(`${BASE_URL}/api/plaid/schedule`).then(json<PlaidSchedule>),

  // -- FIRE projection (Smart feature #2) -----------------------------
  fireDefaults: (): Promise<FireDefaults> =>
    fetch(`${BASE_URL}/api/fire/defaults`).then(json<FireDefaults>),
  fireProjection: (params: FireProjectionParams): Promise<FireProjection> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return fetch(`${BASE_URL}/api/fire/projection?${qs.toString()}`).then(
      json<FireProjection>,
    );
  },

  // -- Net worth attribution (Smart feature #4) -----------------------
  netWorthAttribution: (months = 12): Promise<AttributionReport> =>
    fetch(`${BASE_URL}/api/networth/attribution?months=${months}`).then(
      json<AttributionReport>,
    ),
};

// FIRE types — kept narrow; full set lives in the web client.
export type FireSimulationMode = "normal" | "historical";

export type FireDefaults = {
  starting_cents: number;
  monthly_savings_cents: number;
  annual_spending_cents: number;
};

export type FireProjectionParams = {
  current_age: number;
  target_retirement_age: number;
  starting_cents: number;
  monthly_savings_cents: number;
  annual_spending_cents: number;
  end_age?: number;
  mean_return_pct?: number;
  std_dev_pct?: number;
  n_trials?: number;
  simulation_mode?: FireSimulationMode;
};

export type FireYear = {
  age: number;
  p10_cents: number;
  p25_cents: number;
  p50_cents: number;
  p75_cents: number;
  p90_cents: number;
};

export type FireProjection = {
  fire_number_cents: number;
  years: FireYear[];
  median_hit_age: number | null;
  success_probability_pct: number;
  prob_hit_target_by_retirement_pct: number;
  safe_withdrawal_rate_pct: number | null;
  realized_mean_return_pct: number | null;
  summary_text: string;
};

// Attribution types
export type AttributionCategory = {
  name: string;
  cents: number;
  txn_count: number;
};

export type AttributionMonth = {
  month_start: string;
  month_label: string;
  nw_start_cents: number | null;
  nw_end_cents: number | null;
  delta_cents: number | null;
  income_cents: number;
  spending_cents: number;
  net_cash_flow_cents: number;
  debt_paydown_cents: number;
  other_cents: number | null;
  top_spending_categories: AttributionCategory[];
};

export type AttributionReport = {
  months: AttributionMonth[];
  summary_text: string;
};

export { BASE_URL };
