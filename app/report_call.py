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
    """Count only quote records that represent an actual dial attempt.

    `quotes/*.json` also holds `_mark_unreachable` records (calls.py) for homes
    that were never dialed at all — no phone number on file, skipped as a
    non-DEMO_TARGET in DEMO_MODE, or ElevenLabs rejected the outbound request
    before anything rang — so counting every file overstates how many homes
    were really called. `call_id` is the discriminator, but it is not a
    "quote vs. unreachable" split: `_mark_unreachable` itself carries a
    `call_id` when the home *was* actually dialed and just didn't yield a
    quote (no answer / empty transcript, or extraction failed on a real
    transcript) — only the never-dialed cases leave it None. So `call_id`
    truthy means "the phone actually rang for this home," which is exactly
    what this count needs, regardless of whether a quote came out of it.
    """
    qdir = storage.case_dir(case_id) / "quotes"
    if not qdir.exists():
        return 0
    n = 0
    for p in qdir.glob("*.json"):
        q = storage.read_json(case_id, f"quotes/{p.name}") or {}
        if q.get("call_id"):
            n += 1
    return n


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


def _recommendation_constraint(case_id: str) -> str:
    """The one recommendation, and the one dial count, the spoken summary is bound to.

    _best_home is the gated, evidenced truth (unagreed negotiations excluded);
    report.md (app/report.py) applies no such filter and its LLM may recommend
    on value rather than price. Handing this to the summarizer as an explicit
    constraint keeps report_summary from naming a different home or price than
    recommended_home/final_price state on the same call.

    _homes_called gets the same treatment for the same reason: report.py's
    quotes/*.json gathers one record per home regardless of whether it was
    ever dialed (report.md tells the LLM to note unreachable homes rather than
    omit them), so a report_summary built only from the report body could read
    the row count off the table and state how many homes "were called" when
    some were only ever marked unreachable. Binding the count here keeps that
    figure tied to the same gated data as the recommendation, on the same call.
    """
    name, price = _best_home(case_id)
    count = _homes_called(case_id)
    return (
        "AUTHORITATIVE CONSTRAINT — this governs over the report body wherever the two "
        f"conflict: the recommended funeral home is {name or NO_RECOMMENDATION}, the "
        f"confirmed final price is {_money(price) or NO_PRICE}, and the number of funeral "
        f"homes actually called (dialed, whether or not they answered) is {count}. Do not "
        "name any other home as the recommendation, do not state any other figure as the "
        "confirmed price, and do not state any other number of homes called."
    )


def summarize_for_speech(case_id: str, md: str) -> tuple[str, str]:
    """Turn report.md into spoken prose. Returns (text, "llm" | "fallback").

    Never raises and never returns an empty string: a degraded summary is always
    better than handing the agent a blank to improvise around.
    """
    try:
        constraint = _recommendation_constraint(case_id)
        client = OpenAI(api_key=settings.openai_api_key)
        model = getattr(settings, "openai_extraction_model", "") or _EXTRACTION_MODEL_DEFAULT
        resp = client.responses.create(
            model=model,
            input=[
                {"role": "system", "content": _extraction_prompt("report_speech.md")},
                {"role": "user", "content": constraint + "\n\nREPORT:\n" + md},
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
    try:
        storage.save_json(case_id, "report_call.json", rec)
    except Exception:
        # Persisting the record is best-effort; returning it is not optional.
        # This is the last-resort path (called from deliver_report's outer
        # except), so it must be incapable of raising itself.
        log.exception("failed to persist report_call.json case=%s", case_id)
    log.info("report call case=%s status=%s notes=%s", case_id, status, notes)
    return rec


def _deliver(case_id: str, md: str) -> dict:
    # A prior "placed" call means the family's phone already rang for this
    # report — return that record instead of dialing again. This is the only
    # thing standing between start_next_nego_call's post-hoc status guard (see
    # calls.py) and a second call landing during the window between a placed
    # call and set_status(case_id, "done"): a retried webhook, or a second
    # entrant that read status=="negotiating" before that write lands, both
    # re-enter here. A "skipped"/"failed"/"aborted" prior record is not a
    # placed call, so it must still allow a legitimate retry.
    prior = storage.read_json(case_id, "report_call.json")
    if prior and prior.get("status") == "placed":
        log.info(
            "report call already placed case=%s call_id=%s — not dialing again",
            case_id, prior.get("call_id"),
        )
        return prior
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
        try:
            storage.index_conversation(conv, case_id, "report")
        except Exception:
            # The call already went out — indexing is bookkeeping, and its
            # failure must not turn a placed call into a recorded failure.
            log.exception(
                "failed to index conversation case=%s conversation_id=%s", case_id, conv,
            )
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
