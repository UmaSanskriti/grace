"""Deliver the finished report to the family by voice (spec 2026-07-19).

SMS was the original plan (the Twilio settings in config.py are its remnant),
but it isn't available to us, so a fourth ElevenLabs agent calls the family and
reads them the outcome.

report.py turns case data into a document; this module gets that document
spoken down a phone line. Keeping them apart means the document generator never
learns about phone numbers, DEMO_MODE, or ElevenLabs failures — and it means
`generate_report` stays testable without a phone.
"""

from __future__ import annotations

import logging

from openai import OpenAI

from . import storage
from .config import settings
from .elevenlabs_client import ElevenLabsError, outbound_call
from .extraction import _EXTRACTION_MODEL_DEFAULT, _extraction_prompt

log = logging.getLogger("grace")

# Denials, not blanks. An empty variable inside an assertive sentence is what
# let the negotiation agent invent a competitor quote (see _competing_disclosure
# in calls.py); the report agent gets the same treatment.
NO_RECOMMENDATION = "no clear recommendation — see the written report"
NO_PRICE = "no confirmed price"
DEFAULT_CONTACT_NAME = "there"  # "Hello there" reads naturally; "Hello " does not


def _money(x: object) -> str:
    return f"${x:,.0f}" if isinstance(x, (int, float)) else ""


def _homes_called(case_id: str) -> int:
    qdir = storage.case_dir(case_id) / "quotes"
    return len(list(qdir.glob("*.json"))) if qdir.exists() else 0


def _best_home(case_id: str) -> tuple[str, object]:
    """(name, price) of the cheapest home with a confirmed number, else ("", None).

    Derived from the quote/negotiation records rather than parsed out of the
    report markdown, so the agent's opening line is right even when the spoken
    summary is the fallback string. A negotiated price supersedes the home's
    original quote; homes we never reached are ignored.
    """
    negos: dict[str, dict] = {}
    ndir = storage.case_dir(case_id) / "negotiations"
    if ndir.exists():
        for p in sorted(ndir.glob("*.json")):
            n = storage.read_json(case_id, f"negotiations/{p.name}") or {}
            if n.get("funeral_home_id"):
                negos[n["funeral_home_id"]] = n

    best_name, best_price = "", None
    qdir = storage.case_dir(case_id) / "quotes"
    if not qdir.exists():
        return best_name, best_price
    for p in sorted(qdir.glob("*.json")):
        q = storage.read_json(case_id, f"quotes/{p.name}") or {}
        if not q.get("reached"):
            continue
        fh_id = q.get("funeral_home_id") or ""
        nego = negos.get(fh_id, {})
        # `_validate_final_price` (extraction.py) only type-checks final_price_usd;
        # it never enforces the extraction prompt's "if nothing was agreed, use
        # null" rule. So an unagreed negotiation can still carry a non-null
        # final_price_usd, and without this gate we'd read it out to the family
        # as the confirmed price. Only trust it when agreed is explicitly True.
        price = nego.get("final_price_usd") if nego.get("agreed") is True else None
        if price is None:
            price = q.get("quoted_price_usd")
        if not isinstance(price, (int, float)):
            continue
        if best_price is None or price < best_price:
            best_price = price
            best_name = (
                nego.get("funeral_home_name") or q.get("funeral_home_name") or fh_id
            )
    return best_name, best_price


def _fallback_summary(case_id: str) -> str:
    """Deterministic prose if the LLM is unavailable — flat, but never blank."""
    name, price = _best_home(case_id)
    if name and price is not None:
        rec = f"Our recommendation is {name} at {_money(price)}."
    else:
        rec = "We were not able to confirm a price."
    return (
        f"We called {_homes_called(case_id)} funeral homes for you. {rec} "
        "The full written report is ready for you."
    )


def summarize_for_speech(case_id: str, md: str) -> tuple[str, str]:
    """Turn report.md into spoken prose. Returns (text, "llm" | "fallback").

    Never raises and never returns an empty string: a degraded summary is always
    better than handing the agent a blank to improvise around.
    """
    try:
        client = OpenAI(api_key=settings.openai_api_key)
        model = getattr(settings, "openai_extraction_model", "") or _EXTRACTION_MODEL_DEFAULT
        resp = client.responses.create(
            model=model,
            input=[
                {"role": "system", "content": _extraction_prompt("report_speech.md")},
                {"role": "user", "content": "REPORT:\n" + md},
            ],
        )
        text = (resp.output_text or "").strip()
        if text:
            return text, "llm"
        log.error("speech summary empty case=%s — using fallback", case_id)
    except Exception as e:  # LLM down / model unavailable — still make the call
        log.error("speech summary failed case=%s: %s — using fallback", case_id, e)
    try:
        return _fallback_summary(case_id), "fallback"
    except Exception as e:  # corrupt/unreadable JSON under quotes/ or negotiations/
        log.error("fallback summary failed case=%s: %s — using hardcoded fallback", case_id, e)
        return (
            "We have finished calling funeral homes for you, and your written "
            "report is ready."
        ), "fallback"


def _dynamic_vars(case_id: str, summary: str) -> dict[str, str]:
    user_info = storage.read_json(case_id, "user_info.json") or {}
    name, price = _best_home(case_id)
    return {
        "case_id": case_id,
        "agent_type": "report",
        "contact_name": (user_info.get("contact_name") or "").strip() or DEFAULT_CONTACT_NAME,
        "report_summary": summary,
        "recommended_home": name or NO_RECOMMENDATION,
        "final_price": _money(price) or NO_PRICE,
    }


def _record(
    case_id: str,
    status: str,
    *,
    call_id: str | None = None,
    to_number: str | None = None,
    summary_source: str | None = None,
    notes: str = "",
) -> dict:
    rec = {
        "status": status,
        "call_id": call_id,
        "to_number": to_number,
        "summary_source": summary_source,
        "notes": notes,
    }
    storage.save_json(case_id, "report_call.json", rec)
    log.info("report call case=%s status=%s notes=%s", case_id, status, notes)
    return rec


def _deliver(case_id: str, md: str) -> dict:
    if storage.is_aborted(case_id):
        return _record(case_id, "aborted", notes="case aborted")
    if not settings.elevenlabs_report_agent_id:
        return _record(case_id, "skipped", notes="ELEVENLABS_REPORT_AGENT_ID not set")

    phone = (storage.read_case(case_id) or {}).get("user_phone") or ""
    if not phone:
        return _record(case_id, "skipped", notes="no user phone on file")
    if settings.demo_mode and phone not in settings.demo_target_list:
        return _record(
            case_id, "skipped", to_number=phone,
            notes="skipped: not a DEMO_TARGET in DEMO_MODE",
        )

    summary, source = summarize_for_speech(case_id, md)
    try:
        resp = outbound_call(
            agent_id=settings.elevenlabs_report_agent_id,
            to_number=phone,
            dynamic_variables=_dynamic_vars(case_id, summary),
        )
    except ElevenLabsError as e:
        return _record(
            case_id, "failed", to_number=phone, summary_source=source, notes=str(e),
        )

    conv = resp.get("conversation_id", "")
    if conv:
        storage.index_conversation(conv, case_id, "report")
    log.info("placed report call case=%s to=%s conversation_id=%s", case_id, phone, conv)
    return _record(
        case_id, "placed", call_id=conv or None, to_number=phone, summary_source=source,
    )


def deliver_report(case_id: str, md: str) -> dict:
    """Call the family and read them the report. Returns the report_call.json record.

    Never raises. The written report is the deliverable of record, so a call
    that cannot be placed must not leave the case short of `done`.
    """
    try:
        return _deliver(case_id, md)
    except Exception as e:  # nothing here may break the pipeline's path to done
        log.exception("report call crashed case=%s", case_id)
        return _record(case_id, "failed", notes=f"unexpected error: {e}")
