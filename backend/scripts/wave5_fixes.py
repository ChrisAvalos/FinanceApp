"""Wave 5 audit one-shot data fixes (2026-05-14).

Three confident data fixes from the audit:

    C. Recategorize PETER SEIMAS PH transactions from Subscriptions to Medical.
       (Confirmed by user: this is a recurring medical/therapy payment, not
       a SaaS subscription.)

    D. Mark Stock Plan (TSLA) account as inactive.
       (Confirmed by user: the account is empty/closed.)

    E. Add Self.inc credit-builder subscription ($35/mo).
       (Surfaced from Gmail receipts: account ...6689, $35 due 5/18.)

Run::

    cd backend
    .\\.venv\\Scripts\\activate
    py -m scripts.wave5_fixes

Idempotent. Re-running is safe — each step checks for the current state
before mutating.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select

from finance_app.db.models import (
    Account,
    Category,
    Subscription,
    SubscriptionStatus,
    Transaction,
)
from finance_app.db.session import SessionLocal


_PETER_DESC_HINTS = ("peter seimas", "seimas ph")


def fix_c_peter_seimas(db) -> int:
    """Move PETER SEIMAS PH transactions to the Medical category."""
    medical_cat = db.execute(
        select(Category).where(Category.name.ilike("%medical%"))
    ).scalars().first()
    if medical_cat is None:
        # Fall back to creating it — we should always have a Medical bucket.
        medical_cat = Category(name="Medical", is_discretionary=False)
        db.add(medical_cat)
        db.flush()

    target_cat_id = medical_cat.id

    candidates = db.execute(
        select(Transaction).where(Transaction.amount_cents < 0)
    ).scalars().all()

    moved = 0
    for tx in candidates:
        parts = (
            (tx.description_clean or "").lower(),
            (tx.description_raw or "").lower(),
            (tx.memo or "").lower(),
        )
        blob = " ".join(parts)
        if not any(h in blob for h in _PETER_DESC_HINTS):
            continue
        if tx.category_id == target_cat_id:
            continue
        tx.category_id = target_cat_id
        moved += 1

    # Also drop the Subscription row(s), if any, so the user doesn't keep
    # seeing it on Subscriptions panel as "active SaaS."
    subs = db.execute(select(Subscription)).scalars().all()
    sub_removed = 0
    for s in subs:
        name = (s.name or "").lower()
        if any(h in name for h in _PETER_DESC_HINTS):
            s.status = SubscriptionStatus.dismissed
            sub_removed += 1

    db.commit()
    return moved, sub_removed


def fix_d_stock_plan_inactive(db) -> int:
    """Mark Stock Plan (TSLA) — user-confirmed empty/closed."""
    stock_plan_accts = db.execute(
        select(Account).where(Account.name.ilike("%stock plan%"))
    ).scalars().all()
    flipped = 0
    for a in stock_plan_accts:
        if a.is_active:
            a.is_active = False
            flipped += 1
    if flipped:
        db.commit()
    return flipped


def fix_e_add_self_inc(db) -> bool:
    """Add Self.inc credit-builder subscription if missing.

    Wave 5 verification follow-up (2026-05-14): Self.inc operates legally
    as "Self Lender Inc" and the Plaid txn description matches that name.
    The recurring-subscription detector ALREADY picks it up as "SELF
    LENDER INC", so adding a separate "Self.inc credit builder" row is
    a duplicate. Check for BOTH name variants and skip if either exists.
    """
    existing = db.execute(
        select(Subscription).where(
            (Subscription.name.ilike("%self.inc%"))
            | (Subscription.name.ilike("%self lender%"))
        )
    ).scalars().first()
    if existing is not None:
        return False

    s = Subscription(
        name="Self.inc credit builder",
        # Stored as negative cents to match the rest of the table (outflow).
        amount_cents=-3500,  # $35.00 monthly
        cadence_days=30,
        status=SubscriptionStatus.active,
        is_user_confirmed=True,
        cadence_label="monthly",
        next_expected_date=date(2026, 5, 18),
        notes=(
            "Added 2026-05-14 from Gmail evidence (Wave 4 audit): "
            "account ...6689, $35 due 5/18. Credit-builder loan/savings hybrid."
        ),
    )
    db.add(s)
    db.commit()
    return True


def main() -> None:
    with SessionLocal() as db:
        moved, sub_removed = fix_c_peter_seimas(db)
        print(f"C. PETER SEIMAS PH — recategorized {moved} txns to Medical, "
              f"dismissed {sub_removed} subscription row(s)")

        flipped = fix_d_stock_plan_inactive(db)
        print(f"D. Stock Plan — flipped {flipped} account(s) to inactive")

        added = fix_e_add_self_inc(db)
        print(f"E. Self.inc — {'added' if added else 'already present'}")


if __name__ == "__main__":
    main()
