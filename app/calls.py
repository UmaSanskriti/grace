"""Sequential outbound quote-call loop (Slice 4, v0-instruction.md §7 M4).

One call at a time (simpler, avoids webhook races): place a quote call to the
next funeral home, and when its post-call webhook arrives, extract the quote and
place the next call — until every home has a result, then -> quotes_collected.

DEMO safety: when DEMO_MODE is on, only numbers in DEMO_TARGETS are ever dialed.
Any home whose phone isn't a DEMO_TARGET is marked unreachable and skipped, so a
stale non-demo funeral_homes.json can never place a real call.
"""

from __future__ import annotations

import logging

from . import storage
from .config import settings
from .elevenlabs_client import ElevenLabsError, outbound_call
from .extraction import extract_final_price, extract_quote

log = logging.getLogger("grace")


def _money(x: object) -> str:
    return f"${x:,.0f}" if isinstance(x, (int, float)) else ""


def _quote_rel(fh_id: str) -> str:
    return f"quotes/{fh_id}.json"


def _home_by_id(homes: list[dict], fh_id: str) -> dict | None:
    return next((h for h in homes if h.get("id") == fh_id), None)


def _mark_unreachable(case_id: str, home: dict, reason: str) -> None:
    fh_id = home.get("id", "unknown")
    storage.save_json(
        case_id,
        _quote_rel(fh_id),
        {
            "funeral_home_id": fh_id,
            "funeral_home_name": home.get("name", ""),
            "call_id": None,
            "reached": False,
            "quoted_price_usd": None,
            "status": "unreachable",
            "notes": reason,
        },
    )
    log.info("quote home unreachable case=%s fh=%s: %s", case_id, fh_id, reason)


def _quote_dynamic_vars(case_id: str, home: dict, user_info: dict) -> dict[str, str]:
    loc = user_info.get("location") or {}
    return {
        "case_id": case_id,
        "agent_type": "quote",
        "fh_id": home.get("id", ""),
        "service_type": user_info.get("service_type") or "",
        "city": loc.get("city") or "",
        "state": loc.get("state") or "",
        "timeline": user_info.get("timeline") or "",
        "attendee_count": str(user_info.get("attendee_estimate") or ""),
    }


def start_next_quote_call(case_id: str) -> dict:
    """Place a quote call to the next un-quoted home, or finish the round.

    Skips (marking unreachable) homes with no phone, or — in DEMO_MODE — any
    phone not in DEMO_TARGETS, continuing until a call is placed or none remain.
    """
    case = storage.read_case(case_id)
    if not case or case.get("status") != "calling_for_quotes":
        return {"skipped": f"status is {case.get('status') if case else None!r}"}

    homes = storage.read_json(case_id, "funeral_homes.json") or []
    user_info = storage.read_json(case_id, "user_info.json") or {}

    for home in homes:
        fh_id = home.get("id", "")
        if storage.read_json(case_id, _quote_rel(fh_id)) is not None:
            continue  # already has a quote or an unreachable marker

        phone = home.get("phone", "")
        if not phone:
            _mark_unreachable(case_id, home, "no phone number")
            continue
        if settings.demo_mode and phone not in settings.demo_target_list:
            _mark_unreachable(case_id, home, "skipped: not a DEMO_TARGET in DEMO_MODE")
            continue

        if not settings.elevenlabs_quote_agent_id:
            return {"error": "ELEVENLABS_QUOTE_AGENT_ID not set"}
        try:
            resp = outbound_call(
                agent_id=settings.elevenlabs_quote_agent_id,
                to_number=phone,
                dynamic_variables=_quote_dynamic_vars(case_id, home, user_info),
            )
        except ElevenLabsError as e:
            _mark_unreachable(case_id, home, f"call failed: {e}")
            continue

        conv = resp.get("conversation_id", "")
        if conv:
            storage.index_conversation(conv, case_id, "quote", fh_id)
        log.info(
            "placed quote call case=%s fh=%s to=%s conversation_id=%s",
            case_id, fh_id, phone, conv,
        )
        return {"placed": fh_id, "conversation_id": conv}

    # Nothing left to call.
    storage.set_status(case_id, "quotes_collected")
    log.info("all quotes collected case=%s", case_id)
    return {"done": True, "status": "quotes_collected"}


def handle_quote_result(case_id: str, fh_id: str | None, conversation_id: str, transcript: str) -> None:
    """Extract + save a quote from a finished call, then place the next one.

    Idempotent: re-skips extraction if the quote is already recorded (webhook
    retries). Extraction/empty-transcript failures mark the home unreachable so
    the loop always advances.
    """
    if not fh_id:
        log.warning("quote webhook without fh_id case=%s — cannot record", case_id)
        return

    if storage.read_json(case_id, _quote_rel(fh_id)) is not None:
        log.info("quote already recorded case=%s fh=%s, skipping extract", case_id, fh_id)
    else:
        homes = storage.read_json(case_id, "funeral_homes.json") or []
        home = _home_by_id(homes, fh_id) or {"id": fh_id, "name": ""}
        if not transcript.strip():
            _mark_unreachable(case_id, home, "empty transcript / no answer")
        else:
            try:
                quote = extract_quote(transcript)
            except Exception as e:  # LLM / validation failure
                _mark_unreachable(case_id, home, f"extraction failed: {e}")
            else:
                record = {
                    "funeral_home_id": fh_id,
                    "funeral_home_name": home.get("name", ""),
                    "call_id": conversation_id,
                    "transcript_path": f"transcripts/{fh_id}_{conversation_id}.txt",
                    **quote,
                }
                storage.save_json(case_id, _quote_rel(fh_id), record)
                log.info(
                    "quote recorded case=%s fh=%s reached=%s price=%s",
                    case_id, fh_id, quote.get("reached"), quote.get("quoted_price_usd"),
                )

    # Chain the next home (or finish the round).
    start_next_quote_call(case_id)


# --- negotiation loop (Slice 5) --------------------------------------------

def _nego_rel(fh_id: str) -> str:
    return f"negotiations/{fh_id}.json"


def _mark_nego_unreachable(case_id: str, fh_id: str, name: str, reason: str) -> None:
    storage.save_json(
        case_id,
        _nego_rel(fh_id),
        {
            "funeral_home_id": fh_id,
            "funeral_home_name": name,
            "call_id": None,
            "agreed": False,
            "final_price_usd": None,
            "status": "unreachable",
            "notes": reason,
        },
    )
    log.info("nego home unreachable case=%s fh=%s: %s", case_id, fh_id, reason)


def _nego_dynamic_vars(case_id: str, home: dict, quote: dict, hs: dict, user_info: dict) -> dict[str, str]:
    return {
        "case_id": case_id,
        "agent_type": "nego",
        "fh_id": home.get("id", ""),
        "funeral_home_name": home.get("name") or quote.get("funeral_home_name", ""),
        "service_type": user_info.get("service_type") or "",
        "current_price": _money(hs.get("current_price_usd") or quote.get("quoted_price_usd")),
        "target_price": _money(hs.get("target_price_usd")),
        "walk_away_price": _money(hs.get("walk_away_price_usd")),
        "leverage": "; ".join(hs.get("leverage") or []) or "the local market average",
    }


def start_next_nego_call(case_id: str) -> dict:
    """Place a negotiation call to the next shortlisted home, or finish + report."""
    case = storage.read_case(case_id)
    if not case or case.get("status") not in ("strategy_ready", "negotiating"):
        return {"skipped": f"status is {case.get('status') if case else None!r}"}

    strategy = storage.read_json(case_id, "strategy.json") or {}
    per_home = {s.get("funeral_home_id"): s for s in strategy.get("per_home_strategy", [])}
    shortlist = strategy.get("shortlist") or list(per_home.keys())
    homes = storage.read_json(case_id, "funeral_homes.json") or []
    user_info = storage.read_json(case_id, "user_info.json") or {}

    for fh_id in shortlist:
        if storage.read_json(case_id, _nego_rel(fh_id)) is not None:
            continue
        home = _home_by_id(homes, fh_id) or {"id": fh_id, "name": ""}
        quote = storage.read_json(case_id, _quote_rel(fh_id)) or {}
        hs = per_home.get(fh_id, {})
        name = home.get("name") or quote.get("funeral_home_name", "")

        phone = home.get("phone", "")
        if not phone:
            _mark_nego_unreachable(case_id, fh_id, name, "no phone number")
            continue
        if settings.demo_mode and phone not in settings.demo_target_list:
            _mark_nego_unreachable(case_id, fh_id, name, "skipped: not a DEMO_TARGET in DEMO_MODE")
            continue

        if not settings.elevenlabs_nego_agent_id:
            return {"error": "ELEVENLABS_NEGO_AGENT_ID not set"}
        try:
            resp = outbound_call(
                agent_id=settings.elevenlabs_nego_agent_id,
                to_number=phone,
                dynamic_variables=_nego_dynamic_vars(case_id, home, quote, hs, user_info),
            )
        except ElevenLabsError as e:
            _mark_nego_unreachable(case_id, fh_id, name, f"call failed: {e}")
            continue

        conv = resp.get("conversation_id", "")
        if conv:
            storage.index_conversation(conv, case_id, "nego", fh_id)
        storage.set_status(case_id, "negotiating")
        log.info(
            "placed nego call case=%s fh=%s to=%s conversation_id=%s",
            case_id, fh_id, phone, conv,
        )
        return {"placed": fh_id, "conversation_id": conv}

    # Shortlist exhausted -> produce the final report.
    from . import report  # lazy import to avoid a cycle
    report.generate_report(case_id)
    storage.set_status(case_id, "done")
    log.info("negotiations complete case=%s -> done", case_id)
    return {"done": True, "status": "done"}


def handle_nego_result(case_id: str, fh_id: str | None, conversation_id: str, transcript: str) -> None:
    """Extract + save a negotiation outcome, then place the next one (or report)."""
    if not fh_id:
        log.warning("nego webhook without fh_id case=%s — cannot record", case_id)
        return

    if storage.read_json(case_id, _nego_rel(fh_id)) is not None:
        log.info("nego already recorded case=%s fh=%s, skipping extract", case_id, fh_id)
    else:
        homes = storage.read_json(case_id, "funeral_homes.json") or []
        home = _home_by_id(homes, fh_id) or {"id": fh_id, "name": ""}
        quote = storage.read_json(case_id, _quote_rel(fh_id)) or {}
        name = home.get("name") or quote.get("funeral_home_name", "")
        if not transcript.strip():
            _mark_nego_unreachable(case_id, fh_id, name, "empty transcript / no answer")
        else:
            try:
                outcome = extract_final_price(transcript)
            except Exception as e:
                _mark_nego_unreachable(case_id, fh_id, name, f"extraction failed: {e}")
            else:
                record = {
                    "funeral_home_id": fh_id,
                    "funeral_home_name": name,
                    "call_id": conversation_id,
                    "transcript_path": f"transcripts/{fh_id}_{conversation_id}.txt",
                    **outcome,
                }
                storage.save_json(case_id, _nego_rel(fh_id), record)
                log.info(
                    "nego recorded case=%s fh=%s agreed=%s final=%s",
                    case_id, fh_id, outcome.get("agreed"), outcome.get("final_price_usd"),
                )

    start_next_nego_call(case_id)
