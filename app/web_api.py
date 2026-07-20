"""Web-UI adapter endpoints for the React dashboard under `web/`.

The dashboard was written against the Deno/Supabase Edge Functions, so this
module serves the same four routes it polls, projected out of our JSON case
store instead:

    GET  /agent-activity                  -> { cases: [...] }        (picker)
    GET  /agent-activity?case_id=...      -> Activity                (loop view)
    GET  /call-transcript?conversation_id= -> ElevenLabs transcript proxy
    POST /demo-call                       -> place a call, return conversation_id

Read-only apart from /demo-call. Nothing here touches the pipeline modules —
the loop view is a projection, so a broken shape can never stall a live case.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import storage
from .config import settings
from .elevenlabs_client import API_BASE, ElevenLabsError, outbound_call

log = logging.getLogger("grace.web")

router = APIRouter(tags=["web-ui"])


# --- status -> progress ----------------------------------------------------
# The dashboard gates every node on the Deno state machine's 0..16 ordinal
# (`progress >= N`), so our statuses are mapped onto that same scale rather
# than renumbered — otherwise the pipeline nodes never light up.

_PROGRESS: dict[str, int] = {
    "orphan_webhook": 0,
    "awaiting_intake": 3,
    "active": 3,
    "intake_call_failed": 3,
    "intake_extract_failed": 3,
    "intake_done": 5,
    "researching": 6,
    "research_failed": 6,
    "calling_for_quotes": 7,
    # Terminal: the quote round finished but produced nothing usable. Shares
    # quotes_collected's slot so the caller node still lights up as reached —
    # the case got this far, it just cannot continue past it.
    "quotes_failed": 9,
    "quotes_collected": 9,
    "strategy_ready": 10,
    "negotiating": 11,
    "done": 15,
}


def _progress(status: str | None) -> int:
    return _PROGRESS.get(status or "", 0)


# --- node projection -------------------------------------------------------

def _node(
    node_id: str, label: str, kind: str, state: str, activity: str, output: str
) -> dict:
    return {
        "id": node_id,
        "label": label,
        "kind": kind,
        "state": state,
        "activity": activity,
        "output": output,
    }


def _build_nodes(case: dict) -> list[dict]:
    """Derive the eight backend nodes the loop view reads by id."""
    status = case.get("status") or ""
    user_info = case.get("user_info") or {}
    homes = case.get("funeral_homes") or []
    quotes = case.get("quotes") or []
    strategy = case.get("strategy") or {}
    negos = case.get("negotiations") or []
    prog = _progress(status)

    reached = [q for q in quotes if q.get("reached")]
    priced = [q for q in reached if q.get("quoted_price_usd") is not None]

    def state_for(done: bool, active: bool) -> str:
        return "active" if active else ("done" if done else "idle")

    # Homes list may be a bare list or {"homes": [...]} depending on research run.
    home_list = homes.get("homes", []) if isinstance(homes, dict) else homes

    return [
        _node(
            "intake", "Intake Agent", "voice",
            state_for(bool(user_info), status in ("awaiting_intake", "active")),
            "Interviewing the family" if not user_info else "Intake complete",
            (
                f"{user_info.get('service_type') or 'service TBD'}"
                f" · {len(user_info.get('unknowns') or [])} unknown(s)"
                if user_info else "waiting for the call"
            ),
        ),
        _node(
            "research", "Research", "tool",
            state_for(bool(home_list), status == "researching"),
            "Finding nearby funeral homes" if not home_list else "Providers shortlisted",
            f"{len(home_list)} home(s) found" if home_list else "—",
        ),
        _node(
            "caller", "Caller Agent", "voice",
            state_for(prog >= 9, status == "calling_for_quotes"),
            "Calling providers for quotes" if status == "calling_for_quotes"
            else ("Quote calls complete" if quotes else "Waiting on the brief"),
            # Against the provider total, not quotes-recorded-so-far: mid-run the
            # latter reads "0/1 reached" when only one call has come back yet.
            f"{len(reached)}/{len(home_list) or len(quotes)} reached" if quotes else "—",
        ),
        _node(
            "normalizer", "Normalizer", "tool",
            state_for(bool(quotes), False),
            "Extracting itemized quotes" if quotes else "Idle",
            f"{len(priced)} priced quote(s)" if priced else "—",
        ),
        _node(
            # No separate audit stage in this pipeline: extraction emits null for
            # anything it could not evidence, so "audited" == "extracted" here.
            "auditor", "Auditor", "tool",
            state_for(bool(quotes), False),
            "Checking totals and missing fees" if quotes else "Idle",
            f"{len(quotes) - len(priced)} quote(s) missing a price"
            if quotes else "—",
        ),
        _node(
            "ranker", "Ranker", "tool",
            state_for(bool(strategy), status == "quotes_collected"),
            "Ranking and building leverage" if strategy else "Idle",
            f"shortlist: {', '.join(strategy.get('shortlist', [])[:2])}"
            if strategy.get("shortlist") else "—",
        ),
        _node(
            "closer", "Closer Agent", "voice",
            state_for(bool(negos), status == "negotiating"),
            "Negotiating with the provider" if status == "negotiating"
            else ("Negotiation complete" if negos else "Awaiting strategy"),
            (
                f"{sum(1 for n in negos if n.get('agreed'))}/{len(negos)} agreed"
                if negos else "—"
            ),
        ),
        _node(
            "ledger", "Evidence ledger", "tool",
            state_for(prog >= 15, False),
            "Assembling the family report" if prog >= 11 else "Recording evidence",
            f"{len(case.get('transcripts') or [])} transcript(s)",
        ),
    ]


def _active_node(nodes: list[dict]) -> str | None:
    for n in nodes:
        if n["state"] == "active":
            return n["id"]
    return None


def _summary(case: dict) -> dict:
    quotes = case.get("quotes") or []
    strategy = case.get("strategy") or {}
    priced = [q for q in quotes if q.get("quoted_price_usd") is not None]

    # strategy.shortlist holds funeral_home_ids; the UI wants something a human
    # can read, so resolve through the quote records (which carry both).
    names = {
        q.get("funeral_home_id"): q.get("funeral_home_name")
        for q in quotes if q.get("funeral_home_name")
    }
    recommended = None
    shortlist = strategy.get("shortlist") or []
    if shortlist:
        recommended = names.get(shortlist[0], shortlist[0])
    elif priced:
        best = min(priced, key=lambda q: q["quoted_price_usd"])
        recommended = best.get("funeral_home_name") or best.get("funeral_home_id")

    # How many providers this case actually has, so the UI can stop hardcoding
    # "/3" — that came from main's spec, which assumed three roleplayers. We
    # build one per DEMO_TARGETS entry, so the real number varies.
    homes = case.get("funeral_homes") or []
    home_list = homes.get("homes", []) if isinstance(homes, dict) else homes

    return {
        "quotes": len(quotes),
        "audited": len(priced),
        # No independent audit pass yet — surfaced as 0 rather than invented.
        "audit_flags": sum(1 for q in quotes if q.get("quoted_price_usd") is None),
        "is_tie": None,
        "recommended": recommended,
        "providers": len(home_list),
    }


def _quote_status(q: dict) -> str:
    """calls.py only writes `status` when marking a home unreachable, so a
    successful quote has none — derive one rather than surfacing null."""
    if q.get("status"):
        return q["status"]
    if q.get("quoted_price_usd") is not None:
        return "quoted"
    return "reached_no_price" if q.get("reached") else "unreachable"


def _nego_status(n: dict) -> str:
    if n.get("status"):
        return n["status"]
    return "agreed" if n.get("agreed") else "no_agreement"


def _intake_calls(case_id: str) -> list[dict]:
    """Intake conversations for this case, recovered from the conversation index.

    Intake leaves no per-call artifact the way quotes and negotiations do, so the
    index is the only record that it happened. The dashboard needs it: on an
    inbound demo the consumer's own call is the one worth watching.
    """
    idx = storage._read_json(storage.INDEX_PATH, {}) or {}
    return [
        {"purpose": "intake", "provider_id": None, "status": "done",
         "conversation_id": conv}
        for conv, meta in idx.items()
        if meta.get("case_id") == case_id and meta.get("agent_type") == "intake"
    ]


def _calls(case: dict, case_id: str) -> list[dict]:
    out: list[dict] = _intake_calls(case_id)
    for q in case.get("quotes") or []:
        out.append({
            "purpose": "initial_quote",
            "provider_id": q.get("funeral_home_id"),
            "status": _quote_status(q),
            # Lets the UI poll /call-transcript without a manual launch.
            "conversation_id": q.get("call_id"),
        })
    for n in case.get("negotiations") or []:
        out.append({
            "purpose": "negotiation",
            "provider_id": n.get("funeral_home_id"),
            "status": _nego_status(n),
            "conversation_id": n.get("call_id"),
        })
    return out


def _events(case: dict) -> list[dict]:
    """Coarse event feed. We keep no event log, so this is derived from the
    artifacts that exist — enough for the UI's recent-activity strip."""
    ts = case.get("updated_at") or case.get("created_at") or ""
    events: list[dict] = [{
        "type": f"status:{case.get('status')}",
        "actor": "orchestrator",
        "timestamp": ts,
    }]
    for q in case.get("quotes") or []:
        events.append({
            "type": f"quote:{_quote_status(q)}",
            "actor": q.get("funeral_home_name") or q.get("funeral_home_id") or "provider",
            "timestamp": ts,
        })
    for n in case.get("negotiations") or []:
        events.append({
            "type": f"negotiation:{_nego_status(n)}",
            "actor": n.get("funeral_home_name") or n.get("funeral_home_id") or "provider",
            "timestamp": ts,
        })
    return events[:20]


# --- routes ----------------------------------------------------------------

@router.get("/agent-activity")
def agent_activity(case_id: str | None = None) -> dict:
    if not case_id:
        cases = []
        if storage.DATA_DIR.exists():
            for p in sorted(storage.DATA_DIR.glob("case_*"), reverse=True):
                if not p.is_dir():
                    continue
                c = storage.read_case(p.name)
                if not c:
                    continue
                cases.append({
                    "case_id": c["case_id"],
                    "status": c.get("status") or "unknown",
                    "current_version": 1,
                    "created_at": c.get("created_at") or "",
                })
        return {"cases": cases[:15]}

    case = storage.dump_case(case_id)
    if case is None:
        raise HTTPException(404, f"unknown case {case_id}")

    nodes = _build_nodes(case)
    return {
        "case": {
            "case_id": case_id,
            "status": case.get("status") or "unknown",
            "progress": _progress(case.get("status")),
            # This pipeline is voice-first; SMS intake is not implemented.
            "preferred_channel": "voice",
            "current_version": 1,
            "aborted": bool(case.get("aborted")),
        },
        "active_node": _active_node(nodes),
        "nodes": nodes,
        "calls": _calls(case, case_id),
        "events": _events(case),
        "summary": _summary(case),
    }


@router.get("/call-transcript")
def call_transcript(conversation_id: str) -> dict:
    """Server-side proxy for an ElevenLabs conversation — the API key must
    never reach the browser."""
    if not settings.elevenlabs_api_key:
        raise HTTPException(500, "ELEVENLABS_API_KEY is not set")

    try:
        resp = httpx.get(
            f"{API_BASE}/v1/convai/conversations/{conversation_id}",
            headers={"xi-api-key": settings.elevenlabs_api_key},
            timeout=15.0,
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"ElevenLabs unreachable: {e}")

    # Not queryable for a moment right after launch — poll, don't error.
    if resp.status_code == 404:
        return {"status": "pending", "transcript": [], "duration_secs": None}
    if resp.status_code >= 300:
        raise HTTPException(502, f"ElevenLabs conversation fetch failed: {resp.status_code}")

    data = resp.json()
    turns = []
    for t in data.get("transcript") or []:
        msg = (t.get("message") or "").strip()
        if not msg:
            continue
        turns.append({
            # "user" is the human on the line; everything else is Grace.
            "role": "caller" if t.get("role") == "user" else "grace",
            "message": msg,
            "secs": t.get("time_in_call_secs"),
        })

    return {
        "status": data.get("status") or "unknown",
        "transcript": turns,
        "duration_secs": (data.get("metadata") or {}).get("call_duration_secs"),
    }


class DemoCallRequest(BaseModel):
    kind: str                      # "intake" | "caller"
    to: str
    case_id: str | None = None
    provider_id: str | None = None


# The dashboard's vocabulary ("caller") vs ours ("quote").
_KIND_TO_AGENT = {"intake": "intake", "caller": "quote", "closer": "nego"}


@router.post("/demo-call")
def demo_call(req: DemoCallRequest) -> dict:
    """Place a call from the dashboard's live buttons.

    Mirrors /debug/call but speaks the dashboard's request/response vocabulary
    and always returns a conversation_id, which the transcript panel polls on.
    """
    agent = _KIND_TO_AGENT.get(req.kind)
    if agent is None:
        raise HTTPException(400, f"unknown kind {req.kind!r}")

    # Same allowlist gate calls.py applies to quote calls: in DEMO_MODE we only
    # ever dial consented roleplay numbers. The dashboard exposes a free-text
    # field, so this is the only thing standing between a typo and a real call
    # to a real funeral home.
    if settings.demo_mode and req.to not in settings.demo_target_list:
        raise HTTPException(
            403,
            f"{req.to} is not in DEMO_TARGETS; refusing to dial in DEMO_MODE",
        )

    agent_id = settings.agent_id_for(agent)
    if not agent_id:
        raise HTTPException(500, f"agent id for {agent!r} not configured in .env")

    case = storage.read_case(req.case_id) if req.case_id else None
    if case is None:
        case = storage.create_case(
            status="awaiting_intake" if agent == "intake" else "calling_for_quotes"
        )
    case_id = case["case_id"]

    dyn = {"case_id": case_id, "agent_type": agent}
    if req.provider_id:
        dyn["fh_id"] = req.provider_id

    try:
        resp = outbound_call(agent_id=agent_id, to_number=req.to, dynamic_variables=dyn)
    except ElevenLabsError as e:
        log.error("demo-call failed: %s", e)
        raise HTTPException(502, str(e))

    conversation_id = resp.get("conversation_id", "")
    if conversation_id:
        storage.index_conversation(conversation_id, case_id, agent, req.provider_id)
    log.info("demo-call %s case=%s to=%s conv=%s", agent, case_id, req.to, conversation_id)

    return {
        "case_id": case_id,
        "conversation_id": conversation_id,
        "call_sid": resp.get("callSid"),
    }
