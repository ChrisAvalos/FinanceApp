"""Seed the database with a sensible category taxonomy and common-merchant rules.

Safe to run multiple times — upserts by slug/name.
"""
from __future__ import annotations

from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from finance_app.db.models import Base, Category, Rule
from finance_app.db.session import SessionLocal, engine

# Taxonomy: (slug, name, parent_slug, is_discretionary)
CATEGORY_SEED: list[tuple[str, str, str | None, bool]] = [
    # Essentials
    ("housing", "Housing", None, False),
    ("housing.rent_mortgage", "Rent / Mortgage", "housing", False),
    ("housing.utilities", "Utilities", "housing", False),
    ("housing.internet", "Internet", "housing", False),
    ("housing.home_improvement", "Home Improvement", "housing", True),
    ("food", "Food", None, False),
    ("food.groceries", "Groceries", "food", False),
    ("food.restaurants", "Restaurants", "food", True),
    ("food.coffee", "Coffee", "food", True),
    ("food.delivery", "Delivery", "food", True),
    ("transport", "Transport", None, False),
    ("transport.gas", "Gas", "transport", False),
    ("transport.rideshare", "Rideshare", "transport", True),
    ("transport.public_transit", "Public Transit", "transport", False),
    ("transport.car_payment", "Car Payment", "transport", False),
    ("transport.insurance", "Auto Insurance", "transport", False),
    ("transport.maintenance", "Auto Maintenance", "transport", False),
    ("transport.parking", "Parking / Tolls", "transport", False),
    # Health
    ("health", "Health", None, False),
    ("health.medical", "Medical", "health", False),
    ("health.pharmacy", "Pharmacy", "health", False),
    ("health.fitness", "Fitness", "health", True),
    # Subscriptions & media
    ("subscriptions", "Subscriptions", None, True),
    ("subscriptions.streaming", "Streaming", "subscriptions", True),
    ("subscriptions.software", "Software / SaaS", "subscriptions", True),
    ("subscriptions.news", "News / Magazines", "subscriptions", True),
    # Shopping
    ("shopping", "Shopping", None, True),
    ("shopping.online", "Online", "shopping", True),
    ("shopping.clothing", "Clothing", "shopping", True),
    ("shopping.electronics", "Electronics", "shopping", True),
    ("shopping.household", "Household", "shopping", True),
    # Personal / lifestyle
    ("personal", "Personal", None, True),
    ("personal.entertainment", "Entertainment", "personal", True),
    ("personal.travel", "Travel", "personal", True),
    ("personal.gifts", "Gifts", "personal", True),
    ("personal.pets", "Pets", "personal", True),
    # Financial
    ("financial", "Financial", None, False),
    ("financial.transfer", "Transfer", "financial", False),
    ("financial.fees", "Fees", "financial", False),
    ("financial.interest", "Interest", "financial", False),
    ("financial.savings", "Savings Contribution", "financial", False),
    ("financial.investment", "Investment Contribution", "financial", False),
    ("financial.payment", "Credit Card Payment", "financial", False),
    # Income
    ("income", "Income", None, False),
    ("income.salary", "Salary", "income", False),
    ("income.interest", "Interest Earned", "income", False),
    ("income.refund", "Refund", "income", False),
    ("income.other", "Other Income", "income", False),
    # Catch-all
    ("other", "Other", None, True),
    ("uncategorized", "Uncategorized", None, True),
]


def ensure_categories(db: Session) -> dict[str, Category]:
    existing = {c.slug: c for c in db.query(Category).all()}
    by_slug: dict[str, Category] = dict(existing)

    # Two passes — parents first
    for slug, name, parent_slug, is_disc in CATEGORY_SEED:
        if parent_slug is None and slug not in by_slug:
            c = Category(slug=slug, name=name, parent_id=None, is_discretionary=is_disc)
            db.add(c)
            by_slug[slug] = c
    db.flush()

    for slug, name, parent_slug, is_disc in CATEGORY_SEED:
        if parent_slug is not None and slug not in by_slug:
            parent = by_slug.get(parent_slug)
            c = Category(
                slug=slug,
                name=name,
                parent_id=parent.id if parent else None,
                is_discretionary=is_disc,
            )
            db.add(c)
            by_slug[slug] = c
    db.flush()
    return by_slug


def load_seed_rules(db: Session, categories: dict[str, Category]) -> None:
    """Load seed rules from YAML. Idempotent — matches by (name, is_seed=True)."""
    path = Path(__file__).parent.parent / "categorization" / "seed_rules.yaml"
    if not path.exists():
        return
    # Explicit UTF-8 — seed YAML contains em-dashes and accented merchant
    # names. Default Path.read_text() uses OS locale (cp1252 on Windows).
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or []

    existing_seed = {r.name: r for r in db.query(Rule).filter(Rule.is_seed.is_(True)).all()}

    for rule_data in data:
        name = rule_data["name"]
        cat_slug = rule_data.get("category")
        cat = categories.get(cat_slug) if cat_slug else None
        if name in existing_seed:
            r = existing_seed[name]
            r.pattern = rule_data["pattern"]
            r.is_regex = rule_data.get("is_regex", False)
            r.category_id = cat.id if cat else None
            r.priority = rule_data.get("priority", 100)
        else:
            db.add(Rule(
                name=name,
                pattern=rule_data["pattern"],
                is_regex=rule_data.get("is_regex", False),
                category_id=cat.id if cat else None,
                priority=rule_data.get("priority", 100),
                is_seed=True,
                is_active=True,
            ))


def seed_all() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        cats = ensure_categories(db)
        load_seed_rules(db, cats)
        db.commit()
    print(f"Seeded {len(CATEGORY_SEED)} categories and refreshed seed rules.")


if __name__ == "__main__":
    seed_all()
