"""Chat endpoint — Smart Feature #3.

Wraps :mod:`finance_app.chat` (context builder + Ollama orchestrator)
with a FastAPI POST endpoint.

Why POST not GET: the request body carries ``history`` which can be
arbitrarily long (up to the last 6 turns); URL-encoding that as query
params would be ugly. POST is also the right verb because each call
is non-cacheable — the underlying state changes as transactions
ingest.

Response is always 200 with a structured body. We don't return 5xx
when Ollama is unreachable — the chat module returns a friendly
"start Ollama" message in the answer field instead, so the user gets
actionable guidance in chat-style flow rather than a red error toast.

Per-request timeout: the underlying Ollama call can take 30-90s on
a cold CPU. We cap the endpoint at 75s via asyncio.wait_for and
return a graceful "taking too long" message rather than letting the
HTTP request hang from the client's perspective. The orphaned thread
keeps running — Ollama will finish eventually, and the next request
benefits from a now-warm model.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from finance_app.chat import ask
from finance_app.db.session import get_db
from finance_app.llm.client import get_client

logger = logging.getLogger(__name__)

# Hard ceiling on /chat/ask. Llama 3.1 8B on CPU averages 20-30s in
# context mode after warm-up; first call can be ~60s. 75s leaves head-
# room without making the user wait forever.
_CHAT_ASK_TIMEOUT_S = 75.0

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatAskIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list)
    # Default flipped to "context" in Sprint 17-followup. tool_use does
    # two LLM round trips (plan + answer) which doubles latency on
    # CPU-bound local Ollama — context mode delivers a clean answer in
    # one round trip using a structured snapshot of the user's data,
    # which is plenty for the question shapes the panel surfaces
    # ("how much did I spend on X last month?"). Power users can still
    # opt in to tool_use explicitly when they need richer queries.
    mode: Literal["tool_use", "context"] = "context"


class ChatToolCallOut(BaseModel):
    tool: str
    args: dict
    result: dict


class ChatAskOut(BaseModel):
    answer: str
    ollama_available: bool
    used_context_kb: int
    mode: str
    tool_calls: list[ChatToolCallOut] = Field(default_factory=list)
    error: str | None = None


class ChatStatus(BaseModel):
    ollama_available: bool
    model: str
    base_url: str


@router.get("/status", response_model=ChatStatus)
def chat_status() -> ChatStatus:
    """Probe Ollama health so the UI can render an empty-state CTA
    when the model isn't running, instead of letting the user type
    questions that just fail."""
    client = get_client()
    return ChatStatus(
        ollama_available=client.is_available(),
        model=client.model,
        base_url=client.base_url,
    )


@router.post("/ask", response_model=ChatAskOut)
async def chat_ask(payload: ChatAskIn, db: Session = Depends(get_db)) -> ChatAskOut:
    """Answer a single question, optionally using prior turns as context.

    Runs the synchronous ``ask()`` in a thread with a 75s timeout so a
    stuck Ollama call returns a friendly response rather than hanging
    the HTTP request indefinitely.
    """
    history_dicts = [t.model_dump() for t in payload.history]
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(
                ask, db, payload.question, history_dicts, mode=payload.mode
            ),
            timeout=_CHAT_ASK_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "chat /ask timed out after %.0fs (question prefix=%r)",
            _CHAT_ASK_TIMEOUT_S,
            payload.question[:80],
        )
        return ChatAskOut(
            answer=(
                f"The local model is taking longer than {int(_CHAT_ASK_TIMEOUT_S)} seconds "
                "to answer. This usually happens on the first call after Ollama starts — "
                "the model is loading into memory. Wait a few seconds and ask again; "
                "subsequent answers should arrive in 20–30 seconds."
            ),
            ollama_available=True,
            used_context_kb=0,
            mode=payload.mode,
            tool_calls=[],
            error="chat-timeout",
        )
    return ChatAskOut(
        answer=result.answer,
        ollama_available=result.ollama_available,
        used_context_kb=result.used_context_kb,
        mode=result.mode,
        tool_calls=[
            ChatToolCallOut(tool=tc["tool"], args=tc["args"], result=tc["result"])
            for tc in (result.tool_calls or [])
        ],
        error=result.error,
    )
