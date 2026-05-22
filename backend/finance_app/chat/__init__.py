"""Conversational AI assistant — Smart Feature #3.

Local Ollama-powered Q&A over the user's financial data. The hard
part isn't the LLM call (we already have :mod:`finance_app.llm.client`)
— it's giving the model the right context so answers are grounded in
real numbers instead of plausible-sounding hallucinations.

Strategy:
  1. **Context builder** (:func:`build_context`) — runs a small handful
     of fast SQL queries to compose a structured snapshot of the
     user's current state: balances, recent spending, subscriptions,
     goals. ~500-1500 tokens, fits comfortably in any Ollama model's
     context window.
  2. **Prompt template** (:func:`compose_prompt`) — wraps the context
     with a strict system message that forbids the LLM from going
     beyond the data. Includes a few-shot of how to handle "I don't
     know" gracefully.
  3. **Orchestrator** (:func:`ask`) — runs the pieces and returns
     a chat-shaped response.

Why local-only: the user's financial data shouldn't leave the machine.
Categorization-grade local models (llama3.1:8b, qwen2.5:7b) are plenty
strong at answering "how much did I spend on groceries last month" if
we hand them the right pre-computed summary.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import json

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.chat import tools as chat_tools
from finance_app.db.models import (
    Account,
    Category,
    Goal,
    Subscription,
    SubscriptionStatus,
    Transaction,
)
from finance_app.llm.client import OllamaUnavailable, get_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
#  Context types
# ---------------------------------------------------------------------------


@dataclass
class CategorySpend:
    """One row of category spending over a window."""
    name: str
    cents: int  # always positive; aggregator does abs()
    txn_count: int


@dataclass
class FinancialContext:
    """The structured snapshot we'll hand the LLM.

    Each field is something a typical personal-finance question might
    reference. We don't include obscure stuff (legal claims, redress)
    because those have their own panels; the chat is for daily-life
    "where's my money going" questions.
    """
    as_of: date
    # Account-side
    accounts: list[dict[str, Any]] = field(default_factory=list)
    total_assets_cents: int = 0
    total_liabilities_cents: int = 0
    net_worth_cents: int = 0
    # Spending windows
    spending_30d: list[CategorySpend] = field(default_factory=list)
    spending_90d: list[CategorySpend] = field(default_factory=list)
    total_outflow_30d_cents: int = 0
    total_outflow_90d_cents: int = 0
    total_inflow_30d_cents: int = 0
    total_inflow_90d_cents: int = 0
    # Subscriptions
    active_subscriptions: list[dict[str, Any]] = field(default_factory=list)
    monthly_subscription_cost_cents: int = 0
    # Goals
    goals: list[dict[str, Any]] = field(default_factory=list)
    # Top merchants (last 90d outflow)
    top_merchants: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
#  Context builder — pure SQL, no LLM
# ---------------------------------------------------------------------------


# Category slugs that represent MONEY MOVEMENT, not consumption.
# These will be excluded from spending rollups in the chat context —
# otherwise "top spending category" reads as Transfer / Credit Card
# Payment, which is technically true but useless: every dollar that
# moves between the user's own accounts shows up as a "spend" on the
# from-side. The same dollar isn't really being consumed. The totals
# elsewhere (last_30d_outflow) still reflect gross outflow.
_MONEY_MOVEMENT_SLUGS = frozenset({
    "financial.transfer",
    "financial.payment",         # "Credit Card Payment" — moves money to the card
    "financial.savings",         # contributions to savings account
    "financial.investment",      # contributions to brokerage
})


def _spending_by_category(
    db: Session, since: date, until: date
) -> tuple[list[CategorySpend], int, int]:
    """Bucket transaction outflows by category for a date window.

    Returns (rows sorted desc by spend, total_outflow_cents, total_inflow_cents).
    Outflow is sum of abs(amount_cents) for negative amounts. Inflow
    is sum of positive amounts. "Unbudgeted" transactions (no
    category_id) bucket into the "Uncategorized" pseudo-row.

    Money-movement categories (transfer, credit card payment, savings/
    investment contributions) are EXCLUDED from the per-category rows
    so chat answers about "top spending" surface real consumption, not
    money sliding between the user's own accounts. The outflow/inflow
    totals are computed BEFORE the filter so they still reflect gross
    flows.
    """
    rows = db.execute(
        select(
            Transaction.category_id,
            func.sum(Transaction.amount_cents).label("net"),
            func.sum(
                case(
                    (Transaction.amount_cents < 0, func.abs(Transaction.amount_cents)),
                    else_=0,
                )
            ).label("outflow"),
            func.sum(
                case(
                    (Transaction.amount_cents > 0, Transaction.amount_cents),
                    else_=0,
                )
            ).label("inflow"),
            func.count().label("n"),
        )
        .where(Transaction.posted_date >= since, Transaction.posted_date < until)
        .group_by(Transaction.category_id)
    ).all()

    if not rows:
        return [], 0, 0

    # Build id→(name, slug) map once.
    cat_info = {
        c.id: (c.name, c.slug)
        for c in db.execute(select(Category)).scalars().all()
    }
    out: list[CategorySpend] = []
    total_outflow = 0
    total_inflow = 0
    for cat_id, _net, outflow, inflow, n in rows:
        outflow = int(outflow or 0)
        inflow = int(inflow or 0)
        total_outflow += outflow
        total_inflow += inflow
        # Skip the row entirely if it's a pure-inflow category (e.g.
        # paycheck → Salary). We re-surface inflows in the totals.
        if outflow == 0:
            continue
        name, slug = cat_info.get(cat_id, ("Uncategorized", None))
        # Exclude money-movement categories from the rollup — they're
        # not consumption, just dollars shuffling between own-accounts.
        if slug in _MONEY_MOVEMENT_SLUGS:
            continue
        out.append(CategorySpend(name=name, cents=outflow, txn_count=int(n)))
    out.sort(key=lambda r: r.cents, reverse=True)
    return out, total_outflow, total_inflow


def _top_merchants(db: Session, days: int = 90, limit: int = 8) -> list[dict[str, Any]]:
    """Top N merchants by absolute outflow over the last `days` days."""
    cutoff = date.today() - timedelta(days=days)
    # Aggregate by ``description_clean`` (the per-row normalized merchant
    # string) — matches the pattern in api/merchants.py. Transaction has
    # only a ``merchant`` SQLAlchemy relationship, not a scalar column,
    # so it can't be selected/grouped directly. ``description_raw`` is
    # the fallback when description_clean hasn't been populated.
    merchant_col = func.coalesce(
        Transaction.description_clean, Transaction.description_raw
    )
    rows = db.execute(
        select(
            merchant_col.label("merchant"),
            func.sum(func.abs(Transaction.amount_cents)).label("total"),
            func.count().label("n"),
        )
        .where(
            Transaction.amount_cents < 0,
            Transaction.posted_date >= cutoff,
        )
        .group_by(merchant_col)
        .order_by(func.sum(func.abs(Transaction.amount_cents)).desc())
        .limit(limit)
    ).all()
    return [
        {"merchant": m, "cents": int(total or 0), "txn_count": int(n)}
        for m, total, n in rows
        if m
    ]


def build_context(db: Session) -> FinancialContext:
    """Compose the snapshot. ~5-10 SQL queries, runs in <100ms."""
    today = date.today()
    ctx = FinancialContext(as_of=today)

    # Accounts
    accounts = (
        db.execute(select(Account).where(Account.is_active.is_(True)))
        .scalars()
        .all()
    )
    for a in accounts:
        bal = a.current_balance_cents or 0
        ctx.accounts.append(
            {
                "name": a.name,
                "type": a.account_type.value if hasattr(a.account_type, "value") else str(a.account_type),
                "balance_cents": bal,
            }
        )
        if bal >= 0:
            ctx.total_assets_cents += bal
        else:
            ctx.total_liabilities_cents += abs(bal)
    ctx.net_worth_cents = ctx.total_assets_cents - ctx.total_liabilities_cents

    # Spending — 30d and 90d windows
    spending_30, outflow_30, inflow_30 = _spending_by_category(
        db, today - timedelta(days=30), today + timedelta(days=1)
    )
    spending_90, outflow_90, inflow_90 = _spending_by_category(
        db, today - timedelta(days=90), today + timedelta(days=1)
    )
    ctx.spending_30d = spending_30[:12]  # top 12, rest tail-summed in prompt if needed
    ctx.spending_90d = spending_90[:12]
    ctx.total_outflow_30d_cents = outflow_30
    ctx.total_outflow_90d_cents = outflow_90
    ctx.total_inflow_30d_cents = inflow_30
    ctx.total_inflow_90d_cents = inflow_90

    # Subscriptions — only active+confirmed; the rest are noise.
    subs = (
        db.execute(
            select(Subscription).where(
                Subscription.status == SubscriptionStatus.active,
            )
        )
        .scalars()
        .all()
    )
    for s in subs:
        # Subscription.amount_cents is negative; flip for display.
        amount = abs(s.amount_cents or 0)
        ctx.active_subscriptions.append(
            {
                "merchant": s.merchant or "?",
                "monthly_cents": amount,
                "cadence": getattr(s, "cadence_label", None) or "monthly",
            }
        )
        ctx.monthly_subscription_cost_cents += amount

    # Goals (in-progress only)
    goals = db.execute(select(Goal)).scalars().all()
    for g in goals:
        # Skip completed/abandoned goals — chat answers should be about
        # what's currently in motion.
        status_val = (
            g.status.value if hasattr(g.status, "value") else str(g.status or "")
        )
        if status_val in {"completed", "abandoned", "archived"}:
            continue
        target = g.target_amount_cents or 0
        current = g.current_amount_cents or 0
        ctx.goals.append(
            {
                "name": g.name,
                "target_cents": target,
                "current_cents": current,
                "progress_pct": round(100.0 * current / target, 1) if target > 0 else 0.0,
                "deadline": g.target_date.isoformat() if g.target_date else None,
            }
        )

    # Top merchants
    ctx.top_merchants = _top_merchants(db, days=90, limit=8)

    return ctx


# ---------------------------------------------------------------------------
#  Prompt composition
# ---------------------------------------------------------------------------


SYSTEM_PROMPT = """You are a helpful, concise personal finance assistant for the user.

You answer questions using ONLY the financial data in the CONTEXT block. Hard rules:

- Be concise. Aim for 2–4 sentences. Longer only if the user explicitly asks.
- Use specific numbers from the context. Format dollars with a $ sign and comma separators.
- If the data needed to answer isn't in the context, say so plainly: "I don't see that in your data." Do not guess or invent numbers.
- Don't say "based on the provided data" or "according to the context" — just answer directly.
- When comparing two numbers, give both the absolute and percentage delta.
- Don't give generic financial advice unless the user asks for it. The user wants information about THEIR money, not lectures.
- The CONTEXT is a structured snapshot for YOU to read — never quote raw field labels (like `total_monthly`, `last_30d_outflow`, `active_subscriptions`) in your reply. Translate them into natural English ("about $1,260/month on subscriptions"). The user has no idea what those keys are.
- "Spending" means real consumption. Transfers between the user's own accounts and credit-card payments aren't spending — they're already excluded from the per-category breakdown. If the user asks about overall outflow, use the cash-flow totals instead.
"""


def _fmt_cents(c: int) -> str:
    sign = "-" if c < 0 else ""
    return f"{sign}${abs(c) / 100:,.2f}"


def _ctx_to_prompt_block(ctx: FinancialContext) -> str:
    """Render the FinancialContext as a structured plaintext block.

    Section headers are written as natural-English titles (e.g. "Net
    worth" rather than ``net_worth:``) so the LLM doesn't echo raw
    YAML keys into its prose. Earlier passes used identifier-shaped
    keys and llama3.1 happily wrote things like 'your total_monthly
    for active_subscriptions'. Plain titles fix that without losing
    structure the model can scan.
    """
    lines: list[str] = ["## CONTEXT", f"As of: {ctx.as_of.isoformat()}", ""]

    # Net worth
    lines.append("Net worth:")
    lines.append(f"  Total net worth: {_fmt_cents(ctx.net_worth_cents)}")
    lines.append(f"  Total assets: {_fmt_cents(ctx.total_assets_cents)}")
    lines.append(f"  Total liabilities: {_fmt_cents(ctx.total_liabilities_cents)}")
    lines.append("")

    # Accounts (compact one-liner each)
    lines.append("Accounts:")
    for a in ctx.accounts:
        lines.append(
            f"  - {a['name']} ({a['type']}): {_fmt_cents(a['balance_cents'])}"
        )
    lines.append("")

    # Cash flow last 30 / 90 days
    lines.append("Cash flow:")
    lines.append(f"  Last 30 days — money out: {_fmt_cents(ctx.total_outflow_30d_cents)}")
    lines.append(f"  Last 30 days — money in:  {_fmt_cents(ctx.total_inflow_30d_cents)}")
    lines.append(f"  Last 30 days — net:       {_fmt_cents(ctx.total_inflow_30d_cents - ctx.total_outflow_30d_cents)}")
    lines.append(f"  Last 90 days — money out: {_fmt_cents(ctx.total_outflow_90d_cents)}")
    lines.append(f"  Last 90 days — money in:  {_fmt_cents(ctx.total_inflow_90d_cents)}")
    lines.append("  (Outflow includes transfers and credit-card payments; the per-category breakdown below excludes those.)")
    lines.append("")

    # Spending 30d
    if ctx.spending_30d:
        lines.append("Spending by category — last 30 days (consumption only, excludes transfers / card payments):")
        for s in ctx.spending_30d:
            lines.append(f"  - {s.name}: {_fmt_cents(s.cents)} ({s.txn_count} transactions)")
        lines.append("")

    # Spending 90d
    if ctx.spending_90d:
        lines.append("Spending by category — last 90 days (consumption only, excludes transfers / card payments):")
        for s in ctx.spending_90d:
            lines.append(f"  - {s.name}: {_fmt_cents(s.cents)} ({s.txn_count} transactions)")
        lines.append("")

    # Top merchants
    if ctx.top_merchants:
        lines.append("Top merchants — last 90 days:")
        for m in ctx.top_merchants:
            lines.append(
                f"  - {m['merchant']}: {_fmt_cents(m['cents'])} ({m['txn_count']} transactions)"
            )
        lines.append("")

    # Subscriptions
    if ctx.active_subscriptions:
        lines.append(
            f"Active subscriptions — {_fmt_cents(ctx.monthly_subscription_cost_cents)}/month total:"
        )
        for s in ctx.active_subscriptions:
            lines.append(
                f"  - {s['merchant']}: {_fmt_cents(s['monthly_cents'])}/{s['cadence']}"
            )
        lines.append("")

    # Goals
    if ctx.goals:
        lines.append("Savings goals:")
        for g in ctx.goals:
            lines.append(
                f"  - {g['name']}: {_fmt_cents(g['current_cents'])} of "
                f"{_fmt_cents(g['target_cents'])} ({g['progress_pct']}% complete"
                + (f", target date {g['deadline']}" if g["deadline"] else "")
                + ")"
            )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def compose_prompt(question: str, ctx: FinancialContext, history: list[dict] | None = None) -> str:
    """Assemble the user-facing prompt body that follows the system msg.

    Includes prior chat history (if any) so the model can resolve
    references like "what about the prior month?". History entries are
    expected to be ``[{"role": "user"|"assistant", "content": "..."}]``.
    We cap at the last 6 turns to keep token count bounded.
    """
    parts: list[str] = [_ctx_to_prompt_block(ctx)]

    if history:
        parts.append("## PRIOR CONVERSATION")
        for turn in history[-6:]:  # last 3 user/assistant pairs
            role = turn.get("role", "user").upper()
            content = (turn.get("content") or "").strip()
            if content:
                parts.append(f"{role}: {content}")
        parts.append("")

    parts.append("## CURRENT QUESTION")
    parts.append(question.strip())
    parts.append("")
    parts.append("## ANSWER")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
#  Orchestrator
# ---------------------------------------------------------------------------


@dataclass
class ChatAnswer:
    answer: str
    used_context_kb: int       # rough size of the context block in KB, for debug
    ollama_available: bool
    error: str | None = None   # populated when ollama_available=False
    # Tool-use telemetry. Empty list when running in context-only mode.
    # Each entry: {"tool": str, "args": dict, "result": dict}
    tool_calls: list[dict] = field(default_factory=list)
    mode: str = "context"      # "context" or "tool_use"


PLAN_SYSTEM_PROMPT = """You are a tool-routing planner for a personal finance assistant.

You will see a user's question and a list of available TOOLS. Your job is to emit a JSON plan listing the tool calls needed to answer the question. Hard rules:

- Output VALID JSON, nothing else. No prose, no markdown fences.
- Shape: {"plan": [{"tool": "...", "args": {...}}, ...]}
- Use 0–4 tool calls. Most questions need 1, comparisons need 2.
- If no tool is needed (e.g. a definition question), return {"plan": []}.
- ``args`` keys must match the tool's ``args`` exactly. Use null for omitted optional fields.
- Don't invent tools. Only use tools listed in the TOOLS section.
"""


ANSWER_SYSTEM_PROMPT = """You are a helpful, concise personal finance assistant.

You have already executed a small set of tool calls and have their results in the TOOL_RESULTS section. Use ONLY those results plus the static CONTEXT (account balances, etc.) to answer.

Rules:
- 2–4 sentences; longer only if explicitly asked.
- Use specific numbers from the tool results. Format dollars with $ + commas.
- If results are empty, say so plainly: "I don't see that in your data."
- Don't say "based on the data" or "according to the results" — just answer.
- For comparisons, give both absolute and percent delta.
- Don't lecture about general financial concepts unless asked.
- TOOL_RESULTS and CONTEXT are structured for YOU to read — never quote raw field labels (keys like `total_monthly`, `outflow`, `category_id`) in your reply. Translate them into natural English. The user has no idea what those keys are.
"""


def _format_tool_specs() -> str:
    """Render TOOL_SPECS as a compact YAML-ish block for the planner prompt."""
    lines = ["AVAILABLE TOOLS:"]
    for spec in chat_tools.TOOL_SPECS:
        lines.append(f"- name: {spec['name']}")
        lines.append(f"  description: {spec['description']}")
        if spec.get("args"):
            lines.append("  args:")
            for k, v in spec["args"].items():
                lines.append(f"    {k}: {v}")
        else:
            lines.append("  args: (none)")
    return "\n".join(lines)


def _plan(client, question: str, history: list[dict] | None) -> list[dict]:
    """Ask the LLM for a JSON tool-call plan. Returns list of {tool, args}.

    Returns empty list if the LLM emits invalid JSON or an empty plan —
    the caller treats this as a signal to fall back to context-only mode.
    """
    parts = [_format_tool_specs(), ""]
    if history:
        parts.append("RECENT CONVERSATION:")
        for turn in history[-4:]:
            role = turn.get("role", "user").upper()
            content = (turn.get("content") or "").strip()
            if content:
                parts.append(f"{role}: {content}")
        parts.append("")
    parts.append(f"QUESTION: {question}")
    parts.append("")
    parts.append("Output the JSON plan now:")

    raw = client.generate(
        "\n".join(parts),
        system=PLAN_SYSTEM_PROMPT,
        json_mode=True,
        temperature=0.0,
        max_tokens=400,
    )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("planner emitted non-JSON: %r", raw[:200])
        return []
    plan = data.get("plan", [])
    if not isinstance(plan, list):
        return []
    # Defensive: cap at 4 tool calls and drop malformed entries.
    out = []
    for entry in plan[:4]:
        if not isinstance(entry, dict):
            continue
        tool = entry.get("tool")
        args = entry.get("args") or {}
        if isinstance(tool, str) and isinstance(args, dict):
            out.append({"tool": tool, "args": args})
    return out


def _ctx_block_for_answer(ctx: FinancialContext) -> str:
    """Compact context for the answer step — accounts only, no spending
    rollups. The tool results carry the spending-side numbers; we just
    need balance context for "what's my checking balance" follow-ups.
    Uses natural-English labels for the same reason as
    :func:`_ctx_to_prompt_block` — keeps the model from echoing raw
    field keys into its reply."""
    lines = ["## CONTEXT"]
    lines.append(f"As of: {ctx.as_of.isoformat()}")
    lines.append(f"Net worth: {_fmt_cents(ctx.net_worth_cents)}")
    lines.append(f"Total assets: {_fmt_cents(ctx.total_assets_cents)}")
    lines.append(f"Total liabilities: {_fmt_cents(ctx.total_liabilities_cents)}")
    lines.append("Accounts:")
    for a in ctx.accounts:
        lines.append(
            f"  - {a['name']} ({a['type']}): {_fmt_cents(a['balance_cents'])}"
        )
    return "\n".join(lines) + "\n"


def ask(
    db: Session,
    question: str,
    history: list[dict] | None = None,
    *,
    max_tokens: int = 400,
    mode: str = "tool_use",
) -> ChatAnswer:
    """End-to-end Q&A.

    Two modes:
      - ``"tool_use"`` (default): planner LLM emits JSON tool calls, we
        execute them server-side, then a second LLM call composes the
        natural-language answer.
      - ``"context"``: legacy single-shot — bake everything into the
        prompt.

    The tool-use path falls back to context mode automatically if the
    planner returns an empty/invalid plan.
    """
    client = get_client()
    if not client.is_available():
        return ChatAnswer(
            answer=(
                "I can't reach the local AI model right now. Make sure "
                "Ollama is running (try `ollama serve` in a terminal) "
                "and that the configured model is pulled "
                f"(`ollama pull {client.model}`)."
            ),
            used_context_kb=0,
            ollama_available=False,
            error="ollama unreachable",
            mode=mode,
        )

    if mode == "tool_use":
        try:
            plan = _plan(client, question, history)
        except OllamaUnavailable as exc:
            logger.warning("planner failed, falling back to context mode: %r", exc)
            plan = []

        if plan:
            # Execute the tools server-side.
            tool_calls: list[dict] = []
            for entry in plan:
                result = chat_tools.execute(db, entry["tool"], entry["args"])
                tool_calls.append(
                    {"tool": entry["tool"], "args": entry["args"], "result": result}
                )

            # Compose the answer prompt.
            ctx = build_context(db)
            tool_results_block = "## TOOL_RESULTS\n" + json.dumps(
                tool_calls, indent=2, default=str
            )
            ctx_block = _ctx_block_for_answer(ctx)

            answer_parts = [ctx_block, tool_results_block, ""]
            if history:
                answer_parts.append("## PRIOR CONVERSATION")
                for turn in history[-6:]:
                    role = turn.get("role", "user").upper()
                    content = (turn.get("content") or "").strip()
                    if content:
                        answer_parts.append(f"{role}: {content}")
                answer_parts.append("")
            answer_parts.append(f"## QUESTION\n{question}\n")
            answer_parts.append("## ANSWER")
            answer_prompt = "\n".join(answer_parts)
            used_kb = len(answer_prompt.encode("utf-8")) // 1024

            try:
                text = client.generate(
                    answer_prompt,
                    system=ANSWER_SYSTEM_PROMPT,
                    temperature=0.2,
                    max_tokens=max_tokens,
                )
            except OllamaUnavailable as exc:
                logger.warning("answer generate failed: %r", exc)
                return ChatAnswer(
                    answer=(
                        "I ran the queries, but the model errored out while "
                        "composing the answer. Try again."
                    ),
                    used_context_kb=used_kb,
                    ollama_available=False,
                    error=str(exc),
                    tool_calls=tool_calls,
                    mode="tool_use",
                )

            return ChatAnswer(
                answer=text.strip(),
                used_context_kb=used_kb,
                ollama_available=True,
                tool_calls=tool_calls,
                mode="tool_use",
            )
        # else: empty plan → fall through to context mode

    # --- Context-mode path ----------------------------------------------
    ctx = build_context(db)
    prompt = compose_prompt(question, ctx, history)
    used_kb = len(prompt.encode("utf-8")) // 1024

    try:
        text = client.generate(
            prompt,
            system=SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=max_tokens,
        )
    except OllamaUnavailable as exc:
        logger.warning("ollama generate failed: %r", exc)
        return ChatAnswer(
            answer=(
                "The local AI model errored out partway through. Try "
                "again, or check the Ollama logs."
            ),
            used_context_kb=used_kb,
            ollama_available=False,
            error=str(exc),
            mode="context",
        )

    return ChatAnswer(
        answer=text.strip(),
        used_context_kb=used_kb,
        ollama_available=True,
        mode="context",
    )


__all__ = [
    "ChatAnswer",
    "FinancialContext",
    "ask",
    "build_context",
    "compose_prompt",
]
