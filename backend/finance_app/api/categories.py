"""Categories list endpoint."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.api.schemas import CategoryOut
from finance_app.db.models import Category, Rule
from finance_app.db.seed import ensure_categories, load_seed_rules
from finance_app.db.session import get_db

router = APIRouter(tags=["categories"])


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(db: Session = Depends(get_db)) -> list[Category]:
    return db.execute(select(Category).order_by(Category.slug)).scalars().all()


def _slugify(name: str) -> str:
    """Lowercase, collapse non-alphanumerics to hyphens. 'Wellness' -> 'wellness'."""
    s = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return s or "category"


def _unique_slug(db: Session, base: str) -> str:
    """Return ``base``, or ``base-2`` / ``base-3`` ... if it is already taken.
    Category.slug is UNIQUE — a collision would 500 on commit otherwise."""
    candidate = base
    n = 2
    while db.execute(
        select(Category.id).where(Category.slug == candidate)
    ).scalar_one_or_none() is not None:
        candidate = f"{base}-{n}"
        n += 1
    return candidate


class CategoryCreate(BaseModel):
    """Body for POST /categories — create a new spending category.

    ``slug`` is derived server-side (``parent-slug.name-slug``) so the
    caller never has to know the dotted-slug convention; the seeded
    categories all follow it (e.g. ``health.medical``).
    """
    name: str = Field(min_length=1, max_length=80)
    parent_id: int | None = None
    # Defaults to True (variable spend) — the suggestion + budget engines
    # treat discretionary categories as the ones the user can flex.
    is_discretionary: bool = True
    icon: str | None = None


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(
    body: CategoryCreate,
    db: Session = Depends(get_db),
) -> Category:
    """Create a new category.

    The hierarchy is shallow (top-level group -> leaf). The slug is
    generated from the name, prefixed with the parent's slug when a
    parent is given, and de-duplicated so the UNIQUE constraint holds.
    """
    parent: Category | None = None
    if body.parent_id is not None:
        parent = db.get(Category, body.parent_id)
        if parent is None:
            raise HTTPException(404, f"Parent category {body.parent_id} not found")

    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Category name cannot be blank")

    base_slug = _slugify(name)
    if parent is not None:
        base_slug = f"{parent.slug}.{base_slug}"
    slug = _unique_slug(db, base_slug)

    cat = Category(
        name=name,
        parent_id=body.parent_id,
        slug=slug,
        is_discretionary=body.is_discretionary,
        icon=body.icon,
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


class CategoryReparent(BaseModel):
    """Sprint M-5 (2026-05-14): update only a category's parent."""
    parent_id: int | None  # None = move to top level


@router.patch("/categories/{category_id}/parent", response_model=CategoryOut)
def reparent_category(
    category_id: int,
    body: CategoryReparent,
    db: Session = Depends(get_db),
) -> Category:
    """Move a category under a different parent (or to top-level).

    Used by the drag-and-drop "Manage categories" UI. We deliberately
    don't allow editing other fields here — slug + name are seeded and
    referenced by Rules + Transactions. Renaming would cascade in ways
    the user doesn't expect from a drag operation.

    Validations:
      * Target category must exist.
      * New parent must exist (when not None).
      * Cannot self-parent (parent_id == category_id).
      * Cannot create a cycle (new parent's ancestors must not include
        the category being moved). Since the hierarchy is shallow (2
        levels) we just walk parent chain a few hops.
    """
    cat = db.get(Category, category_id)
    if cat is None:
        raise HTTPException(404, f"Category {category_id} not found")

    new_parent_id = body.parent_id
    if new_parent_id is not None:
        if new_parent_id == category_id:
            raise HTTPException(400, "Cannot self-parent")
        new_parent = db.get(Category, new_parent_id)
        if new_parent is None:
            raise HTTPException(404, f"Parent category {new_parent_id} not found")
        # Walk ancestors of new_parent — none of them can be `cat`.
        cursor = new_parent
        safety = 0
        while cursor is not None and safety < 20:
            safety += 1
            if cursor.id == category_id:
                raise HTTPException(
                    400,
                    "Would create a cycle: target is an ancestor of the new parent",
                )
            if cursor.parent_id is None:
                break
            cursor = db.get(Category, cursor.parent_id)

    cat.parent_id = new_parent_id
    db.commit()
    db.refresh(cat)
    return cat


@router.post("/categories/seed", tags=["categories"])
def seed_categories_and_rules(db: Session = Depends(get_db)) -> dict[str, int]:
    """Idempotent: ensure CATEGORY_SEED rows + reload seed rules.

    Useful when the categories table is empty (fresh DB) — without this,
    categorization can't bind rules to category_ids and every transaction
    falls through to Uncategorized. Returns counts of what landed.
    """
    cats_before = db.execute(select(Category)).scalars().all()
    rules_before = db.execute(select(Rule).where(Rule.is_seed.is_(True))).scalars().all()
    cat_map = ensure_categories(db)
    load_seed_rules(db, cat_map)
    db.commit()
    cats_after = db.execute(select(Category)).scalars().all()
    rules_after = db.execute(select(Rule).where(Rule.is_seed.is_(True))).scalars().all()
    return {
        "categories_before": len(cats_before),
        "categories_after": len(cats_after),
        "rules_before": len(rules_before),
        "rules_after": len(rules_after),
    }
