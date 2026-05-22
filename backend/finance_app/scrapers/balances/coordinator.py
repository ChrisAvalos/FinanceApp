"""Balance-scraper coordinator — Sprint 43.

Runs every registered balance scraper, upserts the synthetic Account
rows (one per scraped product), and writes a fresh BalanceSnapshot
per balance. Symmetric to the offers and credit-score coordinators.

Why centralized
---------------
Each individual scraper just returns ``list[ScrapedBalance]``. The
coordinator owns the DB writes so the Playwright code stays
side-effect-free and unit-testable. It also handles the Account-
creation logic (one synthetic row per site+label combo) and the
sanity-skip for products already covered by Plaid (e.g. Albert Cash).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Account,
    AccountType,
    BalanceSnapshot,
    IngestSource,
    Institution,
    InstitutionKind,
)

from .albert import AlbertScraper
from .base import AuthStateMissing, BalanceScraperBase, ScrapedBalance

logger = logging.getLogger(__name__)


# Add new scraper classes here. The site_key on each is the dispatch
# key the bootstrap command uses too — they must match.
_SCRAPER_REGISTRY: list[BalanceScraperBase] = [
    AlbertScraper(),
]


# Site-specific "don't write a balance for this account_type — Plaid
# already has it" rules. Keeps us from clobbering Plaid's fresh data
# with our scraper's older read.
_SKIP_OVERLAPS: dict[str, set[str]] = {
    # Albert Cash is the one product Plaid covers — let Plaid stay
    # authoritative there. We still write Savings and Investing.
    "albert": {"Albert Cash", "Albert Instant"},
}


@dataclass
class ScraperRunResult:
    """What happened on a single coordinator pass."""
    sites_attempted: int = 0
    sites_succeeded: int = 0
    sites_auth_missing: list[str] = field(default_factory=list)
    sites_failed: list[tuple[str, str]] = field(default_factory=list)
    balances_written: int = 0
    accounts_created: int = 0

    def as_dict(self) -> dict:
        return {
            "sites_attempted": self.sites_attempted,
            "sites_succeeded": self.sites_succeeded,
            "sites_auth_missing": list(self.sites_auth_missing),
            "sites_failed": [
                {"site": s, "error": e} for s, e in self.sites_failed
            ],
            "balances_written": self.balances_written,
            "accounts_created": self.accounts_created,
        }


# ---------------------------------------------------------------------
#  Persistence helpers
# ---------------------------------------------------------------------


def _account_type_for(label: str) -> AccountType:
    """Coerce the scraper's string `account_type` to our enum.

    The scraper sends strings from a small whitelist (savings,
    investment, checking, other). Anything unrecognized defaults to
    ``other`` so we never crash on a future scraper that yields a
    novel type — the user can re-categorize manually if needed.
    """
    try:
        return AccountType(label)
    except ValueError:
        return AccountType.other


def _ensure_institution(db: Session, name: str) -> Institution:
    """Upsert an Institution row by display name."""
    existing = db.execute(
        select(Institution).where(Institution.name == name).limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    inst = Institution(name=name, kind=InstitutionKind.bank)
    db.add(inst)
    db.flush()  # populate inst.id without a full commit
    return inst


def _ensure_account(
    db: Session,
    *,
    institution: Institution,
    label: str,
    account_type: AccountType,
) -> tuple[Account, bool]:
    """Upsert a synthetic Account keyed on (institution, name). Returns
    (account, created) — caller increments accounts_created when True.

    We deliberately store ``mask=None`` for these scraper-fed accounts
    because we don't know the underlying account number, and we want
    the UniqueConstraint(institution, name, mask) to keep the same
    row across re-runs.
    """
    existing = db.execute(
        select(Account)
        .where(Account.institution_id == institution.id)
        .where(Account.name == label)
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        return existing, False
    acct = Account(
        institution_id=institution.id,
        name=label,
        account_type=account_type,
        mask=None,
        currency="USD",
        is_active=True,
        notes="Scraped balance — Playwright (see scrapers/balances).",
    )
    db.add(acct)
    db.flush()
    return acct, True


def _write_snapshot(
    db: Session, *, account: Account, balance_cents: int, scraped: ScrapedBalance,
) -> None:
    """Append a BalanceSnapshot AND refresh the Account-side cache.

    Mirrors :func:`finance_app.networth.service.log_manual_balance` —
    that path is for explicit user entry; this is the scraper path,
    but they target the same tables. We use ``source=manual`` because
    the snapshot is end-of-day-equivalent (no transaction history
    backing it) and the rest of the system treats manual + scraper
    rows identically for reporting.
    """
    # One snapshot per (account, day, source=manual). Re-running the
    # scraper today overwrites the same row rather than appending,
    # which avoids polluting the history chart with redundant points.
    existing = db.execute(
        select(BalanceSnapshot)
        .where(BalanceSnapshot.account_id == account.id)
        .where(BalanceSnapshot.as_of == scraped.as_of)
        .where(BalanceSnapshot.source == IngestSource.manual)
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        existing.balance_cents = balance_cents
    else:
        db.add(
            BalanceSnapshot(
                account_id=account.id,
                as_of=scraped.as_of,
                balance_cents=balance_cents,
                available_cents=None,
                source=IngestSource.manual,
            )
        )
    account.current_balance_cents = balance_cents


# ---------------------------------------------------------------------
#  Public entry point
# ---------------------------------------------------------------------


def run_scrapers(
    db: Session,
    *,
    scrapers: Iterable[BalanceScraperBase] | None = None,
) -> ScraperRunResult:
    """Run every registered balance scraper and persist results.

    Pass an explicit ``scrapers`` iterable to override the registry
    (tests, single-site runs from the API). Otherwise we walk the
    package-level ``_SCRAPER_REGISTRY``.
    """
    targets = list(scrapers) if scrapers is not None else _SCRAPER_REGISTRY
    result = ScraperRunResult()

    for scraper in targets:
        result.sites_attempted += 1
        try:
            balances = scraper.run()
        except AuthStateMissing as exc:
            logger.info("balance scraper %s needs auth bootstrap: %s",
                        scraper.site_key, exc)
            result.sites_auth_missing.append(scraper.site_key)
            continue
        except Exception as exc:  # noqa: BLE001 — scraper failure shouldn't crash the coordinator
            logger.exception("balance scraper %s failed", scraper.site_key)
            result.sites_failed.append((scraper.site_key, repr(exc)))
            continue

        # No balances scraped successfully — log as a soft failure
        # but don't error out. Could be a layout change or an empty
        # account list; both are recoverable on the next run.
        if not balances:
            result.sites_failed.append(
                (scraper.site_key, "scraper returned 0 balances")
            )
            continue

        institution = _ensure_institution(db, scraper.institution_name)
        skip_labels = _SKIP_OVERLAPS.get(scraper.site_key, set())
        for sb in balances:
            if sb.account_label in skip_labels:
                continue
            atype = _account_type_for(sb.account_type)
            account, created = _ensure_account(
                db,
                institution=institution,
                label=sb.account_label,
                account_type=atype,
            )
            if created:
                result.accounts_created += 1
            _write_snapshot(
                db,
                account=account,
                balance_cents=sb.balance_cents,
                scraped=sb,
            )
            result.balances_written += 1
        result.sites_succeeded += 1

    db.commit()
    logger.info(
        "balance scraper run finished — %d/%d sites, %d balances, %d new accounts",
        result.sites_succeeded, result.sites_attempted,
        result.balances_written, result.accounts_created,
    )
    return result


__all__ = ["run_scrapers", "ScraperRunResult"]
