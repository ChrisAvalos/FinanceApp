"""Setup-checklist endpoint — Sprint 46.

Returns the user's progress on each of the one-time-setup steps the
app depends on. The Overview panel renders this as a top-of-page
checklist so a first-time user sees a clear "you haven't done X yet"
list rather than blank panels with subtle "needs auth" badges.

Each item carries:
  * ``key`` — stable identifier for React keys
  * ``title`` — short label ("Connect a bank")
  * ``detail`` — current-state copy ("3 connections", "needs bootstrap")
  * ``status`` — "done" | "partial" | "todo"
  * ``action_hash`` — where to navigate to start the setup
  * ``action_label`` — CTA copy ("Set up", "Bootstrap", "Open Receipts")

The status logic is intentionally lenient — "partial" covers both
"started but not finished" (e.g. 1 of 3 receipts uploaded) AND
"works but stale" (e.g. cookies expired).
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    EmailMessage,
    PlaidItem,
    PlaidItemStatus,
    Receipt,
)
from finance_app.db.session import get_db
from finance_app.llm import get_client as _get_ollama

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/setup", tags=["setup"])


class SetupItemOut(BaseModel):
    key: str
    title: str
    detail: str
    status: str  # "done" | "partial" | "todo"
    action_hash: str
    action_label: str


class SetupStatusOut(BaseModel):
    items: list[SetupItemOut]
    completed: int       # count where status == "done"
    total: int


def _auth_state_dir() -> Path:
    """Same .auth_state dir used by every Playwright scraper.

    Defined here (rather than imported from scrapers/balances/base.py)
    to keep the import graph one-directional — the API layer
    shouldn't depend on internals of every scraper package. The path
    is stable and tested by the bootstrap scripts.
    """
    return (
        Path(__file__).resolve().parent.parent.parent / ".auth_state"
    )


@router.get("/status", response_model=SetupStatusOut)
def get_setup_status(db: Session = Depends(get_db)) -> SetupStatusOut:
    items: list[SetupItemOut] = []

    # 1. Plaid — at least one healthy item linked.
    plaid_good = db.execute(
        select(func.count(PlaidItem.id)).where(
            PlaidItem.status == PlaidItemStatus.good,
        )
    ).scalar_one() or 0
    items.append(SetupItemOut(
        key="plaid",
        title="Connect a bank via Plaid",
        detail=(
            f"{plaid_good} healthy connection" + ("s" if plaid_good != 1 else "")
            if plaid_good > 0
            else "Pulls transactions + balances. Required for almost every panel."
        ),
        status="done" if plaid_good > 0 else "todo",
        action_hash="#connections",
        action_label="Manage" if plaid_good > 0 else "Connect",
    ))

    # 2. Gmail — at least one parsed email tells us OAuth + parser
    # pipeline are working end-to-end.
    parsed_count = db.execute(
        select(func.count(EmailMessage.id)).where(
            EmailMessage.parser_outcome.is_not(None),
        )
    ).scalar_one() or 0
    items.append(SetupItemOut(
        key="gmail",
        title="Connect Gmail (read-only)",
        detail=(
            f"{parsed_count} email" + ("s" if parsed_count != 1 else "") + " parsed"
            if parsed_count > 0
            else "Pulls receipts, bank alerts, subscription confirmations."
        ),
        status="done" if parsed_count > 0 else "todo",
        action_hash="#gmail",
        action_label="Manage" if parsed_count > 0 else "Connect",
    ))

    # 3. Receipts — uploading 3+ unlocks Shopping Patterns + Cross-Store.
    receipt_count = db.execute(
        select(func.count(Receipt.id))
    ).scalar_one() or 0
    if receipt_count >= 3:
        receipt_status, receipt_detail = "done", f"{receipt_count} uploaded"
    elif receipt_count > 0:
        receipt_status = "partial"
        receipt_detail = f"{receipt_count} of 3 uploaded — need a few more to start Shopping Patterns"
    else:
        receipt_status = "todo"
        receipt_detail = "Upload 3+ to unlock Shopping Patterns + Cross-Store Deals."
    items.append(SetupItemOut(
        key="receipts",
        title="Upload receipts",
        detail=receipt_detail,
        status=receipt_status,
        action_hash="#receipts",
        action_label="Upload" if receipt_count < 3 else "Manage",
    ))

    # 4. Ollama — local LLM for chat, T3 categorization, Gmail discovery.
    try:
        ollama = _get_ollama()
        ollama_up = ollama.is_available()
    except Exception:  # noqa: BLE001 — module-import / config issues
        ollama_up = False
    items.append(SetupItemOut(
        key="ollama",
        title="Install Ollama (local LLM)",
        detail=(
            "Running — chat, smart categorization, and Gmail discovery enabled."
            if ollama_up
            else "Powers chat + smart categorization. Install + `ollama pull llama3.1`."
        ),
        status="done" if ollama_up else "todo",
        action_hash="#chat",
        action_label="Open Ask AI" if ollama_up else "Set up",
    ))

    # 5. Card-offer scrapers — Chase + Amex Offers via Playwright.
    offer_dir = _auth_state_dir()
    chase_ready = (offer_dir / "chase.json").exists()
    amex_ready = (offer_dir / "amex.json").exists()
    if chase_ready and amex_ready:
        offers_status = "done"
        offers_detail = "Chase + Amex bootstrapped"
    elif chase_ready or amex_ready:
        offers_status = "partial"
        which = "Chase" if chase_ready else "Amex"
        other = "Amex" if chase_ready else "Chase"
        offers_detail = f"{which} ✓ · {other} still needs auth"
    else:
        offers_status = "todo"
        offers_detail = "Bootstrap Chase or Amex Offers to scrape live promos."
    items.append(SetupItemOut(
        key="card_offers",
        title="Bootstrap Card Offers scrapers",
        detail=offers_detail,
        status=offers_status,
        action_hash="#offers",
        action_label="Open Offers",
    ))

    # 6. Albert balance scraper — bootstrap once.
    albert_ready = (offer_dir / "albert.json").exists()
    items.append(SetupItemOut(
        key="albert",
        title="Bootstrap Albert balance scraper",
        detail=(
            "Auth state saved — Savings + Investing balances refresh on every Scrape balances click."
            if albert_ready
            else "Optional. Lets us see Albert Savings + Investing (Plaid only sees Cash)."
        ),
        status="done" if albert_ready else "todo",
        action_hash="#connections",
        action_label="Open Connections",
    ))

    done_count = sum(1 for it in items if it.status == "done")
    return SetupStatusOut(
        items=items,
        completed=done_count,
        total=len(items),
    )
