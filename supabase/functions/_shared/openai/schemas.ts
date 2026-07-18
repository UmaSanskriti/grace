// =====================================================================
// Grace — OpenAI Responses API JSON Schemas (§6.4)
// Every schema is `strict: true` with `additionalProperties: false` and
// lists all properties in `required`. Optional / partial fields are made
// nullable (type arrays or anyOf-with-null) so the model can omit them
// while still satisfying strict-mode structural requirements.
// These schemas mirror the canonical contracts in ../types.ts.
// =====================================================================

export type JSONSchema = Record<string, unknown>;

/** A JSON-schema value that is either the referenced def or null. */
function nullableRef(ref: string): JSONSchema {
  return { anyOf: [{ $ref: ref }, { type: "null" }] };
}

// ---------- Shared sub-schemas ----------

const evidenceRefSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    conversation_id: { type: "string" },
    turn_index: { type: "integer" },
    start_seconds: { type: ["number", "null"] },
    end_seconds: { type: ["number", "null"] },
  },
  required: ["conversation_id", "turn_index", "start_seconds", "end_seconds"],
};

const auditFlagSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    severity: { type: "string", enum: ["info", "warn", "error"] },
    message: { type: "string" },
    evidence: nullableRef("#/$defs/evidence_ref"),
  },
  required: ["code", "severity", "message", "evidence"],
};

const quoteLineItemSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string" },
    description: { type: "string" },
    // null == unknown (INV-08); every amount still carries a source or null.
    amount: { type: ["number", "null"] },
    required_for_case: { type: "boolean" },
    source: nullableRef("#/$defs/evidence_ref"),
  },
  required: ["category", "description", "amount", "required_for_case", "source"],
};

// ---------- CasePatch (used by grace_text_turn) ----------
// CasePatch = Partial<Omit<CaseSpec, "case_id" | "version" | "confirmed_at">>.
// Under strict mode all keys are required, so every field is nullable and a
// null value means "no change to this field" for the orchestrator to apply.

const permissionsSchema: JSONSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    research: { type: "boolean" },
    call: { type: "boolean" },
    // INV-04: mention_budget defaults false and is never inferred.
    mention_budget: { type: "boolean" },
    use_verified_quote: { type: "boolean" },
    negotiate_within_policy: { type: "boolean" },
    transcribe_if_all_parties_consent: { type: "boolean" },
  },
  required: [
    "research",
    "call",
    "mention_budget",
    "use_verified_quote",
    "negotiate_within_policy",
    "transcribe_if_all_parties_consent",
  ],
};

const servicePreferencesSchema: JSONSchema = {
  // Record<string, unknown> is not expressible under strict mode; we pin the
  // known demo preference keys and make each nullable.
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    viewing: { type: ["string", "null"] },
    ceremony: { type: ["string", "null"] },
    return_of_ashes: { type: ["boolean", "null"] },
    livestream: { type: ["boolean", "null"] },
    graveside: { type: ["boolean", "null"] },
  },
  required: ["viewing", "ceremony", "return_of_ashes", "livestream", "graveside"],
};

const casePatchSchema: JSONSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    mode: { type: ["string", "null"], enum: ["at_need", "pre_need", null] },
    jurisdiction: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        country: { type: "string" },
        state: { type: "string" },
      },
      required: ["country", "state"],
    },
    location: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        pickup_zip: { type: ["string", "null"] },
        search_radius_miles: { type: "number" },
      },
      required: ["pickup_zip", "search_radius_miles"],
    },
    custody: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        current_location_type: { type: ["string", "null"] },
        transfer_deadline_at: { type: ["string", "null"] },
      },
      required: ["current_location_type", "transfer_deadline_at"],
    },
    authority: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        confirmed_for_demo: { type: "boolean" },
        role: { type: ["string", "null"] },
      },
      required: ["confirmed_for_demo", "role"],
    },
    disposition: { type: ["string", "null"] },
    must_haves: { type: ["array", "null"], items: { type: "string" } },
    service_preferences: servicePreferencesSchema,
    cost_posture: {
      type: ["string", "null"],
      enum: ["lowest_comparable_total", "balanced", "prioritize_fit", null],
    },
    budget_user_stated: { type: ["string", "number", "null"] },
    benefits_to_check: { type: ["array", "null"], items: { type: "string" } },
    permissions: permissionsSchema,
    facts_disallowed: { type: ["array", "null"], items: { type: "string" } },
    unknowns: { type: ["array", "null"], items: { type: "string" } },
  },
  required: [
    "mode",
    "jurisdiction",
    "location",
    "custody",
    "authority",
    "disposition",
    "must_haves",
    "service_preferences",
    "cost_posture",
    "budget_user_stated",
    "benefits_to_check",
    "permissions",
    "facts_disallowed",
    "unknowns",
  ],
};

// All CaseStatus values (must stay in sync with ../types.ts CaseStatus).
const CASE_STATUS_ENUM = [
  "NEW",
  "CONSENTED",
  "PREFERENCE_SMS_SENT",
  "TEXT_INTAKE",
  "INTAKE_AGENT_ACTIVE",
  "CASE_DRAFT",
  "CASE_CONFIRMED",
  "CALLER_BATCH_QUEUED",
  "CALLER_AGENT_ACTIVE",
  "QUOTE_CAPTURED",
  "CALLBACK",
  "DECLINED",
  "UNAVAILABLE",
  "QUOTES_NORMALIZED_AND_AUDITED",
  "CLOSER_READY",
  "CLOSER_NEGOTIATION_ACTIVE",
  "QUOTE_REVISED",
  "NEGOTIATION_DECLINED",
  "REPORT_READY",
  "CLOSER_CONSUMER_CALL_ACTIVE",
  "CONSUMER_TEXT_SUMMARY",
  "CONSUMER_UPDATED",
  "CLOSED",
];

// ---------- 1. grace_text_turn (App A.4) ----------
export const graceTextTurnSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply_sms: { type: "string", maxLength: 320 },
    case_patch: casePatchSchema,
    next_state: { type: "string", enum: CASE_STATUS_ENUM },
    requires_human_confirmation: { type: "boolean" },
  },
  required: ["reply_sms", "case_patch", "next_state", "requires_human_confirmation"],
};

// ---------- 2. normalize_quote (strict QuoteResult) ----------
export const quoteResultSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  $defs: {
    evidence_ref: evidenceRefSchema,
    audit_flag: auditFlagSchema,
    line_item: quoteLineItemSchema,
  },
  properties: {
    quote_id: { type: "string" },
    provider_id: { type: "string" },
    case_spec_version: { type: "integer" },
    outcome: {
      type: "string",
      enum: ["itemized_quote", "callback", "declined", "unavailable", "consent_declined"],
    },
    price_type: { type: "string", enum: ["firm", "estimate", "range", "package"] },
    currency: { type: "string" },
    line_items: { type: "array", items: { $ref: "#/$defs/line_item" } },
    funeral_home_subtotal: { type: ["number", "null"] },
    cash_advance_total: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    assumptions: { type: "array", items: { type: "string" } },
    missing_fields: { type: "array", items: { type: "string" } },
    written_confirmation: { type: "string", enum: ["requested", "received", "none"] },
    audit_flags: { type: "array", items: { $ref: "#/$defs/audit_flag" } },
    confidence: { type: "number" },
  },
  required: [
    "quote_id",
    "provider_id",
    "case_spec_version",
    "outcome",
    "price_type",
    "currency",
    "line_items",
    "funeral_home_subtotal",
    "cash_advance_total",
    "total",
    "assumptions",
    "missing_fields",
    "written_confirmation",
    "audit_flags",
    "confidence",
  ],
};

// ---------- 3. audit_quote ----------
export const auditResultSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  $defs: {
    evidence_ref: evidenceRefSchema,
    audit_flag: auditFlagSchema,
  },
  properties: {
    flags: { type: "array", items: { $ref: "#/$defs/audit_flag" } },
    corrected_total: { type: ["number", "null"] },
  },
  required: ["flags", "corrected_total"],
};

// ---------- 4. word_negotiation (§5.7) ----------
export const negotiationSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ask: { type: "string" },
    fallback: { type: "string" },
  },
  required: ["ask", "fallback"],
};

// ---------- 5. explain_report ----------
export const explainReportSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};
