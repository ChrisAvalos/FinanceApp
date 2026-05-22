"""Canonical data model.

Conventions:
- All monetary amounts stored as integer cents (``amount_cents``). Positive = inflow,
  negative = outflow. Stick to this everywhere — mixing float dollars and sign
  conventions is how finance apps grow bugs.
- Every categorization carries its ``source`` so we can audit why a transaction
  landed in a category (rule match, user override, default).
- ``external_id`` + ``source`` on Transaction lets us dedupe across ingest runs:
  re-importing the same CSV must not double-count.
"""
from __future__ import annotations

import enum
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy import event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


# ---------- Enums ----------

class AccountType(str, enum.Enum):
    checking = "checking"
    savings = "savings"
    credit_card = "credit_card"
    loan = "loan"
    mortgage = "mortgage"
    investment = "investment"
    cash = "cash"
    # Asset types added in Phase 7.1 for the net-worth tracker. These
    # don't have transaction streams (you don't get a feed of "your
    # house increased $200 yesterday"), so the user updates them
    # manually via POST /api/accounts/{id}/balance — typically once
    # a month or quarter.
    real_estate = "real_estate"
    vehicle = "vehicle"
    crypto = "crypto"
    hsa = "hsa"
    other = "other"


class InstitutionKind(str, enum.Enum):
    bank = "bank"
    credit_card_issuer = "credit_card_issuer"
    service_provider = "service_provider"  # Xfinity, T-Mobile, Netflix
    utility = "utility"
    investment = "investment"
    other = "other"


class TransactionStatus(str, enum.Enum):
    posted = "posted"
    pending = "pending"


class CategorySource(str, enum.Enum):
    rule = "rule"
    manual = "manual"
    llm = "llm"
    default = "default"
    unset = "unset"


class SubscriptionStatus(str, enum.Enum):
    active = "active"
    paused = "paused"
    cancelled = "cancelled"
    suspected = "suspected"  # detected but not confirmed
    dismissed = "dismissed"  # user said "this isn't a subscription" — don't resurface


class SubscriptionType(str, enum.Enum):
    """Coarse-grained classification of recurring outflows.

    Phase B added this so Chris can filter / aggregate cost by category and so
    the surplus engine can distinguish 'streaming I might cut' from 'utility I
    must pay.' Mapping is heuristic (merchant name + transaction category) —
    when nothing matches, we land on ``unknown`` so the UI can prompt for
    triage rather than guessing wrong.
    """
    streaming = "streaming"          # Netflix, Spotify, Disney+, Hulu, Max
    saas = "saas"                    # Adobe, ChatGPT Plus, GitHub, AWS, 1Password
    news_media = "news_media"        # NYT, WSJ, Substack, Patreon
    utilities = "utilities"          # PG&E, water, gas, trash
    internet = "internet"            # Xfinity, Comcast, AT&T Fiber
    telecom = "telecom"              # T-Mobile, Verizon, mint mobile
    insurance = "insurance"          # auto, home, renter, life, health premiums
    fitness = "fitness"              # gyms, Peloton, ClassPass
    storage = "storage"              # iCloud, Dropbox, Public Storage, Extra Space
    gaming = "gaming"                # Xbox Live, PS+, Nintendo Online
    other = "other"                  # confirmed-recurring but not in any bucket above
    unknown = "unknown"              # detector hasn't classified yet — UI surfaces for triage


class PlaidItemStatus(str, enum.Enum):
    """Health of a Plaid Item (connection). 'login_required' means the user
    needs to re-authenticate (bank session expired); 'error' is everything else.
    """
    good = "good"
    login_required = "login_required"
    error = "error"


class OfferStatus(str, enum.Enum):
    available = "available"
    activated = "activated"
    redeemed = "redeemed"
    expired = "expired"
    dismissed = "dismissed"


class CreditBureau(str, enum.Enum):
    equifax = "equifax"
    experian = "experian"
    transunion = "transunion"


class CreditScoringModel(str, enum.Enum):
    fico8 = "fico8"
    fico9 = "fico9"
    vantagescore3 = "vantagescore3"
    vantagescore4 = "vantagescore4"
    other = "other"


class ScoreSource(str, enum.Enum):
    """How a credit score observation entered the system.

    ``manual`` — Chris typed it in (Phase C.1 — the fallback we always keep).
    ``scraped`` — generic scraped marker. Kept as a backward-compatibility
        catchall; new Phase 4.3 scrapers use their per-portal value below
        so the natural-key (bureau, model, as_of, source) doesn't collide
        when two portals both pull the same bureau on the same day (Credit
        Karma + CreditWise both report TransUnion / VantageScore3).
    ``scraped_credit_karma`` / ``scraped_creditwise`` / ``scraped_credit_journey`` —
        Phase 4.3 per-portal markers. Each scraper writes its own
        source value so the existing unique index on (bureau, scoring_model,
        as_of, source) keeps each portal's daily observation distinct.
    ``imported`` — bulk historical import from a CSV or API response.
    """
    manual = "manual"
    scraped = "scraped"
    scraped_credit_karma = "scraped_credit_karma"
    scraped_creditwise = "scraped_creditwise"
    scraped_credit_journey = "scraped_credit_journey"
    imported = "imported"


class BudgetStatus(str, enum.Enum):
    """Derived runtime status — NOT persisted. Computed by the rollup endpoint.

    ``on_track`` — outflow so far is within the pace for the month.
    ``warning``  — outflow is ahead of pace (>80% used with time remaining).
    ``over``     — outflow exceeds the cap.
    """
    on_track = "on_track"
    warning = "warning"
    over = "over"


class LegalClaimStatus(str, enum.Enum):
    """Lifecycle of a class-action claim, tracked manually.

    ``available`` — eligible to file, no action taken yet.
    ``claimed``   — Chris filed the claim form, waiting for payout.
    ``paid``      — settlement check / electronic payment received.
    ``dismissed`` — Chris reviewed it and decided not to file (don't resurface).

    'Expired' is *not* a stored status — it's derived at read time from
    ``claim_deadline < today`` so a single source of truth (the date) drives
    the badge in the UI without needing a nightly cron job to flip rows.
    """
    available = "available"
    claimed = "claimed"
    paid = "paid"
    dismissed = "dismissed"


class GoalKind(str, enum.Enum):
    """Phase D — what kind of savings/debt goal this row represents.

    The kind drives suggestion logic: emergency_fund/general_savings/specific_savings
    are *funding* goals (allocate surplus toward them), while debt_payoff is a
    *reduction* goal (allocate surplus toward principal beyond the minimum).

    ``emergency_fund`` is split out from ``general_savings`` so the suggestion
    engine can prioritise it ahead of all other savings goals — Chris's hard
    rule is "fully fund 3-mo emergency reserve before adding to vacation
    fund." Without a separate kind we'd have to encode that in priority ints
    AND remember the convention; the explicit kind makes intent obvious.
    """
    emergency_fund = "emergency_fund"
    general_savings = "general_savings"
    specific_savings = "specific_savings"
    debt_payoff = "debt_payoff"


class GoalStatus(str, enum.Enum):
    """Lifecycle states for a Goal.

    ``active``   — currently funding / being worked toward.
    ``achieved`` — current_amount_cents reached target_amount_cents (or debt
                   balance hit zero). UI archives but keeps for history.
    ``paused``   — user manually halted contributions; still listed but
                   suggestion engine ignores it.
    ``archived`` — user dismissed; do not resurface in suggestions or list.
    """
    active = "active"
    achieved = "achieved"
    paused = "paused"
    archived = "archived"


class GoalContributionSource(str, enum.Enum):
    """How a contribution row got into the system.

    ``manual``           — user typed it in ("I moved $200 to savings on 4/15").
    ``transfer_record``  — derived from a transaction we matched to the goal
                           (e.g. detected internal-transfer to linked savings).
    ``debt_payment``     — payment to a debt goal's linked credit/loan account.
    """
    manual = "manual"
    transfer_record = "transfer_record"
    debt_payment = "debt_payment"


class ProofRequirement(str, enum.Enum):
    """Whether a settlement requires receipts/documentation to file.

    ``not_required`` — name + address is enough. The "coffee break" tier.
    ``required``     — receipts, account statements, or notarisation needed.
    ``unknown``      — scraper couldn't determine; UI surfaces these in a
                       separate bucket so Chris can read the page and decide.

    Phase F.1 used a plain ``proof_required: bool`` field, which collapsed
    "unknown" into False. The 3-state shape was added in Phase F.2 once we
    started extracting from heterogeneous aggregator pages where the proof
    text is sometimes missing — defaulting ambiguous cases to "Quick" was
    polluting the bucket Chris uses for fast wins.
    """
    not_required = "not_required"
    required = "required"
    unknown = "unknown"


class ParserOutcome(str, enum.Enum):
    """What happened when a Gmail parser ran against a message.

    ``parsed``   — parser matched and produced structured output (a transaction,
                   a bill, an offer, etc.).
    ``ignored``  — no parser claimed this message (expected for the firehose of
                   irrelevant mail that also comes from matched senders).
    ``failed``   — a parser claimed the message but blew up extracting data;
                   the error is stored on the EmailMessage row for debugging.
    ``duplicate``— parser ran fine but the resulting transaction already existed
                   (common: the same charge comes through Plaid *and* a bank
                   alert email).
    """
    parsed = "parsed"
    ignored = "ignored"
    failed = "failed"
    duplicate = "duplicate"


class IngestSource(str, enum.Enum):
    csv = "csv"
    ofx = "ofx"
    plaid = "plaid"
    gmail = "gmail"
    playwright = "playwright"
    manual = "manual"
    qa_intake = "qa_intake"


# ---------- Core entities ----------

class Institution(Base):
    __tablename__ = "institutions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    kind: Mapped[InstitutionKind] = mapped_column(
        Enum(InstitutionKind), default=InstitutionKind.bank
    )
    website: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    accounts: Mapped[list["Account"]] = relationship(back_populates="institution")


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    institution_id: Mapped[int] = mapped_column(ForeignKey("institutions.id"))
    name: Mapped[str] = mapped_column(String(120))
    account_type: Mapped[AccountType] = mapped_column(Enum(AccountType))
    # Last 4 digits only — never store full account numbers
    mask: Mapped[str | None] = mapped_column(String(4))
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # For credit cards, limit_cents is helpful for utilization calcs
    credit_limit_cents: Mapped[int | None] = mapped_column(Integer)
    # APR stored as basis points (2450 = 24.50%) for integer math
    apr_bps: Mapped[int | None] = mapped_column(Integer)

    # Credit-ops fields — populated for credit_card accounts; null otherwise.
    # statement_close_day / statement_due_day are day-of-month ints (1..28).
    # Use 28 as the ceiling to avoid Feb edge cases; real-world cards that
    # close on the 30/31 land on the last day of the month in practice — if
    # that becomes a problem we'll handle it in the rollover logic, not here.
    # last_statement_balance_cents is what the issuer REPORTED to the bureaus
    # at last close — this is the number that drives your utilization %, not
    # your live running balance.
    # current_balance_cents is the live balance; we use it for "if you pay $X
    # before statement close, your reported utilization will be Y%" analysis.
    statement_close_day: Mapped[int | None] = mapped_column(Integer)
    statement_due_day: Mapped[int | None] = mapped_column(Integer)
    last_statement_balance_cents: Mapped[int | None] = mapped_column(Integer)
    last_statement_date: Mapped[date | None] = mapped_column(Date)
    current_balance_cents: Mapped[int | None] = mapped_column(Integer)

    # Manual card-benefits override. Plaid often returns generic
    # "CREDIT CARD" as the account name and the catalog matcher can't
    # bind that to a profile. The user picks a profile name from the
    # Connections panel; benefits/service.py reads this first.
    card_profile_override: Mapped[str | None] = mapped_column(String(120))

    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Plaid linkage — null for CSV/manual accounts, populated when the account
    # was discovered via Plaid Link. plaid_account_id is Plaid's stable ID
    # (different from our PK) and is what /transactions/sync references.
    plaid_item_id: Mapped[int | None] = mapped_column(ForeignKey("plaid_items.id"))
    plaid_account_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)

    institution: Mapped[Institution] = relationship(back_populates="accounts")
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="account")
    balances: Mapped[list["BalanceSnapshot"]] = relationship(back_populates="account")
    plaid_item: Mapped["PlaidItem | None"] = relationship(back_populates="accounts")

    __table_args__ = (
        UniqueConstraint("institution_id", "name", "mask", name="uq_account_inst_name_mask"),
    )


class PlaidItem(Base):
    """A single Plaid 'Item' — one linked-bank session for the user.

    Plaid's model: one Item = one set of credentials at one institution. An
    Item can expose multiple accounts (e.g. linking Chase once exposes your
    checking, savings, and credit card together).

    Security note: ``access_token`` is stored here in plain text for the
    local-first v0.2. Acceptable because the SQLite file already lives with
    the user's other personal data on their own machine and is never sent
    anywhere. Phase 5 (mobile/sync) will layer on at-rest encryption —
    SQLCipher or a per-token symmetric key in the OS keychain — before any
    token ever leaves the machine.
    """
    __tablename__ = "plaid_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    institution_id: Mapped[int] = mapped_column(ForeignKey("institutions.id"))

    # Plaid's identifiers — item_id is unique per user-bank connection; the
    # institution_id is Plaid's institution catalog ID (ins_3 for Chase, etc.)
    plaid_item_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    plaid_institution_id: Mapped[str | None] = mapped_column(String(64))

    # Long-lived token used to call Plaid endpoints. See class docstring re: encryption.
    access_token: Mapped[str] = mapped_column(String(255))

    # /transactions/sync cursor — opaque string Plaid returns. Empty on first call.
    transactions_cursor: Mapped[str | None] = mapped_column(String(500))

    # Health + refresh tracking
    status: Mapped[PlaidItemStatus] = mapped_column(
        Enum(PlaidItemStatus), default=PlaidItemStatus.good
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(Text)

    # Products the user granted us (transactions, accounts, liabilities, etc.)
    # Stored as comma-separated string to stay SQLite-friendly.
    granted_products: Mapped[str | None] = mapped_column(String(200))

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    institution: Mapped[Institution] = relationship()
    accounts: Mapped[list["Account"]] = relationship(back_populates="plaid_item")


class Category(Base):
    """Hierarchical category tree. parent_id=None for top-level."""
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    # is_discretionary helps the suggestion engine target non-essential spend
    is_discretionary: Mapped[bool] = mapped_column(Boolean, default=True)
    icon: Mapped[str | None] = mapped_column(String(40))

    parent: Mapped["Category | None"] = relationship(remote_side="Category.id", back_populates="children")
    children: Mapped[list["Category"]] = relationship(back_populates="parent")


class Merchant(Base):
    """Normalized merchant. raw descriptions map to this via MerchantAlias."""
    __tablename__ = "merchants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    default_category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    website: Mapped[str | None] = mapped_column(String(255))
    logo_url: Mapped[str | None] = mapped_column(String(500))
    # For offer matching — what broad merchant category
    mcc: Mapped[str | None] = mapped_column(String(8))  # merchant category code
    notes: Mapped[str | None] = mapped_column(Text)

    aliases: Mapped[list["MerchantAlias"]] = relationship(back_populates="merchant", cascade="all, delete-orphan")
    default_category: Mapped["Category | None"] = relationship()


class MerchantAlias(Base):
    """Raw-description fragments that map to a canonical merchant."""
    __tablename__ = "merchant_aliases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    merchant_id: Mapped[int] = mapped_column(ForeignKey("merchants.id"))
    pattern: Mapped[str] = mapped_column(String(200), index=True)  # substring or regex
    is_regex: Mapped[bool] = mapped_column(Boolean, default=False)

    merchant: Mapped[Merchant] = relationship(back_populates="aliases")


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)

    # Core fields
    posted_date: Mapped[date] = mapped_column(Date, index=True)
    # amount_cents: positive=inflow/credit, negative=outflow/debit. Keep sign consistent.
    amount_cents: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    status: Mapped[TransactionStatus] = mapped_column(Enum(TransactionStatus), default=TransactionStatus.posted)

    # Descriptions
    description_raw: Mapped[str] = mapped_column(String(500))
    description_clean: Mapped[str | None] = mapped_column(String(500))
    memo: Mapped[str | None] = mapped_column(Text)

    # Classification (optional, filled in by engine)
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id"), index=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"), index=True)
    category_source: Mapped[CategorySource] = mapped_column(Enum(CategorySource), default=CategorySource.unset)
    category_rule_id: Mapped[int | None] = mapped_column(ForeignKey("rules.id"))

    # One-time-spend flag. When True, this transaction is a non-recurring
    # spike (medical emergency, car repair, a big one-off purchase). The
    # multi-month projection (compute_trailing_real_outflow + projector)
    # excludes it so a single outlier is not smeared into the "monthly"
    # outflow rate. It does NOT affect the this-month EOM card — the charge
    # really did happen this month.
    is_one_time: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0", nullable=False
    )

    # Optional structured metadata (location, card network, plaid metadata)
    extra: Mapped[dict | None] = mapped_column(JSON)

    # Dedup: source + external_id form a stable identity key for ingested rows.
    # For CSV: external_id is hash(date+amount+description+account) — see deduplication.py
    source: Mapped[IngestSource] = mapped_column(Enum(IngestSource))
    external_id: Mapped[str] = mapped_column(String(64), index=True)
    ingest_batch_id: Mapped[int | None] = mapped_column(ForeignKey("ingest_batches.id"))

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    account: Mapped[Account] = relationship(back_populates="transactions")
    merchant: Mapped["Merchant | None"] = relationship()
    category: Mapped["Category | None"] = relationship()

    __table_args__ = (
        UniqueConstraint("source", "external_id", "account_id", name="uq_txn_source_external"),
        Index("ix_txn_account_date", "account_id", "posted_date"),
    )

    @property
    def amount(self) -> Decimal:
        """Dollar amount as Decimal. Prefer this for display; keep integer math for logic."""
        return Decimal(self.amount_cents) / Decimal(100)


class BalanceSnapshot(Base):
    __tablename__ = "balance_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    as_of: Mapped[date] = mapped_column(Date, index=True)
    balance_cents: Mapped[int] = mapped_column(Integer)
    # For credit cards, available credit at that point
    available_cents: Mapped[int | None] = mapped_column(Integer)
    source: Mapped[IngestSource] = mapped_column(Enum(IngestSource))

    account: Mapped[Account] = relationship(back_populates="balances")

    __table_args__ = (
        UniqueConstraint("account_id", "as_of", "source", name="uq_balance_acct_date_source"),
    )


# ---------- Categorization rules ----------

class Rule(Base):
    """User- or seed-defined rule for auto-categorizing transactions."""
    __tablename__ = "rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    # Pattern tested against description_raw (and description_clean if present).
    pattern: Mapped[str] = mapped_column(String(200))
    is_regex: Mapped[bool] = mapped_column(Boolean, default=False)
    # Optional amount constraint: "only match if abs(amount) in range"
    min_amount_cents: Mapped[int | None] = mapped_column(Integer)
    max_amount_cents: Mapped[int | None] = mapped_column(Integer)
    # What the rule assigns
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id"))
    # Priority: higher wins when multiple rules match
    priority: Mapped[int] = mapped_column(Integer, default=100)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_seed: Mapped[bool] = mapped_column(Boolean, default=False)  # loaded from seed_rules.yaml
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # Hit counter: incremented every time the categorization engine
    # picks this rule as the winning match. Lets the rules-management UI
    # surface dead weight (rules that never fire) and confirm which rules
    # carry the load. Maintained best-effort — don't fail categorization
    # if the increment fails. Added 2026-04-27 with the rules-expansion
    # batch (60 → 330+ patterns) so we can watch which of those new rules
    # actually pull weight on real Plaid data vs. dead-weight noise.
    hit_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_hit_at: Mapped[datetime | None] = mapped_column(DateTime)

    category: Mapped["Category | None"] = relationship()
    merchant: Mapped["Merchant | None"] = relationship()


# ---------- Phase 3: subscriptions & bills ----------

class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id"))
    name: Mapped[str] = mapped_column(String(160))
    amount_cents: Mapped[int] = mapped_column(Integer)  # typical amount (negative = outflow)
    cadence_days: Mapped[int] = mapped_column(Integer, default=30)  # ~30 monthly, 365 annual
    next_expected_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[SubscriptionStatus] = mapped_column(Enum(SubscriptionStatus), default=SubscriptionStatus.suspected)
    # Usage signal: derived from related transactions / user confirmation
    usage_score: Mapped[float | None] = mapped_column(Float)
    notes: Mapped[str | None] = mapped_column(Text)
    # ----- Phase B additions -----
    # Type classification — mostly heuristic; user can override via API.
    subscription_type: Mapped[SubscriptionType] = mapped_column(
        Enum(SubscriptionType), default=SubscriptionType.unknown
    )
    # 0..1 detector confidence (occurrences × amount_stability × cadence_agreement).
    confidence_score: Mapped[float | None] = mapped_column(Float)
    # User has explicitly accepted this row (so the surplus engine should
    # count it). Untouched suspected rows do NOT contribute to surplus math.
    is_user_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Most recent observed amount — separate from amount_cents (which is the
    # mean across the whole series). Useful for price-change comparisons.
    last_amount_cents: Mapped[int | None] = mapped_column(Integer)
    # Baseline amount before the most recent change. Both populated → price
    # changed. Both null OR equal → stable.
    prior_amount_cents: Mapped[int | None] = mapped_column(Integer)
    price_change_date: Mapped[date | None] = mapped_column(Date)
    # Stored counts/labels so the UI doesn't re-derive from the notes string.
    n_occurrences: Mapped[int | None] = mapped_column(Integer)
    cadence_label: Mapped[str | None] = mapped_column(String(20))
    # Variable-amount bills (utilities, insurance with mid-year adjustments)
    # are detected with a looser amount tolerance and shouldn't trigger
    # "price change" alerts on every wobble.
    is_variable_amount: Mapped[bool] = mapped_column(Boolean, default=False)
    # ----- Phase F: composite-charge unmasking -----
    # Some merchants are *aggregators* — Apple App Store, Google Play,
    # PayPal recurring, Patreon, Amazon Subscribe&Save — that bundle
    # multiple individual subscriptions into a single bank charge. The
    # detector tags those parents with is_composite=True; user-declared
    # or Apple-receipt-parsed line items are stored as child Subscription
    # rows linked via parent_subscription_id. Children inherit cadence
    # from the parent and feed into bundle detection / retention playbook
    # the same way standalone rows do — so "Peacock-as-Apple-line-item"
    # behaves identically to "Peacock-paid-directly" for downstream
    # consumers.
    is_composite: Mapped[bool] = mapped_column(Boolean, default=False)
    parent_subscription_id: Mapped[int | None] = mapped_column(
        ForeignKey("subscriptions.id")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    merchant: Mapped["Merchant | None"] = relationship()


# ---------- Phase 5.2: retention negotiation playbook + outcome log ----------


class RetentionOutcome(str, enum.Enum):
    """What happened on a retention call.

    ``accepted``     — issuer offered something acceptable; sub kept at lower price.
    ``declined_kept`` — issuer offered nothing useful; sub kept at the original price
                       anyway (user wasn't actually going to cancel).
    ``cancelled``    — issuer offered nothing useful; user followed through and cancelled.
    ``called_back``  — issuer asked to call back later; awaiting follow-up.
    ``no_response``  — left voicemail / chat queue / etc; no response yet.
    """
    accepted = "accepted"
    declined_kept = "declined_kept"
    cancelled = "cancelled"
    called_back = "called_back"
    no_response = "no_response"


class RetentionChannel(str, enum.Enum):
    """How the negotiation was attempted."""
    phone = "phone"
    chat = "chat"
    email = "email"
    in_app_cancel_flow = "in_app_cancel_flow"
    other = "other"


class RetentionAttempt(Base):
    """One attempt to negotiate retention on a subscription.

    The "negotiation playbook" feature surfaces a generated script to
    take into a call/chat. Whatever happens, you log the outcome here
    so the playbook gets smarter over time. Future iterations can roll
    these up to compute issuer-specific success rates and tweak the
    generated scripts accordingly.
    """
    __tablename__ = "retention_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        ForeignKey("subscriptions.id"), index=True
    )
    contacted_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    channel: Mapped[RetentionChannel] = mapped_column(
        Enum(RetentionChannel), default=RetentionChannel.phone
    )
    outcome: Mapped[RetentionOutcome] = mapped_column(
        Enum(RetentionOutcome), default=RetentionOutcome.no_response
    )
    # The first thing the rep offered (often a token discount). Helps
    # us learn which issuers open with what.
    opening_offer: Mapped[str | None] = mapped_column(Text)
    # What the user asked for / countered with.
    counter_asked: Mapped[str | None] = mapped_column(Text)
    # If accepted: monthly savings vs. the prior price, in cents.
    monthly_savings_cents: Mapped[int | None] = mapped_column(Integer)
    # If accepted: how many months the discount applies.
    duration_months: Mapped[int | None] = mapped_column(Integer)
    # Free-form. Worth capturing rep names / promise IDs for follow-up.
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    subscription: Mapped["Subscription"] = relationship()


# ---------- Phase 6: in-app notifications ----------


class Notification(Base):
    """One in-app notification.

    Generic — Phase 6 introduces "goal_milestone" notifications first
    via the milestone-checker job, but the table is shaped to absorb
    future kinds (large-charge alerts, score drops, expiring offers,
    etc.) without schema churn.

    Lifecycle: notifications start unread; the dashboard marks them
    read on click. Old read notifications get aged out after 60 days
    by a future cleanup job.

    Why a generic ``payload`` JSON column: each kind needs different
    structured fields, but enumerating them as columns explodes the
    schema. payload-as-JSON gives us flexibility; the consumer (UI)
    knows what shape to expect for each ``kind``.
    """
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSON)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime)


class SecurityType(str, enum.Enum):
    """Coarse security classification used by the Empower-style net-worth panel."""
    equity = "equity"          # individual stocks
    etf = "etf"                # ETFs (SPY, VTI, etc.)
    mutual_fund = "mutual_fund"
    bond = "bond"
    treasury = "treasury"       # T-bills / T-notes / I-bonds
    money_market = "money_market"
    crypto = "crypto"
    option = "option"
    cash = "cash"               # idle cash inside a brokerage
    other = "other"


class Security(Base):
    """A single instrument we track positions in.

    Lookup-by-ticker for stocks/ETFs; lookup-by-isin/cusip for fixed
    income; freeform for anything else. We only persist what's
    necessary to value the holding — the rest (sector, beta, dividend
    yield) lives in lookup tables we can populate later from Plaid /
    Polygon / IEX when the user wants the deeper analytics.

    ``latest_price_cents`` is a denormalized cache. Refreshed by the
    daily price-fetch job (or whenever Plaid's investments product
    syncs and reports a new price).
    """
    __tablename__ = "securities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str | None] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(240))
    security_type: Mapped[SecurityType] = mapped_column(
        Enum(SecurityType), default=SecurityType.equity
    )
    cusip: Mapped[str | None] = mapped_column(String(20))
    isin: Mapped[str | None] = mapped_column(String(20))
    plaid_security_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    latest_price_cents: Mapped[int | None] = mapped_column(Integer)
    latest_price_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Holding(Base):
    """A position the user holds in one Security inside one Account.

    Quantity is decimal-as-string in some Plaid responses; we store as
    integer of "ten-thousandths-of-a-share" to preserve precision
    without floating point. Dollar amounts are cents (signed integer)
    consistent with the rest of the schema.

    ``cost_basis_cents`` is what the user paid total. ``current_value_cents``
    is the current market value (refreshed when prices update).
    Realized vs unrealized gain math lives at the API layer.
    """
    __tablename__ = "holdings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    security_id: Mapped[int] = mapped_column(ForeignKey("securities.id"), index=True)
    # Stored as 10000ths of a share so we get 4 decimal places without floats.
    quantity_units: Mapped[int] = mapped_column(Integer, default=0)
    # Total cost basis across the position
    cost_basis_cents: Mapped[int | None] = mapped_column(Integer)
    # Current market value
    current_value_cents: Mapped[int] = mapped_column(Integer, default=0)
    # When this row was last refreshed by Plaid sync or manual edit
    as_of: Mapped[date] = mapped_column(Date, default=date.today, index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("account_id", "security_id", name="uq_holding_acct_sec"),
    )


class HsaReceiptStatus(str, enum.Enum):
    """Lifecycle of an HSA medical receipt.

    The HSA "receipt bank" play: pay medical bills out-of-pocket NOW,
    save the receipt, let the HSA invest tax-free for decades, then
    reimburse any time later — even at age 80. IRS doesn't require
    contemporaneous reimbursement; only that the expense was qualified,
    was incurred after HSA establishment, and wasn't already reimbursed
    via insurance.
    """
    saved = "saved"
    reimbursed = "reimbursed"
    voided = "voided"


class HsaReceipt(Base):
    """One out-of-pocket medical expense saved for future HSA reimbursement."""
    __tablename__ = "hsa_receipts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    expense_date: Mapped[date] = mapped_column(Date, index=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
    description: Mapped[str] = mapped_column(String(240))
    expense_category: Mapped[str | None] = mapped_column(String(80))
    provider_name: Mapped[str | None] = mapped_column(String(160))
    payment_method: Mapped[str | None] = mapped_column(String(80))
    transaction_id: Mapped[int | None] = mapped_column(ForeignKey("transactions.id"))
    receipt_path: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[HsaReceiptStatus] = mapped_column(
        Enum(HsaReceiptStatus), default=HsaReceiptStatus.saved, index=True
    )
    reimbursed_at: Mapped[datetime | None] = mapped_column(DateTime)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CardApplicationStatus(str, enum.Enum):
    """Lifecycle of a credit-card application + bonus pursuit."""
    planning = "planning"       # researching; haven't applied yet
    applied = "applied"         # application submitted
    approved = "approved"       # card approved; bonus minimum-spend window open
    bonus_earned = "bonus_earned"  # hit the spend; waiting for points to post
    bonus_posted = "bonus_posted"   # done — card earned its keep
    denied = "denied"           # application rejected
    abandoned = "abandoned"     # we decided not to pursue


class CardApplication(Base):
    """One credit-card application + welcome-bonus pursuit.

    Why a dedicated table vs. extending Account: the application
    happens BEFORE the Account exists (research / planning phase),
    and we want to track applications that never get approved
    (denied) too. Once an application is approved, the user creates
    the Account and we link them via ``account_id``.

    Bonuses we track:
      * sign-up bonus (the headline, e.g. "60,000 UR points after $4k spend in 3mo")
      * referral bonus on the referring card (10k UR for the referrer)
      * any other promotional offers on top

    Eligibility rules surfaced via this row:
      * Chase **5/24** — can't be approved for any Chase card if 5+ new
        cards (any issuer) were opened in the prior 24 months.
        ``count_for_5_24`` defaults to True for personal cards from any
        issuer; flip false for business cards (Chase doesn't count
        biz cards toward your 5/24 — but Capital One's business cards
        DO appear on personal credit reports, edge case).
      * Amex **once-per-lifetime** — most Amex cards' welcome bonuses
        are one-shot. Set ``bonus_lifetime_eligible_at`` for cards
        you've already earned bonuses on; the eligibility query
        respects it.
    """
    __tablename__ = "card_applications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    issuer: Mapped[str] = mapped_column(String(60), index=True)  # "Chase", "Amex", "Citi", "Capital One"
    card_name: Mapped[str] = mapped_column(String(160))           # "Sapphire Preferred", "Gold Card"
    # Status lifecycle.
    status: Mapped[CardApplicationStatus] = mapped_column(
        Enum(CardApplicationStatus),
        default=CardApplicationStatus.planning,
        index=True,
    )
    # Linked Account once approved + opened. Nullable through whole
    # lifecycle until activation.
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))

    # Welcome-bonus terms.
    bonus_value_cents: Mapped[int | None] = mapped_column(Integer)  # estimated $ value of points/cash
    bonus_points: Mapped[int | None] = mapped_column(Integer)        # raw points (e.g. 60_000)
    minimum_spend_cents: Mapped[int | None] = mapped_column(Integer)  # e.g. 400_000 = $4k
    minimum_spend_window_days: Mapped[int | None] = mapped_column(Integer)  # e.g. 90
    # Tracking spend toward the bonus
    spend_to_date_cents: Mapped[int] = mapped_column(Integer, default=0)
    # The countdown clock starts at approval.
    minimum_spend_deadline: Mapped[date | None] = mapped_column(Date)

    # Eligibility flags
    counts_toward_5_24: Mapped[bool] = mapped_column(Boolean, default=True)
    bonus_lifetime_eligible_at: Mapped[date | None] = mapped_column(Date)  # next earliest date

    # Annual fee for the math
    annual_fee_cents: Mapped[int | None] = mapped_column(Integer)
    # Whether the first year's annual fee is waived. Affects Y1 ROI.
    first_year_fee_waived: Mapped[bool] = mapped_column(Boolean, default=False)

    notes: Mapped[str | None] = mapped_column(Text)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    bonus_earned_at: Mapped[datetime | None] = mapped_column(DateTime)
    bonus_posted_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class RedressStatus(str, enum.Enum):
    """Lifecycle for a CFPB / state-AG / regulatory redress eligibility."""
    eligible = "eligible"  # we think you qualify based on transaction match
    pending_filed = "pending_filed"  # you've filed the claim
    paid = "paid"
    rejected = "rejected"
    dismissed = "dismissed"  # not pursuing


class RegulatoryRedress(Base):
    """A CFPB / state-AG / regulatory enforcement redress you may qualify for.

    Companion to UnclaimedProperty + LegalClaim. Different shape:
      - LegalClaim is class-action settlements (private litigation)
      - UnclaimedProperty is state escheatment (decades-old dormant funds)
      - RegulatoryRedress is government-enforcement actions: CFPB
        consent orders, state AG settlements, FTC orders.

    Examples:
      - 2023 Wells Fargo $3.7B CFPB consent order — automatic refunds to
        affected accounts
      - Capital One $190M consumer-harm fund — application required
      - State AG settlements with payday lenders, debt collectors, etc.

    Many of these distribute money automatically TO affected accounts,
    so the user might already have received funds. But a meaningful
    fraction require user action (file a claim form, opt in, prove
    affected) — which is what this table tracks.
    """
    __tablename__ = "regulatory_redress"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # The agency that issued the order. CFPB / FTC / OCC / state AG / etc.
    agency: Mapped[str] = mapped_column(String(60), index=True)
    # The defendant company.
    company_name: Mapped[str] = mapped_column(String(240), index=True)
    # Short title of the case ("Wells Fargo - 2023 consumer redress").
    title: Mapped[str] = mapped_column(String(240))
    # Free-form description of who qualifies.
    eligibility_description: Mapped[str | None] = mapped_column(Text)
    # Where to file or check status.
    claim_url: Mapped[str | None] = mapped_column(String(500))
    # Total redress amount the company was ordered to distribute (so
    # the user has context for how big the case is).
    total_redress_cents: Mapped[int | None] = mapped_column(Integer)
    # Estimated payout per affected user. Often null when it's
    # case-by-case.
    estimated_per_user_cents: Mapped[int | None] = mapped_column(Integer)
    # Filing deadline if the redress requires user action.
    claim_deadline: Mapped[date | None] = mapped_column(Date)
    # Status lifecycle.
    status: Mapped[RedressStatus] = mapped_column(
        Enum(RedressStatus), default=RedressStatus.eligible, index=True
    )
    # Did we discover this via merchant-match against the user's
    # transactions, or did the user log it manually?
    discovery_source: Mapped[str] = mapped_column(String(60), default="manual")
    # JSON list of merchant strings / transaction IDs we matched on.
    matched_evidence: Mapped[dict | None] = mapped_column(JSON)
    notes: Mapped[str | None] = mapped_column(Text)
    discovered_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    filed_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime)
    actual_payout_cents: Mapped[int | None] = mapped_column(Integer)


class UnclaimedPropertyStatus(str, enum.Enum):
    """Lifecycle for an unclaimed-property record.

    ``found``     — search returned a match; user hasn't acted yet
    ``claimed``   — user filed the state's claim form
    ``paid``      — money received
    ``rejected``  — state denied the claim (proof issue, identity mismatch)
    ``dismissed`` — user reviewed it and decided not to pursue
    """
    found = "found"
    claimed = "claimed"
    paid = "paid"
    rejected = "rejected"
    dismissed = "dismissed"


class UnclaimedProperty(Base):
    """One unclaimed-property record from a NAUPA / state-DB lookup.

    Most people don't know this category exists: every U.S. state runs
    an unclaimed-property database holding old uncashed checks, dormant
    bank accounts, forgotten utility deposits, life-insurance proceeds,
    etc. Aggregate value across all states is in the **billions of
    dollars** of consumer money.

    NAUPA (the National Association of Unclaimed Property Administrators)
    exposes a free national search via MissingMoney.com. Some states
    (Texas, NY, CA among others) also run their own portals with deeper
    data than NAUPA's aggregator. We support both: a Playwright scraper
    framework lives in :mod:`scrapers.unclaimed_property` and manual
    entry via the API for matches the user already found themselves.

    Why a separate table from LegalClaim: lifecycle + dedupe key are
    different. LegalClaim is dedupe-by-source-URL; UnclaimedProperty
    is dedupe-by-(state, holder_name, owner_name, claim_id) when claim_id
    is given. Different state databases use wildly different ID
    schemes (NY uses 8-char alphanumeric, FL uses owner+holder hash,
    etc.) so we keep claim_id free-form.
    """
    __tablename__ = "unclaimed_properties"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # State that holds the unclaimed money. Two-char US state code,
    # or "federal" for IRS / Treasury / VA / PBGC / etc. When the
    # source is a federal database we just use "federal" so the same
    # table absorbs all "money-the-government-owes-you" records.
    state: Mapped[str] = mapped_column(String(20), index=True)
    # The reporter — a bank, employer, utility, insurance carrier — that
    # turned the property over to the state. Free-form, sometimes
    # missing on aggregator results.
    holder_name: Mapped[str | None] = mapped_column(String(240))
    # The name on the original account. We let the user log multiple
    # variants ("Christopher Avalos" / "Chris Avalos" / "C Avalos") via
    # separate rows.
    owner_name: Mapped[str] = mapped_column(String(160))
    # Sometimes a partial / asterisked address — states redact for
    # privacy. Free-form.
    last_known_address: Mapped[str | None] = mapped_column(String(240))
    # State-side claim ID, where present. Used in dedupe.
    claim_id: Mapped[str | None] = mapped_column(String(120), index=True)
    # Property type: "uncashed_check", "savings_account", "utility_deposit",
    # "life_insurance", "stock_dividend", "safe_deposit_contents", etc.
    # Free-form for now — states report ~60+ distinct codes.
    property_type: Mapped[str | None] = mapped_column(String(80))
    # Many state portals don't show the value of small claims; large
    # ones list it. Nullable so the UI can show "TBD" in the panel.
    estimated_value_cents: Mapped[int | None] = mapped_column(Integer)
    # Status lifecycle.
    status: Mapped[UnclaimedPropertyStatus] = mapped_column(
        Enum(UnclaimedPropertyStatus),
        default=UnclaimedPropertyStatus.found,
        index=True,
    )
    # Where to file the claim. State portal URL where possible.
    claim_url: Mapped[str | None] = mapped_column(String(500))
    # Source metadata: "missingmoney.com", "tx_comptroller", "manual".
    source: Mapped[str] = mapped_column(String(80), default="manual")
    notes: Mapped[str | None] = mapped_column(Text)
    discovered_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime)
    actual_payout_cents: Mapped[int | None] = mapped_column(Integer)


class NetWorthSnapshot(Base):
    """Aggregate net-worth point-in-time snapshot.

    Phase 7.1 ships a daily scheduler job that computes (sum of asset
    balances) − (sum of liability balances) and writes one row here.
    Used to render the historical chart on the net-worth panel.

    This is materialized aggregate, not derived-on-read, because
    walking BalanceSnapshot per-account per-day is O(N×days) and
    blows up the chart endpoint as the DB grows. A single row per
    day per (assets_cents, liabilities_cents, net_cents) keeps the
    chart query a tight range scan.
    """
    __tablename__ = "net_worth_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    as_of: Mapped[date] = mapped_column(Date, index=True, unique=True)
    assets_cents: Mapped[int] = mapped_column(Integer, default=0)
    liabilities_cents: Mapped[int] = mapped_column(Integer, default=0)
    net_cents: Mapped[int] = mapped_column(Integer, default=0)
    # JSON breakdown by AccountType so the UI can render the asset/
    # liability composition without re-walking BalanceSnapshot.
    breakdown: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Bill(Base):
    """Recurring bills the user tracks explicitly (mortgage, insurance, utilities)."""
    __tablename__ = "bills"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    institution_id: Mapped[int | None] = mapped_column(ForeignKey("institutions.id"))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    typical_amount_cents: Mapped[int | None] = mapped_column(Integer)
    cadence_days: Mapped[int] = mapped_column(Integer, default=30)
    due_day_of_month: Mapped[int | None] = mapped_column(Integer)
    is_negotiable: Mapped[bool] = mapped_column(Boolean, default=False)  # hint for suggestion engine
    notes: Mapped[str | None] = mapped_column(Text)


# ---------- Phase 4: offers ----------

class Offer(Base):
    __tablename__ = "offers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(240))
    description: Mapped[str | None] = mapped_column(Text)
    # Where the offer came from — Chase Offers, Xfinity email, manual entry, etc.
    source: Mapped[str] = mapped_column(String(80))
    # Which account/card the offer is attached to
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id"))
    # Offer terms (flexible — use extra for structured details per-source)
    reward_type: Mapped[str | None] = mapped_column(String(40))  # "percent_back", "fixed_amount", "bundle", ...
    reward_value_bps: Mapped[int | None] = mapped_column(Integer)  # 1000 = 10%
    reward_cap_cents: Mapped[int | None] = mapped_column(Integer)
    minimum_spend_cents: Mapped[int | None] = mapped_column(Integer)
    activation_url: Mapped[str | None] = mapped_column(String(500))
    expires_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[OfferStatus] = mapped_column(Enum(OfferStatus), default=OfferStatus.available)
    # Computed by matcher: estimated value for THIS user given their spend history
    estimated_value_cents: Mapped[int | None] = mapped_column(Integer)
    extra: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    merchant: Mapped["Merchant | None"] = relationship()


class Suggestion(Base):
    """Output of the suggestion engine: 'here's how you save money.'"""
    __tablename__ = "suggestions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))  # activate_offer, cancel_subscription, switch_plan, etc.
    title: Mapped[str] = mapped_column(String(240))
    body: Mapped[str] = mapped_column(Text)
    estimated_savings_cents: Mapped[int | None] = mapped_column(Integer)
    confidence: Mapped[float | None] = mapped_column(Float)  # 0..1
    # Link back to the source evidence
    offer_id: Mapped[int | None] = mapped_column(ForeignKey("offers.id"))
    subscription_id: Mapped[int | None] = mapped_column(ForeignKey("subscriptions.id"))
    bill_id: Mapped[int | None] = mapped_column(ForeignKey("bills.id"))
    status: Mapped[str] = mapped_column(String(20), default="new")  # new, acted, dismissed, expired
    extra: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ---------- Goals ----------

class Goal(Base):
    """A savings or debt-reduction goal.

    Phase D extends the original 6-column row with: kind (so the suggestion
    engine knows whether to allocate INTO it or pay DOWN it), priority (lower
    int wins ties when surplus is split), current_amount_cents (cached
    progress — sum of GoalContribution.amount_cents, materialised so the UI
    doesn't re-aggregate on every render), status (lifecycle), and
    linked_debt_account_id (for debt_payoff goals — the credit/loan account
    we're paying down). ``linked_account_id`` is repurposed as the savings
    *destination* (where surplus would land); ``linked_debt_account_id`` is
    the debt *source*. Both nullable so abstract goals ("$3k vacation fund,
    no specific savings account") still work.

    Why cache current_amount_cents instead of computing on read: the
    contribution table is the source of truth, but the dashboard list query
    would otherwise need a SUM subquery per row. The cache is updated
    transactionally inside the contribute endpoint.
    """
    __tablename__ = "goals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[GoalKind] = mapped_column(
        Enum(GoalKind), default=GoalKind.general_savings, index=True
    )
    target_amount_cents: Mapped[int] = mapped_column(Integer)
    current_amount_cents: Mapped[int] = mapped_column(Integer, default=0)
    target_date: Mapped[date | None] = mapped_column(Date)
    # Lower number = higher priority. 1 = "fund this first." Default 5 keeps
    # new goals out of the way until the user explicitly ranks them.
    priority: Mapped[int] = mapped_column(Integer, default=5)
    status: Mapped[GoalStatus] = mapped_column(
        Enum(GoalStatus), default=GoalStatus.active, index=True
    )
    # For savings goals: where surplus would be moved.
    linked_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    # For debt_payoff goals: the credit-card or loan account being paid down.
    # Separate from linked_account_id so a single goal can model
    # "pay down Chase Sapphire from $4,200 to $0" without confusing the
    # destination/source.
    linked_debt_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    # Highest milestone (50/75/100) we've already notified the user about.
    # Phase 6 milestone job uses this to fire each threshold exactly once
    # per goal even if the percentage briefly dips below + comes back up.
    last_milestone_pct: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    contributions: Mapped[list["GoalContribution"]] = relationship(
        back_populates="goal",
        cascade="all, delete-orphan",
        order_by="GoalContribution.contributed_at.desc()",
    )


class GoalContribution(Base):
    """One recorded movement of money toward a Goal.

    For a savings goal: an inflow into the savings destination (or just the
    user logging "I transferred $200 today"). For a debt_payoff goal: a
    principal-reducing payment (recorded value is the *positive* amount
    applied; the underlying transaction is a negative outflow on the debt
    account). The Goal.current_amount_cents cache is incremented on insert
    and decremented on delete.

    We NEVER move money — these rows always represent an action the user
    already took. The endpoint that creates them is "record this", not
    "execute this."
    """
    __tablename__ = "goal_contributions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    goal_id: Mapped[int] = mapped_column(
        ForeignKey("goals.id", ondelete="CASCADE"), index=True
    )
    amount_cents: Mapped[int] = mapped_column(Integer)
    contributed_at: Mapped[date] = mapped_column(Date, index=True)
    source: Mapped[GoalContributionSource] = mapped_column(
        Enum(GoalContributionSource), default=GoalContributionSource.manual
    )
    # Optional link to a Transaction we matched (transfer_record / debt_payment)
    transaction_id: Mapped[int | None] = mapped_column(ForeignKey("transactions.id"))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    goal: Mapped[Goal] = relationship(back_populates="contributions")


# ---------- Audit / ingest metadata ----------

class IngestBatch(Base):
    """Record of one ingestion run — file path, rows parsed, rows created, errors."""
    __tablename__ = "ingest_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[IngestSource] = mapped_column(Enum(IngestSource))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    source_ref: Mapped[str | None] = mapped_column(String(500))  # file path, email id, plaid cursor
    rows_parsed: Mapped[int] = mapped_column(Integer, default=0)
    rows_created: Mapped[int] = mapped_column(Integer, default=0)
    rows_duplicate: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)


class EmailMessage(Base):
    """One Gmail message we've fetched + attempted to parse.

    We keep the row even for ``ignored`` messages so the next sync doesn't
    re-fetch + re-parse them. The body is stored truncated (see gmail/client.py)
    so the SQLite file doesn't balloon — full body is always re-fetchable via
    the Gmail API using gmail_message_id.
    """
    __tablename__ = "email_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Gmail identifiers — message_id is globally unique per account
    gmail_message_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    gmail_thread_id: Mapped[str | None] = mapped_column(String(40), index=True)

    # Envelope (all strings trimmed; body_plain truncated to ~50KB)
    from_address: Mapped[str] = mapped_column(String(320))  # RFC 5321 max local+domain
    from_domain: Mapped[str] = mapped_column(String(255), index=True)  # "chase.com" — cheap filter
    subject: Mapped[str | None] = mapped_column(String(500))
    received_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    snippet: Mapped[str | None] = mapped_column(String(500))  # Gmail's pre-rendered snippet
    body_plain: Mapped[str | None] = mapped_column(Text)  # plain-text body (HTML → text)

    # Parser bookkeeping
    parser_name: Mapped[str | None] = mapped_column(String(80), index=True)  # None = no parser matched
    parser_outcome: Mapped[ParserOutcome] = mapped_column(
        Enum(ParserOutcome), default=ParserOutcome.ignored
    )
    parser_error: Mapped[str | None] = mapped_column(Text)  # traceback on ``failed``

    # If the parser produced a transaction, link it here. For bills/offers we
    # use the extra JSON blob and a dedicated downstream row (Phase 3/4).
    transaction_id: Mapped[int | None] = mapped_column(ForeignKey("transactions.id"))

    # Structured parser output that doesn't fit a first-class column.
    # Examples: {"bill_amount_cents": 8500, "due_date": "2026-05-15", "tags": ["offer"]}
    extra: Mapped[dict | None] = mapped_column(JSON)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    transaction: Mapped["Transaction | None"] = relationship()

    __table_args__ = (
        Index("ix_email_domain_received", "from_domain", "received_at"),
    )


# ---------- Phase A: budgets ----------

class Budget(Base):
    """Monthly spending budget per category.

    One row per (category, month). ``month_start`` is the first day of the
    budget month (2026-04-01 for April 2026). Using a real Date instead of
    year+month ints means we can do date arithmetic (prev month, range
    queries) without splitting the value; the application layer enforces
    month_start.day == 1.

    ``amount_cents`` is stored as a POSITIVE integer — the cap on outflow
    for the month. Actual spending (also always expressed as a positive
    "how much went out") is computed on the fly from Transaction rows with
    negative amount_cents.

    ``rollover=True`` is YNAB-style — unused budget carries to next month.
    ``rollover=False`` resets monthly (EveryDollar-style). The rollup
    endpoint honors this when computing available_cents (future work).
    """
    __tablename__ = "budgets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), index=True)
    month_start: Mapped[date] = mapped_column(Date, index=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
    rollover: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # Legacy columns from the pre-refactor schema (year+month ints). They
    # remain NOT NULL in DBs that pre-date the refactor and SQLite can't
    # relax NOT NULL without a full table rebuild. Marked nullable on the
    # Python side so brand-new DBs (which DO get these via create_all even
    # though we never read them) and legacy DBs both work; a before_insert
    # listener below populates them from month_start automatically.
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    month: Mapped[int | None] = mapped_column(Integer, nullable=True)

    category: Mapped["Category"] = relationship()

    __table_args__ = (
        UniqueConstraint("category_id", "month_start", name="uq_budget_cat_month"),
    )


# ---------- Phase C: credit scores ----------

class CreditScoreSnapshot(Base):
    """Point-in-time credit score observation.

    Pure observation — no derived fields. Utilization and CLI-opportunity
    math live in the credit module, not here, because those depend on
    live account balances which drift independent of score pulls.

    Unique on (bureau, scoring_model, as_of, source) so we can record the
    same score from multiple places on the same day (e.g. Credit Karma
    shows VantageScore while Discover shows FICO) without collisions.
    """
    __tablename__ = "credit_score_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    score: Mapped[int] = mapped_column(Integer)  # typical FICO/VS range 300..850
    bureau: Mapped[CreditBureau] = mapped_column(Enum(CreditBureau))
    scoring_model: Mapped[CreditScoringModel] = mapped_column(
        Enum(CreditScoringModel), default=CreditScoringModel.fico8
    )
    as_of: Mapped[date] = mapped_column(Date, index=True)
    source: Mapped[ScoreSource] = mapped_column(
        Enum(ScoreSource), default=ScoreSource.manual
    )
    # Free-form detail: "Chase mobile app", "creditkarma.com", "Experian email".
    # Useful for debugging scraper accuracy once Phase C.2 ships.
    source_detail: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "bureau", "scoring_model", "as_of", "source",
            name="uq_score_bureau_model_date_source",
        ),
        Index("ix_credit_score_as_of_desc", "as_of"),
    )


# ---------- Phase F: class-action settlements ----------

class LegalClaim(Base):
    """A class-action settlement Chris is eligible to file.

    Phase F starts manual: Chris (or a sidekick scraper, later) inserts rows;
    the dashboard surfaces them sorted by deadline and bucketed by whether
    they need proof of purchase. The lifecycle is intentionally light —
    available → claimed → paid (or dismissed). No automated submission;
    that's a much bigger compliance lift and out of scope for v1.

    Two small but load-bearing design choices:

    * ``proof_required`` is a hard boolean rather than a 3-state
      "easy / medium / hard". The UX win is a single toggle: "show me the
      ones I can knock out in a coffee break." Cases requiring receipts,
      documentation, or notarization all map to True; "name and address"
      claims map to False.
    * ``estimated_payout_cents`` is nullable because most settlements only
      promise "up to $X" or "pro-rata depending on claim count" — putting
      a number in the column would suggest false certainty. The UI shows
      "—" and lets Chris fill in a guess; ``actual_payout_cents`` records
      the cheque when it arrives so we can sanity-check the estimates.
    """
    __tablename__ = "legal_claims"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Identification
    name: Mapped[str] = mapped_column(String(200))
    administrator: Mapped[str | None] = mapped_column(String(120))
    case_number: Mapped[str | None] = mapped_column(String(80))
    source_url: Mapped[str] = mapped_column(String(500))

    # The thing the user actually reads to decide if they qualify
    description: Mapped[str | None] = mapped_column(Text)
    eligibility: Mapped[str | None] = mapped_column(Text)

    # Filtering / bucketing.
    #
    # ``proof_status`` is the source of truth from F.2 onward — a 3-state
    # enum (not_required / required / unknown). ``proof_required`` is the
    # legacy boolean from F.1; it's kept in the schema because dropping a
    # NOT NULL column requires an Alembic migration we haven't set up yet.
    # An event listener below mirrors proof_status → proof_required on
    # save so the legacy column never goes stale.
    proof_required: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    proof_status: Mapped[ProofRequirement] = mapped_column(
        Enum(ProofRequirement),
        default=ProofRequirement.unknown,
        index=True,
    )
    estimated_payout_cents: Mapped[int | None] = mapped_column(Integer)

    # Time-pressure: deadline drives sort order in the UI; payout_date is
    # the rough "when will I see money" hint when it's published.
    claim_deadline: Mapped[date | None] = mapped_column(Date, index=True)
    payout_date: Mapped[date | None] = mapped_column(Date)

    # Lifecycle
    status: Mapped[LegalClaimStatus] = mapped_column(
        Enum(LegalClaimStatus), default=LegalClaimStatus.available, index=True
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime)
    actual_payout_cents: Mapped[int | None] = mapped_column(Integer)

    # Free-form
    notes: Mapped[str | None] = mapped_column(Text)

    # Provenance: where did this row come from. ``manual`` for hand-entered;
    # later we'll add ``scraped_topclassactions``, ``scraped_classaction_org``,
    # etc. so we can audit which source produced which rows.
    source: Mapped[str] = mapped_column(String(60), default="manual")

    # State eligibility — which US state(s) the settlement covers.
    # Stored as a comma-separated list of 2-letter codes (e.g. "CA,FL,TX")
    # or the literal string ``"nationwide"`` when the case is open to
    # consumers in any state. Drives the Settlemate-style state filter
    # chips in the UI ("California (31)", etc.).
    #
    # Most class actions are nationwide; state-specific ones are
    # detected by parsing eligibility text for "[State] residents",
    # "consumers who live in [State]", etc. Defaults to ``"nationwide"``
    # when the parser can't determine — same conservative-default
    # philosophy as proof_status=unknown.
    state_eligibility: Mapped[str] = mapped_column(
        String(120),
        default="nationwide",
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # Common query: "what's not dismissed/paid, sorted by deadline?"
        Index("ix_legal_claim_status_deadline", "status", "claim_deadline"),
        # Dedupe guard: same case URL shouldn't be inserted twice when the
        # scraper lands. URL is the most stable identifier — administrator
        # / case_number are often missing or formatted differently.
        UniqueConstraint("source_url", name="uq_legal_claim_source_url"),
    )


# Keep the legacy ``proof_required`` boolean in sync with ``proof_status``
# on every insert and update. The boolean is still NOT NULL in the DB
# (that's a leftover from F.1 — dropping it would require a real Alembic
# migration). We never read it from API code; this listener exists solely
class ReceiptStatus(str, enum.Enum):
    """Lifecycle of a receipt upload.

    ``pending``  — image uploaded, OCR not yet run.
    ``parsed``   — OCR ran successfully, line items extracted.
    ``failed``   — OCR failed (tesseract not installed, image unreadable, etc.).
                   The raw image is kept so the user can retry with a manual
                   paste of the text.
    ``manual``   — user pasted/edited line items by hand.
    """
    pending = "pending"
    parsed = "parsed"
    failed = "failed"
    manual = "manual"


class Receipt(Base):
    """One uploaded receipt — usually a photo of a paper receipt or a PDF
    pulled from an email.

    Phase 10 — shopping intelligence foundation. Each receipt rolls up
    one shopping trip:

      - merchant + posted_date locate it in time and store
      - subtotal/tax/total are the dollar facts
      - raw_text is the OCR output (kept for re-parsing if heuristics improve)
      - status drives the UI badge
      - linked transaction_id (optional) ties the receipt back to the Plaid
        line so we can reconcile per-item detail with the bank-side total

    The receipt itself doesn't store the image bytes — those live on disk
    at ``image_path`` (relative to the configured uploads dir). Keeping
    images out of SQLite avoids bloating WAL files and keeps backups fast.
    """
    __tablename__ = "receipts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Where the original image lives. Relative to the receipts upload dir
    # (configurable via settings.receipts_upload_dir).
    image_path: Mapped[str | None] = mapped_column(String(500))
    # Detected store, e.g. "Costco Wholesale". Free-form because OCR will
    # pull whatever the receipt header says — we don't normalize at write
    # time so a later canonicalization pass has the original.
    merchant: Mapped[str | None] = mapped_column(String(200), index=True)
    purchase_date: Mapped[date | None] = mapped_column(Date, index=True)

    subtotal_cents: Mapped[int | None] = mapped_column(Integer)
    tax_cents: Mapped[int | None] = mapped_column(Integer)
    total_cents: Mapped[int | None] = mapped_column(Integer)

    # Full OCR output, preserved for retry / debugging. Trimmed to 50KB
    # at write time (real receipts are typically 1-5KB of text).
    raw_text: Mapped[str | None] = mapped_column(Text)

    status: Mapped[ReceiptStatus] = mapped_column(
        Enum(ReceiptStatus), default=ReceiptStatus.pending, index=True
    )

    # Optional linkage — when the user uploads a receipt and we can match
    # it to a Plaid transaction by amount + date + merchant, the link
    # lets us show "$87.43 at Costco on 2026-04-15" with full per-item
    # detail attached. Soft FK; SET NULL on transaction delete.
    transaction_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Free-form. Store-specific oddities, OCR error notes, etc.
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    items: Mapped[list["ReceiptItem"]] = relationship(
        back_populates="receipt", cascade="all, delete-orphan"
    )


class ReceiptItem(Base):
    """One line on a receipt.

    The OCR / parser populates ``raw_line`` with the literal line text
    plus a best-effort split into structured fields. Subsequent passes
    (item canonicalization, deal matching) read from these structured
    columns and write back the canonical_key.

    ``unit_price_cents * quantity`` should approximate ``line_total_cents``
    but receipts often round differently — we keep both columns so the
    user-facing display can show whichever the receipt actually printed.

    Phase 10A: line items are extracted but ``canonical_key`` is left
    NULL. Phase 10B (canonicalization) is a follow-up that backfills it.
    """
    __tablename__ = "receipt_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_id: Mapped[int] = mapped_column(
        ForeignKey("receipts.id", ondelete="CASCADE"), index=True
    )

    # Original line as-printed on the receipt — preserved verbatim so the
    # user can see exactly what we OCR'd and correct any mis-reads.
    raw_line: Mapped[str] = mapped_column(String(500))

    # Best-effort extracted name, with retailer-specific abbreviations
    # expanded (CHRMN UL → "Charmin Ultra Soft", SMALL MILK 1G → "Milk 1gal").
    name: Mapped[str | None] = mapped_column(String(200), index=True)
    brand: Mapped[str | None] = mapped_column(String(120))

    # Quantity stored as an integer scaled by 1000 (so 1.5 lbs → 1500),
    # mirroring the trick we use in Holding.quantity_units. Keeps math
    # exact and doesn't pollute the schema with floats.
    quantity_units: Mapped[int] = mapped_column(Integer, default=1000)
    unit_label: Mapped[str | None] = mapped_column(String(40))  # "ea", "lb", "oz", "ct"

    unit_price_cents: Mapped[int | None] = mapped_column(Integer)
    line_total_cents: Mapped[int | None] = mapped_column(Integer)

    # Item discount/savings if printed on the receipt (member savings,
    # store coupon, manufacturer rebate). Negative cents = discount.
    discount_cents: Mapped[int | None] = mapped_column(Integer)

    # SKU / item number if present on the receipt (Costco prints them,
    # Target sometimes does, Walmart usually doesn't). Useful as a
    # canonicalization anchor.
    sku: Mapped[str | None] = mapped_column(String(40), index=True)

    # Filled in by the canonicalizer (Phase 10E). NULL until then.
    # Same canonical_key across stores means "same product" — drives
    # cross-store deal alerts. canonical_key is the normalized string
    # form (kept for legacy/compatibility); canonical_product_id is
    # the proper FK link added in Slice E.
    canonical_key: Mapped[str | None] = mapped_column(String(200), index=True)
    canonical_product_id: Mapped[int | None] = mapped_column(
        ForeignKey("canonical_products.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Free-form category tag (groceries, household, paper, beverages,
    # etc.). Distinct from the transaction-level Category — receipts
    # are one-merchant but contain mixed categories.
    item_category: Mapped[str | None] = mapped_column(String(60))

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    receipt: Mapped["Receipt"] = relationship(back_populates="items")


class ReceiptCouponStatus(str, enum.Enum):
    """Lifecycle of a coupon harvested from a receipt.

    ``available`` — extracted, not yet redeemed
    ``used``      — user marked redeemed (we don't auto-detect)
    ``expired``   — past the expiration date (or older than 365d if unknown)
    ``dismissed`` — user said "skip" — won't resurface in Money on the Table
    """
    available = "available"
    used = "used"
    expired = "expired"
    dismissed = "dismissed"


class ReceiptCoupon(Base):
    """One coupon / offer / promo code extracted from a receipt — Slice C.

    Why this is its own table (not on Receipt directly):
      • Receipts often have 0 or N coupons; cardinality is 1:N
      • Coupons need their own lifecycle (used/expired/dismissed) that
        the parent receipt doesn't share
      • The Money-on-the-Table aggregator queries directly without
        joining to the parent receipt — keeping coupons in their own
        table makes that query trivial

    Sources of truth a coupon row carries:
      • title (human-readable, "20% off your next visit")
      • code (alphanumeric token to enter at checkout, may be NULL)
      • redemption_url (explicit URL to redeem, may be NULL)
      • estimated_value_cents (parsed from "$5 off"-style text where possible)
      • expires_at (parsed from "Expires MM/DD/YY")

    Real-world examples that should produce one of these rows:
      "Save $5 on your next purchase. Code: SAVE5. Expires 5/15/26"
      "Take our survey at survey.target.com/code/12345 for $3 off"
      "20% off all electronics — visit costco.com/electronics2026"
      "Manufacturer rebate: mail this receipt to ... for $X back"
    """
    __tablename__ = "receipt_coupons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_id: Mapped[int] = mapped_column(
        ForeignKey("receipts.id", ondelete="CASCADE"), index=True
    )

    # Free-form. Often the literal coupon text trimmed to a sentence.
    title: Mapped[str] = mapped_column(String(300))
    # Promo code printed on the receipt (alphanumeric, often case-sensitive).
    # NULL if the offer is URL-only or rebate-form-only.
    code: Mapped[str | None] = mapped_column(String(80), index=True)
    # Redemption URL — extracted from the receipt body when present.
    # NULL if redemption is in-store-only or via mail.
    redemption_url: Mapped[str | None] = mapped_column(String(500))

    # Best-effort dollar value: "$5 off" → 500. NULL when value is
    # qualitative ("free shipping") or percentage-based without a
    # clear cap. Drives sort order in the Money-on-the-Table panel.
    estimated_value_cents: Mapped[int | None] = mapped_column(Integer)

    # Source store — copied from the parent Receipt at write time so
    # the Money-on-the-Table aggregator doesn't need a join. Also
    # useful for grouping ("Costco coupons" vs "Target coupons").
    merchant: Mapped[str | None] = mapped_column(String(200), index=True)

    expires_at: Mapped[date | None] = mapped_column(Date, index=True)

    status: Mapped[ReceiptCouponStatus] = mapped_column(
        Enum(ReceiptCouponStatus),
        default=ReceiptCouponStatus.available,
        index=True,
    )

    # The literal text we extracted this coupon from. Helps the user
    # eyeball what we caught + retrain the parser on misses.
    raw_text: Mapped[str | None] = mapped_column(Text)

    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    used_at: Mapped[datetime | None] = mapped_column(DateTime)


class RecurringPurchaseStatus(str, enum.Enum):
    """Lifecycle of a detected recurring-purchase pattern."""
    active = "active"           # currently being purchased on cadence
    inactive = "inactive"       # last purchase > 2× cadence ago — pattern broke
    dismissed = "dismissed"     # user said "stop tracking this"


class RecurringPurchase(Base):
    """A pattern of a household item bought repeatedly — Phase 10 Slice B.

    Different from Subscription: subscriptions are merchant + amount
    that repeat (Netflix at $19.99). Recurring purchases are *items*
    that repeat — toilet paper at Costco every 6 weeks, coffee at
    Trader Joe's every 3 weeks. They're surfaced from receipt
    line-items (which carry SKU + name + price) rather than from
    transaction descriptions.

    The detector populates this table by walking ReceiptItem rows and
    grouping them by SKU (when present) or normalized name (fallback).
    A pattern is "real" when there are ≥3 occurrences spread over ≥45
    days at a roughly stable cadence and price.

    Why not just join to ReceiptItem at query-time? Three reasons:
      1. The detector is expensive (cadence math + price stats), so we
         materialize results instead of recomputing on every page load.
      2. The user-facing lifecycle (active/inactive/dismissed) lives
         on the pattern, not on individual receipt rows.
      3. Slice D (cross-store deal alerts) needs a stable per-pattern
         identity to attach price observations to over time.
    """
    __tablename__ = "recurring_purchases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Best-guess canonical name for the item ("Charmin Ultra Soft 24ct")
    # — derived by the detector from the most-frequent ReceiptItem.name
    # in the cluster. The user can rename via PATCH; the detector won't
    # clobber a manually-set name on re-run.
    canonical_name: Mapped[str] = mapped_column(String(200), index=True)

    # Where it's typically purchased. Optional — multi-merchant items
    # leave this NULL and rely on per-occurrence detail.
    primary_merchant: Mapped[str | None] = mapped_column(String(200), index=True)

    # Item identifier when consistent across receipts. Often the SKU
    # printed on the receipt; can be NULL for grocery items where the
    # SKU rotates by package.
    primary_sku: Mapped[str | None] = mapped_column(String(40), index=True)

    # Price + quantity stats over the cluster
    typical_unit_price_cents: Mapped[int | None] = mapped_column(Integer)
    typical_line_total_cents: Mapped[int | None] = mapped_column(Integer)
    typical_quantity_units: Mapped[int | None] = mapped_column(Integer)
    unit_label: Mapped[str | None] = mapped_column(String(40))

    # Cadence — median days between purchases. Drives "next expected"
    # and the annualized-cost projection.
    cadence_days: Mapped[int | None] = mapped_column(Integer)
    occurrence_count: Mapped[int] = mapped_column(Integer, default=0)
    first_purchased_at: Mapped[date | None] = mapped_column(Date)
    last_purchased_at: Mapped[date | None] = mapped_column(Date, index=True)

    # 0.0 - 1.0. Combines cadence-stability + price-stability + count.
    # Surfaces in the UI as "high/medium/low confidence" badges.
    confidence_score: Mapped[float] = mapped_column(Float, default=0.0)

    # Free-form category (groceries, household, paper, beverages, etc.).
    # Set by the detector from the underlying ReceiptItems' item_category;
    # editable by the user.
    category: Mapped[str | None] = mapped_column(String(60), index=True)

    status: Mapped[RecurringPurchaseStatus] = mapped_column(
        Enum(RecurringPurchaseStatus),
        default=RecurringPurchaseStatus.active,
        index=True,
    )

    # When the user has hand-renamed the canonical_name — the detector
    # should respect that and not overwrite. Set automatically on PATCH.
    name_locked: Mapped[bool] = mapped_column(Boolean, default=False)

    notes: Mapped[str | None] = mapped_column(Text)

    # Slice E — link to the canonical product identity. Lets us pivot
    # observations across receipt patterns when the same canonical is
    # bought at multiple stores under different patterns.
    canonical_product_id: Mapped[int | None] = mapped_column(
        ForeignKey("canonical_products.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class CanonicalProduct(Base):
    """A cross-store product identity — Phase 10 Slice E.

    The "Charmin Ultra Soft 24 Mega Rolls" you buy at Costco and the
    "CHRMN UL TP 24CT" line on a Target receipt resolve to the same
    CanonicalProduct row. This unlocks:
      • Cross-store deal detection at item identity (not just SKU,
        which differs per retailer).
      • Per-canonical price history that aggregates every merchant.
      • Receipt-line-item rollups where the user sees lifetime spend
        on Charmin regardless of where they bought it.

    Materialized rather than computed-on-the-fly because:
      1. Fuzzy matching is expensive — we want to do it once per
         receipt-item ingestion, not on every page load.
      2. The user can override the auto-canonicalization (merge two
         canonical rows that should be one, split one that shouldn't).
         Stable IDs let those overrides survive.
      3. Future: scrapers can use the canonical name + brand + size
         as their search query without re-deriving from raw line text.

    The ``normalized_key`` column is what the matcher uses for
    similarity — a token-sorted lowercased string like ``"24 charmin
    ct ultra"``. Equal keys mean "definitely same product"; near-equal
    keys go through a fuzzy match step before being merged.
    """
    __tablename__ = "canonical_products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # User-facing display name — picked from the longest, most-readable
    # observed name across linked ReceiptItems. The user can rename via
    # PATCH; rename → name_locked=True so the canonicalizer doesn't
    # clobber the manual edit on the next run.
    name: Mapped[str] = mapped_column(String(200))

    # Extracted by the brand extractor in canonicalization/. NULL when
    # we can't infer a brand (private label, generics, "store brand").
    brand: Mapped[str | None] = mapped_column(String(80), index=True)

    # Free-form. Mirrors ReceiptItem.item_category but at the canonical
    # level so a per-canonical category survives renames.
    category: Mapped[str | None] = mapped_column(String(60), index=True)

    # Size triple — populated by the size extractor.
    # "24 mega rolls" → size_value=24, size_unit="ct", form="mega rolls"
    # "64 fl oz"      → size_value=64, size_unit="oz", form=None
    size_value: Mapped[float | None] = mapped_column(Float)
    size_unit: Mapped[str | None] = mapped_column(String(20))
    form: Mapped[str | None] = mapped_column(String(60))  # "mega rolls", "tall cans", etc.

    # Token-sorted normalized name. The matcher's primary key for
    # detecting "this receipt item is this canonical". Required + indexed.
    normalized_key: Mapped[str] = mapped_column(String(300), index=True)

    # Universal Product Code, when known. Strongest cross-store identity
    # (same UPC = same SKU = same item). Almost always NULL on receipts
    # but populated when the user manually links a UPC.
    primary_upc: Mapped[str | None] = mapped_column(String(20), unique=True, index=True)

    # When the user has hand-renamed the canonical name, the
    # canonicalizer respects that and won't overwrite. Mirrors
    # RecurringPurchase.name_locked.
    name_locked: Mapped[bool] = mapped_column(Boolean, default=False)

    # Free-form user notes.
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class PriceObservationSource(str, enum.Enum):
    """Where a PriceObservation came from.

    ``manual``           — user typed it in via the Deals panel
    ``scraper:walmart``  — Walmart Playwright scraper (or stub today)
    ``scraper:target``   — Target Playwright scraper (or stub today)
    ``scraper:costco``   — Costco Playwright scraper (or stub today)
    ``scraper:amazon_fresh``
    ``scraper:kroger``
    ``email``            — future: scraped from a deal-email parser

    The "scraper:*" prefixing matches the convention used elsewhere
    (LegalClaim.source, Subscription.source) — easy to filter "anything
    a scraper produced" with a LIKE 'scraper:%'.
    """
    manual = "manual"
    scraper_walmart = "scraper:walmart"
    scraper_target = "scraper:target"
    scraper_costco = "scraper:costco"
    scraper_amazon_fresh = "scraper:amazon_fresh"
    scraper_kroger = "scraper:kroger"
    email = "email"


class PriceObservation(Base):
    """A single observed price for a recurring item — Phase 10 Slice D.

    Every time we see (or the user logs) a price for a tracked item,
    we append a row here. The deal detector reads these to find
    observations meaningfully below the user's historical median for
    that pattern.

    Why a separate table from RecurringPurchase: observations are
    inherently many-per-pattern (one per merchant per scrape run +
    every manual entry), and we want to keep history so trend
    analysis is possible later (price chart per item, "Charmin has
    crept up 12% over the last 6 months", etc.).

    The dedup key for scraper rows is (recurring_purchase_id, merchant,
    observed_at::date) — re-running the scraper the same day shouldn't
    create duplicate rows. Manual entries skip dedup so the user can
    log multiple sightings on the same day if they want.
    """
    __tablename__ = "price_observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recurring_purchase_id: Mapped[int] = mapped_column(
        ForeignKey("recurring_purchases.id", ondelete="CASCADE"), index=True
    )

    # Where the price was observed. Free-form so a custom store the
    # user shops at ("Smart & Final", "Sprouts") works without code
    # changes — the scrapers are a Best-effort layer on top.
    merchant: Mapped[str] = mapped_column(String(200), index=True)

    # The observed price for the item, in cents. We don't normalize
    # to per-unit at write time because pack sizes vary and the
    # canonicalizer (Slice 10E) hasn't shipped yet — it'll be added
    # later as a denormalized ``unit_price_cents`` column.
    price_cents: Mapped[int] = mapped_column(Integer)

    # The date the price was seen. Distinct from created_at because
    # the user might log a price they saw a week ago.
    observed_at: Mapped[date] = mapped_column(Date, index=True)

    source: Mapped[PriceObservationSource] = mapped_column(
        Enum(PriceObservationSource), default=PriceObservationSource.manual
    )

    # Stock state at observation time. Some scrapers can detect "out
    # of stock"; manual entry assumes True unless the user says otherwise.
    in_stock: Mapped[bool] = mapped_column(Boolean, default=True)

    # Optional pointer to the live page where the price was seen —
    # makes it actionable in the UI ("click to buy at Target").
    product_url: Mapped[str | None] = mapped_column(String(500))

    # Free-form. "ad-week 03/15", "in-store only", etc.
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class DailyMoveAction(Base):
    """User action on a daily-move opportunity (done / snoozed / dismissed).

    The Daily Moves queue surfaces opportunities from many sources
    (class actions, card benefits, offers, etc.) and the user wants
    to be able to mark them off without deleting the underlying source
    row. This table records those actions so the /today endpoint can
    filter actioned items out of the queue.

    Identity:
      - For DB-backed opportunities (LegalClaim, CardBenefit, etc.) the
        ``source_id`` integer is the natural key.
      - For catalog-only opportunities (passive_check, bank_bonus —
        which don't have a backing row) ``source_id`` is null and we
        identify by ``source_key``, which is the title hash.

    The unique constraint is on the triple ``(source_kind, source_id,
    source_key)`` so a given opportunity has at most one open action at
    a time. Re-actioning replaces the prior row.
    """
    __tablename__ = "daily_move_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_kind: Mapped[str] = mapped_column(String(40), index=True)
    source_id: Mapped[int | None] = mapped_column(Integer, index=True)
    # Stable hash for catalog items that have no source_id. Use the
    # opportunity's title (lowercased + whitespace-collapsed) so the
    # same passive-check from one day to the next has the same key.
    source_key: Mapped[str | None] = mapped_column(String(200), index=True)
    # "done" — user finished it. Persists forever.
    # "snoozed" — user pushed it; comes back when ``snoozed_until`` passes.
    # "dismissed" — user said never show me this again. Persists forever.
    action: Mapped[str] = mapped_column(String(20))
    snoozed_until: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    actioned_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "source_kind", "source_id", "source_key",
            name="uq_dma_source",
        ),
    )


# to keep the column populated so old DBs and the SQLite NOT NULL constraint
# don't choke on inserts that don't mention proof_required.
@event.listens_for(LegalClaim, "before_insert")
@event.listens_for(LegalClaim, "before_update")
def _sync_proof_required(_mapper, _conn, target: "LegalClaim") -> None:  # type: ignore[name-defined]
    status = target.proof_status or ProofRequirement.unknown
    target.proof_required = (status == ProofRequirement.required)


# Mirror of the proof_required pattern above — Budget was refactored from
# (year, month) ints to a single month_start DATE, but those legacy columns
# are still NOT NULL in DBs that pre-date the refactor (SQLite can't easily
# drop or relax NOT NULL without a full table rebuild). This listener keeps
# year/month populated on insert/update by deriving them from month_start,
# so the application-level model only ever has to deal with month_start.
# Uses ``getattr(target, ..., None)`` so brand-new DBs without legacy columns
# never see an AttributeError — the assignment is a no-op there.
@event.listens_for(Budget, "before_insert")
@event.listens_for(Budget, "before_update")
def _sync_budget_year_month(_mapper, _conn, target: "Budget") -> None:  # type: ignore[name-defined]
    ms = target.month_start
    if ms is None:
        return
    if hasattr(type(target), "year"):
        target.year = ms.year  # type: ignore[attr-defined]
    if hasattr(type(target), "month"):
        target.month = ms.month  # type: ignore[attr-defined]
