// =====================================================================
// Grace web — frontend types, owned here.
//
// These used to be mirrored from the Deno/Supabase Edge Functions' shared
// types. That track is gone (issue #12); the backend is the FastAPI app under
// `app/`, and this file is now the frontend's own contract against it.
//
// Two groups live here, and the split matters:
//
//   1. LIVE — types matching what `app/web_api.py` actually returns today.
//      See the "Backend responses" section at the bottom of this file.
//   2. LEGACY — the domain model below (CaseSpec, QuoteResult, RankedReport,
//      …) came from the Deno spec. No FastAPI route serves these shapes; they
//      are still referenced by Enroll.tsx / CaseDashboard.tsx, which are not
//      wired to a working endpoint. Kept so those screens keep compiling, but
//      do NOT treat them as a description of the live backend.
// =====================================================================

// ---------- LEGACY: Deno-era state machine ----------
// NOT the backend's status vocabulary. `app/` uses: orphan_webhook,
// awaiting_intake, active, intake_extract_failed, intake_done, researching,
// research_failed, calling_for_quotes, quotes_collected, strategy_ready,
// negotiating, done. See BackendCaseStatus below.
export type CaseStatus =
  | "NEW"
  | "CONSENTED"
  | "PREFERENCE_SMS_SENT"
  | "TEXT_INTAKE"
  | "INTAKE_AGENT_ACTIVE"
  | "CASE_DRAFT"
  | "CASE_CONFIRMED"
  | "CALLER_BATCH_QUEUED"
  | "CALLER_AGENT_ACTIVE"
  | "QUOTE_CAPTURED"
  | "CALLBACK"
  | "DECLINED"
  | "UNAVAILABLE"
  | "QUOTES_NORMALIZED_AND_AUDITED"
  | "CLOSER_READY"
  | "CLOSER_NEGOTIATION_ACTIVE"
  | "QUOTE_REVISED"
  | "NEGOTIATION_DECLINED"
  | "REPORT_READY"
  | "CLOSER_CONSUMER_CALL_ACTIVE"
  | "CONSUMER_TEXT_SUMMARY"
  | "CONSUMER_UPDATED"
  | "CLOSED";

export type PreferredChannel = "text" | "voice" | "unknown";
export type ContactStatus = "active" | "revoked";
export type CostPosture =
  | "lowest_comparable_total"
  | "balanced"
  | "prioritize_fit";
export type CaseMode = "at_need" | "pre_need";

// ---------- CaseSpec (§4.4) ----------
export interface CaseSpecPermissions {
  research: boolean;
  call: boolean;
  mention_budget: boolean; // default false; cannot be inferred (INV-04)
  use_verified_quote: boolean;
  negotiate_within_policy: boolean;
  transcribe_if_all_parties_consent: boolean;
}

export interface CaseSpec {
  case_id: string;
  version: number;
  mode: CaseMode;
  jurisdiction: { country: string; state: string };
  location: { pickup_zip: string | null; search_radius_miles: number };
  custody: {
    current_location_type: string | null;
    transfer_deadline_at: string | null;
  };
  authority: { confirmed_for_demo: boolean; role: string | null };
  disposition: string | null;
  must_haves: string[];
  service_preferences: Record<string, unknown>;
  cost_posture: CostPosture;
  budget_user_stated: string | number | null;
  benefits_to_check: string[];
  permissions: CaseSpecPermissions;
  facts_disallowed: string[];
  unknowns: string[];
  confirmed_at: string | null;
}

export type CasePatch = Partial<
  Omit<CaseSpec, "case_id" | "version" | "confirmed_at">
>;

// ---------- ProviderCallTask (§5.2) ----------
export type CallPurpose =
  | "initial_quote"
  | "negotiation"
  | "consumer_explanation";

export interface ProviderCallTask {
  task_id: string;
  case_id: string;
  provider_id: string;
  case_spec_version: number;
  purpose: CallPurpose;
  destination_e164: string;
  facts_allowed: string[];
  questions_required: string[];
  verified_leverage: VerifiedLeverage | null;
  negotiation_policy_id: string;
  transcription_policy: "announce_and_affirmative_consent";
}

// ---------- Quote (§5.5) ----------
export type QuoteOutcome =
  | "itemized_quote"
  | "callback"
  | "declined"
  | "unavailable"
  | "consent_declined";

export type PriceType = "firm" | "estimate" | "range" | "package";
export type AuditStatus = "PENDING" | "PENDING_REVIEW" | "AUDITED";

export interface EvidenceRef {
  conversation_id: string;
  turn_index: number;
  start_seconds: number | null;
  end_seconds: number | null;
}

export interface QuoteLineItem {
  category: string;
  description: string;
  amount: number | null; // null == unknown (INV-08)
  required_for_case: boolean;
  source: EvidenceRef | null;
}

export interface QuoteResult {
  quote_id: string;
  provider_id: string;
  case_spec_version: number;
  outcome: QuoteOutcome;
  price_type: PriceType;
  currency: string;
  line_items: QuoteLineItem[];
  funeral_home_subtotal: number | null;
  cash_advance_total: number | null;
  total: number | null;
  assumptions: string[];
  missing_fields: string[];
  written_confirmation: "requested" | "received" | "none";
  audit_flags: AuditFlag[];
  confidence: number;
}

export interface AuditFlag {
  code: string;
  severity: "info" | "warn" | "error";
  message: string;
  evidence?: EvidenceRef | null;
}

// ---------- Negotiation leverage (§5.7) ----------
export interface VerifiedLeverage {
  quote_id: string;
  provider_id: string;
  supported_amount: number;
  allowed_disclosure_sentence: string;
}

export interface RevisedTerms {
  provider_id: string;
  quote_id: string;
  before_amount: number | null;
  after_amount: number | null;
  changed_category: string | null;
  term_change: string | null;
  evidence: EvidenceRef | null;
}

// ---------- Ranking (§5.8, App B.3) ----------
export interface ScoreBreakdown {
  must_have_fit: number;
  comparable_total: number;
  completeness_certainty: number;
  timing_capacity: number;
  communication_trust: number;
}

export interface ProviderScore {
  provider_id: string;
  quote_id: string | null;
  score: number;
  breakdown: ScoreBreakdown;
  hard_failed: boolean;
  hard_fail_reason: string | null;
  comparable_total: number | null;
  audit_flags: AuditFlag[];
}

export interface RankedReport {
  case_id: string;
  case_spec_version: number;
  scores: ProviderScore[];
  is_tie: boolean;
  tie_reason: string | null;
  recommended_provider_id: string | null;
  runner_up_provider_id: string | null;
  material_tradeoff: string | null;
  next_human_action: string;
  generated_at: string | null;
}

// ---------- Consent / participants (§4.1) ----------
export interface ConsentRecord {
  scope: string;
  phone_hash: string;
  disclosure_version: string;
  sms_opt_in: boolean;
  ai_voice_opt_in: boolean;
  transcription_opt_in: boolean;
  marketing_opt_in: boolean;
  granted_at: string;
  revoked_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

// ---------- SMS intake turn (App A.4) ----------
export interface GraceTextTurnResult {
  reply_sms: string;
  case_patch: CasePatch | null;
  next_state: CaseStatus;
  requires_human_confirmation: boolean;
}

// ---------- Compact contexts (§6.6) ----------
export interface IntakeContext {
  case_id: string;
  purpose: "consumer_intake";
  case_version: number;
  case_spec_draft: CaseSpec;
  unresolved_fields: string[];
}

export interface CallerContext {
  case_id: string;
  purpose: "initial_quote";
  task_id: string;
  provider_id: string;
  compact_task_json: string;
}

export interface EventSummary {
  type: string;
  actor: string;
  timestamp: string;
  summary: string;
}

export interface CloserContext {
  case_id: string;
  purpose: "negotiation" | "consumer_explanation";
  comparison_id: string;
  verified_leverage_id: string | null;
  audited_comparison: ProviderScore[];
  verified_leverage: VerifiedLeverage | null;
  permissions: CaseSpecPermissions;
  last_material_events: EventSummary[];
}

// ---------- LEGACY: case context wrapper ----------
// NOT served by the FastAPI backend. `GET /cases/{id}` returns the raw case
// dump from storage.dump_case (case_id, status, user_info, funeral_homes,
// quotes, negotiations, strategy, transcripts) — a different shape entirely.
export interface CaseContextResponse {
  case_id: string;
  status: CaseStatus;
  masked_phone: string | null;
  case_spec: CaseSpec | null;
  quotes: QuoteResult[];
  comparison: ProviderScore[] | null;
  verified_leverage: VerifiedLeverage | null;
  revised_terms: RevisedTerms[] | null;
  evidence_markdown: string | null;
  context_markdown: string | null;
  case_spec_hash: string | null;
  updated_at: string | null;
}

// ---------- LEGACY: ranked-report wrapper ----------
// NOT served as JSON. `GET /cases/{id}/report` returns text/markdown.
export interface CaseReportResponse {
  case_id: string;
  status: CaseStatus;
  report: RankedReport | null;
  report_markdown: string | null;
}

// ---------- LEGACY: enrollment ----------
// NOT served by the FastAPI backend — it has no enrollment route at all. The
// live demo is voice-first: the family dials in and the webhook creates the
// case. Enroll.tsx still posts this and will fail against `app/`.
export interface EnrollRequest {
  phone_e164: string;
  scope: string;
  disclosure_version: string;
  sms_opt_in: boolean;
  ai_voice_opt_in: boolean;
  transcription_opt_in: boolean;
  marketing_opt_in: boolean;
}

export interface EnrollResponse {
  case_id: string;
  masked_phone: string;
  status: CaseStatus;
  preferred_channel: PreferredChannel;
  first_sms_preview?: string;
}

// =====================================================================
// LIVE — backend responses, reconciled against app/web_api.py.
// These describe what the FastAPI backend actually returns today. AgentLoop
// currently declares equivalents inline; folding it onto these is follow-up
// (that file is being restructured in parallel).
// =====================================================================

/** Case statuses the backend actually writes (app/web_api.py `_PROGRESS`). */
export type BackendCaseStatus =
  | "orphan_webhook"
  | "awaiting_intake"
  | "active"
  | "intake_extract_failed"
  | "intake_done"
  | "researching"
  | "research_failed"
  | "calling_for_quotes"
  | "quotes_collected"
  | "strategy_ready"
  | "negotiating"
  | "done";

export type ActivityNodeState = "idle" | "active" | "done";

/** One of the eight pipeline nodes from `_build_nodes`. */
export interface ActivityNode {
  id: string;
  label: string;
  kind: "voice" | "tool";
  state: ActivityNodeState;
  activity: string;
  output: string;
}

/** An entry of `_calls`. `conversation_id` is null for a home never dialed. */
export interface ActivityCall {
  purpose: "intake" | "initial_quote" | "negotiation";
  provider_id: string | null;
  status: string;
  conversation_id: string | null;
}

/** An entry of `_events`. Note: no `summary` field — unlike EventSummary. */
export interface ActivityEvent {
  type: string;
  actor: string;
  timestamp: string;
}

export interface ActivitySummary {
  quotes: number;
  audited: number;
  audit_flags: number;
  /** Always null today: the backend has no tie detection. */
  is_tie: boolean | null;
  recommended: string | null;
  providers: number;
}

/** GET /agent-activity?case_id= */
export interface AgentActivityResponse {
  case: {
    case_id: string;
    status: BackendCaseStatus | "unknown";
    /** 0..16 ordinal inherited from the Deno state machine (issue #16). */
    progress: number;
    preferred_channel: "voice";
    current_version: number;
    aborted: boolean;
  };
  active_node: string | null;
  nodes: ActivityNode[];
  calls: ActivityCall[];
  events: ActivityEvent[];
  summary: ActivitySummary;
}

/** GET /agent-activity (no case_id) — the case picker. */
export interface AgentActivityCaseListResponse {
  cases: {
    case_id: string;
    status: BackendCaseStatus | "unknown";
    current_version: number;
    created_at: string;
  }[];
}

/** GET /call-transcript?conversation_id= */
export interface CallTranscriptResponse {
  /** ElevenLabs status, or "pending" before the conversation is queryable. */
  status: string;
  transcript: {
    role: "caller" | "grace";
    message: string;
    secs: number | null;
  }[];
  duration_secs: number | null;
}

/** POST /demo-call */
export interface DemoCallRequest {
  kind: "intake" | "caller" | "closer";
  to: string;
  case_id?: string | null;
  provider_id?: string | null;
}

export interface DemoCallResponse {
  case_id: string;
  conversation_id: string;
  call_sid: string | null;
}
