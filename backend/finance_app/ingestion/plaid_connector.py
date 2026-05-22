"""Plaid connector.

Flow (sandbox-identical to production):

    1. client.create_link_token(user_id)           → a short-lived token the
                                                     frontend uses to bootstrap
                                                     Plaid Link.
    2. user completes Plaid Link in browser        → returns a public_token to
                                                     our frontend.
    3. client.exchange_public_token(public_token)  → our backend gets a
                                                     long-lived access_token +
                                                     Plaid item_id.
    4. We persist a PlaidItem row, then pull /accounts/get and mirror each
       Plaid account into our Account table (keyed on plaid_account_id).
    5. On every sync call we /transactions/sync with the saved cursor, apply
       added/modified/removed, and save the new cursor.

Design notes:
    * Plaid's amount sign convention is opposite ours: Plaid positive = money
      OUT of the account, Plaid negative = money IN. We flip the sign on
      ingest so the rest of the system can keep using our convention
      (negative = outflow, positive = inflow).
    * External_id = Plaid's transaction_id — it's already stable and unique.
    * sandbox is the default env; switch to "development" or "production" via
      PLAID_ENV in .env when live credentials are ready.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Callable, TypeVar

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from finance_app.config import settings
from finance_app.db.models import (
    Account,
    AccountType,
    CategorySource,
    Holding,
    IngestSource,
    Institution,
    InstitutionKind,
    PlaidItem,
    PlaidItemStatus,
    Security,
    SecurityType,
    Transaction,
    TransactionStatus,
)
from finance_app.util.txn_dedup import merchant_token

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
#  Sprint 26 — transient-error retry wrapper
# ---------------------------------------------------------------------
#
# Plaid occasionally returns 502/503/504 or surfaces network resets
# during sync. Without retry, a single transient blip flips the
# PlaidItem to status=error and the user has to manually re-link.
# Audit-day Sprint 1 fixed the UI surfacing of these errors; Sprint
# 26 prevents them from being recorded as errors at all when they're
# actually retry-able.
#
# Markers we treat as transient (per Plaid docs + observed errors):
#   * INTERNAL_SERVER_ERROR
#   * SERVICE_UNAVAILABLE
#   * PLANNED_MAINTENANCE
#   * INSTITUTION_DOWN / INSTITUTION_NOT_AVAILABLE / INSTITUTION_NOT_RESPONDING
#   * RATE_LIMIT_EXCEEDED  (rare, but retry-able with backoff)
#   * Generic 5xx / Connection / Timeout in the error string

_RETRYABLE_PLAID_CODES = (
    "INTERNAL_SERVER_ERROR",
    "SERVICE_UNAVAILABLE",
    "PLANNED_MAINTENANCE",
    "INSTITUTION_DOWN",
    "INSTITUTION_NOT_AVAILABLE",
    "INSTITUTION_NOT_RESPONDING",
    "RATE_LIMIT_EXCEEDED",
)

_RETRYABLE_HTTP_MARKERS = (
    "502 Bad Gateway", "503 Service Unavailable", "504 Gateway",
    "ReadTimeout", "ConnectTimeout", "ConnectionError",
    "Connection reset", "Connection aborted",
)


def _is_retryable_plaid_error(exc: BaseException) -> bool:
    """Decide whether a Plaid API exception is worth retrying.

    Plaid wraps errors with both an error code and an HTTP status. We
    treat both surface forms as retry-able to keep this robust against
    the various ways plaid-python may format the exception.
    """
    err_str = repr(exc)
    if any(code in err_str for code in _RETRYABLE_PLAID_CODES):
        return True
    if any(marker in err_str for marker in _RETRYABLE_HTTP_MARKERS):
        return True
    return False


_T = TypeVar("_T")


def _call_with_retry(
    fn: Callable[[], _T],
    *,
    attempts: int = 3,
    initial_delay_s: float = 1.0,
    backoff: float = 2.0,
    label: str = "plaid-call",
) -> _T:
    """Run ``fn`` with retry on transient Plaid errors.

    Logs each retry; returns the final exception unchanged if every
    attempt fails so the caller's existing error-handling still gets
    the original Plaid exception shape.
    """
    delay = initial_delay_s
    last_exc: BaseException | None = None
    for i in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — plaid wraps as ApiException
            last_exc = exc
            if i >= attempts or not _is_retryable_plaid_error(exc):
                raise
            logger.warning(
                "%s transient failure (attempt %d/%d): %r — retrying in %.1fs",
                label, i, attempts, exc, delay,
            )
            time.sleep(delay)
            delay *= backoff
    # Unreachable — the loop either returns or raises.
    assert last_exc is not None
    raise last_exc


# Required products — every linked institution must support these.
# Transactions is core; the rest stay narrow on purpose so checking-only
# banks can link without their auth flow demanding investments scope.
DEFAULT_PRODUCTS = ["transactions"]

# Optional products — Plaid will request these only when the institution
# supports them.
#   • ``investments`` lights up brokerage holdings sync for E*TRADE /
#     Schwab / Fidelity etc.
#   • ``liabilities`` exposes APRs, statement timing, payoff dates, and
#     min payments for credit cards, student loans, and mortgages —
#     covers the "how do I see my student loan balance?" use case.
DEFAULT_OPTIONAL_PRODUCTS = ["investments", "liabilities"]

DEFAULT_COUNTRY_CODES = ["US"]


# ---------------------------------------------------------------------------
# Plaid account type → our AccountType mapping. Plaid uses `type`/`subtype`
# strings like depository/checking, depository/savings, credit/credit card,
# loan/mortgage, investment/brokerage, etc.
# ---------------------------------------------------------------------------
def _map_account_type(plaid_type: str, plaid_subtype: str | None) -> AccountType:
    t, s = plaid_type.lower(), (plaid_subtype or "").lower()
    if t == "depository":
        if s == "savings":
            return AccountType.savings
        return AccountType.checking
    if t == "credit":
        return AccountType.credit_card
    if t == "loan":
        if s == "mortgage":
            return AccountType.mortgage
        return AccountType.loan
    if t == "investment" or t == "brokerage":
        return AccountType.investment
    return AccountType.other


# Plaid's `securities[].type` values are: "cash", "cryptocurrency",
# "derivative", "equity", "etf", "fixed income", "loan", "mutual fund",
# "other". Map onto our SecurityType enum, defaulting unknown to other.
_SECURITY_TYPE_MAP = {
    "equity": SecurityType.equity,
    "etf": SecurityType.etf,
    "mutual fund": SecurityType.mutual_fund,
    "fixed income": SecurityType.bond,
    "cryptocurrency": SecurityType.crypto,
    "derivative": SecurityType.option,
    "cash": SecurityType.cash,
}


def _map_security_type(plaid_type: Any) -> SecurityType:
    return _SECURITY_TYPE_MAP.get(str(plaid_type or "").lower(), SecurityType.other)


def _pick_purchase_apr(aprs: list[dict[str, Any]]) -> float | None:
    """Plaid liabilities returns multiple APRs per card (purchase /
    balance_transfer / cash_advance / promotional). For the credit-
    utilization + statement-close-optimizer math we want the purchase
    APR — that's what applies to the bulk of normal spend. Fall back
    to the first APR with a non-null percentage if no ``purchase``
    entry is present.
    """
    if not aprs:
        return None
    for a in aprs:
        if str(a.get("apr_type") or "").lower() in {"purchase_apr", "purchase"}:
            v = a.get("apr_percentage")
            if v is not None:
                return float(v)
    for a in aprs:
        v = a.get("apr_percentage")
        if v is not None:
            return float(v)
    return None


def _coerce_date(raw: Any) -> date | None:
    """Parse a Plaid date — usually ISO ``YYYY-MM-DD`` strings, but the
    plaid-python SDK sometimes hands back ``datetime.date`` objects
    after to_dict(). Be defensive on both shapes.
    """
    if raw is None:
        return None
    if isinstance(raw, date) and not isinstance(raw, datetime):
        return raw
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, str):
        try:
            return datetime.strptime(raw[:10], "%Y-%m-%d").date()
        except ValueError:
            return None
    return None


def _grants_product(granted_products: str | None, product: str) -> bool:
    """Whether ``product`` is in the comma-separated ``granted_products`` list.

    PlaidItem.granted_products is a string we set at register-time; we
    treat the absence of an "investments" entry as definitive (the link
    flow either granted it or didn't). Whitespace-tolerant; case-folded.
    """
    if not granted_products:
        return False
    target = product.strip().lower()
    return any(p.strip().lower() == target for p in granted_products.split(","))


# ---------------------------------------------------------------------------
# Thin wrapper around plaid-python so tests/smoke can monkey-patch easily.
# ---------------------------------------------------------------------------

@dataclass
class ExchangeResult:
    access_token: str
    item_id: str


class PlaidClient:
    """Thin facade over plaid-python so callers don't import plaid.* directly.

    Construction is lazy — the plaid SDK is only imported when we actually
    instantiate this, so the rest of the app still works if plaid-python
    isn't installed (e.g. in CI that doesn't need Plaid).
    """

    def __init__(
        self,
        client_id: str | None = None,
        secret: str | None = None,
        env: str | None = None,
    ):
        from plaid import ApiClient, Configuration  # noqa: PLC0415
        from plaid.api import plaid_api  # noqa: PLC0415

        env = env or settings.plaid_env or "sandbox"
        host_map = {
            "sandbox": "https://sandbox.plaid.com",
            "development": "https://development.plaid.com",
            "production": "https://production.plaid.com",
        }
        host = host_map.get(env, host_map["sandbox"])
        config = Configuration(
            host=host,
            api_key={
                "clientId": client_id or settings.plaid_client_id,
                "secret": secret or settings.plaid_secret,
            },
        )
        self._api = plaid_api.PlaidApi(ApiClient(config))
        self._env = env

    # --- Link token / exchange ---

    def create_link_token(self, user_id: str, client_name: str = "Finance App") -> str:
        """Create a short-lived link_token for the frontend Plaid Link flow.

        ``products`` is the must-support list — every linked institution
        has to satisfy it. We only require ``transactions`` so that pure
        depository banks link cleanly.

        ``optional_products`` is the maybe-support list — Plaid grants
        them when the institution supports them and silently skips
        otherwise. ``investments`` is here so brokerages (E*TRADE,
        Schwab, Fidelity) also sync holdings without forcing the
        permission on a checking-only link.
        """
        from plaid.model.country_code import CountryCode  # noqa: PLC0415
        from plaid.model.link_token_create_request import LinkTokenCreateRequest  # noqa: PLC0415
        from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser  # noqa: PLC0415
        from plaid.model.products import Products  # noqa: PLC0415

        req = LinkTokenCreateRequest(
            products=[Products(p) for p in DEFAULT_PRODUCTS],
            optional_products=[Products(p) for p in DEFAULT_OPTIONAL_PRODUCTS],
            client_name=client_name,
            country_codes=[CountryCode(c) for c in DEFAULT_COUNTRY_CODES],
            language="en",
            user=LinkTokenCreateRequestUser(client_user_id=user_id),
        )
        resp = self._api.link_token_create(req)
        return resp["link_token"]

    def create_update_link_token(
        self,
        access_token: str,
        user_id: str,
        *,
        account_selection: bool = True,
        client_name: str = "Finance App",
    ) -> str:
        """Sprint 42 — create a link_token in UPDATE MODE for an
        existing item, so the user can re-pick which accounts to share
        without un-linking and re-linking the institution.

        Why this exists
        ---------------
        Plaid Link's account-selection screen lets the user pick a
        subset of the accounts the bank exposes. If they only checked
        "Checking" the first time, the Savings / Investing accounts
        are invisible to us forever — even after sync, ``/accounts/get``
        returns only what was originally shared. Update mode with
        ``update.account_selection_enabled=true`` re-opens that picker
        so the user can add the missing accounts. After the user
        finishes in Link, the next ``/sync`` call's ``_sync_accounts``
        upserts the newly-shared rows.

        Pass ``access_token`` (NOT ``products``) per Plaid's update-mode
        contract. ``user.client_user_id`` must match what was used at
        original link time — we use the same per-user constant we
        always use for this local-first app.
        """
        from plaid.model.country_code import CountryCode  # noqa: PLC0415
        from plaid.model.link_token_create_request import LinkTokenCreateRequest  # noqa: PLC0415
        from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser  # noqa: PLC0415
        from plaid.model.link_token_create_request_update import (  # noqa: PLC0415
            LinkTokenCreateRequestUpdate,
        )

        req = LinkTokenCreateRequest(
            access_token=access_token,
            client_name=client_name,
            country_codes=[CountryCode(c) for c in DEFAULT_COUNTRY_CODES],
            language="en",
            user=LinkTokenCreateRequestUser(client_user_id=user_id),
            update=LinkTokenCreateRequestUpdate(
                account_selection_enabled=account_selection,
            ),
        )
        resp = self._api.link_token_create(req)
        return resp["link_token"]

    def exchange_public_token(self, public_token: str) -> ExchangeResult:
        """Swap a one-time public_token (from Plaid Link) for a durable access_token."""
        from plaid.model.item_public_token_exchange_request import (  # noqa: PLC0415
            ItemPublicTokenExchangeRequest,
        )

        resp = self._api.item_public_token_exchange(
            ItemPublicTokenExchangeRequest(public_token=public_token)
        )
        return ExchangeResult(access_token=resp["access_token"], item_id=resp["item_id"])

    # --- Item / accounts ---

    def accounts_get(self, access_token: str) -> list[dict[str, Any]]:
        """Return the raw accounts array for a given access_token."""
        from plaid.model.accounts_get_request import AccountsGetRequest  # noqa: PLC0415

        resp = self._api.accounts_get(AccountsGetRequest(access_token=access_token))
        return [a.to_dict() for a in resp["accounts"]]

    def item_get(self, access_token: str) -> dict[str, Any]:
        """Return metadata about the Item itself (institution_id, etc.)."""
        from plaid.model.item_get_request import ItemGetRequest  # noqa: PLC0415

        resp = self._api.item_get(ItemGetRequest(access_token=access_token))
        return resp["item"].to_dict()

    def institution_get(self, institution_id: str) -> dict[str, Any]:
        """Look up friendly institution metadata (name, logo) by Plaid institution_id."""
        from plaid.model.country_code import CountryCode  # noqa: PLC0415
        from plaid.model.institutions_get_by_id_request import (  # noqa: PLC0415
            InstitutionsGetByIdRequest,
        )

        resp = self._api.institutions_get_by_id(
            InstitutionsGetByIdRequest(
                institution_id=institution_id,
                country_codes=[CountryCode(c) for c in DEFAULT_COUNTRY_CODES],
            )
        )
        return resp["institution"].to_dict()

    # --- Transactions ---

    def transactions_sync(
        self,
        access_token: str,
        cursor: str | None,
    ) -> dict[str, Any]:
        """Incremental transactions sync. Returns raw Plaid payload.

        Plaid will paginate automatically via `has_more`; we loop until done.
        """
        from plaid.model.transactions_sync_request import TransactionsSyncRequest  # noqa: PLC0415

        added: list[dict[str, Any]] = []
        modified: list[dict[str, Any]] = []
        removed: list[dict[str, Any]] = []
        next_cursor = cursor or ""
        has_more = True

        while has_more:
            req = TransactionsSyncRequest(
                access_token=access_token,
                cursor=next_cursor or "",
            )
            resp = self._api.transactions_sync(req)
            added.extend(t.to_dict() for t in resp["added"])
            modified.extend(t.to_dict() for t in resp["modified"])
            removed.extend(t.to_dict() for t in resp["removed"])
            next_cursor = resp["next_cursor"]
            has_more = bool(resp["has_more"])

        return {
            "added": added,
            "modified": modified,
            "removed": removed,
            "next_cursor": next_cursor,
        }

    # --- Liabilities (student loans, mortgages, credit-card APR detail) ---

    def liabilities_get(self, access_token: str) -> dict[str, Any]:
        """Fetch /liabilities/get for the access_token.

        Returns the raw Plaid payload. Plaid's response splits liabilities
        by type — ``credit`` (cards), ``student``, ``mortgage`` — each
        with its own field set. Connector-side merges the relevant
        fields onto our existing ``Account`` rows.
        """
        from plaid.model.liabilities_get_request import (  # noqa: PLC0415
            LiabilitiesGetRequest,
        )

        resp = self._api.liabilities_get(LiabilitiesGetRequest(access_token=access_token))
        return {
            "accounts": [a.to_dict() for a in resp["accounts"]],
            "liabilities": resp["liabilities"].to_dict(),
        }

    # --- Investments (Phase 9.1 hookup) ---

    def investments_holdings_get(self, access_token: str) -> dict[str, Any]:
        """Fetch /investments/holdings/get for the access_token.

        Returns the raw Plaid payload with three lists: ``accounts``,
        ``securities``, ``holdings``. Idempotent — Plaid always returns
        the current portfolio snapshot, so re-runs just refresh prices /
        quantities. Coordinator side handles the upsert.
        """
        from plaid.model.investments_holdings_get_request import (  # noqa: PLC0415
            InvestmentsHoldingsGetRequest,
        )

        resp = self._api.investments_holdings_get(
            InvestmentsHoldingsGetRequest(access_token=access_token)
        )
        return {
            "accounts": [a.to_dict() for a in resp["accounts"]],
            "securities": [s.to_dict() for s in resp["securities"]],
            "holdings": [h.to_dict() for h in resp["holdings"]],
        }

    # --- Sandbox helpers (for smoke test + dev) ---

    def sandbox_public_token_create(
        self,
        institution_id: str = "ins_109508",  # First Platypus Bank (sandbox demo)
        products: list[str] | None = None,
    ) -> str:
        """Sandbox-only: mint a ready-to-exchange public_token without Plaid Link.

        Useful for automated tests and scripted demos. Fails outside sandbox.
        """
        from plaid.model.products import Products  # noqa: PLC0415
        from plaid.model.sandbox_public_token_create_request import (  # noqa: PLC0415
            SandboxPublicTokenCreateRequest,
        )

        req = SandboxPublicTokenCreateRequest(
            institution_id=institution_id,
            initial_products=[Products(p) for p in (products or DEFAULT_PRODUCTS)],
        )
        resp = self._api.sandbox_public_token_create(req)
        return resp["public_token"]


# ---------------------------------------------------------------------------
# Connector — orchestrates the DB side of things using a PlaidClient.
# Pattern mirrors the CSV Importer ABC: a `run`-style entry point that produces
# an IngestBatch and inserts normalized transactions.
# ---------------------------------------------------------------------------

class PlaidConnector:
    source = IngestSource.plaid

    def __init__(self, db: Session, client: PlaidClient | None = None):
        self.db = db
        self.client = client or PlaidClient()

    # --- Public entry points ---

    def create_link_token(self, user_id: str = "finance-app-local-user") -> str:
        return self.client.create_link_token(user_id)

    def create_update_link_token(
        self,
        item: PlaidItem,
        *,
        user_id: str = "finance-app-local-user",
    ) -> str:
        """Sprint 42 — wrap PlaidClient.create_update_link_token with the
        item's access_token. Used by the "Manage accounts" button on
        the Bank Connections panel.
        """
        return self.client.create_update_link_token(
            access_token=item.access_token,
            user_id=user_id,
            account_selection=True,
        )

    def register_item(self, public_token: str) -> PlaidItem:
        """Exchange a public_token and persist the resulting PlaidItem +
        mirror its accounts into our schema.

        Idempotent on plaid_item_id — calling twice with the same token just
        refreshes the access_token and account list.
        """
        ex = self.client.exchange_public_token(public_token)

        # Pull item metadata (institution_id + available products)
        item_meta = self.client.item_get(ex.access_token)
        plaid_institution_id = item_meta.get("institution_id")

        # Resolve or create our Institution row
        inst_name = "Unknown Bank"
        if plaid_institution_id:
            try:
                inst_meta = self.client.institution_get(plaid_institution_id)
                inst_name = inst_meta.get("name") or inst_name
            except Exception as exc:  # sandbox institutions may 404 — non-fatal
                logger.warning("institution_get failed: %r", exc)

        institution = (
            self.db.execute(select(Institution).where(Institution.name == inst_name))
            .scalars()
            .first()
        )
        if institution is None:
            institution = Institution(name=inst_name, kind=InstitutionKind.bank)
            self.db.add(institution)
            self.db.flush()

        # Upsert PlaidItem
        existing = (
            self.db.execute(
                select(PlaidItem).where(PlaidItem.plaid_item_id == ex.item_id)
            )
            .scalars()
            .first()
        )
        # Trust Plaid's billed_products list over our DEFAULT_PRODUCTS —
        # the link flow may have granted optional products (investments)
        # or denied requested ones depending on what the institution
        # supports. Fall back to the requested list if Plaid omits.
        billed = item_meta.get("billed_products") or item_meta.get("products") or []
        granted = [str(p) for p in billed] if billed else list(DEFAULT_PRODUCTS)

        if existing is None:
            item = PlaidItem(
                institution_id=institution.id,
                plaid_item_id=ex.item_id,
                plaid_institution_id=plaid_institution_id,
                access_token=ex.access_token,
                status=PlaidItemStatus.good,
                granted_products=",".join(granted),
            )
            self.db.add(item)
            self.db.flush()
        else:
            existing.access_token = ex.access_token
            existing.status = PlaidItemStatus.good
            existing.last_error = None
            existing.granted_products = ",".join(granted)
            item = existing

        # Mirror accounts
        self._sync_accounts(item)

        # Liabilities: pull APR / statement-close timing on the first link
        # too, not just on the next manual Sync. Without this, the Credit
        # panel's "Last reported" and "Close in" columns stay blank until
        # the user clicks Sync — which is confusing because the Net Worth
        # panel already shows the card balance from _sync_accounts above.
        # Best-effort: if Chase declined the liabilities product, this is
        # a no-op; if the call errors, we log and continue rather than
        # failing the link.
        if _grants_product(item.granted_products, "liabilities"):
            try:
                self.sync_liabilities(item)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "sync_liabilities failed during register_item for %s",
                    item.plaid_item_id,
                )

        self.db.commit()
        return item

    def _sync_accounts(self, item: PlaidItem) -> None:
        """Pull /accounts/get and upsert our Account table.

        Lookup strategy (matters for re-linking the same institution after
        a previous DELETE /plaid/items/{id}):

          1. Match by ``plaid_account_id`` — this is Plaid's stable
             per-Item account identifier. New accounts on a fresh Item
             will have a new id, so this misses on re-link.
          2. Fall back to natural key ``(institution_id, name, mask)``
             — that triple is what our UNIQUE constraint protects, and
             is what would otherwise blow up with an IntegrityError on
             INSERT. If we find a row via this key, *adopt* it onto
             the new Item by updating plaid_account_id + plaid_item_id
             rather than inserting a duplicate.

        The fallback is what makes a delete-then-re-link cycle work
        idempotently — without it, orphaned account rows from the
        previous connection collide with the new ones.
        """
        plaid_accounts = self.client.accounts_get(item.access_token)
        for pa in plaid_accounts:
            plaid_account_id = pa["account_id"]
            existing = (
                self.db.execute(
                    select(Account).where(Account.plaid_account_id == plaid_account_id)
                )
                .scalars()
                .first()
            )
            # Plaid shape: type/subtype are enum objects post-to_dict; stringify defensively.
            plaid_type = str(pa.get("type") or "")
            plaid_subtype = str(pa.get("subtype") or "") if pa.get("subtype") else None
            mapped_type = _map_account_type(plaid_type, plaid_subtype)
            display_name = pa.get("name") or pa.get("official_name") or "Plaid account"
            mask = pa.get("mask")
            balances = pa.get("balances") or {}

            # Natural-key fallback: if we didn't find by plaid_account_id,
            # try (institution_id, name, mask). This catches orphan rows
            # left behind by a prior DELETE /plaid/items/{id} that didn't
            # cascade — without this, the INSERT below would explode on
            # uq_account_inst_name_mask. We adopt the orphan onto the new
            # Item by clearing its old plaid_account_id and re-pointing it.
            if existing is None:
                existing = (
                    self.db.execute(
                        select(Account).where(
                            Account.institution_id == item.institution_id,
                            Account.name == display_name,
                            Account.mask == mask,
                        )
                    )
                    .scalars()
                    .first()
                )
                if existing is not None:
                    logger.info(
                        "Adopting orphan account id=%s (%s ····%s) onto new Plaid item %s",
                        existing.id, display_name, mask, item.plaid_item_id,
                    )
                    existing.plaid_account_id = plaid_account_id

            # Credit limit (only meaningful for credit-card accounts)
            credit_limit = balances.get("limit")
            credit_limit_cents = (
                int(round(credit_limit * 100)) if credit_limit is not None else None
            )

            # Current balance. Plaid returns ``balances.current`` as a
            # positive float for both deposit accounts ($1,234.56 in
            # checking) and liability accounts ($812.40 owed on a card).
            # In our schema we want assets positive and liabilities
            # negative so net-worth math is just a sum across accounts.
            # ``balances.available`` is the alternative for depository
            # accounts when ``current`` is missing or pending.
            raw_balance = balances.get("current")
            if raw_balance is None:
                raw_balance = balances.get("available")
            current_balance_cents: int | None = None
            if raw_balance is not None:
                cents = int(round(float(raw_balance) * 100))
                if mapped_type in (
                    AccountType.credit_card,
                    AccountType.loan,
                    AccountType.mortgage,
                ):
                    # Plaid reports balances on liability accounts as the
                    # positive amount owed — flip to negative so it's a
                    # liability in our accounting.
                    current_balance_cents = -abs(cents)
                else:
                    current_balance_cents = cents

            if existing is None:
                self.db.add(
                    Account(
                        institution_id=item.institution_id,
                        name=display_name,
                        account_type=mapped_type,
                        mask=mask,
                        plaid_item_id=item.id,
                        plaid_account_id=plaid_account_id,
                        credit_limit_cents=credit_limit_cents,
                        current_balance_cents=current_balance_cents,
                    )
                )
            else:
                existing.name = display_name
                existing.account_type = mapped_type
                existing.mask = mask
                existing.plaid_item_id = item.id
                if credit_limit_cents is not None:
                    existing.credit_limit_cents = credit_limit_cents
                if current_balance_cents is not None:
                    existing.current_balance_cents = current_balance_cents
        self.db.flush()

    # --- Sync transactions ---

    def sync_transactions(self, item: PlaidItem) -> dict[str, int]:
        """Run /transactions/sync for one item and upsert into our Transaction table.

        Returns {"added": n, "modified": n, "removed": n, "cursor_advanced": bool}.

        Also re-runs ``_sync_accounts`` so that balances + credit limits
        refresh on every Sync click. Without this, balances only update
        at the moment of linking — which means net-worth and credit-
        utilization stayed frozen between syncs. One extra HTTP call per
        sync but the data is much more useful.
        """
        # Refresh accounts (balances + limits) on every sync. Best-effort
        # — if Plaid's accounts/get errors, we don't want it to block the
        # transactions-sync that follows.
        try:
            self._sync_accounts(item)
        except Exception:  # noqa: BLE001
            logger.exception("accounts refresh failed for item %s", item.plaid_item_id)

        # Refresh liabilities (APR, payoff date, statement timing) on
        # every sync too — same reasoning as accounts. Skips silently
        # if the item didn't grant the liabilities product.
        if _grants_product(item.granted_products, "liabilities"):
            try:
                self.sync_liabilities(item)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "liabilities refresh failed for item %s", item.plaid_item_id,
                )

        result = {"added": 0, "modified": 0, "removed": 0, "cursor_advanced": 0}

        # Make a stable per-plaid-account → our account_id lookup for this item
        account_lookup = {
            a.plaid_account_id: a.id
            for a in self.db.execute(
                select(Account).where(Account.plaid_item_id == item.id)
            )
            .scalars()
            .all()
            if a.plaid_account_id
        }

        try:
            # Sprint 26 — wrap in retry-with-backoff so a 502/503 blip
            # doesn't flip the item to error and force a re-link.
            sync = _call_with_retry(
                lambda: self.client.transactions_sync(
                    item.access_token, item.transactions_cursor,
                ),
                label=f"plaid.transactions_sync({item.institution.name if item.institution else item.plaid_institution_id})",
            )
        except Exception as exc:
            item.status = PlaidItemStatus.error
            item.last_error = f"{exc!r}"
            self.db.commit()
            raise

        # Process REMOVED first so the session never holds dirty ORM objects
        # for rows we're about to bulk-delete. Without this ordering, an
        # earlier _upsert_txn call could load a Transaction into the
        # identity map (via the fuzzy-dedup SELECT), Plaid's removed list
        # then deletes the underlying row, and the next autoflush tries
        # to UPDATE the orphan → StaleDataError ("expected to update N
        # rows; 0 were matched") which then poisons the session with
        # PendingRollbackError. synchronize_session='fetch' selects
        # matching ids before delete and expunges them from the session,
        # which is the safe choice when we can't be sure the predicate
        # is evaluable client-side (it's not — uses an Enum column).
        for t in sync["removed"]:
            removed_id = t.get("transaction_id")
            if removed_id:
                self.db.query(Transaction).filter(
                    Transaction.source == IngestSource.plaid,
                    Transaction.external_id == removed_id,
                ).delete(synchronize_session="fetch")
                result["removed"] += 1
        # Flush deletes before we start mutating fuzzy-matched rows so
        # the next SELECT in _upsert_txn sees a clean slate.
        self.db.flush()

        for t in sync["added"]:
            if self._upsert_txn(item, t, account_lookup, is_modified=False):
                result["added"] += 1
        for t in sync["modified"]:
            if self._upsert_txn(item, t, account_lookup, is_modified=True):
                result["modified"] += 1

        # Advance cursor + mark last sync time
        if sync["next_cursor"] != (item.transactions_cursor or ""):
            item.transactions_cursor = sync["next_cursor"]
            result["cursor_advanced"] = 1
        item.last_synced_at = datetime.utcnow()
        item.status = PlaidItemStatus.good
        item.last_error = None
        self.db.commit()

        # Auto-categorize freshly-ingested rows. The CSV/OFX path does
        # this in api/ingest.py via CategorizationEngine.categorize_all,
        # but the Plaid path was missing the call — every Plaid row
        # was landing with category_source=unset and never getting
        # routed. That made every downstream panel (Trends, Budgets,
        # Tax export, Money-on-table by-kind aggregations) show
        # "(uncategorized)" for everything. Local import to avoid an
        # ingest→categorization circular at module load.
        if result["added"] or result["modified"]:
            try:
                from finance_app.categorization.engine import CategorizationEngine
                CategorizationEngine(self.db).categorize_all(only_unset=True)
                self.db.commit()
            except Exception:  # noqa: BLE001 — never let categorization tank a sync
                logger.exception("auto-categorization after Plaid sync failed")
                self.db.rollback()

            # Auto-detect subscriptions on freshly-ingested rows. Same
            # rationale as the categorization auto-call above: without
            # this, the Subscriptions panel + Cash Flow forecast events
            # + Overview "RECURRING · MONTHLY" hero all stay at $0 until
            # the user manually clicks Run detection. Idempotent —
            # `sync_to_db()` upserts by `key`, so running it on every
            # sync is safe (refreshes confidence + last_amount on
            # existing rows). Local import for the same circular-load
            # reason as the categorization call.
            try:
                from finance_app.subscriptions.detector import SubscriptionDetector
                SubscriptionDetector(self.db).sync_to_db()
                self.db.commit()
            except Exception:  # noqa: BLE001 — detection failure never tanks a sync
                logger.exception("auto-subscription-detect after Plaid sync failed")
                self.db.rollback()

        return result

    def _upsert_txn(
        self,
        item: PlaidItem,
        plaid_txn: dict[str, Any],
        account_lookup: dict[str, int],
        *,
        is_modified: bool,
    ) -> bool:
        account_id = account_lookup.get(plaid_txn.get("account_id"))
        if account_id is None:
            logger.warning(
                "Plaid txn %s references unknown account_id %s — skipping",
                plaid_txn.get("transaction_id"),
                plaid_txn.get("account_id"),
            )
            return False

        # Amount + sign flip: Plaid positive = money-out-of-account.
        amount = plaid_txn.get("amount")
        if amount is None:
            return False
        amount_cents = -int(round(float(amount) * 100))

        # Posted date preference: authorized_date → date.
        # Plaid returns two dates per txn: `authorized_date` (when the
        # purchase actually happened) and `date` (when the bank posted
        # it). For credit-card swipes those differ by 1-3 days — a
        # Saturday Costco run posts Monday morning. Bucketing by `date`
        # leaves Saturday systematically empty in the heatmap and
        # weekday/weekend stats. Prefer authorized_date when Plaid
        # provides it; fall back to `date` for cash/transfer rows that
        # don't have an authorization step.
        raw_date = (
            plaid_txn.get("authorized_date")
            or plaid_txn.get("date")
            or datetime.utcnow().date()
        )
        if isinstance(raw_date, str):
            raw_date = datetime.strptime(raw_date, "%Y-%m-%d").date()

        pending = bool(plaid_txn.get("pending"))
        status = TransactionStatus.pending if pending else TransactionStatus.posted
        description = plaid_txn.get("name") or plaid_txn.get("merchant_name") or ""
        external_id = plaid_txn.get("transaction_id")
        if not external_id:
            return False

        values = {
            "account_id": account_id,
            "posted_date": raw_date,
            "amount_cents": amount_cents,
            "currency": plaid_txn.get("iso_currency_code") or "USD",
            "status": status,
            "description_raw": description,
            "description_clean": plaid_txn.get("merchant_name") or None,
            "memo": None,
            "source": IngestSource.plaid,
            "external_id": external_id,
            "category_source": CategorySource.unset,
            "extra": {
                "plaid_category_id": plaid_txn.get("category_id"),
                "plaid_personal_finance_category": plaid_txn.get(
                    "personal_finance_category"
                ),
                "plaid_payment_channel": plaid_txn.get("payment_channel"),
                "plaid_item_id": item.plaid_item_id,
            },
        }

        # ----- Fuzzy-match prevention layer -----
        # The native dedup is on (source, external_id, account_id). That
        # works inside a single Plaid item but breaks when Plaid issues
        # NEW external_ids for already-synced transactions — which it
        # does on item re-link AND on pending → posted transitions. Both
        # of those scenarios silently created hundreds of duplicate rows
        # in Chris's DB before the cleanup endpoint shipped.
        #
        # To prevent recurrence: before inserting a "new" txn, check if
        # we already have one matching (account_id, posted_date,
        # amount_cents, merchant_token). If yes, treat it as the same
        # transaction — update the existing row with the new external_id
        # and refreshed fields. The merchant_token resolves both
        # "APPLE.COM/BILL CA 04/28" and "POS DEBIT APPLE.COM/BILL" to
        # "APPLE.COM/BILL", so pending-vs-posted stops creating dups.
        #
        # Risk we accept: two genuinely-distinct transactions with the
        # same account/date/amount/merchant on the same day get merged
        # (e.g. two coffee runs of the exact same amount). Rare, and the
        # alternative (silent doubling on every relink) is worse. The
        # cleanup endpoint can split them apart manually if it ever
        # actually matters to the user.
        token = merchant_token(description)
        if token:
            existing = self.db.execute(
                select(Transaction)
                .where(Transaction.account_id == account_id)
                .where(Transaction.posted_date == raw_date)
                .where(Transaction.amount_cents == amount_cents)
                .where(Transaction.source == IngestSource.plaid)
            ).scalars().all()
            for candidate in existing:
                # Skip the row that ALREADY matches on external_id —
                # that's the regular update path, handled below.
                if candidate.external_id == external_id:
                    break  # exact match exists; let the normal upsert handle it
                # Same merchant token? Then this is the same logical
                # transaction under a different external_id. Adopt the
                # new id + refresh the fields, leave categorization etc
                # intact on the existing row.
                if merchant_token(candidate.description_raw or "") == token:
                    candidate.external_id = external_id
                    candidate.posted_date = raw_date
                    candidate.amount_cents = amount_cents
                    candidate.status = status
                    candidate.description_raw = description
                    candidate.description_clean = (
                        plaid_txn.get("merchant_name") or candidate.description_clean
                    )
                    candidate.extra = values["extra"]
                    logger.info(
                        "Plaid fuzzy-dedup: reused txn id=%s for new external_id=%s "
                        "(token=%r, account=%s, date=%s, amount=%s)",
                        candidate.id, external_id, token, account_id, raw_date, amount_cents,
                    )
                    return True

        stmt = sqlite_insert(Transaction).values(**values)
        # If a row already exists with the same (source, external_id, account_id),
        # update the fields Plaid may change; otherwise insert.
        stmt = stmt.on_conflict_do_update(
            index_elements=["source", "external_id", "account_id"],
            set_={
                "posted_date": values["posted_date"],
                "amount_cents": values["amount_cents"],
                "status": values["status"],
                "description_raw": values["description_raw"],
                "description_clean": values["description_clean"],
                "extra": values["extra"],
            },
        )
        result = self.db.execute(stmt)
        return bool(result.rowcount and result.rowcount > 0)

    # --- Sync liabilities (APR, payoff date, statement timing) ---

    def sync_liabilities(self, item: PlaidItem) -> dict[str, int]:
        """Pull /liabilities/get and overlay APR / payoff / statement-timing
        fields onto our existing Account rows (no new table needed —
        the Account model already has ``apr_bps``, ``last_statement_*``,
        and ``statement_close_day`` / ``statement_due_day`` columns
        from earlier credit-ops work).

        Returns ``{"credit_updated": n, "student_updated": n,
        "mortgage_updated": n, "skipped": "<reason>"}``. ``skipped`` is
        present (and short-circuits) when the item didn't grant
        ``liabilities`` or when Plaid returns ``PRODUCT_NOT_SUPPORTED``.

        Sign / scaling notes:
          • Plaid APRs come as percentages (e.g. ``22.49``). We store
            in basis points (× 100) on ``apr_bps`` so 22.49% → 2249 bps.
          • Statement balances + dollar fields are floats; we round to
            cents the same way ``_sync_accounts`` does.
        """
        result: dict[str, Any] = {
            "credit_updated": 0,
            "student_updated": 0,
            "mortgage_updated": 0,
        }

        if not _grants_product(item.granted_products, "liabilities"):
            result["skipped"] = "liabilities not granted"
            return result

        try:
            payload = self.client.liabilities_get(item.access_token)
        except Exception as exc:  # noqa: BLE001
            err_str = repr(exc)
            if any(
                code in err_str
                for code in ("PRODUCT_NOT_SUPPORTED", "PRODUCT_NOT_READY", "NO_ACCOUNTS")
            ):
                result["skipped"] = f"plaid: {err_str[:120]}"
                return result
            raise

        liabilities = payload.get("liabilities") or {}

        # Build plaid_account_id → our Account.id lookup once.
        account_lookup = {
            a.plaid_account_id: a
            for a in self.db.execute(
                select(Account).where(Account.plaid_item_id == item.id)
            )
            .scalars()
            .all()
            if a.plaid_account_id
        }

        # ---- Credit cards: APRs, last statement, due day ----
        for card in liabilities.get("credit") or []:
            acct = account_lookup.get(card.get("account_id"))
            if acct is None:
                continue
            # Plaid sends a list of APRs — purchase / balance_transfer /
            # cash_advance / etc. We pick the purchase APR for the
            # headline credit-utilization math, falling back to the
            # first APR if no purchase entry exists.
            apr_pct = _pick_purchase_apr(card.get("aprs") or [])
            if apr_pct is not None:
                acct.apr_bps = int(round(float(apr_pct) * 100))
            last_stmt_bal = card.get("last_statement_balance")
            if last_stmt_bal is not None:
                acct.last_statement_balance_cents = int(round(float(last_stmt_bal) * 100))
            last_stmt_issue = card.get("last_statement_issue_date")
            if last_stmt_issue:
                acct.last_statement_date = _coerce_date(last_stmt_issue)
            # Plaid gives ISO statement dates; derive day-of-month for
            # the close-day optimizer's math.
            if last_stmt_issue:
                d = _coerce_date(last_stmt_issue)
                if d is not None:
                    acct.statement_close_day = d.day
            next_due = card.get("next_payment_due_date")
            if next_due:
                d = _coerce_date(next_due)
                if d is not None:
                    acct.statement_due_day = d.day
            result["credit_updated"] += 1

        # ---- Student loans: APR, payoff date, balance ----
        for loan in liabilities.get("student") or []:
            acct = account_lookup.get(loan.get("account_id"))
            if acct is None:
                continue
            apr_pct = loan.get("interest_rate_percentage")
            if apr_pct is not None:
                acct.apr_bps = int(round(float(apr_pct) * 100))
            # ``minimum_payment_amount`` and ``next_payment_due_date``
            # on student loans inform the cash-flow forecast. The
            # Account schema doesn't have a min-payment column yet, so
            # we stash the due date for now via statement_due_day.
            next_due = loan.get("next_payment_due_date")
            if next_due:
                d = _coerce_date(next_due)
                if d is not None:
                    acct.statement_due_day = d.day
            result["student_updated"] += 1

        # ---- Mortgages: APR, term, next due ----
        for mtg in liabilities.get("mortgage") or []:
            acct = account_lookup.get(mtg.get("account_id"))
            if acct is None:
                continue
            interest = mtg.get("interest_rate") or {}
            apr_pct = interest.get("percentage")
            if apr_pct is not None:
                acct.apr_bps = int(round(float(apr_pct) * 100))
            next_due = mtg.get("next_payment_due_date")
            if next_due:
                d = _coerce_date(next_due)
                if d is not None:
                    acct.statement_due_day = d.day
            result["mortgage_updated"] += 1

        item.last_synced_at = datetime.utcnow()
        self.db.commit()
        return result

    # --- Sync investments (Phase 9.1 Plaid hookup) ---

    def sync_investments(self, item: PlaidItem) -> dict[str, int]:
        """Pull /investments/holdings/get and upsert Securities + Holdings.

        Returns ``{"securities_upserted": n, "holdings_upserted": n,
        "holdings_removed": n, "skipped": "<reason>"}``. ``skipped`` is
        present (and short-circuits) when the item didn't grant
        investments, when no investment-type accounts exist locally,
        or when Plaid raises ``PRODUCT_NOT_SUPPORTED``.
        """
        result: dict[str, Any] = {
            "securities_upserted": 0,
            "holdings_upserted": 0,
            "holdings_removed": 0,
        }

        # Skip if the item didn't grant investments — the link flow makes
        # it optional, so checking-only banks legitimately won't have it.
        if not _grants_product(item.granted_products, "investments"):
            result["skipped"] = "investments not granted"
            return result

        try:
            payload = self.client.investments_holdings_get(item.access_token)
        except Exception as exc:  # noqa: BLE001 — plaid-python wraps as ApiException
            err_str = repr(exc)
            # Plaid surfaces "PRODUCT_NOT_SUPPORTED" / "PRODUCT_NOT_READY"
            # for items we asked optionally but the institution didn't
            # actually serve. Treat as a soft skip rather than an error
            # so transactions sync still gets the green check.
            if any(
                code in err_str
                for code in ("PRODUCT_NOT_SUPPORTED", "PRODUCT_NOT_READY", "NO_ACCOUNTS")
            ):
                result["skipped"] = f"plaid: {err_str[:120]}"
                return result
            raise

        plaid_accounts = payload.get("accounts") or []
        securities = payload.get("securities") or []
        holdings = payload.get("holdings") or []

        # Map plaid_account_id → our Account.id for the investment accounts
        # tied to this item. Non-investment accounts are out of scope here.
        account_lookup = {
            a.plaid_account_id: a.id
            for a in self.db.execute(
                select(Account).where(Account.plaid_item_id == item.id)
            )
            .scalars()
            .all()
            if a.plaid_account_id
        }
        # If our local schema doesn't yet have rows for the investment
        # accounts (e.g. older items linked before this hookup), pull a
        # fresh /accounts/get to mirror them in.
        plaid_inv_account_ids = {
            pa.get("account_id") for pa in plaid_accounts if pa.get("account_id")
        }
        if plaid_inv_account_ids - account_lookup.keys():
            self._sync_accounts(item)
            account_lookup = {
                a.plaid_account_id: a.id
                for a in self.db.execute(
                    select(Account).where(Account.plaid_item_id == item.id)
                )
                .scalars()
                .all()
                if a.plaid_account_id
            }

        # ---- Securities ----
        # Keyed by plaid_security_id (unique). Refreshes ticker, name,
        # latest_price, etc. on every sync.
        sec_id_by_plaid: dict[str, int] = {}
        for ps in securities:
            plaid_sec_id = ps.get("security_id")
            if not plaid_sec_id:
                continue
            existing = (
                self.db.execute(
                    select(Security).where(Security.plaid_security_id == plaid_sec_id)
                )
                .scalars()
                .first()
            )
            close_price = ps.get("close_price")
            close_price_cents = (
                int(round(float(close_price) * 100)) if close_price is not None else None
            )
            sec_type = _map_security_type(ps.get("type"))
            if existing is None:
                row = Security(
                    ticker=ps.get("ticker_symbol"),
                    name=(ps.get("name") or "Unknown").strip()[:240],
                    security_type=sec_type,
                    cusip=ps.get("cusip"),
                    isin=ps.get("isin"),
                    plaid_security_id=plaid_sec_id,
                    latest_price_cents=close_price_cents,
                    latest_price_at=datetime.utcnow() if close_price_cents is not None else None,
                )
                self.db.add(row)
                self.db.flush()
                sec_id_by_plaid[plaid_sec_id] = row.id
                result["securities_upserted"] += 1
            else:
                existing.ticker = ps.get("ticker_symbol") or existing.ticker
                existing.name = (ps.get("name") or existing.name).strip()[:240]
                existing.security_type = sec_type
                if ps.get("cusip"):
                    existing.cusip = ps.get("cusip")
                if ps.get("isin"):
                    existing.isin = ps.get("isin")
                if close_price_cents is not None:
                    existing.latest_price_cents = close_price_cents
                    existing.latest_price_at = datetime.utcnow()
                sec_id_by_plaid[plaid_sec_id] = existing.id
                result["securities_upserted"] += 1

        # ---- Holdings ----
        # Keyed by (account_id, security_id). We track the (acct, sec)
        # tuples Plaid reports so we can prune locally-stored positions
        # the user no longer holds (sold-out positions).
        seen_keys: set[tuple[int, int]] = set()
        for h in holdings:
            plaid_acct_id = h.get("account_id")
            plaid_sec_id = h.get("security_id")
            account_id = account_lookup.get(plaid_acct_id)
            security_id = sec_id_by_plaid.get(plaid_sec_id)
            if account_id is None or security_id is None:
                continue
            seen_keys.add((account_id, security_id))

            quantity = h.get("quantity") or 0
            quantity_units = int(round(float(quantity) * 10_000))  # 4 decimal places
            inst_value = h.get("institution_value")
            current_value_cents = (
                int(round(float(inst_value) * 100)) if inst_value is not None else 0
            )
            cost_basis = h.get("cost_basis")
            cost_basis_cents = (
                int(round(float(cost_basis) * 100)) if cost_basis is not None else None
            )

            existing = (
                self.db.execute(
                    select(Holding)
                    .where(Holding.account_id == account_id)
                    .where(Holding.security_id == security_id)
                )
                .scalars()
                .first()
            )
            if existing is None:
                self.db.add(
                    Holding(
                        account_id=account_id,
                        security_id=security_id,
                        quantity_units=quantity_units,
                        cost_basis_cents=cost_basis_cents,
                        current_value_cents=current_value_cents,
                        as_of=date.today(),
                    )
                )
            else:
                existing.quantity_units = quantity_units
                if cost_basis_cents is not None:
                    existing.cost_basis_cents = cost_basis_cents
                existing.current_value_cents = current_value_cents
                existing.as_of = date.today()
            result["holdings_upserted"] += 1

        # ---- Prune sold-out positions ----
        # Anything previously held in one of THIS item's investment
        # accounts that Plaid no longer reports is treated as sold.
        # Scoped to the item's accounts so we don't touch holdings the
        # user manually entered or that came from a different broker.
        if account_lookup:
            local_keys = {
                (h.account_id, h.security_id)
                for h in self.db.execute(
                    select(Holding).where(Holding.account_id.in_(account_lookup.values()))
                )
                .scalars()
                .all()
            }
            stale = local_keys - seen_keys
            for acct_id, sec_id in stale:
                self.db.query(Holding).filter(
                    Holding.account_id == acct_id,
                    Holding.security_id == sec_id,
                ).delete()
                result["holdings_removed"] += 1

        item.last_synced_at = datetime.utcnow()
        self.db.commit()
        return result

    # --- Bulk ---

    def sync_all(self) -> dict[str, Any]:
        """Iterate every good PlaidItem and sync each. Returns per-item counts.

        Each item gets transactions sync (always) plus investments sync
        (only when the item granted the ``investments`` product). The
        per-item dict contains ``txn`` and optionally ``investments``
        sub-dicts so the caller can summarize either.
        """
        items = (
            self.db.execute(
                select(PlaidItem).where(PlaidItem.status != PlaidItemStatus.error)
            )
            .scalars()
            .all()
        )
        per_item: dict[str, Any] = {}
        for item in items:
            entry: dict[str, Any] = {}
            try:
                entry["txn"] = self.sync_transactions(item)
            except Exception as exc:  # noqa: BLE001
                entry["txn"] = {"error": f"{exc!r}"}
            # Investments sync is best-effort — we don't want a brokerage
            # outage to mask a successful txn sync from the same item.
            if _grants_product(item.granted_products, "investments"):
                try:
                    entry["investments"] = self.sync_investments(item)
                except Exception as exc:  # noqa: BLE001
                    entry["investments"] = {"error": f"{exc!r}"}
            # Liabilities sync (APR, payoff dates, statement timing) —
            # also best-effort. Skips silently when not granted.
            if _grants_product(item.granted_products, "liabilities"):
                try:
                    entry["liabilities"] = self.sync_liabilities(item)
                except Exception as exc:  # noqa: BLE001
                    entry["liabilities"] = {"error": f"{exc!r}"}
            per_item[item.plaid_item_id] = entry
        return {
            "synced_at": datetime.utcnow().isoformat(),
            "items": per_item,
            "item_count": len(items),
        }


def recently_synced_items(db: Session, within: timedelta) -> list[PlaidItem]:
    """Items last synced within `within`. Useful for the scheduler to skip work."""
    cutoff = datetime.utcnow() - within
    return (
        db.execute(
            select(PlaidItem).where(
                PlaidItem.last_synced_at.isnot(None),
                PlaidItem.last_synced_at >= cutoff,
            )
        )
        .scalars()
        .all()
    )
