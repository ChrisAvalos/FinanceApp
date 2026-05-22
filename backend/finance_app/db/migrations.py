"""Dev-mode auto-migrations for additive schema drift.

Why this file exists
--------------------
The app uses ``Base.metadata.create_all(bind=engine)`` at startup to keep
``make dev`` friction-free — no ``alembic upgrade`` step required. But
``create_all`` is "create if not exists" only: if we add a column to an
existing model, it will NOT propagate to the live SQLite file.

``apply_auto_migrations`` closes that gap for additive column changes only.
It's idempotent — safe to call on every startup — and works by
inspecting each table via ``PRAGMA table_info`` and issuing
``ALTER TABLE ... ADD COLUMN`` for any field that's in the model but not
in the database.

What it does NOT handle
-----------------------
Renames, drops, type changes, constraint additions. Those need a real
Alembic migration. When we need one, the upgrade path is:

    1. Run ``alembic revision --autogenerate -m "..."``
    2. Inspect + hand-edit the generated file (autogen misses things)
    3. ``alembic upgrade head``

For now, this file is the escape valve for the 90% of schema changes
that are purely additive.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

# (table_name, column_name, SQL type spec) — order matters only within a table.
# The "SQL type spec" is the full bit after the column name in
# ``ALTER TABLE ... ADD COLUMN <name> <spec>`` — so it can include
# DEFAULT and NOT NULL clauses, which SQLite REQUIRES if you want to add
# a NOT NULL column to an existing table (it has to know what to fill
# the existing rows with).
#
# Keep this list in sync with models.py; removing an entry is fine once the
# underlying column has been present in production for long enough that no
# live DB is missing it.
_COLUMN_ADDITIONS: list[tuple[str, str, str]] = [
    # Credit-ops fields on Account
    ("accounts", "statement_close_day", "INTEGER"),
    ("accounts", "statement_due_day", "INTEGER"),
    ("accounts", "last_statement_balance_cents", "INTEGER"),
    ("accounts", "last_statement_date", "DATE"),
    ("accounts", "current_balance_cents", "INTEGER"),
    # Phase 2 — Plaid linkage on Account. These columns shipped with
    # ``create_all`` so fresh DBs got them, but DBs created in Phase A
    # (before the Plaid model landed) miss them and any SELECT on accounts
    # explodes with "no such column: plaid_item_id". A unique index on
    # plaid_account_id is created separately below in _POST_ADDITION_INDEXES
    # since SQLite ALTER TABLE can't add UNIQUE/INDEX in one step.
    ("accounts", "plaid_item_id", "INTEGER REFERENCES plaid_items(id)"),
    ("accounts", "plaid_account_id", "VARCHAR(64)"),
    # Budget refactor — replaced year+month INT pair with month_start DATE
    # (one column, real date arithmetic). Old columns left in place for
    # safety; backfilled below from year/month if present.
    ("budgets", "month_start", "DATE"),
    # Phase 2 polish — per-rule hit counters so the rules-management UI
    # can surface dead-weight rules + confirm which rules carry the load
    # against real-world Plaid data. Default 0 so existing rules don't
    # appear inflated.
    ("rules", "hit_count", "INTEGER NOT NULL DEFAULT 0"),
    ("rules", "last_hit_at", "DATETIME"),
    # Phase 6 — track which 50/75/100% threshold has already fired for
    # each goal so the milestone-checker emits each notification at most
    # once per goal. Default 0 keeps existing goals from being treated
    # as "already at 100%" on first run after migration.
    ("goals", "last_milestone_pct", "INTEGER NOT NULL DEFAULT 0"),
    # Phase F.2 — replace boolean proof_required with a 3-state enum.
    # The legacy boolean column stays in place; this is the new source of truth.
    (
        "legal_claims",
        "proof_status",
        "VARCHAR(20) NOT NULL DEFAULT 'unknown'",
    ),
    # Settlemate-inspired state filtering — comma-separated list of 2-char
    # state codes (e.g. "CA,FL,TX") or "nationwide". Defaults to nationwide
    # so existing rows immediately become visible under the All-states tab
    # without losing them.
    (
        "legal_claims",
        "state_eligibility",
        "VARCHAR(120) NOT NULL DEFAULT 'nationwide'",
    ),
    # Phase 10 Slice E — canonical product FKs. Both nullable so existing
    # rows survive the migration; the canonicalizer fills them in on its
    # next run. SQLite ignores REFERENCES on ALTER TABLE so we don't
    # bother declaring the foreign key here — the constraint only
    # matters at create-table time, which fresh DBs hit through ORM.
    ("receipt_items", "canonical_product_id", "INTEGER"),
    ("recurring_purchases", "canonical_product_id", "INTEGER"),
    # Phase B — extend Subscription with type/confidence/price-tracking columns.
    (
        "subscriptions",
        "subscription_type",
        "VARCHAR(20) NOT NULL DEFAULT 'unknown'",
    ),
    ("subscriptions", "confidence_score", "REAL"),
    ("subscriptions", "is_user_confirmed", "INTEGER NOT NULL DEFAULT 0"),
    ("subscriptions", "last_amount_cents", "INTEGER"),
    ("subscriptions", "prior_amount_cents", "INTEGER"),
    ("subscriptions", "price_change_date", "DATE"),
    ("subscriptions", "n_occurrences", "INTEGER"),
    ("subscriptions", "cadence_label", "VARCHAR(20)"),
    ("subscriptions", "is_variable_amount", "INTEGER NOT NULL DEFAULT 0"),
    # Phase F — composite-charge unmasking. is_composite flags aggregator
    # parents (Apple App Store, Google Play, PayPal, Patreon, Amazon S&S);
    # parent_subscription_id is the self-FK that links children to their
    # parent. Both nullable / default-false so existing rows survive the
    # migration and the auto-tagger fills them in on next detection run.
    ("subscriptions", "is_composite", "INTEGER NOT NULL DEFAULT 0"),
    ("subscriptions", "parent_subscription_id", "INTEGER REFERENCES subscriptions(id)"),
    # Phase D — extend Goal with kind/priority/current/status/debt link.
    # Existing goal rows (if any) default to general_savings priority 5 active —
    # safe baseline that puts them in the savings bucket without surfacing as
    # a top suggestion.
    ("goals", "kind", "VARCHAR(20) NOT NULL DEFAULT 'general_savings'"),
    ("goals", "current_amount_cents", "INTEGER NOT NULL DEFAULT 0"),
    ("goals", "priority", "INTEGER NOT NULL DEFAULT 5"),
    ("goals", "status", "VARCHAR(20) NOT NULL DEFAULT 'active'"),
    ("goals", "linked_debt_account_id", "INTEGER"),
    ("goals", "updated_at", "DATETIME"),
    # Card-benefits manual override — Plaid often returns generic
    # "CREDIT CARD" as the account name, which the auto-matcher in
    # benefits/service.py can't bind to the catalog. The user picks a
    # profile name here on the Connections panel; the matcher honors it
    # before falling through to fuzzy matching by name.
    ("accounts", "card_profile_override", "VARCHAR(120)"),
    # One-time-spend flag on Transaction. INTEGER 0/1 (SQLite bool).
    # NOT NULL DEFAULT 0 so every existing row is treated as recurring
    # spend until the user explicitly flags it.
    ("transactions", "is_one_time", "INTEGER NOT NULL DEFAULT 0"),
]


# Post-add backfill statements. Run once after the column has been added,
# in the same transaction. Idempotent — they're WHERE-guarded so running
# them on subsequent boots is a no-op.
#
# Format: (table, column-that-must-have-just-been-added, SQL statement)
# We only run the SQL if the column was added in *this* invocation,
# so a long-running deployment doesn't re-run them every boot.
_POST_ADD_BACKFILLS: list[tuple[str, str, str]] = [
    (
        "legal_claims",
        "proof_status",
        # Migrate any pre-existing rows that were created under the old
        # boolean schema. ``proof_required`` may not exist if this is a
        # brand-new DB — guarded by a separate column-existence check below.
        "UPDATE legal_claims SET proof_status = "
        "CASE WHEN proof_required = 1 THEN 'required' ELSE 'not_required' END "
        "WHERE proof_status = 'unknown' AND proof_required IS NOT NULL",
    ),
    (
        "budgets",
        "month_start",
        # Carry forward the old (year, month) int pair into the new
        # month_start DATE. Skipped on brand-new DBs where year/month
        # don't exist (the apply loop catches the OperationalError).
        "UPDATE budgets SET month_start = "
        "printf('%04d-%02d-01', year, month) "
        "WHERE month_start IS NULL",
    ),
]


def apply_auto_migrations(engine: Engine) -> dict[str, list[str]]:
    """Apply any missing additive columns. Returns a report keyed by table.

    Report shape: ``{"accounts": ["statement_close_day", ...]}`` — only
    tables that received additions appear. Useful for logging on startup.

    After columns are added, runs any matching ``_POST_ADD_BACKFILLS`` so
    enum/state migrations can move data from old columns to new ones in a
    single transaction.
    """
    report: dict[str, list[str]] = {}
    with engine.begin() as conn:
        # Cache table_info per table to avoid repeated PRAGMA calls
        _table_cache: dict[str, set[str]] = {}

        def _columns(table: str) -> set[str]:
            if table not in _table_cache:
                rows = conn.exec_driver_sql(
                    f"PRAGMA table_info({table})"
                ).fetchall()
                # PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
                _table_cache[table] = {row[1] for row in rows}
            return _table_cache[table]

        # 1) Add missing columns
        for table, column, sql_type in _COLUMN_ADDITIONS:
            existing = _columns(table)
            if column in existing:
                continue
            # ADD COLUMN is safe in SQLite — it doesn't rewrite the table.
            conn.exec_driver_sql(
                f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"
            )
            existing.add(column)
            report.setdefault(table, []).append(column)

        # 2) Run backfill statements only for columns we just added in this
        #    invocation — keeps boots fast on stable schemas.
        added_keys = {(t, c) for t, cols in report.items() for c in cols}
        for table, column, sql in _POST_ADD_BACKFILLS:
            if (table, column) not in added_keys:
                continue
            try:
                conn.exec_driver_sql(sql)
            except Exception as e:  # noqa: BLE001 — log + keep going
                # Most likely cause: a column the backfill references
                # doesn't exist (brand-new DB without the legacy column).
                # That's fine — the new column already has a sane default.
                report.setdefault(f"{table}!", []).append(
                    f"backfill skipped ({column}): {e}"
                )
    return report
