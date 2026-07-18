// =====================================================================
// Grace web — types MIRRORED from supabase/functions/_shared/types.ts
// (§ CONTRACTS.md) Runtimes are kept separate: we do NOT import across the
// Deno / Node boundary. Keep this in sync with the canonical contract file.
// =====================================================================

// ---------- State machine (§3.3) ----------
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

// ---------- Case context wrapper returned by GET /cases/{id}/context ----------
// The spec keeps the exact shape agent-specific; the dashboard reads a
// superset that includes the confirmed CaseSpec, quotes, comparison and the
// rendered Markdown ledger for display.
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

// ---------- GET /cases/{id}/report ----------
export interface CaseReportResponse {
  case_id: string;
  status: CaseStatus;
  report: RankedReport | null;
  report_markdown: string | null;
}

// ---------- POST /demo/enroll ----------
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
