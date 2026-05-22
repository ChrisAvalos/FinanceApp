"""Thin Ollama HTTP client with graceful-degradation semantics.

Why thin
--------
The Ollama API is a few HTTP endpoints — using the ``ollama`` Python
package adds a dependency for stuff we can do in 60 lines of httpx.
We hit ``/api/generate`` for prompt → text completion. Streaming is
nice but the consumers (categorization fallback, weekly narrator) want
the full string anyway.

Why graceful
------------
When Ollama isn't running, the client raises :class:`OllamaUnavailable`
instead of a generic exception. Callers catch it and fall back to a
no-LLM path so the rest of the app keeps working. This means installing
Ollama is *optional*: features upgrade themselves when it's there.
"""
from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from typing import Any, Sequence

import httpx

from ..config import settings

logger = logging.getLogger(__name__)


class OllamaUnavailable(RuntimeError):
    """Raised when Ollama isn't reachable, isn't responding, or returned an
    error we can't recover from. Catch this in feature code to fall back
    to no-LLM behavior."""


class OllamaClient:
    """Tiny Ollama wrapper. Stateless except for an httpx.Client for
    connection reuse."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        model: str | None = None,
        timeout_s: float = 90.0,
    ) -> None:
        # 90s default — Llama 3.1 8B on CPU takes 20-30s for a "Say hi"
        # prompt and longer for the categorization prompt (which ships
        # the full ~40-slug taxonomy as context). 30s was too tight and
        # caused silent ReadTimeouts under the engine's blanket
        # try/except. 90s gives us breathing room without unreasonable
        # wall-clock blocking on a stuck model.
        self.base_url = (base_url or settings.ollama_url).rstrip("/")
        self.model = model or settings.ollama_model
        self.timeout_s = timeout_s
        self._client = httpx.Client(timeout=timeout_s)

    def close(self) -> None:
        self._client.close()

    # ------------------------------------------------------------------
    #  Health
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        """Cheap reachability probe. ~50ms when Ollama is running, ~error timeout otherwise."""
        try:
            r = self._client.get(f"{self.base_url}/api/tags", timeout=2.0)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    # ------------------------------------------------------------------
    #  Core: generate
    # ------------------------------------------------------------------

    def generate(
        self,
        prompt: str,
        *,
        system: str | None = None,
        json_mode: bool = False,
        temperature: float = 0.0,
        max_tokens: int = 512,
    ) -> str:
        """Synchronous prompt → completion. Returns the raw text.

        Set ``json_mode=True`` to ask Ollama to constrain output to valid
        JSON — useful for the categorization fallback where we want one
        category slug back, not prose. Temperature 0 by default since
        these are classification / summarization tasks, not creative.
        """
        body: dict[str, Any] = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }
        if system:
            body["system"] = system
        if json_mode:
            body["format"] = "json"
        try:
            r = self._client.post(f"{self.base_url}/api/generate", json=body)
        except httpx.HTTPError as e:
            raise OllamaUnavailable(f"Ollama request failed: {e!r}") from e
        if r.status_code != 200:
            raise OllamaUnavailable(
                f"Ollama returned {r.status_code}: {r.text[:200]}"
            )
        try:
            data = r.json()
        except json.JSONDecodeError as e:
            raise OllamaUnavailable(f"Ollama returned non-JSON body: {e!r}") from e
        if "response" not in data:
            raise OllamaUnavailable(
                f"Ollama response missing 'response' field: {data}"
            )
        return data["response"].strip()

    # ------------------------------------------------------------------
    #  Sprint 49 — multimodal: prompt + images → completion
    # ------------------------------------------------------------------

    def generate_with_images(
        self,
        prompt: str,
        image_paths: Sequence[str | Path],
        *,
        model: str | None = None,
        system: str | None = None,
        json_mode: bool = False,
        temperature: float = 0.0,
        max_tokens: int = 1024,
        timeout_s: float | None = None,
    ) -> str:
        """Run a vision-capable model on (prompt, images) → text.

        Hits the same ``/api/generate`` endpoint as ``generate`` but
        attaches the images base64-encoded under the ``images`` field
        (the schema Ollama exposes for multimodal models like
        llama3.2-vision and llava).

        ``model`` defaults to ``settings.ollama_vision_model`` because
        the regular text model can't accept images — passing the
        wrong model name produces a cryptic "no compatible adapter"
        error from Ollama. Caller can override for testing.

        ``max_tokens`` defaults higher than ``generate`` (1024 vs 512)
        because the typical use case is "describe / transcribe this
        receipt", which can run to several hundred tokens of output.

        ``timeout_s`` overrides the constructor timeout for this call
        only — vision inference on CPU is much slower than text, so
        callers should pass at least 180s for a full receipt extract.
        """
        if not image_paths:
            raise ValueError("generate_with_images requires at least one image path")
        encoded: list[str] = []
        for ip in image_paths:
            p = Path(ip)
            if not p.exists():
                raise FileNotFoundError(p)
            data = p.read_bytes()
            encoded.append(base64.b64encode(data).decode("ascii"))
        body: dict[str, Any] = {
            "model": model or settings.ollama_vision_model,
            "prompt": prompt,
            "images": encoded,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }
        if system:
            body["system"] = system
        if json_mode:
            body["format"] = "json"
        # Vision models on CPU are ~5–10x slower than text — bump the
        # request timeout so we don't bail mid-inference. Caller can
        # further override via the timeout_s arg.
        request_timeout = timeout_s if timeout_s is not None else max(self.timeout_s, 240.0)
        try:
            r = self._client.post(
                f"{self.base_url}/api/generate",
                json=body,
                timeout=request_timeout,
            )
        except httpx.HTTPError as e:
            raise OllamaUnavailable(f"Ollama vision request failed: {e!r}") from e
        if r.status_code != 200:
            raise OllamaUnavailable(
                f"Ollama vision returned {r.status_code}: {r.text[:200]}"
            )
        try:
            data = r.json()
        except json.JSONDecodeError as e:
            raise OllamaUnavailable(f"Ollama vision returned non-JSON body: {e!r}") from e
        if "response" not in data:
            raise OllamaUnavailable(
                f"Ollama vision response missing 'response' field: {data}"
            )
        return data["response"].strip()

    def is_vision_model_available(self, model: str | None = None) -> bool:
        """Check whether the vision model is pulled locally.

        Ollama returns 404 from /api/show when the model name doesn't
        match anything pulled. Cheap (no inference), so safe to call
        on every receipt-page render to drive the install hint.
        """
        target = model or settings.ollama_vision_model
        try:
            r = self._client.post(
                f"{self.base_url}/api/show",
                json={"name": target},
                timeout=2.0,
            )
            return r.status_code == 200
        except httpx.HTTPError:
            return False


_singleton: OllamaClient | None = None


def get_client() -> OllamaClient:
    """Process-singleton client so connection pools stay warm.

    Recreate by setting ``_singleton = None`` — needed in tests when
    swapping config.
    """
    global _singleton
    if _singleton is None:
        _singleton = OllamaClient()
    return _singleton
