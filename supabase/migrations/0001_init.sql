-- =====================================================================
-- Grace — 0001_init.sql
-- Canonical schema for the "Grace" funeral-arrangements advocate demo.
--
-- Implements all 14 canonical tables from spec §6.2. Column shapes match
-- supabase/functions/_shared/types.ts (the frozen cross-module contract).
--
-- Design notes:
--   * uuid primary keys via gen_random_uuid(); timestamptz everywhere.
--   * *_json columns are jsonb (validated payloads are the canonical store;
--     the Markdown ledger in §6.5 is only a projection).
--   * Phone numbers are NEVER stored in a queryable plaintext column:
--     participants carry phone_e164_encrypted (ciphertext) + phone_hash
--     (deterministic hash for lookup) — see §9.7 / §10 (PII).
--   * ON DELETE CASCADE from cases → all child rows so DELETE /cases/{id}
--     purges a case cleanly in one statement (INV-12).
--   * Row Level Security is enabled on every table and is deny-by-default.
--     Edge Functions connect with the Supabase service_role key, which
--     bypasses RLS; anon/authenticated (browser) roles get NO policies and
--     therefore no access to case data (§10 "RLS: no public tables").
--   * Retention: cases.purge_at plus per-row purge_at on transcript_turns
--     (created_at + DEMO_RETENTION_HOURS = 72h) — see §10.2.
--   * Idempotency: events.idempotency_key UNIQUE, plus unique constraints on
--     MessageSid / CallSid / conversation_id so webhook replays cannot create
--     duplicate rows (§6.7, §10, webhook-replay test §11.1).
-- =====================================================================

-- gen_random_uuid() is built in on PG13+; keep pgcrypto for portability.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums (mirror the string unions in types.ts)
-- ---------------------------------------------------------------------

-- CaseStatus state machine (§3.3 / types.ts).
create type case_status as enum (
  'NEW',
  'CONSENTED',
  'PREFERENCE_SMS_SENT',
  'TEXT_INTAKE',
  'INTAKE_AGENT_ACTIVE',
  'CASE_DRAFT',
  'CASE_CONFIRMED',
  'CALLER_BATCH_QUEUED',
  'CALLER_AGENT_ACTIVE',
  'QUOTE_CAPTURED',
  'CALLBACK',
  'DECLINED',
  'UNAVAILABLE',
  'QUOTES_NORMALIZED_AND_AUDITED',
  'CLOSER_READY',
  'CLOSER_NEGOTIATION_ACTIVE',
  'QUOTE_REVISED',
  'NEGOTIATION_DECLINED',
  'REPORT_READY',
  'CLOSER_CONSUMER_CALL_ACTIVE',
  'CONSUMER_TEXT_SUMMARY',
  'CONSUMER_UPDATED',
  'CLOSED'
);

-- PreferredChannel (types.ts).
create type preferred_channel as enum ('text', 'voice', 'unknown');

-- Message flow.
create type message_direction as enum ('inbound', 'outbound');
create type message_channel as enum ('sms', 'voice');

-- AuditStatus (types.ts).
create type audit_status as enum ('PENDING', 'PENDING_REVIEW', 'AUDITED');

-- ---------------------------------------------------------------------
-- 1. cases  (§6.2: case_id, status, preferred_channel, current_version,
--            created_at, purge_at)
-- ---------------------------------------------------------------------
create table cases (
  case_id           uuid primary key default gen_random_uuid(),
  status            case_status      not null default 'NEW',
  preferred_channel preferred_channel not null default 'unknown',
  -- Pointer to the active case_versions.version. Kept as a plain integer
  -- (no composite FK) to avoid a chicken-and-egg insert cycle with
  -- case_versions; the backend keeps it in sync.
  current_version   integer          not null default 0,
  -- Kill switch / STOP support (§10, INV-10): once true no further outbound.
  cancelled         boolean          not null default false,
  created_at        timestamptz      not null default now(),
  -- Demo data must be purged at or before purge_at (INV-12). Default 72h.
  purge_at          timestamptz      not null default (now() + interval '72 hours')
);

comment on column cases.purge_at is
  'INV-12: purge demo data at or before this time (created_at + DEMO_RETENTION_HOURS=72h).';

-- ---------------------------------------------------------------------
-- 2. case_versions  (§6.2: case_id, version, case_spec_json, confirmed_at,
--                    input_hash)
-- Immutable, append-only snapshots of the CaseSpec. INV-03: all initial
-- provider tasks reference one (version, input_hash).
-- ---------------------------------------------------------------------
create table case_versions (
  case_id        uuid        not null references cases(case_id) on delete cascade,
  version        integer     not null,
  case_spec_json jsonb       not null,          -- CaseSpec (types.ts)
  input_hash     text        not null,          -- hash freezing the spec content
  confirmed_at   timestamptz,                   -- set once explicitly confirmed
  created_at     timestamptz not null default now(),
  primary key (case_id, version)
);

-- ---------------------------------------------------------------------
-- 3. participants  (§6.2: participant_id, case_id, role,
--                   phone_e164_encrypted, phone_hash)
-- ---------------------------------------------------------------------
create table participants (
  participant_id       uuid  primary key default gen_random_uuid(),
  case_id              uuid  not null references cases(case_id) on delete cascade,
  role                 text  not null,          -- e.g. 'consumer', 'provider'
  -- Phone stored ONLY as ciphertext + deterministic hash (§9.7). No
  -- plaintext phone in any queryable column.
  phone_e164_encrypted text,
  phone_hash           text,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. consents  (§6.2: participant_id, scope, disclosure_version,
--               granted_at, revoked_at)
-- Consent booleans mirror ConsentRecord (types.ts).
-- ---------------------------------------------------------------------
create table consents (
  consent_id          uuid        primary key default gen_random_uuid(),
  participant_id      uuid        not null references participants(participant_id) on delete cascade,
  scope               text        not null,      -- consent scope label
  disclosure_version  text        not null,
  sms_opt_in          boolean     not null default false,
  ai_voice_opt_in     boolean     not null default false, -- INV-01 gate for calls
  transcription_opt_in boolean    not null default false, -- INV-07 gate for transcripts
  marketing_opt_in    boolean     not null default false,
  ip                  text,
  user_agent          text,
  granted_at          timestamptz not null default now(),
  revoked_at          timestamptz
);

-- ---------------------------------------------------------------------
-- 8. providers  (§6.2: provider_id, type, label, destination, persona_id,
--                allowlisted)
-- Reference data (synthetic demo personas). Not case-scoped, so NOT cascade
-- deleted with a case. Defined here (ahead of its §6.2 ordinal) because
-- messages / call_sessions / provider_call_tasks / quotes FK to it.
-- ---------------------------------------------------------------------
create table providers (
  provider_id text        primary key,           -- natural key, e.g. 'demo_transparent'
  type        text        not null default 'demo',
  label       text        not null,
  -- Placeholder E.164; the real allowlisted team destination is injected at
  -- demo time from DEMO_ALLOWED_E164 (INV-02). Never a real funeral home.
  destination text,
  persona_id  text,                               -- 'A' | 'B' | 'C' (config/personas.json)
  -- Must match DEMO_ALLOWED_E164 before any outbound is permitted (INV-02).
  allowlisted boolean     not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 5. messages  (§6.2: message_id, case_id, direction, channel,
--               provider_id, body, status, timestamp)
-- ---------------------------------------------------------------------
create table messages (
  message_id   uuid              primary key default gen_random_uuid(),
  case_id      uuid              not null references cases(case_id) on delete cascade,
  direction    message_direction not null,
  channel      message_channel   not null default 'sms',
  provider_id  text              references providers(provider_id), -- null for consumer SMS
  body         text,
  status       text,                                       -- Twilio delivery status
  -- Idempotency: a given Twilio MessageSid maps to exactly one row so
  -- webhook/status replays cannot duplicate (§6.7, §10).
  twilio_sid   text              unique,   -- Twilio MessageSid (idempotency)
  timestamp    timestamptz       not null default now()
);

-- ---------------------------------------------------------------------
-- 6. call_sessions  (§6.2: call_id, case_id, purpose, Twilio SID,
--                    ElevenLabs conversation ID, consent, status)
-- ---------------------------------------------------------------------
create table call_sessions (
  call_id                 uuid        primary key default gen_random_uuid(),
  case_id                 uuid        not null references cases(case_id) on delete cascade,
  provider_id             text        references providers(provider_id), -- null for intake/consumer calls
  -- 'consumer_intake' | 'initial_quote' | 'negotiation' | 'consumer_explanation'
  purpose                 text        not null,
  twilio_sid              text        unique,     -- Twilio CallSid (idempotency §6.7)
  elevenlabs_conversation_id text     unique,     -- idempotency key (§6.7)
  -- Full consent snapshot captured at call start (booleans + affirmations).
  consent_json            jsonb,
  -- Fast INV-07 gate: no transcript_turns may be persisted when this is not
  -- true. Nullable — affirmative transcription consent is captured at call
  -- start for provider/negotiation calls, so it may be null until then.
  consent                 boolean,
  status                  text        not null default 'pending',
  created_at              timestamptz not null default now()
);

comment on column call_sessions.consent is
  'INV-07: transcript_turns must not be persisted for this call unless true.';

-- ---------------------------------------------------------------------
-- 7. transcript_turns  (§6.2: call_id, turn_index, role, text,
--                       start_seconds, end_seconds)
-- Only persisted when the call had all-party transcription consent (INV-07).
-- Purgeable at created_at + 72h (§10.2).
-- ---------------------------------------------------------------------
create table transcript_turns (
  call_id       uuid        not null references call_sessions(call_id) on delete cascade,
  turn_index    integer     not null,
  role          text        not null,            -- 'agent' | 'provider' | 'consumer'
  text          text,
  start_seconds numeric,
  end_seconds   numeric,
  created_at    timestamptz not null default now(),
  -- DEMO_RETENTION_HOURS = 72h. A scheduled purge deletes rows past purge_at.
  purge_at      timestamptz not null default (now() + interval '72 hours'),
  primary key (call_id, turn_index)
);

comment on table transcript_turns is
  'Transcript text is retained 72h then purged (§10.2). Raw vendor webhook '
  'payloads are NOT stored here or in any table: per §6.7/§10.2 they live only '
  'in encrypted private storage with the same 72h TTL; the DB keeps validated '
  'event JSON in events.payload_json.';

-- ---------------------------------------------------------------------
-- 9. provider_call_tasks  (§6.2: task_id, provider_id, case_version,
--                          task_json, attempt, status)
-- ---------------------------------------------------------------------
create table provider_call_tasks (
  task_id          uuid        primary key default gen_random_uuid(),
  -- case_id added so tasks cascade-purge with the case (INV-12).
  case_id          uuid        not null references cases(case_id) on delete cascade,
  provider_id      text        not null references providers(provider_id),
  -- CaseSpec version + hash all initial tasks must share (INV-03).
  case_version     integer     not null,
  task_json        jsonb       not null,          -- ProviderCallTask (types.ts)
  attempt          integer     not null default 1,-- retry-once policy (§10.3)
  status           text        not null default 'queued',
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 10. quotes  (§6.2: quote_id, provider_id, quote_json, total, confidence,
--              audit_status)
-- ---------------------------------------------------------------------
create table quotes (
  quote_id     uuid          primary key default gen_random_uuid(),
  -- case_id added so quotes cascade-purge with the case (INV-12).
  case_id      uuid          not null references cases(case_id) on delete cascade,
  provider_id  text          not null references providers(provider_id),
  -- CaseSpec version this quote answers (matches QuoteResult.case_spec_version).
  case_spec_version integer  not null,
  -- ElevenLabs conversation this quote was normalized from (post-call pipeline).
  conversation_id text,
  quote_json   jsonb         not null,            -- QuoteResult (types.ts)
  total        numeric(12,2),                     -- null == unknown (INV-08)
  confidence   numeric,                           -- 0..1
  audit_status audit_status  not null default 'PENDING',
  created_at   timestamptz   not null default now()
);

-- ---------------------------------------------------------------------
-- 11. quote_line_items  (§6.2: quote_id, category, amount, evidence_ref,
--                        required_for_case)
-- INV-08: every amount carries an evidence reference or is explicitly null.
-- ---------------------------------------------------------------------
create table quote_line_items (
  line_item_id     uuid    primary key default gen_random_uuid(),
  quote_id         uuid    not null references quotes(quote_id) on delete cascade,
  category         text    not null,
  description      text,
  amount           numeric(12,2),                 -- null == unknown (INV-08)
  -- EvidenceRef (types.ts): {conversation_id, turn_index, start/end seconds}.
  evidence_ref     jsonb,
  required_for_case boolean not null default false,
  -- INV-08 enforced at the DB level: a non-null amount must carry evidence.
  constraint quote_line_items_amount_has_evidence
    check (amount is null or evidence_ref is not null)
);

comment on constraint quote_line_items_amount_has_evidence on quote_line_items is
  'INV-08: every material amount has an evidence_ref, otherwise amount must be null/unknown.';

-- ---------------------------------------------------------------------
-- 12. approvals  (§6.2: approval_id, case_id, action, scope_json,
--                 approved_at)
-- Human authorizations (research/call/negotiate). No binding action exists (INV-06).
-- ---------------------------------------------------------------------
create table approvals (
  approval_id uuid        primary key default gen_random_uuid(),
  case_id     uuid        not null references cases(case_id) on delete cascade,
  action      text        not null,               -- e.g. 'call', 'negotiate'
  scope_json  jsonb,                               -- bounded scope of the approval
  approved_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 13. events  (§6.2: event_id, case_id, type, actor, payload_json,
--              timestamp, idempotency_key)
-- The material-event ledger. Stores ONLY validated event JSON (never raw
-- vendor payloads). idempotency_key makes webhook replays no-ops (§6.7, §10).
-- ---------------------------------------------------------------------
create table events (
  event_id        uuid        primary key default gen_random_uuid(),
  -- Nullable so system-level events without a case are allowed; cascades when set.
  case_id         uuid        references cases(case_id) on delete cascade,
  type            text        not null,
  actor           text,
  payload_json    jsonb,
  -- Composite of MessageSid/CallSid/conversation_id + webhook type. UNIQUE so a
  -- replayed webhook cannot create a duplicate row (§6.7, replay test §11.1).
  idempotency_key text        unique,
  timestamp       timestamptz not null default now()
);

comment on column events.idempotency_key is
  'UNIQUE. Derived from MessageSid/CallSid/conversation_id + webhook type so '
  'duplicate webhook deliveries are idempotent (§6.7, §10).';

-- ---------------------------------------------------------------------
-- 14. reports  (§6.2: report_id, case_id, report_json, report_markdown,
--               created_at)
-- Per §10.2 a report may remain after purge only once transcript text and
-- phone identifiers have been removed.
-- ---------------------------------------------------------------------
create table reports (
  report_id       uuid        primary key default gen_random_uuid(),
  case_id         uuid        not null references cases(case_id) on delete cascade,
  report_json     jsonb       not null,            -- RankedReport (types.ts)
  report_markdown text,
  created_at      timestamptz not null default now()
);

-- =====================================================================
-- Indexes (foreign-key lookups, phone_hash, provider_id, purge sweeps)
-- =====================================================================
create index idx_case_versions_case_id       on case_versions (case_id);
create index idx_participants_case_id         on participants (case_id);
create index idx_participants_phone_hash      on participants (phone_hash);
create index idx_consents_participant_id      on consents (participant_id);
create index idx_messages_case_id             on messages (case_id);
create index idx_messages_provider_id         on messages (provider_id);
create index idx_call_sessions_case_id        on call_sessions (case_id);
create index idx_call_sessions_provider_id    on call_sessions (provider_id);
create index idx_transcript_turns_purge_at    on transcript_turns (purge_at);
create index idx_provider_call_tasks_case_id  on provider_call_tasks (case_id);
create index idx_provider_call_tasks_provider on provider_call_tasks (provider_id);
create index idx_quotes_case_id               on quotes (case_id);
create index idx_quotes_provider_id           on quotes (provider_id);
create index idx_quote_line_items_quote_id    on quote_line_items (quote_id);
create index idx_approvals_case_id            on approvals (case_id);
create index idx_events_case_id               on events (case_id);
create index idx_reports_case_id              on reports (case_id);

-- =====================================================================
-- Row Level Security — deny by default on every table (§10 "RLS").
--
-- Edge Functions use the Supabase SERVICE ROLE key, which bypasses RLS.
-- No policy is granted to anon/authenticated (browser) roles, so case data
-- is unreachable from the client. Explicit permissive service_role policies
-- are added below purely for clarity/auditability.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'cases','case_versions','participants','consents','messages',
    'call_sessions','transcript_turns','providers','provider_call_tasks',
    'quotes','quote_line_items','approvals','events','reports'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    -- Explicit full-access policy for the backend service role. (service_role
    -- already bypasses RLS; this documents intent. No anon/authenticated policy
    -- exists, so those roles are denied by default.)
    execute format(
      'create policy %I on %I for all to service_role using (true) with check (true);',
      'service_role_all_' || t, t
    );
  end loop;
end $$;
