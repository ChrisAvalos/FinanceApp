"""Standalone OAuth flow for Gmail.

Why this exists:
    The /gmail/authorize HTTP endpoint blocks a uvicorn worker thread
    inside flow.run_local_server() for as long as it takes the user to
    click through Google's consent screen. HTTP clients (curl,
    Invoke-RestMethod) have their own timeouts and the request can fail
    even when the OAuth itself succeeds. Running OAuth as a one-shot
    script avoids that — opens the browser, listens for the redirect,
    persists ./gmail_token.json, exits.

Usage (from the backend/ directory, with .venv activated):

    py scripts/authorize_gmail.py

Prereqs:
    1. Backend's .venv has google-api-python-client + google-auth-oauthlib.
    2. ``gmail_credentials.json`` must exist at the path settings expects
       (default: ``./gmail_credentials.json`` relative to where the
       backend was started). To get one:

         a. https://console.cloud.google.com/apis/credentials
         b. + Create Credentials → OAuth client ID → Application type:
            Desktop app → name it whatever (e.g. "Finance App local")
         c. After creation click ⬇ and save as ``gmail_credentials.json``
            in the backend/ directory.

    On first run a browser tab opens — sign in with the Gmail account you
    want to read, click through the warning ("Google hasn't verified this
    app — proceed anyway"), and grant the read-only scope. Token is
    written to ``./gmail_token.json`` and reused on subsequent backend
    starts; you only do this once per machine.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running from either backend/ or backend/scripts/
HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from finance_app.gmail.client import (  # noqa: E402
    GmailClient,
    GmailDependenciesMissing,
    GmailNotConfigured,
)


def main() -> int:
    client = GmailClient()
    status = client.status()

    print("Gmail OAuth setup")
    print("=" * 50)
    print(f"  credentials_path: {status['credentials_path']}")
    print(f"  credentials_present: {status['credentials_present']}")
    print(f"  token_path: {status['token_path']}")
    print(f"  token_present: {status['token_present']}")
    print(f"  deps_installed: {status['deps_installed']}")
    print(f"  scopes: {status['scopes']}")
    print()

    if not status["deps_installed"]:
        print("ERROR: google-api-python-client / google-auth-oauthlib not installed.")
        print("  Run: pip install google-api-python-client google-auth-oauthlib")
        return 1

    if not status["credentials_present"]:
        print("ERROR: gmail_credentials.json not found.")
        print(f"  Expected at: {status['credentials_path']}")
        print()
        print("  To create it:")
        print("  1. https://console.cloud.google.com/apis/credentials")
        print("  2. + Create Credentials → OAuth client ID → Desktop app")
        print(f"  3. Download the JSON and save as gmail_credentials.json")
        print(f"     at {status['credentials_path']}")
        print("  Then re-run this script.")
        return 1

    if status["token_present"]:
        print("Token already exists. Validating + refreshing if needed...")
        try:
            client.authorize(interactive=False)
            print("OK — existing token is valid. No action needed.")
            return 0
        except GmailNotConfigured:
            print("Existing token is unusable — running re-consent flow.")
        except Exception as exc:  # noqa: BLE001
            print(f"Existing token check failed: {exc!r}")
            print("Running re-consent flow.")

    print("Starting OAuth flow — a browser tab will open shortly.")
    print("After granting access, this script will exit.")
    print()
    try:
        client.authorize(interactive=True)
    except GmailDependenciesMissing as exc:
        print(f"ERROR: dependencies missing: {exc}")
        return 1
    except GmailNotConfigured as exc:
        print(f"ERROR: not configured: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: authorize failed: {exc!r}")
        return 1

    print()
    print("SUCCESS — token written to:", status["token_path"])
    print("You can now click 'Sync Gmail' in the web UI.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
