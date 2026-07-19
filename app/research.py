"""Funeral-home discovery + market research (Slice 3, v0-instruction.md §7 M3).

- Google Places API (New) Text Search -> name, phone, address, rating.
  Phone comes back directly in the field mask, so no separate Place Details call.
- Tavily -> local market-price context, used later as negotiation ammunition.
- DEMO_MODE: swap Places results for the teammate phone numbers in DEMO_TARGETS
  (never call real funeral homes — see v0-instruction.md §10).

`run_research(case_id)` is the orchestration entrypoint: reads user_info.json,
writes funeral_homes.json + market_research.json, advances case status.
"""

from __future__ import annotations

import logging
import re

import httpx

from . import storage
from .config import settings

log = logging.getLogger("grace")

PLACES_URL = "https://places.googleapis.com/v1/places:searchText"
TAVILY_URL = "https://api.tavily.com/search"

# Cap for the hackathon — a handful of homes is enough to demo compare/negotiate.
DEFAULT_LIMIT = 5


def _to_e164(phone: str) -> str:
    """Best-effort normalize a formatted number to E.164 for the calling API."""
    if not phone:
        return ""
    digits = re.sub(r"[^\d+]", "", phone)
    if digits.startswith("+"):
        return digits
    if len(digits) == 10:  # bare US number
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return digits


def _fh_id(i: int) -> str:
    return f"fh_{i:03d}"


def _demo_homes(limit: int) -> list[dict]:
    homes = []
    for i, number in enumerate(settings.demo_target_list[:limit], start=1):
        homes.append(
            {
                "id": _fh_id(i),
                "name": f"Demo Funeral Home {i} (role-play)",
                "phone": _to_e164(number),
                "address": "",
                "rating": None,
                "source": "demo",
            }
        )
    return homes


def find_funeral_homes(city: str, state: str, limit: int = DEFAULT_LIMIT) -> list[dict]:
    """Return up to `limit` funeral homes as funeral_homes.json entries.

    Honors DEMO_MODE (returns teammate role-play numbers). Otherwise queries the
    Google Places API (New) Text Search.
    """
    if settings.demo_mode:
        homes = _demo_homes(limit)
        log.info("research: DEMO_MODE — %d role-play homes", len(homes))
        return homes

    if not settings.google_places_api_key:
        raise RuntimeError("GOOGLE_PLACES_API_KEY is not set")

    query = f"funeral homes in {city}, {state}".strip().strip(",")
    resp = httpx.post(
        PLACES_URL,
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": settings.google_places_api_key,
            "X-Goog-FieldMask": (
                "places.displayName,places.internationalPhoneNumber,"
                "places.formattedAddress,places.rating"
            ),
        },
        json={"textQuery": query},
        timeout=30,
    )
    if resp.status_code >= 300:
        raise RuntimeError(f"Places search failed [{resp.status_code}]: {resp.text}")

    places = resp.json().get("places", []) or []
    homes = []
    for i, p in enumerate(places[:limit], start=1):
        homes.append(
            {
                "id": _fh_id(i),
                "name": (p.get("displayName") or {}).get("text", ""),
                "phone": _to_e164(p.get("internationalPhoneNumber", "")),
                "address": p.get("formattedAddress", ""),
                "rating": p.get("rating"),
                "source": "google_places",
            }
        )
    log.info("research: Places returned %d homes for %r", len(homes), query)
    return homes


def market_prices(city: str, service_type: str) -> dict:
    """Tavily market-context summary for negotiation ammunition.

    Returns {} (logged) if Tavily isn't configured or errors — market context is
    nice-to-have, not required to proceed to quotes.
    """
    if not settings.tavily_api_key:
        log.warning("research: TAVILY_API_KEY not set, skipping market research")
        return {}

    query = f"average {service_type} funeral cost in {city} 2026"
    try:
        resp = httpx.post(
            TAVILY_URL,
            headers={"Authorization": f"Bearer {settings.tavily_api_key}"},
            json={
                "query": query,
                "search_depth": "basic",
                "max_results": 5,
                "include_answer": "advanced",
                "topic": "general",
            },
            timeout=30,
        )
        if resp.status_code >= 300:
            log.warning("research: Tavily failed [%s]: %s", resp.status_code, resp.text[:200])
            return {}
        data = resp.json()
    except httpx.HTTPError as e:
        log.warning("research: Tavily request error: %s", e)
        return {}

    return {
        "query": query,
        "answer": data.get("answer", ""),
        "sources": [
            {"title": r.get("title", ""), "url": r.get("url", ""), "score": r.get("score")}
            for r in (data.get("results") or [])
        ],
    }


def run_research(case_id: str) -> dict:
    """Read user_info.json -> write funeral_homes.json + market_research.json.

    Idempotent-friendly: safe to re-run (overwrites outputs). On discovery
    failure the case is marked research_failed and the error is returned rather
    than raised (called best-effort from the webhook background task).
    """
    user_info = storage.read_json(case_id, "user_info.json")
    if user_info is None:
        raise ValueError(f"run_research: no user_info.json for case {case_id}")

    loc = user_info.get("location") or {}
    city = loc.get("city") or ""
    state = loc.get("state") or ""
    service_type = user_info.get("service_type") or "funeral"

    storage.set_status(case_id, "researching")
    try:
        homes = find_funeral_homes(city, state)
    except Exception as e:
        log.error("research failed case=%s: %s", case_id, e)
        storage.set_status(case_id, "research_failed")
        return {"ok": False, "error": str(e)}

    storage.save_json(case_id, "funeral_homes.json", homes)
    market = market_prices(city, service_type)
    if market:
        storage.save_json(case_id, "market_research.json", market)

    # Ready for Slice 4 to place quote calls.
    storage.set_status(case_id, "calling_for_quotes")
    log.info(
        "research done case=%s homes=%d market=%s",
        case_id, len(homes), "yes" if market else "no",
    )
    return {"ok": True, "homes": len(homes), "market": bool(market)}
