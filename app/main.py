"""Grace orchestrator — FastAPI app.

Slice 1 surface: place an outbound call and receive its transcript via webhook.
The webhook handler already dispatches on agent_type so the Slice 2+ pipeline
(extraction / research / strategy / report) attaches without rework.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

from . import storage
from .config import settings
from .elevenlabs_client import ElevenLabsError, outbound_call
from .webhook import WebhookVerificationError, parse_webhook, verify_signature

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("grace")

app = FastAPI(title="Grace Orchestrator", version="0.1.0")


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
async def elevenlabs_webhook(request: Request) -> dict:
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

    # Persist raw payload + human-readable transcript regardless of agent type.
    storage.save_raw_payload(case_id, parsed.conversation_id or "unknown", payload)
    name = f"{fh_id or agent_type or 'call'}_{parsed.conversation_id or 'x'}"
    storage.save_transcript(case_id, name, parsed.transcript_text)

    # Slice 2+ dispatch hook. For now we log; handlers get wired per milestone.
    log.info(
        "saved transcript case=%s agent=%s fh=%s turns=%d summary=%r",
        case_id, agent_type, fh_id, len(parsed.transcript_turns), parsed.summary[:120],
    )

    return {"ok": True, "case_id": case_id, "agent_type": agent_type, "fh_id": fh_id}


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


@app.post("/cases/{case_id}/advance")
def advance_case(case_id: str) -> dict:
    """Manual pipeline nudge (debug/demo safety valve).

    Slice 2+: drives the state machine forward. Stub for now.
    """
    case = storage.read_case(case_id)
    if case is None:
        raise HTTPException(404, f"unknown case {case_id}")
    return {
        "case_id": case_id,
        "status": case.get("status"),
        "note": "advance not implemented yet (Slice 2+)",
    }
