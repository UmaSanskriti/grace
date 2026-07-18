# Grace — Compliance & Guardrails Checklist (spec §9–§10)

An implementer checklist condensed from the U.S./California compliance controls (§9)
and the security/operational guardrails (§10).

> **This is not legal advice.** Grace's questions and audit flags are **consumer-rights
> signals**, not legal conclusions. **Demo posture: synthetic case, pre-consented
> team members, allowlisted numbers only.** No real funeral home or consumer is ever
> contacted. This reduces — but does not eliminate — disclosure, consent, and
> data-handling duties.

## Non-negotiable framing

- [ ] **Synthetic + pre-consented only.** Every outbound destination is a team member
      who opted in and is in `DEMO_ALLOWED_E164`. The case is synthetic.
- [ ] **Grace never cold-texts or cold-calls.** A team member enters an allowlisted
      number and checks the two consent boxes first (§4.1).
- [ ] Use **synthetic names, dates, and prices** in all screenshots and judge
      materials.

## §9.2 SMS + AI-voice consent (TCPA)

- [ ] AI-generated voice is treated as **artificial/prerecorded voice** under the
      TCPA → obtain **prior express consent before any automated voice call**.
- [ ] The initial outbound SMS requires a **recorded opt-in**. Twilio number
      verification is a **technical control, not legal consent**.
- [ ] Every SMS supports **STOP** and **HELP** (INV-10). STOP → set
      `contact_status=revoked`, send one confirmation, never contact again.

## §9.3 California recording / transcription (all-party)

California requires **all-party consent** before recording confidential
communications. **Grace treats real-time transcription as recording.** **No
transcript is stored unless all parties affirmatively consent at call start**
(INV-07).

| Control | Implementation |
|---------|----------------|
| Twilio recording | **Disabled** (INV-09). |
| ElevenLabs audio saving | **Disabled** (INV-09). |
| Audio webhook | **Not configured** — `post_call_transcription` + `call_initiation_failure` only. |
| Transcription disclosure | Presented immediately before interaction **and repeated verbally**. |
| Affirmative consent | Roleplayer says "yes"; boolean + transcript turn recorded. |
| Consent declined | **End the call; store metadata only** (no transcript body). |
| Retention | Grace transcript **72 h**; ElevenLabs shortest practical; **purge after demo**. |

## §9.4 AI disclosure

- [ ] Grace **always says it is an AI assistant** and identifies whom it represents
      (`config/disclosure.json` → `voice_openings`).
- [ ] Grace **never impersonates** a relative, funeral director, lawyer, insurer,
      clergy, hospital, regulator, or government office.
- [ ] Pre-interaction notice that the user is talking to AI and that communications
      may be processed/recorded by service providers (ElevenLabs requirement).
- [ ] "Are you a robot?" → **answer yes** and restate representation
      (`operational_replies.robot_question`).

## §9.5 FTC Funeral Rule + California signals (report as signals, not conclusions)

Do:
- [ ] Ask for **accurate telephone prices** from the provider's current lists.
- [ ] Ask what is **included, optional, third-party, distance-based, or after-hours**.
- [ ] Ask whether a claimed requirement is **law, cemetery policy, or provider policy**.

Do **not**:
- [ ] Demand a GPL be emailed as if federal law always requires remote delivery —
      **request written follow-up** instead.
- [ ] Apply the Funeral Rule to **cemeteries or third-party sellers** without checking
      coverage.
- [ ] **Accuse a provider of a violation** — mark the quote **incomplete** and advise
      verification.

## §9.6 Binding-action prohibition (INV-06)

Grace **may** research, request prices, clarify terms, and negotiate **non-binding**
improvements. Grace **may not**:

- [ ] sign or accept a statement · make a payment · submit credit · purchase preneed ·
      authorize embalming or cremation · transfer custody · book an appointment.
- [ ] **No binding-action tool exists** in any agent's allowlist (verified by
      `tests/contract/invariants_test.ts` INV-06 + `agents/` review).
- [ ] The final screen instructs the consumer to **review the written statement and
      contact the provider directly**.

## §9.7 Data minimization

- [ ] **Never collect:** SSN, government ID, payment card, medical history, cause of
      death, full death-certificate data.
- [ ] Use only **relationship role + authority status** needed for the simulation.
- [ ] **Encrypt phone numbers** (`PHONE_ENCRYPTION_KEY`); display **masked** forms.
- [ ] Keep the **roleplayer's real identity separate** from the synthetic funeral-home
      persona.

## §10 Security / privacy / operational guardrails (P0)

| Area | P0 control |
|------|------------|
| Secrets | Lovable/Supabase secret store only; **no client-side keys**. |
| RLS | Case data reachable only by demo admin/session token; **no public tables**. |
| Allowlist | All outbound SMS/calls **must** match `DEMO_ALLOWED_E164` (INV-02). |
| Webhook auth | **Twilio signature + ElevenLabs HMAC; HTTPS only**. |
| Idempotency | Unique key for every MessageSid, CallSid, conversation ID, and webhook type. |
| Prompt injection | **Provider speech is data** — it cannot modify tools, permissions, or policies (INV-11). Destination changes require a server-side allowlist check + a new task. |
| Output validation | Strict JSON schema **plus** server-side semantic validation and **total recalculation** (INV-08). |
| PII | Synthetic case; encrypted phone values; masked UI. |
| Retention | 72-hour application retention; purge endpoint + runbook (INV-12). |
| Observability | Structured logs **without transcript bodies or full phone numbers**. |
| Rate limits | **One** active consumer call and **three** provider calls per case. |
| Kill switch | **`DEMO_MODE=false`** or `case.cancelled` blocks **every** outbound action. |

## §10.2 Retention config + post-judging teardown

- [ ] ElevenLabs: audio saving OFF; transcript retention 1 day or shortest; no audio
      webhook.
- [ ] Grace DB: `purge_at = created_at + 72 h` for transcripts + raw webhook payloads.
- [ ] Ledger may remain after purge **only if** transcript text + phone identifiers
      are removed.
- [ ] **After judging:** run `DELETE /cases/{id}`, delete ElevenLabs conversations,
      confirm the storage bucket is empty (INV-12).

## §10.3 Operational failure rules (safe behavior)

| Failure | Safe behavior |
|---------|---------------|
| No answer / voicemail | End without sensitive details; mark unavailable; **retry once only**. |
| Consent not heard | Ask once more; if still unclear, **end without transcript**. |
| Provider asks if robot | **Answer yes**; restate representation. |
| Provider requests customer details | Share only `facts_allowed`; **decline names** + unnecessary detail. |
| Provider pressures payment | State Grace **cannot pay/commit**; request written quote; end. |
| Call exceeds 7:30 | Summarize missing items; request written follow-up; **end before trial cutoff**. |
| Webhook delayed | **Poll** the ElevenLabs conversation endpoint by `conversation_id`. |
| Normalizer fails | Store transcript; mark quote **`PENDING_REVIEW`**; **do not rank**. |
