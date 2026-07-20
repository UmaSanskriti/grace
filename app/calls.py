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


def _usable_quotes(case_id: str) -> list[dict]:
    """Quote records that can actually carry the case forward.

    A record counts only if the home was reached AND gave a number. An
    `unreachable` marker, or a home that answered but refused to quote, gives
    the strategy LLM no price to target and the negotiation agent nothing to
    cite — proceeding on those is exactly the "strategy over nothing" walk in
    issue #16.

    Never raises: a corrupt or unreadable quote file is not usable, and that is
    all this needs to decide.
    """
    out: list[dict] = []
    qdir = storage.case_dir(case_id) / "quotes"
    if not qdir.exists():
        return out
    for path in sorted(qdir.glob("*.json")):
        try:
            q = storage.read_json(case_id, f"quotes/{path.name}") or {}
        except Exception as e:
            log.warning("unreadable quote file case=%s %s: %s", case_id, path.name, e)
            continue
        if not isinstance(q, dict):
            continue
        if q.get("reached") and q.get("quoted_price_usd") is not None:
            out.append(q)
    return out


def _mark_unreachable(
    case_id: str, home: dict, reason: str, call_id: str | None = None
) -> None:
    """Record a home as unreachable — no quote, but not necessarily never dialed.

    `call_id` distinguishes the two ways a home ends up here: pass the
    conversation id when the call was actually placed (no answer, or a
    transcript extraction failure) and leave it None when the home was never
    dialed at all (no phone on file, skipped as a non-DEMO_TARGET, or
    ElevenLabs rejected the outbound request before anything rang).
    """
    fh_id = home.get("id", "unknown")
    storage.save_json(
        case_id,
        _quote_rel(fh_id),
        {
            "funeral_home_id": fh_id,
            "funeral_home_name": home.get("name", ""),
            "call_id": call_id,
            "reached": False,
            "quoted_price_usd": None,
            "status": "unreachable",
            "notes": reason,
        },
    )
    log.info("quote home unreachable case=%s fh=%s: %s", case_id, fh_id, reason)


# service_preferences keys worth reading to a provider, in the order the quote
# agent walks them. Everything else intake captures is internal.
_QUOTE_NOTE_LABELS: tuple[tuple[str, str], ...] = (
    ("viewing", "viewing"),
    ("ceremony", "ceremony"),
    ("ceremony_location", "ceremony location"),
    ("embalming", "embalming"),
    ("casket_source", "casket from"),
    ("urn_source", "urn from"),
    ("ashes_return", "ashes returned by"),
    ("religion_tradition", "tradition"),
    ("language_needs", "language"),
    ("service_date_window", "service window"),
)

_UNSET = (None, "", "unknown")


def _humanize(value: str) -> str:
    return str(value).replace("_", " ")


def _service_notes(prefs: dict) -> str:
    """Confirmed intake preferences, as one sentence the agent can read aloud.

    Entries intake never resolved are dropped rather than passed through: an
    agent that reads "disposition detail: unknown" to a funeral director is
    stating a placeholder as if it were a family decision.
    """
    parts: list[str] = []
    for key, label in _QUOTE_NOTE_LABELS:
        value = prefs.get(key)
        if value in _UNSET:
            continue
        if isinstance(value, bool):
            if value:
                parts.append(label)
            continue
        parts.append(f"{label}: {_humanize(value)}")
    return "; ".join(parts) or "nothing beyond the case details above"


def _quote_dynamic_vars(case_id: str, home: dict, user_info: dict) -> dict[str, str]:
    loc = user_info.get("location") or {}
    prefs = user_info.get("service_preferences") or {}
    disposition = prefs.get("disposition_detail")
    must_haves = user_info.get("must_haves") or []
    return {
        "case_id": case_id,
        "agent_type": "quote",
        "fh_id": home.get("id", ""),
        "funeral_home_name": home.get("name") or "your funeral home",
        "service_type": user_info.get("service_type") or "",
        "city": loc.get("city") or "",
        "state": loc.get("state") or "",
        "timeline": user_info.get("timeline") or "",
        "attendee_count": str(user_info.get("attendee_estimate") or ""),
        # Empty is meaningful here, so say so rather than leave a blank the
        # agent has to improvise around (see _nego_dynamic_vars).
        "disposition_detail": (
            _humanize(disposition) if disposition not in _UNSET else "to be confirmed by the family"
        ),
        "must_haves": ", ".join(must_haves) or "everything discussed at intake",
        "service_notes": _service_notes(prefs),
    }


def start_next_quote_call(case_id: str) -> dict:
    """Place a quote call to the next un-quoted home, or finish the round.

    Skips (marking unreachable) homes with no phone, or — in DEMO_MODE — any
    phone not in DEMO_TARGETS, continuing until a call is placed or none remain.
    """
    if storage.is_aborted(case_id):
        log.info("quote call suppressed — case=%s aborted", case_id)
        return {"aborted": True}

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

    # Nothing left to call. Before advancing, check the round actually yielded
    # something. If not one home was reached with a price there is nothing to
    # build a strategy from and nothing to negotiate over, so stop here rather
    # than walking the case into strategy on empty data (issue #16). Terminal:
    # `quotes_failed` is not a status start_next_quote_call re-enters on, so a
    # webhook retry cannot bounce the case back out of it.
    usable = _usable_quotes(case_id)
    if not usable:
        attempted = len(list((storage.case_dir(case_id) / "quotes").glob("*.json"))) \
            if (storage.case_dir(case_id) / "quotes").exists() else 0
        storage.set_status(case_id, "quotes_failed")
        log.error(
            "no usable quote from any funeral home case=%s (%d attempted) "
            "-> quotes_failed; not advancing to strategy",
            case_id, attempted,
        )
        return {"done": True, "status": "quotes_failed", "usable_quotes": 0,
                "attempted": attempted}

    storage.set_status(case_id, "quotes_collected")
    log.info("all quotes collected case=%s (%d usable)", case_id, len(usable))
    # Re-check: the abort may have landed while the last quote call was in
    # flight, and set_status above would have cleared a status-based flag.
    if storage.is_aborted(case_id):
        log.info("cascade to strategy/negotiation suppressed — case=%s aborted", case_id)
        return {"aborted": True}
    if settings.auto_advance:
        # Continue: build strategy, then start negotiation calls.
        from . import strategy  # lazy import to avoid a cycle
        if strategy.run_strategy(case_id).get("ok"):
            start_next_nego_call(case_id)
    return {"done": True, "status": (storage.read_case(case_id) or {}).get("status")}


def handle_quote_result(
    case_id: str,
    fh_id: str | None,
    conversation_id: str,
    transcript: str,
    failure_reason: str | None = None,
) -> None:
    """Extract + save a quote from a finished call, then place the next one.

    Idempotent: re-skips extraction if the quote is already recorded (webhook
    retries). Extraction/empty-transcript failures mark the home unreachable so
    the loop always advances.

    `failure_reason` is set when the post-call webhook said the conversation
    failed or was cut off (see webhook.ParsedWebhook.failure_reason). Such a
    transcript is never handed to extraction — a truncated call can still carry
    a plausible-looking number, and extracting one would record a quote that was
    never actually given.
    """
    if not fh_id:
        log.warning("quote webhook without fh_id case=%s — cannot record", case_id)
        return

    if storage.read_json(case_id, _quote_rel(fh_id)) is not None:
        log.info("quote already recorded case=%s fh=%s, skipping extract", case_id, fh_id)
    else:
        homes = storage.read_json(case_id, "funeral_homes.json") or []
        home = _home_by_id(homes, fh_id) or {"id": fh_id, "name": ""}
        if failure_reason:
            # The call was really placed, so carry the conversation id: this
            # counts as a dial attempt even though it yielded nothing.
            _mark_unreachable(
                case_id, home, f"call failed: {failure_reason}", call_id=conversation_id
            )
        elif not transcript.strip():
            # The call was actually placed (a conversation_id exists) — just
            # nobody picked up, or the transcript came back empty. Distinct
            # from "never dialed": carry the call id so _homes_called counts
            # this as a real dial attempt.
            _mark_unreachable(
                case_id, home, "empty transcript / no answer", call_id=conversation_id
            )
        else:
            try:
                quote = extract_quote(transcript)
            except Exception as e:  # LLM / validation failure
                # Also an actual dial — extraction failed on a real transcript.
                _mark_unreachable(
                    case_id, home, f"extraction failed: {e}", call_id=conversation_id
                )
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


def _mark_nego_unreachable(
    case_id: str, fh_id: str, name: str, reason: str, call_id: str | None = None
) -> None:
    """Record a negotiation as not achieved.

    `call_id` mirrors `_mark_unreachable`: pass the conversation id when the
    call was actually placed (no answer, a failed/truncated conversation, or an
    extraction failure) and leave it None when the home was never dialed.
    """
    storage.save_json(
        case_id,
        _nego_rel(fh_id),
        {
            "funeral_home_id": fh_id,
            "funeral_home_name": name,
            "call_id": call_id,
            "agreed": False,
            "final_price_usd": None,
            "status": "unreachable",
            "notes": reason,
        },
    )
    log.info("nego home unreachable case=%s fh=%s: %s", case_id, fh_id, reason)


NO_COMPETING_QUOTE = "no competing quote was captured"


def _best_competing_quote(case_id: str, exclude_fh_id: str) -> dict | None:
    """The lowest *evidenced* competitor quote, or None.

    Built only from quote records — never from strategy.json's LLM-authored
    `leverage`, and never from market research. If no provider actually gave us a
    comparable number, this returns None and the agent is told so explicitly; it
    must not fall back to an average or an estimate (INV-05 / INV-08).
    """
    best: dict | None = None
    qdir = storage.case_dir(case_id) / "quotes"
    if not qdir.exists():
        return None
    for path in sorted(qdir.glob("*.json")):
        q = storage.read_json(case_id, f"quotes/{path.name}") or {}
        if q.get("funeral_home_id") == exclude_fh_id:
            continue  # their own price is not leverage against them
        price = q.get("quoted_price_usd")
        if not q.get("reached") or price is None:
            continue
        if best is None or price < best["quoted_price_usd"]:
            best = q
    return best


def _competing_disclosure(
    case_id: str, exclude_fh_id: str, service_type: str, current_price: object = None
) -> str:
    """The one sentence the agent is allowed to say about a competitor.

    The amount is embedded in the sentence rather than passed as its own variable:
    on 2026-07-19 the prompt read "(a verified quote of {{competing_quote_total}})"
    with that variable unset, so the sentence asserted a quote existed while showing
    a blank — and the agent filled the blank with the confidential target price.
    One variable that is either a complete true sentence or an explicit denial
    removes that failure mode.
    """
    comp = _best_competing_quote(case_id, exclude_fh_id)
    if comp is None:
        return NO_COMPETING_QUOTE
    # A competitor quote is only leverage if it undercuts them. Citing a higher
    # rival price ("can you match their $10,000?" to someone quoting $3,000) is
    # nonsense, so treat it as having no leverage and let the agent fall back to
    # the fee-reduction ask.
    if isinstance(current_price, (int, float)) and comp["quoted_price_usd"] >= current_price:
        return NO_COMPETING_QUOTE
    amount = _money(comp["quoted_price_usd"])
    name = comp.get("funeral_home_name") or comp.get("funeral_home_id") or "another provider"
    return f"another provider ({name}) gave us a verified quote of {amount} for a comparable {service_type or 'service'}"


def _prior_quote_summary(quote: dict) -> str:
    """What this provider already told us — evidenced, so safe to restate."""
    parts: list[str] = []
    if quote.get("price_type"):
        parts.append(f"quoted as a {quote['price_type'].replace('_', ' ')}")
    if quote.get("includes"):
        parts.append(f"includes {', '.join(quote['includes'][:2])}")
    if quote.get("excludes"):
        parts.append(f"excludes {', '.join(quote['excludes'])}")
    return "; ".join(parts) or "no itemization captured"


def _nego_dynamic_vars(case_id: str, home: dict, quote: dict, hs: dict, user_info: dict) -> dict[str, str]:
    fh_id = home.get("id", "")
    service_type = user_info.get("service_type") or ""
    must_haves = user_info.get("must_haves") or []
    flexible = user_info.get("flexible_if_savings") or []
    return {
        "case_id": case_id,
        "agent_type": "nego",
        "fh_id": fh_id,
        "funeral_home_name": home.get("name") or quote.get("funeral_home_name", ""),
        "service_type": service_type,
        "current_price": _money(hs.get("current_price_usd") or quote.get("quoted_price_usd")),
        "target_price": _money(hs.get("target_price_usd")),
        "walk_away_price": _money(hs.get("walk_away_price_usd")),
        "prior_quote_summary": _prior_quote_summary(quote),
        # A complete true sentence, or an explicit denial. Never a bare number.
        "competing_quote_disclosure": _competing_disclosure(
            case_id, fh_id, service_type,
            hs.get("current_price_usd") or quote.get("quoted_price_usd"),
        ),
        # Intake captured these; empty is meaningful, so say so rather than blank.
        "flexible_items": ", ".join(flexible) or "nothing — the family has not authorized any trades",
        "must_haves": ", ".join(must_haves) or "everything discussed at intake",
        "fallback_ask": (
            "including the first two death certificates, or holding the quoted "
            "price in writing for 48 hours"
        ),
    }


def start_next_nego_call(case_id: str) -> dict:
    """Place a negotiation call to the next shortlisted home, or finish: report + deliver."""
    if storage.is_aborted(case_id):
        log.info("negotiation call suppressed — case=%s aborted", case_id)
        return {"aborted": True}

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

    # Shortlist exhausted -> produce the final report, then read it to the family.
    from . import report, report_call  # lazy imports to avoid a cycle
    md = report.generate_report(case_id)
    rc = report_call.deliver_report(case_id, md)
    storage.set_status(case_id, "done")
    log.info("negotiations complete case=%s report_call=%s -> done", case_id, rc["status"])
    return {"done": True, "status": "done", "report_call": rc}


def handle_nego_result(
    case_id: str,
    fh_id: str | None,
    conversation_id: str,
    transcript: str,
    failure_reason: str | None = None,
) -> None:
    """Extract + save a negotiation outcome, then place the next one (or report).

    `failure_reason` is set when the post-call webhook said the conversation
    failed or was cut off; that transcript is never extracted, so a truncated
    call can never be recorded as an agreed price (issue #16).
    """
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
        if failure_reason:
            _mark_nego_unreachable(
                case_id, fh_id, name, f"call failed: {failure_reason}",
                call_id=conversation_id,
            )
        elif not transcript.strip():
            _mark_nego_unreachable(
                case_id, fh_id, name, "empty transcript / no answer",
                call_id=conversation_id,
            )
        else:
            try:
                outcome = extract_final_price(transcript)
            except Exception as e:
                _mark_nego_unreachable(
                    case_id, fh_id, name, f"extraction failed: {e}",
                    call_id=conversation_id,
                )
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
