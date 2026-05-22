"""Plaid Personal Finance Category → our Category mapper.

Sprint 12. Every Plaid transaction carries a
``personal_finance_category`` dict with two keys:

    {"primary": "FOOD_AND_DRINK", "detailed": "FOOD_AND_DRINK_RESTAURANTS"}

Our recurring-charge detector ingests this into
``Transaction.extra["plaid_personal_finance_category"]`` but the
``CategorizationEngine`` has so far ignored it. That's left ~163 of
400 recent transactions falling through to the "Uncategorized" bucket
even though Plaid already labeled them correctly.

This module converts Plaid's labels into our Category slugs. The
mapping is one-to-many in places — Plaid distinguishes finer-grained
classes than our taxonomy does (e.g., GENERAL_MERCHANDISE_HOBBIES and
GENERAL_MERCHANDISE_CONVENIENCE_STORES both land at "Household" for us)
but the round-trip is consistent: a Plaid label → exactly one of our
Category slugs, or None when we genuinely don't have a fit.

When wired into the categorization pipeline, this catches the
overwhelming majority of "obviously categorizable from the merchant
name alone" transactions (ARCO → Gas, MCDONALDS → Restaurants, etc.)
without writing a single hand-tuned Rule.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from finance_app.db.models import Category, Transaction


# Mapping from Plaid's *detailed* category to our category slug.
# Built from the Plaid taxonomy reference at
# https://plaid.com/docs/api/products/transactions/#categories.
# Where Plaid's detail is too granular and we don't have a 1:1 slot,
# we collapse to a sibling parent (e.g., personal-care subtypes land at
# "personal.entertainment" or "shopping.household" depending on what
# the spend really is).
_DETAILED_TO_SLUG: dict[str, str] = {
    # ---- INCOME ----
    "INCOME_DIVIDENDS": "income.interest",
    "INCOME_INTEREST_EARNED": "income.interest",
    "INCOME_RETIREMENT_PENSION": "income.salary",
    "INCOME_TAX_REFUND": "income.refund",
    "INCOME_UNEMPLOYMENT": "income.other",
    "INCOME_WAGES": "income.salary",
    "INCOME_OTHER_INCOME": "income.other",
    # ---- TRANSFER ----
    "TRANSFER_IN_CASH_ADVANCES_AND_LOANS": "financial.transfer",
    "TRANSFER_IN_DEPOSIT": "financial.transfer",
    "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS": "financial.investment",
    "TRANSFER_IN_SAVINGS": "financial.savings",
    "TRANSFER_IN_ACCOUNT_TRANSFER": "financial.transfer",
    "TRANSFER_IN_OTHER_TRANSFER_IN": "financial.transfer",
    "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS": "financial.investment",
    "TRANSFER_OUT_SAVINGS": "financial.savings",
    "TRANSFER_OUT_WITHDRAWAL": "financial.transfer",
    "TRANSFER_OUT_ACCOUNT_TRANSFER": "financial.transfer",
    "TRANSFER_OUT_OTHER_TRANSFER_OUT": "financial.transfer",
    # ---- LOAN PAYMENTS ----
    "LOAN_PAYMENTS_CAR_PAYMENT": "transport.car_payment",
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT": "financial.payment",
    "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT": "financial.payment",
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT": "housing.rent_mortgage",
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT": "financial.payment",
    "LOAN_PAYMENTS_OTHER_PAYMENT": "financial.payment",
    # ---- BANK FEES ----
    "BANK_FEES_ATM_FEES": "financial.fees",
    "BANK_FEES_FOREIGN_TRANSACTION_FEES": "financial.fees",
    "BANK_FEES_INSUFFICIENT_FUNDS": "financial.fees",
    "BANK_FEES_INTEREST_CHARGE": "financial.interest",
    "BANK_FEES_OVERDRAFT_FEES": "financial.fees",
    "BANK_FEES_OTHER_BANK_FEES": "financial.fees",
    # ---- ENTERTAINMENT ----
    "ENTERTAINMENT_CASINOS_AND_GAMBLING": "personal.entertainment",
    "ENTERTAINMENT_MUSIC_AND_AUDIO": "subscriptions.streaming",
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS": "personal.entertainment",
    "ENTERTAINMENT_TV_AND_MOVIES": "subscriptions.streaming",
    "ENTERTAINMENT_VIDEO_GAMES": "personal.entertainment",
    "ENTERTAINMENT_OTHER_ENTERTAINMENT": "personal.entertainment",
    # ---- FOOD AND DRINK ----
    "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR": "food.groceries",
    "FOOD_AND_DRINK_COFFEE": "food.coffee",
    "FOOD_AND_DRINK_FAST_FOOD": "food.restaurants",
    "FOOD_AND_DRINK_GROCERIES": "food.groceries",
    "FOOD_AND_DRINK_RESTAURANT": "food.restaurants",
    "FOOD_AND_DRINK_VENDING_MACHINES": "food.restaurants",
    "FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK": "food.restaurants",
    # ---- GENERAL MERCHANDISE ----
    "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS": "subscriptions.news",
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES": "shopping.clothing",
    "GENERAL_MERCHANDISE_CONVENIENCE_STORES": "shopping.household",
    "GENERAL_MERCHANDISE_DEPARTMENT_STORES": "shopping.household",
    "GENERAL_MERCHANDISE_DISCOUNT_STORES": "shopping.household",
    "GENERAL_MERCHANDISE_ELECTRONICS": "shopping.electronics",
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES": "personal.gifts",
    "GENERAL_MERCHANDISE_OFFICE_SUPPLIES": "shopping.online",
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES": "shopping.online",
    "GENERAL_MERCHANDISE_PET_SUPPLIES": "personal.pets",
    "GENERAL_MERCHANDISE_SPORTING_GOODS": "shopping.online",
    "GENERAL_MERCHANDISE_SUPERSTORES": "shopping.household",
    "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE": "shopping.online",
    "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE": "shopping.online",
    # ---- HOME IMPROVEMENT ----
    "HOME_IMPROVEMENT_FURNITURE": "housing.home_improvement",
    "HOME_IMPROVEMENT_HARDWARE": "housing.home_improvement",
    "HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE": "housing.home_improvement",
    "HOME_IMPROVEMENT_SECURITY": "housing.home_improvement",
    "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT": "housing.home_improvement",
    # ---- MEDICAL ----
    "MEDICAL_DENTAL_CARE": "health.medical",
    "MEDICAL_EYE_CARE": "health.medical",
    "MEDICAL_NURSING_CARE": "health.medical",
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS": "health.pharmacy",
    "MEDICAL_PRIMARY_CARE": "health.medical",
    "MEDICAL_VETERINARY_SERVICES": "personal.pets",
    "MEDICAL_OTHER_MEDICAL": "health.medical",
    # ---- PERSONAL CARE ----
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS": "health.fitness",
    "PERSONAL_CARE_HAIR_AND_BEAUTY": "personal.entertainment",
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING": "shopping.household",
    "PERSONAL_CARE_OTHER_PERSONAL_CARE": "personal.entertainment",
    # ---- GENERAL SERVICES ----
    "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING": "financial.fees",
    "GENERAL_SERVICES_AUTOMOTIVE": "transport.maintenance",
    "GENERAL_SERVICES_CHILDCARE": "personal.entertainment",
    "GENERAL_SERVICES_CONSULTING_AND_LEGAL": "financial.fees",
    "GENERAL_SERVICES_EDUCATION": "subscriptions.news",
    "GENERAL_SERVICES_INSURANCE": "transport.insurance",
    "GENERAL_SERVICES_POSTAGE_AND_SHIPPING": "shopping.online",
    "GENERAL_SERVICES_STORAGE": "shopping.household",
    "GENERAL_SERVICES_OTHER_GENERAL_SERVICES": "shopping.online",
    # ---- GOVERNMENT AND NON-PROFIT ----
    "GOVERNMENT_AND_NON_PROFIT_DONATIONS": "personal.gifts",
    "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES": "financial.fees",
    "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT": "financial.fees",
    "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT": "financial.fees",
    # ---- TRANSPORTATION ----
    "TRANSPORTATION_BIKES_AND_SCOOTERS": "transport.rideshare",
    "TRANSPORTATION_GAS": "transport.gas",
    "TRANSPORTATION_PARKING": "transport.parking",
    "TRANSPORTATION_PUBLIC_TRANSIT": "transport.public_transit",
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES": "transport.rideshare",
    "TRANSPORTATION_TOLLS": "transport.parking",
    "TRANSPORTATION_OTHER_TRANSPORTATION": "transport.rideshare",
    # ---- TRAVEL ----
    "TRAVEL_FLIGHTS": "personal.travel",
    "TRAVEL_LODGING": "personal.travel",
    "TRAVEL_RENTAL_CARS": "personal.travel",
    "TRAVEL_OTHER_TRAVEL": "personal.travel",
    # ---- RENT AND UTILITIES ----
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY": "housing.utilities",
    "RENT_AND_UTILITIES_INTERNET_AND_CABLE": "housing.internet",
    "RENT_AND_UTILITIES_RENT": "housing.rent_mortgage",
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT": "housing.utilities",
    "RENT_AND_UTILITIES_TELEPHONE": "housing.internet",
    "RENT_AND_UTILITIES_WATER": "housing.utilities",
    "RENT_AND_UTILITIES_OTHER_UTILITIES": "housing.utilities",
}

# Coarse fallback when only the *primary* category is set (Plaid
# occasionally omits the detailed field, especially on pending txns).
_PRIMARY_TO_SLUG: dict[str, str] = {
    "INCOME": "income.other",
    "TRANSFER_IN": "financial.transfer",
    "TRANSFER_OUT": "financial.transfer",
    "LOAN_PAYMENTS": "financial.payment",
    "BANK_FEES": "financial.fees",
    "ENTERTAINMENT": "personal.entertainment",
    "FOOD_AND_DRINK": "food.restaurants",
    "GENERAL_MERCHANDISE": "shopping.online",
    "HOME_IMPROVEMENT": "housing.home_improvement",
    "MEDICAL": "health.medical",
    "PERSONAL_CARE": "personal.entertainment",
    "GENERAL_SERVICES": "shopping.online",
    "GOVERNMENT_AND_NON_PROFIT": "financial.fees",
    "TRANSPORTATION": "transport.gas",
    "TRAVEL": "personal.travel",
    "RENT_AND_UTILITIES": "housing.utilities",
}


def _slug_to_category_id(db: Session) -> dict[str, int]:
    """Build a {slug: category_id} dict. Cached on the db session
    object so we don't re-query on every transaction in a batch."""
    cache = getattr(db, "_pfc_slug_cache", None)
    if cache is not None:
        return cache
    rows = db.query(Category.slug, Category.id).all()
    cache = {slug: cid for slug, cid in rows}
    setattr(db, "_pfc_slug_cache", cache)
    return cache


def infer_category_id_from_pfc(
    txn: Transaction, db: Session
) -> Optional[int]:
    """Return the Category.id implied by the Plaid personal_finance_category
    on this transaction, or None if no mapping exists / no PFC data
    was stored.

    Uses the ``detailed`` field when present (fine-grained), falling
    back to ``primary`` (coarse) when detailed is missing or unmapped.
    """
    extra = txn.extra or {}
    pfc = extra.get("plaid_personal_finance_category") or {}
    if not isinstance(pfc, dict):
        return None

    detailed = (pfc.get("detailed") or "").upper()
    primary = (pfc.get("primary") or "").upper()

    slug = _DETAILED_TO_SLUG.get(detailed)
    if slug is None:
        slug = _PRIMARY_TO_SLUG.get(primary)
    if slug is None:
        return None

    return _slug_to_category_id(db).get(slug)
