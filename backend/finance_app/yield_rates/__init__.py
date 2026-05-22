"""Live rate-snapshot fetcher for the yield-arb optimizer.

Why this exists
---------------
Yield-opt previously hardcoded T-bill APYs and HYSA rates. Those go
stale within weeks. This module pulls live yields from FRED (St.
Louis Fed) when an API key is configured, falls back to the
publicly-available Treasury.gov daily yield curve when not, and
finally falls back to the hardcoded rates baked into yield_opt.py.

Public surface
--------------
``fetch_live_rates() -> LiveRates | None``
    One-shot fetch. Tries FRED first if ``settings.fred_api_key`` is
    set, otherwise Treasury.gov. Returns None on total failure (so
    callers know to use the hardcoded fallback).

``cached_rates() -> LiveRates | None``
    Read from the JSON cache without hitting the network. Used on
    every yield-opt request so the panel stays fast.

``refresh_rates_cache() -> LiveRates | None``
    Fetch and persist to disk. Call from a scheduler job.

The cache file lives at ``data/yield_rates_cache.json`` next to the
SQLite DB so it survives restarts.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import httpx

from finance_app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class LiveRates:
    """One snapshot of T-bill APYs (HYSA snapshot is harder to get
    canonically, so we apply a fixed offset to the 4-week yield as a
    proxy — best HYSAs typically hover within ±25bps of the 4-week
    Treasury)."""
    fetched_at: str  # ISO-8601 UTC
    source: str      # "fred" | "treasury_gov"
    tbill_4wk_apy: float
    tbill_13wk_apy: float
    tbill_26wk_apy: float
    # Derived: best HYSA tends to track 4w − ~10 bps after spread.
    # Surface separately so the optimizer can choose how to use it.
    hysa_top_apy_estimate: float


def _cache_path() -> Path:
    """JSON cache lives alongside the SQLite DB."""
    db_path = Path(settings.db_url.replace("sqlite:///", ""))
    cache_dir = db_path.parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "yield_rates_cache.json"


def _from_dict(d: dict) -> LiveRates:
    return LiveRates(
        fetched_at=d["fetched_at"],
        source=d["source"],
        tbill_4wk_apy=float(d["tbill_4wk_apy"]),
        tbill_13wk_apy=float(d["tbill_13wk_apy"]),
        tbill_26wk_apy=float(d["tbill_26wk_apy"]),
        hysa_top_apy_estimate=float(d["hysa_top_apy_estimate"]),
    )


def cached_rates() -> LiveRates | None:
    """Read the on-disk cache. Returns None when the file is missing
    or unparseable. Never raises — callers fall through to hardcoded."""
    p = _cache_path()
    if not p.exists():
        return None
    try:
        return _from_dict(json.loads(p.read_text()))
    except Exception:  # noqa: BLE001
        return None


def _persist(rates: LiveRates) -> None:
    p = _cache_path()
    p.write_text(json.dumps(asdict(rates), indent=2))


# ---------- Source 1: FRED (requires FRED_API_KEY) ----------

_FRED_SERIES = {
    "tbill_4wk_apy": "DGS1MO",
    "tbill_13wk_apy": "DGS3MO",
    "tbill_26wk_apy": "DGS6MO",
}


def _fetch_from_fred(api_key: str, *, timeout: float = 8.0) -> LiveRates | None:
    """Hit FRED for the latest observation of each T-bill series."""
    base = "https://api.stlouisfed.org/fred/series/observations"
    out: dict[str, float] = {}
    try:
        with httpx.Client(timeout=timeout) as client:
            for field, series_id in _FRED_SERIES.items():
                resp = client.get(
                    base,
                    params={
                        "series_id": series_id,
                        "api_key": api_key,
                        "file_type": "json",
                        "sort_order": "desc",
                        "limit": 5,  # in case the most recent is `.` (no-data)
                    },
                )
                resp.raise_for_status()
                obs = resp.json().get("observations", [])
                # FRED returns "." for non-trading days; pick the first
                # numeric observation.
                value: float | None = None
                for o in obs:
                    raw = o.get("value", ".")
                    if raw and raw != ".":
                        try:
                            value = float(raw)
                            break
                        except ValueError:
                            continue
                if value is None:
                    return None  # no recent observations — bail
                out[field] = value
    except Exception:  # noqa: BLE001 — network/parse failures are non-fatal
        logger.exception("FRED fetch failed")
        return None
    # Best HYSA tends to track the 4-week yield within ~10 bps after spread.
    hysa_est = out["tbill_4wk_apy"] - 0.10
    return LiveRates(
        fetched_at=datetime.utcnow().isoformat() + "Z",
        source="fred",
        tbill_4wk_apy=out["tbill_4wk_apy"],
        tbill_13wk_apy=out["tbill_13wk_apy"],
        tbill_26wk_apy=out["tbill_26wk_apy"],
        hysa_top_apy_estimate=max(hysa_est, 0.0),
    )


# ---------- Source 2: Treasury.gov daily yield curve XML ----------

_TREASURY_FEED = (
    "https://home.treasury.gov/sites/default/files/interest-rates/"
    "yield.xml"
)


def _fetch_from_treasury(*, timeout: float = 8.0) -> LiveRates | None:
    """Public Treasury.gov daily yield curve. No API key required.

    The feed is XML; we parse out BC_4WEEK / BC_3MONTH / BC_6MONTH
    nodes from the most recent entry. Lazy import xml.etree to keep
    the cold-import path tight.
    """
    import xml.etree.ElementTree as ET  # local import — used only here

    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.get(_TREASURY_FEED)
            resp.raise_for_status()
            root = ET.fromstring(resp.text)
    except Exception:  # noqa: BLE001
        logger.exception("Treasury.gov fetch failed")
        return None

    # The XML feed has entries; we want the latest.
    ns = {"a": "http://www.w3.org/2005/Atom",
          "m": "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata",
          "d": "http://schemas.microsoft.com/ado/2007/08/dataservices"}
    entries = root.findall("a:entry", ns)
    if not entries:
        return None
    last = entries[-1]
    props = last.find(".//m:properties", ns)
    if props is None:
        return None

    def _val(tag: str) -> float | None:
        el = props.find(f"d:{tag}", ns)
        if el is None or not el.text:
            return None
        try:
            return float(el.text)
        except ValueError:
            return None

    four_wk = _val("BC_4WEEK")
    three_mo = _val("BC_3MONTH")
    six_mo = _val("BC_6MONTH")
    if four_wk is None or three_mo is None or six_mo is None:
        return None

    hysa_est = four_wk - 0.10
    return LiveRates(
        fetched_at=datetime.utcnow().isoformat() + "Z",
        source="treasury_gov",
        tbill_4wk_apy=four_wk,
        tbill_13wk_apy=three_mo,
        tbill_26wk_apy=six_mo,
        hysa_top_apy_estimate=max(hysa_est, 0.0),
    )


def fetch_live_rates() -> LiveRates | None:
    """One-shot fetch. Tries FRED if configured, then Treasury.gov."""
    api_key = getattr(settings, "fred_api_key", None) or ""
    if api_key:
        rates = _fetch_from_fred(api_key)
        if rates is not None:
            return rates
    return _fetch_from_treasury()


def refresh_rates_cache() -> LiveRates | None:
    """Fetch live + persist. Returns the new snapshot or None on failure.

    Idempotent — overwrites the cache on success. On failure, the
    previous cached value (if any) stays in place.
    """
    rates = fetch_live_rates()
    if rates is None:
        return None
    try:
        _persist(rates)
    except Exception:  # noqa: BLE001
        logger.exception("yield rate cache write failed")
    return rates
