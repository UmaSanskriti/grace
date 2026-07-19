"""Grace orchestrator — FastAPI app.

Slice 1 surface: place an outbound call and receive its transcript via webhook.
The webhook handler already dispatches on agent_type so the Slice 2+ pipeline
(extraction / research / strategy / report) attaches without rework.
"""

from __future__ import annotations

import logging

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import calls, research, storage, strategy, web_api
from .config import settings
from .elevenlabs_client import ElevenLabsError, outbound_call
from .extraction import extract_user_info
from .webhook import WebhookVerificationError, parse_webhook, verify_signature

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("grace")

app = FastAPI(title="Grace Orchestrator", version="0.1.0")

# The dashboard runs on the Vite dev server (a different origin). Demo-only:
# tighten to the deployed origin before this is exposed publicly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Adapter routes the React dashboard polls (/agent-activity, /call-transcript,
# /demo-call). Kept in their own module so the pipeline surface stays untouched.
app.include_router(web_api.router)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "demo_mode": settings.demo_mode,
        "base_url": settings.base_url,
        "elevenlabs_configured": bool(settings.elevenlabs_api_key),
    }


# --- debug: trigger an outbound call ---------------------------------------

class DebugCallRequest(BaseModel):
    agent: str = "quote"          # intake | quote | nego
    to_number: str | None = None  # E.164; defaults to first DEMO_TARGET
    case_id: str | None = None    # reuse an existing case, else a new one
    fh_id: str | None = None
    dynamic_vars: dict[str, str] = {}


@app.post("/debug/call")
def debug_call(req: DebugCallRequest) -> dict:
    """Place a test outbound call and index it for webhook routing."""
    if req.agent not in ("intake", "quote", "nego"):
        raise HTTPException(400, f"unknown agent {req.agent!r}")

    to_number = req.to_number or (
        settings.demo_target_list[0] if settings.demo_target_list else None
    )
    if not to_number:
        raise HTTPException(
            400, "no to_number given and DEMO_TARGETS is empty"
        )

    agent_id = settings.agent_id_for(req.agent)
    if not agent_id:
        raise HTTPException(500, f"agent id for {req.agent!r} not configured in .env")

    case = storage.read_case(req.case_id) if req.case_id else None
    if case is None:
        case = storage.create_case(status="calling_for_quotes")
    case_id = case["case_id"]

    # Injected so the webhook can route the transcript back to this case/home.
    dyn: dict[str, str] = {
        "case_id": case_id,
        "agent_type": req.agent,
        **req.dynamic_vars,
    }
    if req.fh_id:
        dyn["fh_id"] = req.fh_id

    try:
        resp = outbound_call(agent_id=agent_id, to_number=to_number, dynamic_variables=dyn)
    except ElevenLabsError as e:
        log.error("outbound_call failed: %s", e)
        raise HTTPException(502, str(e))

    conversation_id = resp.get("conversation_id", "")
    if conversation_id:
        storage.index_conversation(conversation_id, case_id, req.agent, req.fh_id)
    log.info(
        "placed %s call case=%s to=%s conversation_id=%s",
        req.agent, case_id, to_number, conversation_id,
    )
    return {
        "case_id": case_id,
        "to_number": to_number,
        "conversation_id": conversation_id,
        "call_sid": resp.get("callSid"),
        "elevenlabs_response": resp,
    }


# --- single webhook entrypoint for all post-call events --------------------

@app.post("/webhooks/elevenlabs")
async def elevenlabs_webhook(request: Request, background: BackgroundTasks) -> dict:
    raw = await request.body()
    try:
        verify_signature(raw, request.headers.get("ElevenLabs-Signature"))
    except WebhookVerificationError as e:
        log.warning("webhook signature rejected: %s", e)
        raise HTTPException(401, str(e))

    payload = await request.json()
    parsed = parse_webhook(payload)
    log.info(
        "webhook type=%s conversation_id=%s status=%s",
        parsed.type, parsed.conversation_id, parsed.status,
    )

    # Route: prefer echoed dynamic vars, fall back to the call-time index,
    # then to the newest case awaiting intake (inbound calls we didn't start).
    case_id = parsed.case_id
    agent_type = parsed.agent_type
    fh_id = parsed.fh_id
    if not case_id and parsed.conversation_id:
        entry = storage.lookup_conversation(parsed.conversation_id)
        if entry:
            case_id = entry["case_id"]
            agent_type = agent_type or entry.get("agent_type")
            fh_id = fh_id or entry.get("fh_id")
    if not case_id:
        case_id = storage.newest_case_with_status("awaiting_intake")
        agent_type = agent_type or "intake"

    if not case_id:
        # Nothing to attach it to — persist under an orphan case for debugging.
        case = storage.create_case(status="orphan_webhook")
        case_id = case["case_id"]
        log.warning("unrouted webhook -> orphan case %s", case_id)
    else:
        # Routed to a known id — make sure its case.json exists (a call placed
        # outside /debug/call may reference a case that was never materialized).
        storage.ensure_case(case_id)

    # Capture the user's phone from an inbound call (the caller is the user),
    # so we can send SMS progress updates later.
    if parsed.call_direction == "inbound" and parsed.external_number:
        storage.set_user_phone(case_id, parsed.external_number)
        log.info("captured user phone for case=%s (inbound caller)", case_id)

    # Persist raw payload + human-readable transcript regardless of agent type.
    storage.save_raw_payload(case_id, parsed.conversation_id or "unknown", payload)
    name = f"{fh_id or agent_type or 'call'}_{parsed.conversation_id or 'x'}"
    storage.save_transcript(case_id, name, parsed.transcript_text)

    log.info(
        "saved transcript case=%s agent=%s fh=%s turns=%d summary=%r",
        case_id, agent_type, fh_id, len(parsed.transcript_turns), parsed.summary[:120],
    )

    # Dispatch on agent type. Quote/nego extraction lands in Slice 4/5.
    result: dict = {"ok": True, "case_id": case_id, "agent_type": agent_type, "fh_id": fh_id}
    if agent_type == "intake":
        status = _handle_intake(case_id, parsed.transcript_text)
        result["status"] = status
        if status == "intake_done":
            # Research + first quote call, off the request path (fast webhook).
            background.add_task(_pipeline_after_intake, case_id)
    elif agent_type == "quote":
        background.add_task(
            calls.handle_quote_result,
            case_id, fh_id, parsed.conversation_id, parsed.transcript_text,
        )
    elif agent_type == "nego":
        background.add_task(
            calls.handle_nego_result,
            case_id, fh_id, parsed.conversation_id, parsed.transcript_text,
        )
    else:
        log.info("no handler for agent=%s yet (transcript saved)", agent_type)

    return result


def _pipeline_after_intake(case_id: str) -> None:
    """Background: research, then kick the first quote call if it succeeded.

    The quote call (and everything downstream) only auto-fires when AUTO_ADVANCE
    is on; otherwise the case rests at calling_for_quotes for a manual /advance.
    """
    if storage.is_aborted(case_id):
        log.info("post-intake pipeline suppressed — case=%s aborted", case_id)
        return
    res = research.run_research(case_id)
    if res.get("ok") and settings.auto_advance:
        calls.start_next_quote_call(case_id)


def _handle_intake(case_id: str, transcript: str) -> str:
    """Extract user_info.json from an intake transcript and advance the case.

    Idempotent (webhooks may retry): skips if already extracted. Extraction
    failures are logged and surfaced as a status, never a 5xx — returning 200
    keeps ElevenLabs from retry-storming, and the case can be re-run manually.
    """
    if storage.read_json(case_id, "user_info.json") is not None:
        log.info("intake case=%s already extracted, skipping", case_id)
        return "intake_skipped_existing"
    if not transcript.strip():
        log.warning("intake case=%s: empty transcript, skipping extraction", case_id)
        return "intake_empty_transcript"
    try:
        user_info = extract_user_info(transcript)
    except Exception as e:  # LLM / validation failure — don't fail the webhook
        log.error("intake extraction failed case=%s: %s", case_id, e)
        storage.set_status(case_id, "intake_extract_failed")
        return "intake_extract_failed"

    storage.save_json(case_id, "user_info.json", user_info)
    storage.set_status(case_id, "intake_done")
    log.info(
        "intake extracted case=%s contact=%r service=%s unknowns=%d",
        case_id,
        user_info.get("contact_name"),
        user_info.get("service_type"),
        len(user_info.get("unknowns") or []),
    )
    # Slice 3 will kick research here (status -> researching).
    return "intake_done"


# --- read case state (demo UI) ---------------------------------------------

@app.get("/cases/{case_id}")
def get_case(case_id: str) -> dict:
    case = storage.dump_case(case_id)
    if case is None:
        raise HTTPException(404, f"unknown case {case_id}")
    return case


@app.get("/cases/{case_id}/report")
def get_report(case_id: str) -> Response:
    md = storage.read_json(case_id, "report.md")  # report is plain text, may be None
    path = storage.case_dir(case_id) / "report.md"
    if not path.exists():
        raise HTTPException(404, "report not generated yet")
    return Response(path.read_text(), media_type="text/markdown")


@app.post("/cases/{case_id}/abort")
def abort_case(case_id: str) -> dict:
    """Kill switch — stop this case placing any further calls.

    Does not change status (the dashboard would lose the pipeline position) and
    cannot cancel a call already ringing; it stops the *next* one. An in-flight
    call still lands its webhook, and its transcript is still saved.
    """
    if storage.read_case(case_id) is None:
        raise HTTPException(404, f"unknown case {case_id}")
    storage.set_aborted(case_id, True)
    log.warning("case %s ABORTED — no further calls will be placed", case_id)
    return {"case_id": case_id, "aborted": True}


@app.post("/cases/{case_id}/resume")
def resume_case(case_id: str) -> dict:
    """Clear the abort flag. Does not restart the pipeline — use /advance."""
    if storage.read_case(case_id) is None:
        raise HTTPException(404, f"unknown case {case_id}")
    storage.set_aborted(case_id, False)
    log.info("case %s resumed (abort cleared)", case_id)
    return {"case_id": case_id, "aborted": False}


@app.post("/cases/{case_id}/advance")
def advance_case(case_id: str) -> dict:
    """Manual pipeline nudge (debug/demo safety valve).

    Runs the next automated step for the case's current status. Currently:
    intake_done / research_failed -> run research. Quote/nego steps land in
    Slice 4/5.
    """
    case = storage.read_case(case_id)
    if case is None:
        raise HTTPException(404, f"unknown case {case_id}")
    if storage.is_aborted(case_id):
        raise HTTPException(409, f"case {case_id} is aborted — POST /resume first")
    status = case.get("status")

    if status in ("intake_done", "researching", "research_failed"):
        result = research.run_research(case_id)
        if result.get("ok"):
            result["quote_call"] = calls.start_next_quote_call(case_id)
        return {
            "case_id": case_id,
            "ran": "research",
            "result": result,
            "status": (storage.read_case(case_id) or {}).get("status"),
        }

    if status == "calling_for_quotes":
        result = calls.start_next_quote_call(case_id)
        return {
            "case_id": case_id,
            "ran": "quote_call",
            "result": result,
            "status": (storage.read_case(case_id) or {}).get("status"),
        }

    if status == "quotes_collected":
        result = strategy.run_strategy(case_id)
        return {
            "case_id": case_id,
            "ran": "strategy",
            "result": result,
            "status": (storage.read_case(case_id) or {}).get("status"),
        }

    if status in ("strategy_ready", "negotiating"):
        result = calls.start_next_nego_call(case_id)
        return {
            "case_id": case_id,
            "ran": "nego_call",
            "result": result,
            "status": (storage.read_case(case_id) or {}).get("status"),
        }

    return {
        "case_id": case_id,
        "status": status,
        "note": f"no automated step for status {status!r} (pipeline complete or manual)",
    }
