"""Local-LLM helpers (Ollama-backed).

Two consumer-facing helpers:

  * :func:`categorize_merchant` — given a merchant name + an existing
    category list, returns the best category slug. Used as the T3
    fallback in the categorization engine for merchants the rule set
    can't match.
  * :func:`narrate_insights` — given a structured weekly summary,
    returns a 3-5 sentence plain-English digest. Used by the weekly
    digest job and surfaced in the dashboard.

Both helpers gracefully degrade when Ollama isn't reachable: they
return ``None`` (or a sane default) instead of raising. That way the
rest of the app keeps working when Chris hasn't installed Ollama yet
or has it stopped.

See ``MANUAL_TASKS.md`` item #3 for the one-time Ollama setup.
"""
from .client import OllamaClient, OllamaUnavailable, get_client

__all__ = ["OllamaClient", "OllamaUnavailable", "get_client"]
