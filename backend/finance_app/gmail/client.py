"""Gmail OAuth + API wrapper.

Design notes:

* **Lazy imports.** ``google-*`` packages are imported *inside* methods
  so ``from finance_app.gmail.client import GmailClient`` never fails on
  machines where the deps aren't installed (the rest of the app keeps
  working, we just refuse to run the connector).

* **OAuth flow.** We use ``InstalledAppFlow`` (desktop/CLI flow), not the
  web flow. Google's docs call this the "Desktop app" client type. The
  first call pops a browser window for consent; after that ``token.json``
  is cached and silently refreshed.

* **Scopes.** Read-only. We never request send/compose/modify — the
  principle of least privilege here is both the right default and keeps
  Google's OAuth consent screen friendlier ("see your email" vs.
  "manage your email").

* **Body decoding.** Gmail bodies arrive base64url-encoded in a nested
  MIME tree. :func:`extract_plain_text` walks the tree, prefers
  ``text/plain`` parts, and falls back to HTML → text via BeautifulSoup
  if that's all there is (Chase alerts, for instance, are HTML-only).
"""
from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from ..config import settings

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
#  Plain data containers (not SQLAlchemy models — those come later)
# ----------------------------------------------------------------------


@dataclass
class GmailMessage:
    """Normalized view of a Gmail message for parsers to consume."""

    gmail_message_id: str
    gmail_thread_id: str | None
    from_address: str
    from_domain: str
    subject: str
    received_at: datetime  # UTC
    snippet: str
    body_plain: str
    # Headers kept around verbatim in case a parser wants list-id, etc.
    headers: dict[str, str]


class GmailNotConfigured(RuntimeError):
    """Raised when credentials.json is missing or the user hasn't auth'd yet."""


class GmailDependenciesMissing(RuntimeError):
    """Raised when google-* packages aren't installed."""


# ----------------------------------------------------------------------
#  Client
# ----------------------------------------------------------------------


class GmailClient:
    """Thin wrapper around the Gmail API.

    Usage::

        client = GmailClient()
        client.authorize()  # CLI flow — opens browser, writes token.json
        for msg in client.search("from:alerts@chase.com newer_than:90d"):
            ...
    """

    def __init__(
        self,
        credentials_path: str | None = None,
        token_path: str | None = None,
        scopes: Iterable[str] | None = None,
    ) -> None:
        self.credentials_path = Path(credentials_path or settings.gmail_credentials_path).expanduser()
        self.token_path = Path(token_path or settings.gmail_token_path).expanduser()
        self.scopes = list(scopes) if scopes else [
            s.strip() for s in settings.gmail_scopes.split(",") if s.strip()
        ]
        self._service: Any | None = None  # googleapiclient.discovery.Resource

    # ------------------------------------------------------------------
    #  Status helpers — safe to call without deps installed
    # ------------------------------------------------------------------

    @property
    def credentials_present(self) -> bool:
        return self.credentials_path.is_file()

    @property
    def token_present(self) -> bool:
        return self.token_path.is_file()

    def status(self) -> dict[str, Any]:
        """Return a cheap status dict for the /gmail/status endpoint."""
        return {
            "credentials_path": str(self.credentials_path),
            "credentials_present": self.credentials_present,
            "token_path": str(self.token_path),
            "token_present": self.token_present,
            "scopes": self.scopes,
            "deps_installed": _deps_available(),
        }

    # ------------------------------------------------------------------
    #  Auth
    # ------------------------------------------------------------------

    def authorize(self, *, interactive: bool = True) -> None:
        """Load cached token, refresh it, or run the installed-app flow.

        ``interactive=False`` disables the browser popup — use in background
        jobs that should only succeed with an already-valid token.
        """
        Credentials, InstalledAppFlow, Request, build = _import_google()

        creds = None
        if self.token_present:
            creds = Credentials.from_authorized_user_file(str(self.token_path), self.scopes)

        if creds and creds.valid:
            self._service = build("gmail", "v1", credentials=creds, cache_discovery=False)
            return

        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                self._persist_token(creds)
                self._service = build("gmail", "v1", credentials=creds, cache_discovery=False)
                return
            except Exception as exc:  # refresh failures require a new consent
                logger.warning("Gmail token refresh failed, re-auth required: %s", exc)
                creds = None

        # No usable token — need the user's consent.
        if not interactive:
            raise GmailNotConfigured(
                "No valid Gmail token and interactive=False. Run `python -m finance_app.gmail.authorize`."
            )
        if not self.credentials_present:
            raise GmailNotConfigured(
                f"Gmail credentials.json not found at {self.credentials_path}. "
                "Download a Desktop-app OAuth client JSON from Google Cloud Console."
            )

        flow = InstalledAppFlow.from_client_secrets_file(str(self.credentials_path), self.scopes)
        # run_local_server opens a browser and listens on an ephemeral port.
        # port=0 lets the OS pick a free one (avoids the classic "port 8080 in use").
        creds = flow.run_local_server(port=0, prompt="consent")
        self._persist_token(creds)
        self._service = build("gmail", "v1", credentials=creds, cache_discovery=False)

    def _persist_token(self, creds: Any) -> None:
        self.token_path.parent.mkdir(parents=True, exist_ok=True)
        self.token_path.write_text(creds.to_json())
        try:
            # Best-effort: 0o600 so other users on the box can't read it.
            os.chmod(self.token_path, 0o600)
        except OSError:
            pass

    # ------------------------------------------------------------------
    #  API calls
    # ------------------------------------------------------------------

    def _svc(self) -> Any:
        if self._service is None:
            raise GmailNotConfigured("Call authorize() before making API calls.")
        return self._service

    def search_ids(self, query: str, *, max_results: int = 500) -> list[str]:
        """Page through messages.list and return matching Gmail message IDs.

        Gmail's list endpoint returns at most 500 ids per page and caps
        us around 100 messages/request, so we paginate. ``query`` accepts
        the full Gmail search syntax (``from:``, ``newer_than:``,
        ``subject:``, ``has:attachment``, etc.).
        """
        svc = self._svc()
        ids: list[str] = []
        page_token: str | None = None
        while True:
            resp = (
                svc.users()
                .messages()
                .list(userId="me", q=query, pageToken=page_token, maxResults=100)
                .execute()
            )
            ids.extend(m["id"] for m in resp.get("messages", []))
            page_token = resp.get("nextPageToken")
            if not page_token or len(ids) >= max_results:
                break
        return ids[:max_results]

    def get_message(self, message_id: str) -> GmailMessage:
        """Fetch a single message in ``format=full`` and normalize it."""
        svc = self._svc()
        raw = svc.users().messages().get(userId="me", id=message_id, format="full").execute()
        return _normalize_message(raw)

    def search(self, query: str, *, max_results: int = 500) -> list[GmailMessage]:
        """Convenience: search + fetch in one call."""
        ids = self.search_ids(query, max_results=max_results)
        return [self.get_message(mid) for mid in ids]


# ----------------------------------------------------------------------
#  Message normalization
# ----------------------------------------------------------------------


def _normalize_message(raw: dict[str, Any]) -> GmailMessage:
    payload = raw.get("payload", {}) or {}
    headers = {h["name"].lower(): h.get("value", "") for h in payload.get("headers", [])}

    from_addr = headers.get("from", "").strip()
    subject = headers.get("subject", "").strip()

    # Prefer the Gmail-supplied internalDate (ms since epoch, UTC) over parsing
    # the Date header — it's the server-received time and doesn't lie.
    internal_ms = int(raw.get("internalDate", "0"))
    received_at = datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc)

    return GmailMessage(
        gmail_message_id=raw["id"],
        gmail_thread_id=raw.get("threadId"),
        from_address=from_addr,
        from_domain=_extract_domain(from_addr),
        subject=subject,
        received_at=received_at,
        snippet=raw.get("snippet", "") or "",
        body_plain=extract_plain_text(payload),
        headers=headers,
    )


def _extract_domain(from_address: str) -> str:
    """Pull the RFC 5322 domain out of a ``From`` header.

    Handles:  "Chase <alerts@chase.com>"   → chase.com
              "alerts@chase.com"           → chase.com
              "Chase Alerts" <a@b.c>        → b.c
    """
    addr = from_address
    if "<" in addr and ">" in addr:
        addr = addr[addr.rfind("<") + 1 : addr.rfind(">")]
    _, _, domain = addr.partition("@")
    return domain.strip().lower()


def extract_plain_text(payload: dict[str, Any], *, max_chars: int = 50_000) -> str:
    """Walk a Gmail MIME tree and return plain text.

    Strategy, in order of preference:
      1. Any ``text/plain`` part (concatenate if multiple)
      2. Else walk ``text/html`` parts, strip tags with BeautifulSoup
      3. Else empty string (attachment-only weirdness)

    Truncated to ``max_chars`` — we don't need the whole thing, and SQLite
    TEXT is fine with long values but there's no reason to store 500KB
    marketing emails.
    """
    plain_parts: list[str] = []
    html_parts: list[str] = []

    def walk(part: dict[str, Any]) -> None:
        mime = part.get("mimeType", "")
        body = part.get("body", {}) or {}
        data = body.get("data")
        if data:
            try:
                decoded = base64.urlsafe_b64decode(data + "==" * (-len(data) % 4)).decode(
                    "utf-8", errors="replace"
                )
            except Exception:  # malformed base64; ignore this part
                decoded = ""
            if mime == "text/plain":
                plain_parts.append(decoded)
            elif mime == "text/html":
                html_parts.append(decoded)
        for sub in part.get("parts", []) or []:
            walk(sub)

    walk(payload)

    if plain_parts:
        text = "\n\n".join(plain_parts)
    elif html_parts:
        text = _html_to_text("\n\n".join(html_parts))
    else:
        text = ""

    text = text.strip()
    if len(text) > max_chars:
        text = text[:max_chars] + "\n\n…[truncated]"
    return text


def _html_to_text(html: str) -> str:
    try:
        from bs4 import BeautifulSoup
    except ImportError:  # fall back to a crude regex strip
        import re

        return re.sub(r"<[^>]+>", " ", html)
    soup = BeautifulSoup(html, "html.parser")
    # Drop script/style contents before get_text to avoid noise
    for tag in soup(("script", "style")):
        tag.decompose()
    return soup.get_text(separator="\n")


# ----------------------------------------------------------------------
#  Dep detection + lazy import
# ----------------------------------------------------------------------


def _deps_available() -> bool:
    try:
        import googleapiclient  # noqa: F401
        import google.auth  # noqa: F401
        import google_auth_oauthlib  # noqa: F401
    except ImportError:
        return False
    return True


def _import_google() -> tuple[Any, Any, Any, Any]:
    """Resolve the google-* symbols or raise GmailDependenciesMissing."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise GmailDependenciesMissing(
            "Gmail support requires `pip install -e \".[dev]\"` (google-api-python-client, "
            "google-auth, google-auth-oauthlib)."
        ) from exc
    return Credentials, InstalledAppFlow, Request, build
