# Grace v0 — Slice 1 Design: Outbound Call → Webhook Loop

**Date:** 2026-07-18
**Status:** Approved (brainstorming)
**Master spec:** [`docs/v0-instruction.md`](../../v0-instruction.md). This doc narrows v0 to the
first buildable/testable slice and the scaffolding around it.

## Goal

Prove the riskiest integration first: place a real outbound call through the ElevenLabs Agents
Platform and receive the transcript back via a post-call webhook, persisted to disk. Everything
else (extraction, research, strategy, report, full state machine) is scaffolded as stubs that slot
in without rework.

## Verified ElevenLabs API facts (fetched 2026-07-18, do not code from memory)

- **Outbound call:** `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call`
  - Headers: `xi-api-key`, `Content-Type: application/json`
  - Body: `{ agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data: { dynamic_variables: {..} }, call_recording_enabled }`
  - Returns: `{ success, message, conversation_id, callSid }`
- **Dynamic variables:** referenced in prompts/first-message as `{{var_name}}`; passed as the
  `dynamic_variables` map. Built-in `system__conversation_id`, `system__caller_id`, etc. are
  auto-injected. Custom dynamic vars **echo back** in the webhook under
  `data.conversation_initiation_client_data.dynamic_variables`.
- **Post-call webhook:** `{ type: "post_call_transcription", event_timestamp, data: { agent_id,
  conversation_id, status, transcript: [{role, message, time_in_call_secs, ...}], analysis: {
  transcript_summary, data_collection_results, call_successful }, metadata, conversation_initiation_client_data: { dynamic_variables } } }`
- **Signature:** `ElevenLabs-Signature: t=<unix>,v0=<hex>` where
  `<hex> = HMAC_SHA256(secret, f"{t}.{raw_body}")`. Verify only if a webhook secret is configured.

## Architecture

```
POST /debug/call {agent, to_number, dynamic_vars?}
   → elevenlabs_client.outbound_call(agent_id, phone_number_id, to_number, dyn_vars+{case_id,fh_id,agent_type})
   → ElevenLabs places call; returns conversation_id
   → storage indexes conversation_id → {case_id, agent_type, fh_id}
   → (human answers, talks)
   → POST /webhooks/elevenlabs  {post_call_transcription}
   → webhook verifies HMAC (optional), reads dynamic_variables/conversation_id
   → routes to case, saves transcript.txt + raw payload.json under ./data/<case>/
```

## Files built in this pass

| File | Purpose | This pass |
|---|---|---|
| `app/config.py` | pydantic-settings loader for `.env` | full |
| `app/storage.py` | case dirs, save/read json, transcript save, `conversation_id`→case index (`data/_index.json`) | full |
| `app/elevenlabs_client.py` | `outbound_call(...)` httpx wrapper over verified endpoint | full |
| `app/webhook.py` | HMAC verify (optional) + payload parse → normalized transcript | full |
| `app/main.py` | FastAPI: `POST /webhooks/elevenlabs`, `POST /debug/call`, `GET /cases/{id}`, `GET /health` | full |
| `prompts/{intake,quote,negotiation}_agent.md` | agent system prompt + first message (`{{dyn}}`) + dashboard setup notes | full |
| `app/{extraction,research,strategy,report,state_machine}.py` | pipeline modules | **empty stubs** (signatures + TODO) |
| `pyproject.toml`, `requirements.txt`, `README.md` | tooling (uv) + run steps | full |

## Key decisions

- **Webhook routing:** inject `case_id`, `fh_id`, `agent_type` as dynamic variables on every
  outbound call; they echo back in the webhook. Fallback: `conversation_id` index built at call
  time. Inbound intake (no dyn vars set by us) routes by newest `awaiting_intake` case.
- **Storage:** flat JSON per master spec, plus `data/_index.json` for `conversation_id` routing.
- **HMAC:** implemented but skipped when `ELEVENLABS_WEBHOOK_SECRET` unset — lets us test before
  configuring the signing secret in the dashboard.
- **DEMO_MODE:** `DEMO_TARGETS` (comma-separated E.164) in `.env`; research override lands in
  Slice 2, but `/debug/call` can already dial any target for experiments.
- **Tooling:** `uv` for dev; `requirements.txt` retained for Railway.

## Out of scope this pass (Slice 2+, master spec M2–M6)

Transcript→JSON extraction, Google Places + Tavily research, negotiation strategy, report
generation, and the full `/cases/{id}/advance` sequential pipeline. The webhook handler dispatches
on `agent_type` from day one so these attach cleanly.

## Test plan (user-run — dials a real phone)

1. `uv venv && uv pip install -r requirements.txt`
2. `uv run uvicorn app.main:app --reload --port 8000`
3. `ngrok http 8000` → paste https URL into each ElevenLabs agent's post-call webhook config
   (`{BASE_URL}/webhooks/elevenlabs`).
4. `curl -X POST localhost:8000/debug/call -d '{"agent":"quote","to_number":"+1..."}'`
5. Answer the phone, role-play a funeral home, hang up.
6. Confirm `./data/<case>/transcripts/*.txt` + raw payload appear; `GET /cases/<id>` shows state.
