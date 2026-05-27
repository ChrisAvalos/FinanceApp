"""Budgets API router.

This module is the public entry point for everything under ``/budgets/*``.
The feature implementations live in sibling ``_budgets_<feature>.py``
modules (templates / CRUD / rollup / assignment-ledger / rebalance) and
shared helpers live in ``_budgets_helpers.py``.

The router wires each endpoint via ``router.add_api_route`` so the feature
modules stay framework-light (plain functions, easy to unit-test) while
this file remains a thin, scannable manifest of the URL surface.

Tests import ``rollup``, ``assignment_ledger`` and ``rebalance_suggestions``
directly from this module — those names are re-exported below. The
``finance_app.budgets.projector`` module also pulls the alias imports
(``_is_catchall_cat``, ``_RENT_SHIFT_DAY_CUTOFF``, ``_find_rent_like_txns``)
from here for backwards compatibility.
"""
from __future__ import annotations

from fastapi import APIRouter

# Feature implementations
from finance_app.api._budgets_assignment_ledger import assignment_ledger
from finance_app.api._budgets_crud import (
    delete_budget,
    list_budgets,
    upsert_budget,
)
from finance_app.api._budgets_rebalance import rebalance_suggestions
from finance_app.api._budgets_rollup import (
    EomDetailResponse,
    ProjectionResponse,
    RecommendationsResponse,
    eom_detail,
    get_recommendations,
    project_budgets,
    rollup,
)
from finance_app.api._budgets_templates import (
    copy_from_prior,
    fill_from_average,
)

# Back-compat aliases used by ``finance_app.budgets.projector``. These
# symbols moved into ``_budgets_helpers`` but the projector still imports
# them from ``api.budgets``, so we re-export here.
from finance_app.api._budgets_helpers import (  # noqa: F401  back-compat
    _RENT_SHIFT_DAY_CUTOFF,
    _effective_goal_current_cents,
    _find_rent_like_txns,
    _is_catchall_cat,
    _is_other_income,
    _is_payroll_desc,
    _is_rent_cat,
    _is_savings_outflow_desc,
    _ledger_month_kind_totals,
    _month_bounds,
    _normalize_month_start,
    _prior_month_start,
)

# Response models referenced by the route declarations below.
from finance_app.api.schemas import (
    AssignmentLedgerResponse,
    BudgetOut,
    BudgetRollupResponse,
    BudgetTemplateResponse,
    RebalanceSuggestionsResponse,
)


router = APIRouter(prefix="/budgets", tags=["budgets"])

# CRUD
router.add_api_route("", list_budgets, methods=["GET"], response_model=list[BudgetOut])
router.add_api_route("", upsert_budget, methods=["POST"], response_model=BudgetOut)
router.add_api_route("/{budget_id}", delete_budget, methods=["DELETE"], status_code=204)

# Templates
router.add_api_route(
    "/copy-from-prior", copy_from_prior, methods=["POST"], response_model=BudgetTemplateResponse,
)
router.add_api_route(
    "/fill-from-average", fill_from_average, methods=["POST"], response_model=BudgetTemplateResponse,
)

# Rollup + siblings (project / recommendations / eom-detail)
router.add_api_route("/rollup", rollup, methods=["GET"], response_model=BudgetRollupResponse)
router.add_api_route("/project", project_budgets, methods=["POST"], response_model=ProjectionResponse)
router.add_api_route("/recommendations", get_recommendations, methods=["GET"], response_model=RecommendationsResponse)
router.add_api_route("/eom-detail", eom_detail, methods=["GET"], response_model=EomDetailResponse)

# Assignment ledger / Rebalance
router.add_api_route(
    "/assignment-ledger", assignment_ledger, methods=["GET"], response_model=AssignmentLedgerResponse,
)
router.add_api_route(
    "/rebalance-suggestions", rebalance_suggestions, methods=["GET"], response_model=RebalanceSuggestionsResponse,
)


__all__ = [
    "router",
    # Public re-exports used by tests:
    "rollup",
    "assignment_ledger",
    "rebalance_suggestions",
    # Other endpoint functions in case anything else imports them:
    "list_budgets",
    "upsert_budget",
    "delete_budget",
    "copy_from_prior",
    "fill_from_average",
    "project_budgets",
    "get_recommendations",
    "eom_detail",
]
