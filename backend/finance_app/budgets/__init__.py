"""Budgets package — Wave G projection + recommendation services.

The flat ``api/budgets.py`` already owns the rollup + template endpoints.
This package houses the deeper engines (projection, recommendation) so
the API layer stays thin. Public API mirrors what api/budgets_projector.py
imports.
"""
from .projector import (
    DEFAULT_CHECKING_CAP_CENTS,
    DEFAULT_INVESTMENT_APY,
    ProjectionPoint,
    ProjectionResult,
    StartBalances,
    apply_overrides,
    gather_inputs,
    project,
)

__all__ = [
    "DEFAULT_CHECKING_CAP_CENTS",
    "DEFAULT_INVESTMENT_APY",
    "ProjectionPoint",
    "ProjectionResult",
    "StartBalances",
    "apply_overrides",
    "gather_inputs",
    "project",
]
