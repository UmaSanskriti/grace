# Grace — Setup Runbook (spec §8)

End-to-end setup for the Twilio + ElevenLabs + Lovable/Supabase + OpenAI stack.
Do the **manual account setup (§8.1) first**, run the **canary (§8.3)** in the first
hour ([`telephony-canary.md`](./telephony-canary.md)), then configure numbers and
agents.

> Controlled test only: synthetic data, pre-consented team members, allowlisted
> U.S. numbers. Not legal advice. See [`compliance.md`](./compliance.md).

## 8.1 Manual account prerequisites (human required)

A web-enabled AI cannot legitimately create the Twilio account for the team. A human
must complete email + personal-phone verification and accept Twilio's terms. Twilio
advertises a ~30-day trial with product-specific units; trial restrictions still
apply. Work this checklist top to bottom:

- [ ] Redeem **ElevenLabs hackathon credit**; confirm **Agents** access.
- [ ] Create **three ElevenLabs agents**: Intake, Caller, Closer — each with its own
      prompt and `tool_ids` (INV-13).
- [ ] Create the **Twilio trial** manually; verify email + lead phone.
- [ ] Provision **one U.S. local number** with **Voice + SMS** capability.
- [ ] **Verify every** consumer/provider team phone in Twilio.
- [ ] Add all allowed numbers to **`DEMO_ALLOWED_E164`**.
- [ ] Create the **Lovable Cloud** project and add secrets.
- [ ] Create the **OpenAI** project/key; confirm available model IDs.
- [ ] Create a **Tavily** key or load fixture data.

## 8.2 Environment variables

Copy `.env.example` → `.env` and fill in **after** §8.1. All keys are **server-side
only**; never ship them to the client. The template is the source of truth — the
canonical set (spec §8.2):

```
TWILIO_ACCOUNT_SID=            TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER_E164=      TWILIO_MESSAGING_WEBHOOK_URL=
TWILIO_STATUS_WEBHOOK_URL=

ELEVENLABS_API_KEY=            ELEVENLABS_PHONE_NUMBER_ID=
ELEVENLABS_INTAKE_AGENT_ID=    ELEVENLABS_CALLER_AGENT_ID=
ELEVENLABS_CLOSER_AGENT_ID=    ELEVENLABS_WEBHOOK_SECRET=

OPENAI_API_KEY=  OPENAI_MODEL_FAST=  OPENAI_MODEL_AUDIT=

TAVILY_API_KEY=  APP_BASE_URL=
DEMO_ALLOWED_E164=+1..., +1..., +1...
DEMO_RETENTION_HOURS=72   DEMO_MODE=true
```

The repo `.env.example` additionally pins `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`, `PHONE_ENCRYPTION_KEY`
(32-byte base64, for phone encryption at rest), and `DISCLOSURE_VERSION`
(`grace-demo-2026-07-18`). **`DEMO_MODE=true` is the kill switch** — set it `false`
(or cancel the case) to block every outbound action.

## 8.3 Twilio trial canary

See [`telephony-canary.md`](./telephony-canary.md). SMS is go/no-go; **voice
continues on the trial regardless**. Do not debug carrier registration — request
organizer credit.

## 8.4 Configure the Twilio number

- [ ] Set Messaging **"A message comes in"** webhook to
      `POST https://<app>/twilio/sms`.
- [ ] Set the messaging **status callback** if the chosen send path supports it
      (`TWILIO_STATUS_WEBHOOK_URL` → `/webhooks/twilio-status`).
- [ ] **Import the Twilio number into ElevenLabs** native integration for voice.
- [ ] Assign **Grace Intake Agent** for inbound voice **only if** inbound calls are
      part of the demo.
- [ ] **After import, re-check** that the Messaging webhook still points to Grace's
      backend (import can reset it).
- [ ] **Do NOT enable Twilio call recording** (INV-09).

## 8.5 Configure the three ElevenLabs agents (§8.5)

Create **three distinct agent IDs**: `grace-intake-v1`, `grace-caller-v1`,
`grace-closer-v1` — each with a different system prompt, `tool_ids` allowlist, first
message, and eval rubric (INV-13).

| Setting | Required value |
|---------|----------------|
| **Audio format** | Twilio **μ-law 8 kHz** input/output. |
| **Intake first message** | AI + transcription disclosure; obtain consent; confirm the consumer wants to continue. |
| **Caller first message** | AI + family representation + synthetic demo + transcription consent; then request the quote. |
| **Closer first message** | Provider mode: repeat AI / representation / consent. Consumer mode: identify Grace Closer and ask permission to explain results. |
| **Privacy** | **Disable audio saving**; transcript retention **1 day** or shortest account-supported value (INV-09, §10.2). |
| **Webhooks** | Enable **`post_call_transcription`** and **`call_initiation_failure`** only. **No audio webhook.** |
| **Tools (three separate allowlists)** | **Intake:** context / patch / confirm (+ `log_intake_event`, `end_call`). **Caller:** provider task / quote item / finalize (+ `mark_callback_or_decline`, `end_call`). **Closer:** audited comparison / leverage / revision / report / decision (+ `end_call`). |
| **Dynamic variables** | **All:** `case_id`, `purpose`. **Intake:** `case_version` + `intake_context`. **Caller:** `task_id` + `provider_id` + `compact_task_json`. **Closer:** `comparison_id` + `verified_leverage_id` + `compact_closer_context`. |
| **Duration** | **End by 8 minutes** to stay below the Twilio trial 10-minute limit (agents should wrap by ~7:30, §10.3). |
| **Concurrency** | **Intake: 1. Caller: up to 3 concurrent. Closer: 1** negotiation/explanation session at a time. |

First-message wording comes from `config/disclosure.json` → `voice_openings`
(`intake`, `caller`, `closer_provider`, `closer_consumer`) — match it verbatim.

## 8.6 Outbound call request (§8.6)

```http
POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
xi-api-key: ${ELEVENLABS_API_KEY}
Content-Type: application/json

{
  "agent_id": "${ELEVENLABS_CALLER_AGENT_ID}",
  "agent_phone_number_id": "${ELEVENLABS_PHONE_NUMBER_ID}",
  "to_number": "+1XXXXXXXXXX",
  "call_recording_enabled": false,
  "conversation_initiation_client_data": {
    "dynamic_variables": {
      "case_id": "case_uuid",
      "task_id": "task_uuid",
      "provider_id": "demo_hidden_fee",
      "purpose": "initial_quote",
      "compact_task_json": "{...}"
    }
  }
}
```

`call_recording_enabled` **must stay `false`** (INV-09). `to_number` **must** pass
the server-side allowlist check (INV-02) before the request is sent.

## 8.7 Provider-call scheduler (§8.7)

- Launch **three Grace Caller sessions only after** CaseSpec confirmation **and**
  allowlist validation (INV-01/INV-02/INV-03).
- Use **ElevenLabs batch calling** when available, or **three individual
  outbound-call requests with `Promise.allSettled`** and a **concurrency cap of 3**.
- The **Grace Closer Agent is never in this batch** — it is dispatched **only after
  audits** complete.
- Fallbacks (§12.3): on a concurrency error, launch **sequential** calls and
  **preserve the same task IDs**; with only one provider phone, run **three
  sequential calls** to the same roleplayer using three persona cards.
