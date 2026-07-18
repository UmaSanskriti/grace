# Grace — ElevenLabs Agent Configurations

This directory owns the three (and only three) Grace live voice agents and their
client-tool schemas. Quote normalization, compliance audit, scoring, and report
assembly are deterministic tools/orchestrator steps — **do not add more agents**
(§3.2).

| File | Purpose |
|---|---|
| `grace-intake-v1.md` | Consumer-facing voice intake → confirmed CaseSpec. |
| `grace-caller-v1.md` | Provider-facing quote gathering (1 session/provider, up to 3 parallel). |
| `grace-closer-v1.md` | Provider negotiation + consumer explanation of the ranked report. |
| `tool-schemas.json` | ElevenLabs client-tool (webhook) definitions, grouped by agent allowlist. |

**INV-13:** three distinct agent IDs, prompts, tool allowlists, and eval rubrics.
No tool overlap lets the Caller negotiate or the Closer intake.

---

## Environment variables

Set these after creating each agent and importing the number. The Edge Functions
and scheduler read them (see `supabase/functions/.../` and §8.6).

| Env var | Holds |
|---|---|
| `ELEVENLABS_INTAKE_AGENT_ID`  | agent id for `grace-intake-v1` |
| `ELEVENLABS_CALLER_AGENT_ID`  | agent id for `grace-caller-v1` |
| `ELEVENLABS_CLOSER_AGENT_ID`  | agent id for `grace-closer-v1` |
| `ELEVENLABS_PHONE_NUMBER_ID`  | imported Twilio number id (used as `agent_phone_number_id`) |
| `ELEVENLABS_API_KEY`          | `xi-api-key` for the API |
| `ELEVENLABS_WEBHOOK_SECRET`   | HMAC secret verified by `verifyElevenLabsHmac` |
| `APP_BASE_URL`                | origin that `{{APP_BASE_URL}}` in `tool-schemas.json` resolves to |

---

## 1. Create the three agents (dashboard or API)

You can create agents in the ElevenLabs dashboard (Conversational AI → Agents →
Create) or via `POST https://api.elevenlabs.io/v1/convai/agents/create`. For each
agent set **exactly** the values from its `.md` file:

For every agent (shared, §8.5 / §9.x):
- **System prompt** — paste the fenced `System prompt` block from the agent's `.md`.
- **First message** — paste the `voice_openings.*` line (Closer: use `{{first_message}}` and pass the correct opening per `purpose`).
- **Audio format** — Twilio **μ-law 8 kHz** input **and** output.
- **Privacy** — audio saving **OFF**; transcript retention **1 day** (or shortest supported). Twilio recording disabled; `call_recording_enabled: false` on outbound calls (INV-09).
- **Webhooks** — enable **`post_call_transcription`** and **`call_initiation_failure`** only. **No audio webhook** (§8.5, §10.2). Point post-call transcription at `POST {{APP_BASE_URL}}/webhooks/elevenlabs`.
- **Max call duration** — end by **8:00** (Twilio trial cutoff is 10:00).

Per-agent specifics:

| | Intake | Caller | Closer |
|---|---|---|---|
| slug | `grace-intake-v1` | `grace-caller-v1` | `grace-closer-v1` |
| env var | `ELEVENLABS_INTAKE_AGENT_ID` | `ELEVENLABS_CALLER_AGENT_ID` | `ELEVENLABS_CLOSER_AGENT_ID` |
| concurrency | **1** | **up to 3** | **1** |
| dynamic vars | `case_id`, `purpose`, `case_version`, `intake_context` | `case_id`, `purpose`, `task_id`, `provider_id`, `compact_task_json` | `case_id`, `purpose`, `comparison_id`, `verified_leverage_id`, `compact_closer_context` |

Record each returned `agent_id` into its env var above.

## 2. Register client tools and attach the three allowlists

1. Create each tool in `tool-schemas.json` (dashboard: Conversational AI → Tools;
   or API). Use the tool's `name`, `description`, `method`, `url`
   (`{{APP_BASE_URL}}/...`), and `parameters` schema.
2. Capture each returned **`tool_id`**.
3. Attach tools to agents **by `tool_id`** using the three separate allowlists
   (`agents.<slug>.allowlist` in the JSON). Do **not** attach any tool outside an
   agent's allowlist — that is what keeps the Caller from negotiating and the
   Closer from doing intake (INV-13). `end_call` is the built-in ElevenLabs
   system end-call tool (no webhook) and is enabled on all three.
4. Some tool paths are the exact §6.3 endpoints (`comparison`, `report`,
   `quote-item`, `finalize`, `revision`, `case-patch`, `confirm`,
   `cases/{id}/context`); a few follow the `tools-<agent>-<verb>` convention for
   endpoints not spelled out individually (`get_provider_task`,
   `get_verified_leverage`, `save_consumer_decision`, `log_intake_event`) — see the
   `conventions.endpoint_map_source` note in the JSON. Confirm these match the
   deployed Edge Function routes before the demo.

## 3. Import the Twilio number (native integration)

Use the ElevenLabs **native Twilio integration** (not a raw SIP trunk):

1. Conversational AI → **Phone Numbers** → **Import number** → **Twilio**.
2. Provide the Twilio Account SID, Auth Token, and the E.164 number.
3. ElevenLabs stores it as a phone-number resource; record its id into
   `ELEVENLABS_PHONE_NUMBER_ID`. This value is passed as `agent_phone_number_id`
   in the outbound-call request (§8.6):

   ```
   POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
   xi-api-key: ${ELEVENLABS_API_KEY}
   {
     "agent_id": "${ELEVENLABS_CALLER_AGENT_ID}",
     "agent_phone_number_id": "${ELEVENLABS_PHONE_NUMBER_ID}",
     "to_number": "+1XXXXXXXXXX",
     "call_recording_enabled": false,
     "conversation_initiation_client_data": { "dynamic_variables": { ... } }
   }
   ```

   All destinations must be allowlisted team phones (`DEMO_ALLOWED_E164`, INV-02).
   Outbound provider calls launch only after CaseSpec confirmation and allowlist
   validation, with a concurrency cap of 3; the Closer is never in that batch (§8.7).

## 4. Re-check the Messaging webhook after import (§8.4)

Importing a number into ElevenLabs can **overwrite the Twilio number's Messaging
webhook**. After import, open the number in the Twilio console and confirm the
**Messaging → "A message comes in"** webhook still points at the Grace SMS
handler (`POST {{APP_BASE_URL}}/twilio/sms` → `twilio-sms`). If it was changed,
restore it — otherwise inbound SMS (TEXT/CALL/STOP/HELP/YES/EDIT/SUMMARY) will not
reach Grace. Leave the **Voice** webhook to the ElevenLabs native integration.

---

## Verification checklist before demo

- [ ] Three distinct `agent_id`s stored in the three env vars (INV-13).
- [ ] Each agent has its own system prompt, first message, tool allowlist, and eval rubric.
- [ ] Tool allowlists have **no overlap** beyond `end_call`.
- [ ] Audio μ-law 8 kHz; audio saving OFF; Twilio recording OFF (INV-09).
- [ ] Only `post_call_transcription` + `call_initiation_failure` webhooks; no audio webhook.
- [ ] Transcript retention 1 day; 8-minute max duration.
- [ ] Concurrency: Intake 1, Caller 3, Closer 1.
- [ ] Twilio number imported; `ELEVENLABS_PHONE_NUMBER_ID` set; **Messaging webhook re-verified**.
- [ ] All outbound destinations in `DEMO_ALLOWED_E164` (INV-02).
