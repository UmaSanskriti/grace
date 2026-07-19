# Grace — AI Funeral Quote & Negotiation Agent

**v0 build instructions — minimal prototype.**
Hackathon project. Backend only (no frontend for now).

> **Scope of this doc:** This is the *lean v0* — just enough to prove the end-to-end flow
> (intake → research → quote calls → negotiation → report) works. The data models here are
> deliberately minimal happy-path. The **real** information we need to ingest from users and
> funeral homes is much richer (full intake, itemized quote/GPL price breakdowns, negotiation
> detail) — see [`data-model-full.md`](./data-model-full.md). Don't over-build v0; get the
> pipeline running first.

---

## 1. Product summary

Arranging a funeral in the US requires calling multiple funeral homes for quotes, then calling again to negotiate — an exhausting process at the worst possible time. **Grace** is an AI phone agent that does it all:

1. The user calls Grace. Grace interviews them and collects requirements.
2. Grace writes the user's info to structured JSON.
3. Grace researches local funeral homes (name, phone, address).
4. Grace calls each funeral home and obtains a quote.
5. Once quotes are collected, Grace generates a negotiation strategy.
6. Grace calls back the shortlisted funeral homes and negotiates the price.
7. Grace produces a final comparison report for the user.

---

## 2. Architecture overview

```
                    ┌──────────────────────────┐
  User (phone) ───► │  ElevenLabs Agents       │ ◄─── outbound calls to
                    │  (voice layer:           │      funeral homes
                    │   STT + LLM + TTS +      │
                    │   Twilio telephony,      │
                    │   fully managed)         │
                    └───────────┬──────────────┘
                                │ post-call webhooks (transcripts)
                                ▼
                    ┌──────────────────────────┐
                    │  Orchestrator (FastAPI)  │
                    │  - state machine         │
                    │  - transcript → JSON     │
                    │    extraction (LLM)      │
                    │  - triggers next calls   │
                    └───┬───────────┬──────────┘
                        │           │
              ┌─────────▼───┐   ┌────▼─────────────┐
              │ LLM API     │   │ Research APIs    │
              │ (Claude or  │   │ - Google Places  │
              │  OpenAI)    │   │   (funeral home  │
              │ extraction, │   │    list + phones)│
              │ strategy,   │   │ - Tavily         │
              │ report      │   │   (market prices)│
              └─────────────┘   └──────────────────┘

              Storage: JSON files on disk (SQLite optional)
```

**Key decision: do NOT build a raw Twilio Media Streams pipeline.** ElevenLabs Agents Platform handles telephony, STT, TTS, turn-taking, and interruptions. We only build the orchestration layer.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Voice agent | ElevenLabs Agents Platform | We have API credits. Handles inbound + outbound calls, phone number provisioning, post-call webhooks with transcripts. |
| Orchestrator | Python 3.12 + FastAPI | Receives webhooks, runs the pipeline state machine. |
| LLM | OpenAI API | Transcript → JSON extraction, negotiation strategy, final report. |
| Funeral home search | Google Places API (Text Search + Place Details) | Returns name, formatted phone number, address. Tavily cannot reliably return phone numbers. |
| Market research | Tavily API | e.g. "average cremation cost in {city}" — used as negotiation ammunition. |
| Storage | JSON files under `./data/` | One directory per case. SQLite only if concurrency becomes an issue. No Supabase for MVP. |
| Dev tunneling | ngrok | Local FastAPI + `ngrok http 8000`; set the ngrok URL as the ElevenLabs webhook target. |
| Demo deployment | Railway | GitHub-connected auto deploy, env vars via UI. Deploy the day before the demo; develop locally until then. |

---

## 4. Repository layout

```
grace/
├── app/
│   ├── main.py               # FastAPI app, webhook endpoints
│   ├── state_machine.py      # case lifecycle transitions
│   ├── elevenlabs_client.py  # outbound call API, agent config helpers
│   ├── extraction.py         # LLM: transcript → structured JSON
│   ├── research.py           # Google Places + Tavily
│   ├── strategy.py           # LLM: negotiation strategy generation
│   ├── report.py             # LLM: final report generation
│   └── storage.py            # JSON file read/write helpers
├── prompts/
│   ├── intake_agent.md       # ElevenLabs agent system prompt (interview)
│   ├── quote_agent.md        # ElevenLabs agent system prompt (get quote)
│   ├── negotiation_agent.md  # ElevenLabs agent system prompt (negotiate)
│   ├── extract_user_info.md  # LLM extraction prompt
│   ├── extract_quote.md      # LLM extraction prompt
│   └── strategy.md           # negotiation strategy prompt
├── data/                     # runtime case data (gitignored)
├── .env.example
├── requirements.txt
└── README.md
```

---

## 5. Data model

All state lives in `./data/{case_id}/`.

### 5.1 `case.json` — pipeline state

```json
{
  "case_id": "case_20260718_001",
  "status": "collecting_quotes",
  "created_at": "2026-07-18T10:00:00Z",
  "user_phone": "+1415XXXXXXX"
}
```

`status` enum (state machine):

```
awaiting_intake → intake_done → researching → calling_for_quotes
→ quotes_collected → strategy_ready → negotiating → done
```

### 5.2 `user_info.json` — extracted from the intake call

v0 captures only the essentials needed to *request* a quote. Full intake fields (relationship,
attendees, religious/cultural notes, disposition preferences, veteran status, insurance, etc.) →
[`data-model-full.md` §1](./data-model-full.md).

```json
{
  "contact_name": "string",
  "service_type": "cremation | burial | memorial_only",
  "location": { "city": "string", "state": "string", "zip": "string" },
  "timeline": "string (e.g. within 1 week)",
  "budget_usd": 8000
}
```

### 5.3 `funeral_homes.json` — research output

```json
[
  {
    "id": "fh_001",
    "name": "string",
    "phone": "+1XXXXXXXXXX",
    "address": "string",
    "rating": 4.6,
    "source": "google_places"
  }
]
```

### 5.4 `quotes/{fh_id}.json` — one per quote call

v0 records a single headline price + notes. The real quote is an **itemized GPL breakdown**
(basic services fee, embalming, casket/urn, cremation fee, cash advances, package vs. à la carte) —
which is what actually enables comparison and negotiation → [`data-model-full.md` §2](./data-model-full.md).

```json
{
  "funeral_home_id": "fh_001",
  "call_id": "elevenlabs conversation id",
  "quoted_price_usd": 7200,
  "notes": "string",
  "transcript_path": "transcripts/fh_001_quote.txt"
}
```

### 5.5 `strategy.json` and `negotiations/{fh_id}.json`

v0 keeps one target price + a leverage list per home. Richer strategy (walk-away/BATNA, per-item
negotiability, concessions to seek) → [`data-model-full.md` §3](./data-model-full.md).

```json
// strategy.json
{
  "market_context": "summary of Tavily research",
  "shortlist": ["fh_001", "fh_003"],
  "per_home_strategy": [
    {
      "funeral_home_id": "fh_001",
      "target_price_usd": 6500,
      "leverage": ["competitor fh_003 quoted 6800 for same package"]
    }
  ]
}

// negotiations/fh_001.json
{
  "funeral_home_id": "fh_001",
  "final_price_usd": 6600,
  "transcript_path": "transcripts/fh_001_nego.txt"
}
```

### 5.6 `report.md` — final deliverable

Human-readable comparison: Ranking and recommendation, table of homes, original vs. negotiated prices, what's included, Grace's recommendation and reasoning.

---

## 6. ElevenLabs Agents setup

Create **three agents** in the ElevenLabs dashboard (or via API):

### 6.1 Intake agent (inbound)

- Attach a phone number for inbound calls.
- Gather all information required to get quotes (filling `user_info.json`).
- Configure the **post-call webhook** to `POST {BASE_URL}/webhooks/elevenlabs` with the transcript.

### 6.2 Quote agent (outbound)

- Started via the ElevenLabs outbound call API from the orchestrator, one call per funeral home.
- Pass per-call context using **dynamic variables** (user requirements: service type, timeline, city, attendee count). The agent introduces itself honestly as an AI assistant calling on behalf of a family, asks for an itemized quote for the specified service, asks what's included/excluded and about availability, thanks them, ends the call.
- Same post-call webhook.

### 6.3 Negotiation agent (outbound)

- Also started via the outbound call API. Dynamic variables carry the strategy for that specific home: target price, leverage points, walk-away price.
- The agent negotiates politely and honestly (real competitor quotes only — never fabricate numbers), aims for the target price, accepts anything at or below walk-away, and clearly summarizes the agreed final price before ending.
- Same post-call webhook.

> Implementation note for Claude Code: check the current ElevenLabs Agents Platform docs for the exact outbound-call endpoint, dynamic variables syntax, and webhook payload shape before writing the client. Do not code these from memory.

---

## 7. Orchestrator flow (FastAPI)

### Endpoints

| Method & path | Purpose |
|---|---|
| `POST /webhooks/elevenlabs` | Single entrypoint for all post-call webhooks. Route by call metadata (which agent / which case / which funeral home). |
| `POST /cases/{case_id}/advance` | Manual trigger to force the next pipeline step (debugging / demo safety valve). |
| `GET /cases/{case_id}` | Dump full case state as JSON (our "UI" for the demo). |
| `GET /cases/{case_id}/report` | Return `report.md`. |

### State machine logic

1. **Intake call in progress** → use ElevenLabs agent to conduct the intake interview, ensuring all required fields are filled during the call → upon completion, run `extract_user_info` prompt over the transcript → write `user_info.json` → status `intake_done` → immediately kick research.
2. **Research** → Google Places text search: `"funeral homes in {city}, {state}"` → Place Details for phone numbers → write `funeral_homes.json` (cap at 3–5 for the hackathon) → in parallel, Tavily search for local market prices → status `calling_for_quotes` → trigger outbound quote calls **sequentially** (one at a time; simpler and avoids webhook race conditions).
3. **Webhook: quote call ended** → `extract_quote` prompt → write `quotes/{fh_id}.json` → if more homes remain, call the next one; else status `quotes_collected` → generate strategy.
4. **Strategy** → LLM with all quotes + Tavily market data → `strategy.json` → status `strategy_ready` → trigger negotiation calls sequentially for the shortlist.
5. **Webhook: negotiation call ended** → extract final price → `negotiations/{fh_id}.json` → when shortlist exhausted → generate `report.md` → status `done`.

### Error handling (hackathon-grade)

- Every LLM extraction validates against the JSON schema; on failure, retry once with the validation error appended to the prompt.
- If a call fails / no one answers, mark the home `unreachable` and move on.
- All state transitions are idempotent (webhook may retry).
- Log everything to stdout; Railway shows logs in the UI.

---

## 8. Environment variables

```
ELEVENLABS_API_KEY=
ELEVENLABS_INTAKE_AGENT_ID=
ELEVENLABS_QUOTE_AGENT_ID=
ELEVENLABS_NEGO_AGENT_ID=
ELEVENLABS_PHONE_NUMBER_ID=
OPENAI_API_KEY=
GOOGLE_PLACES_API_KEY=
TAVILY_API_KEY=
BASE_URL=                   # ngrok URL in dev, Railway URL in prod
```

---

## 9. Dev & deploy workflow

**Development (all week):**

```bash
uvicorn app.main:app --reload --port 8000
ngrok http 8000        # paste the https URL into ElevenLabs webhook config
```

**Demo deploy (day before):** push to GitHub → connect repo on Railway → set env vars in Railway UI → update `BASE_URL` and the ElevenLabs webhook URL to the Railway domain.

---

## 10. Demo & compliance plan — IMPORTANT

**Do NOT place AI calls to real funeral homes.** California requires two-party consent for call recording, and unsolicited AI robocalls to real businesses carry legal risk (TCPA) and are simply bad form.

For the demo:

- Register **teammates' phone numbers** as the "funeral homes" in `funeral_homes.json` (override the Places results with a `DEMO_MODE=true` env flag that swaps in the teammate list).
- Teammates role-play funeral home staff — this is actually a *better* demo: live human-vs-AI negotiation on stage.
- Google Places research still runs for real and is shown to judges ("in production, these are the numbers Grace would call").
- Grace always identifies itself as an AI assistant at the start of every outbound call.

---

## 11. Build order (milestones for Claude Code)

1. **M1 — Skeleton:** FastAPI app, storage helpers, state machine with all endpoints, fake data fixtures. `GET /cases/{id}` works end-to-end with mocked steps.
2. **M2 — Intake:** ElevenLabs intake agent + webhook → `user_info.json` extraction. Test by actually calling the agent.
3. **M3 — Research:** Google Places + Tavily integration → `funeral_homes.json` (with `DEMO_MODE` override).
4. **M4 — Quote calls:** outbound call API + quote extraction, sequential loop.
5. **M5 — Strategy + negotiation calls.**
6. **M6 — Report generation + Railway deploy + full dress rehearsal.**

Each milestone should be demoable on its own — if time runs out, we present the furthest completed milestone.
