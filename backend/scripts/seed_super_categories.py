"""Sprint M-1: seed 8 super-group categories and parent the existing 24+ flat ones.

Why: 24+ flat categories produce unreadable donut charts. Grouping into
~8 super-groups gives a digestible top-level view; existing categories
become drillable children.

Idempotent — re-running:
  * creates super-groups only if missing,
  * re-assigns parent_id only when null (so user customizations stick),
  * never deletes or renames anything.

Run::

    cd backend
    .\\.venv\\Scripts\\activate
    py -m scripts.seed_super_categories
"""
from __future__ import annotations

from sqlalchemy import select

from finance_app.db.models import Category
from finance_app.db.session import SessionLocal


# 8 super-groups. Each tuple = (slug, name, icon, default_is_discretionary).
# `is_discretionary` matters because category-level budgets / recommenders
# read it to decide whether to recommend trimming. Super-groups inherit
# the most-common stance of their children but the actual child's flag
# stays authoritative; this is just for if/when a child has no override.
SUPER_GROUPS: list[tuple[str, str, str, bool]] = [
    ("housing", "Housing", "🏠", False),
    ("food", "Food", "🍽️", True),
    ("transportation", "Transportation", "🚗", False),
    ("entertainment", "Entertainment", "🎬", True),
    ("health", "Health", "🏥", False),
    ("shopping", "Shopping", "🛍️", True),
    ("bills", "Bills / Subscriptions", "💼", False),
    ("transfers", "Transfers / Internal", "💸", False),
]


# Mapping rules — each entry maps a substring pattern (case-insensitive)
# in a Category name to a super-group slug. Order matters: first match
# wins. Catch-all "transfers" stays last because "Transfer" / "Credit
# Card Payment" / "Uncategorized" all belong there.
NAME_PATTERN_TO_SLUG: list[tuple[str, str]] = [
    # Housing
    ("rent", "housing"),
    ("mortgage", "housing"),
    ("internet", "housing"),
    ("utilities", "housing"),
    ("utility", "housing"),
    ("water", "housing"),
    ("electric", "housing"),
    ("gas bill", "housing"),  # natural gas (utility), not auto fuel
    ("home insurance", "housing"),
    ("homeowner", "housing"),
    ("renters insurance", "housing"),
    ("household", "housing"),
    ("rent / mortgage", "housing"),
    # Food
    ("groceries", "food"),
    ("restaurant", "food"),
    ("dining", "food"),
    ("coffee", "food"),
    ("bar", "food"),
    ("takeout", "food"),
    # Transportation — note: "gas" alone is ambiguous, handled later.
    ("auto insurance", "transportation"),
    ("auto maintenance", "transportation"),
    ("parking", "transportation"),
    ("tolls", "transportation"),
    ("public transit", "transportation"),
    ("rideshare", "transportation"),
    ("uber", "transportation"),
    ("lyft", "transportation"),
    # Health
    ("medical", "health"),
    ("pharmacy", "health"),
    ("doctor", "health"),
    ("dental", "health"),
    ("vision", "health"),
    ("fitness", "health"),
    ("gym", "health"),
    # Entertainment
    ("entertainment", "entertainment"),
    ("streaming", "entertainment"),
    ("travel", "entertainment"),
    ("hotel", "entertainment"),
    ("flight", "entertainment"),
    ("news", "entertainment"),
    ("magazines", "entertainment"),
    # Shopping
    ("clothing", "shopping"),
    ("apparel", "shopping"),
    ("online", "shopping"),
    ("amazon", "shopping"),
    ("gifts", "shopping"),
    ("general merchandise", "shopping"),
    # Bills / Subscriptions
    ("software", "bills"),
    ("saas", "bills"),
    ("subscription", "bills"),
    ("phone", "bills"),
    ("mobile", "bills"),
    ("fees", "bills"),
    ("interest", "bills"),
    # Transfers / Internal (catchalls live here)
    ("transfer", "transfers"),
    ("credit card payment", "transfers"),
    ("investment contribution", "transfers"),
    ("savings", "transfers"),
    ("uncategorized", "transfers"),
]


def _slug_for_category_name(name: str) -> str | None:
    """Return the super-group slug for a category by name, or None if no
    pattern matched. Treats the disambiguous "Gas" specially: if the
    name is just "Gas" (auto fuel) we route to transportation; if it
    contains "Gas Bill" / "Natural Gas" we route to housing.
    """
    lower = name.strip().lower()
    if lower == "gas":
        return "transportation"
    if "natural gas" in lower:
        return "housing"
    for pattern, slug in NAME_PATTERN_TO_SLUG:
        if pattern in lower:
            return slug
    return None


def main() -> None:
    created = 0
    parented = 0
    skipped = 0
    unmatched: list[str] = []

    with SessionLocal() as db:
        # Phase 1: ensure each super-group exists.
        slug_to_id: dict[str, int] = {}
        for slug, name, icon, is_disc in SUPER_GROUPS:
            existing = db.execute(
                select(Category).where(Category.slug == slug)
            ).scalar_one_or_none()
            if existing is None:
                cat = Category(
                    name=name,
                    slug=slug,
                    icon=icon,
                    is_discretionary=is_disc,
                    parent_id=None,
                )
                db.add(cat)
                db.flush()
                slug_to_id[slug] = cat.id
                created += 1
            else:
                # Ensure existing super-group has correct icon & no parent
                # (in case it was created some other way).
                if existing.icon != icon:
                    existing.icon = icon
                if existing.parent_id is not None:
                    existing.parent_id = None
                slug_to_id[slug] = existing.id

        # Phase 2: assign parents to leaf categories.
        super_ids = set(slug_to_id.values())
        all_cats = db.execute(select(Category)).scalars().all()
        for cat in all_cats:
            if cat.id in super_ids:
                continue  # super-groups themselves stay top-level
            if cat.parent_id is not None:
                # Respect existing user-set parent (idempotency).
                skipped += 1
                continue
            slug = _slug_for_category_name(cat.name)
            if slug is None:
                unmatched.append(cat.name)
                continue
            cat.parent_id = slug_to_id[slug]
            parented += 1

        db.commit()

    print(f"Created super-groups:   {created}")
    print(f"Parented leaf cats:     {parented}")
    print(f"Skipped (already set):  {skipped}")
    if unmatched:
        print(f"Unmatched ({len(unmatched)}) — re-parent manually via UI:")
        for n in unmatched:
            print(f"  · {n}")


if __name__ == "__main__":
    main()
