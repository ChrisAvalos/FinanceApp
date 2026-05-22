"""Sprint M-1 cleanup: reconcile the duplicate super-groups my first
seed_super_categories run created against the existing seed taxonomy.

What went wrong:
  * `seed.py` already seeded an 11-group top-level taxonomy with slugs
    housing / food / transport / health / subscriptions / shopping /
    personal / financial / income / other / uncategorized.
  * My first run of seed_super_categories.py created 4 *new* top-level
    categories under DIFFERENT slugs:
      "Transportation" (mine) vs "Transport" (existing)
      "Entertainment" (mine) vs "Personal" → "Entertainment" child (existing)
      "Bills / Subscriptions" (mine) vs "Subscriptions" (existing)
      "Transfers / Internal" (mine) vs "Financial" (existing)
  * It also (correctly) re-used housing / food / health / shopping
    where the slugs lined up.

This script:
  1. Re-parents any leaf categories my script attached to the duplicates
     back to the *correct existing* top-level groups
     (Transportation→Transport, Entertainment→Personal, Bills→Subscriptions,
     Transfers→Financial).
  2. Deletes the 4 duplicate top-level categories.

Idempotent — if there are no duplicates, prints "Nothing to clean up."

Run::

    cd backend
    .\\.venv\\Scripts\\activate
    py -m scripts.reconcile_super_categories
"""
from __future__ import annotations

from sqlalchemy import select

from finance_app.db.models import Category
from finance_app.db.session import SessionLocal


# (dup_slug, target_existing_slug) — re-parent children of `dup_slug`
# to `target_existing_slug`, then delete the duplicate.
DUPLICATE_TO_TARGET: list[tuple[str, str]] = [
    ("transportation", "transport"),
    ("entertainment", "personal"),
    ("bills", "subscriptions"),
    ("transfers", "financial"),
]


def main() -> None:
    moved = 0
    deleted = 0
    skipped = 0

    with SessionLocal() as db:
        for dup_slug, target_slug in DUPLICATE_TO_TARGET:
            dup = db.execute(
                select(Category).where(Category.slug == dup_slug)
            ).scalar_one_or_none()
            target = db.execute(
                select(Category).where(Category.slug == target_slug)
            ).scalar_one_or_none()
            if dup is None or target is None:
                skipped += 1
                continue
            # Re-parent any children of the duplicate to the existing target.
            children = db.execute(
                select(Category).where(Category.parent_id == dup.id)
            ).scalars().all()
            for c in children:
                c.parent_id = target.id
                moved += 1
            db.flush()
            # Now safe to delete the duplicate.
            db.delete(dup)
            deleted += 1

        db.commit()

    print(f"Re-parented children:  {moved}")
    print(f"Deleted duplicates:    {deleted}")
    print(f"Skipped (not found):   {skipped}")
    if deleted == 0 and moved == 0:
        print("\nNothing to clean up. Hierarchy is already consistent.")


if __name__ == "__main__":
    main()
