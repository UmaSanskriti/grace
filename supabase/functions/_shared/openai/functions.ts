// =====================================================================
// Grace — bounded structured OpenAI functions (spec §6.4)
// Five pure functions built on the OpenAI **Responses API** with
// json_schema strict mode. NO database access; callers pass in every
// input and persist every output themselves.
//
// Model names live in environment variables. We default to the fastest
// sponsor-enabled model that supports structured outputs; the exact
// snapshots are pinned via env (OPENAI_MODEL_FAST / OPENAI_MODEL_AUDIT)
// AFTER the golden-call tests, per §6.4 [R12].
// =====================================================================

import type {
  AuditFlag,
  CasePatch,
  CaseSpec,
  CaseStatus,
  GraceTextTurnResult,
  ProviderCallTask,
  QuoteResult,
  RankedReport,
  VerifiedLeverage,
} from "../types.ts";
import {
  type JSONSchema,
  auditResultSchema,
  explainReportSchema,
  graceTextTurnSchema,
  negotiationSchema,
  quoteResultSchema,
} from "./schemas.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

// ---------- Environment ----------
// Read via ../env.ts if it ever exists; today it does not, so we read
// Deno.env directly. Kept in one place so the golden-call pinning stays local.
function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function apiKey(): string {
  return env("OPENAI_API_KEY");
}

/** Fast model for interactive SMS turns. Pinned via env after golden-call tests. */
function fastModel(): string {
  return env("OPENAI_MODEL_FAST");
}

/** Higher-reasoning model for quote normalization/audit and reporting. */
function auditModel(): string {
  return env("OPENAI_MODEL_AUDIT");
}

// ---------- Responses API plumbing ----------

interface Message {
  role: "system" | "user";
  content: string;
}

/**
 * Call the Responses API with a strict json_schema and return the parsed
 * object. Throws on non-OK HTTP responses and on model refusals.
 */
async function callStructured<T>(
  model: string,
  schemaName: string,
  schema: JSONSchema,
  messages: Message[],
): Promise<T> {
  const body = {
    model,
    input: messages,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };

  const resp = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "<no body>");
    throw new Error(
      `OpenAI Responses API error ${resp.status} ${resp.statusText} for ${schemaName}: ${detail}`,
    );
  }

  const data = await resp.json();
  const text = extractOutputText(data);
  if (text === null) {
    throw new Error(`OpenAI response for ${schemaName} contained no output text`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (_e) {
    throw new Error(`OpenAI response for ${schemaName} was not valid JSON: ${text}`);
  }
}

/**
 * Extract the assistant's structured text from a Responses API payload.
 * Prefers the convenience `output_text` field, then walks the `output`
 * array for the first message's `output_text` part. Throws if the model
 * refused.
 */
function extractOutputText(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.output_text === "string" && obj.output_text.length > 0) {
    return obj.output_text;
  }

  const output = obj.output;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p.type === "refusal" && typeof p.refusal === "string") {
        throw new Error(`OpenAI model refused: ${p.refusal}`);
      }
      if (p.type === "output_text" && typeof p.text === "string") {
        return p.text;
      }
    }
  }
  return null;
}

// ---------- System prompts (derived from Appendix A) ----------

/** grace_text_turn — derived from App A.1 + A.4. */
export const GRACE_TEXT_TURN_SYSTEM = `You are Grace, a calm AI logistics advocate for a synthetic U.S. funeral-arrangements demo, operating over SMS. You are not a funeral director, lawyer, therapist, clergy member, or decision-maker.

STYLE: Plain language. Ask exactly ONE question per message. No platitudes; never claim to feel grief. Use the family's chosen words. Offer skip, pause, and "why are you asking?" when natural. Keep reply_sms at most 320 characters.

GOAL: Build or update the confirmed CaseSpec with the minimum facts needed to compare providers. Emit a case_patch containing ONLY newly confirmed facts; set fields you are not changing to null. Never invent facts. Never infer culture or religion — ask.

BUDGET (INV-04): Never require a dollar budget and never ask "how much are you willing to spend?". Ask whether the family wants the lowest comparable total, a balance of price and fit, or fit first. If a budget is volunteered, keep permissions.mention_budget=false unless the family explicitly authorizes sharing it.

PRESERVE: Never overwrite a previously confirmed CaseSpec field or permission with a guess; carry confirmed values forward untouched (return null for them in the patch).

BOUNDARIES: Never request SSN, government ID, payment data, cause of death, medical history, or full death-certificate details. Never book, pay, authorize disposition, or transfer remains. TEXT/CALL/STOP/HELP keywords are handled before you. Do not launch calls yourself.

CONFIRMATION: When the minimum spec is ready, set requires_human_confirmation=true and put a concise YES/EDIT summary in reply_sms. next_state must be one of the allowed CaseStatus values reflecting where the case now stands.`;

/** normalize_quote — derived from App A.2 + §5.5. */
export const NORMALIZE_QUOTE_SYSTEM = `You convert a Grace Caller Agent provider-call transcript into a strict itemized QuoteResult. In demo mode the case and provider are synthetic.

TRUTH: Use ONLY what the provider actually stated in the transcript plus the ProviderCallTask context. Never invent prices, fees, legal rules, or commitments.

EVIDENCE (INV-08): Every line-item amount MUST carry a source EvidenceRef (conversation_id + turn_index, with start/end seconds when known) pointing to where the provider stated it, OR the amount must be null (unknown). Never attach evidence to a number the provider did not say.

ITEMIZATION: Map each stated charge to a quote category. Mark required_for_case using the task's required questions and family must-haves. Record unresolved required categories in missing_fields and stated caveats in assumptions. Set price_type (firm/estimate/range/package). Set written_confirmation to requested/received/none based on the transcript. Compute funeral_home_subtotal, cash_advance_total, and total only from evidenced line items; use null when they cannot be derived. Do not add audit_flags here (leave the array empty); auditing is a separate step. confidence is 0..1.`;

/** audit_quote — derived from §5.9 + config red flags. */
export const AUDIT_QUOTE_SYSTEM = `You are the Grace quote auditor. Given a normalized QuoteResult and its transcript evidence, detect problems and recalculate the total. Values are synthetic.

DETECT (emit an AuditFlag per issue, with evidence when available):
- missing_after_hours_fee / missing_transfer_fee: a required fee category is absent though the case implies it.
- package_only_pricing: only a bundled package price is given with no itemization.
- inconsistent_totals / line_items_do_not_sum_to_total: the stated total does not equal the sum of line items (+ cash advances).
- unverified_law_claim: the provider asserts a legal requirement without a verifiable basis. Do NOT accuse of a violation; mark the quote incomplete and advise verification.

Severity: info/warn/error. Do not apply the Funeral Rule to cemeteries or third-party sellers without checking coverage.

CORRECTED TOTAL: Recalculate the total strictly from evidenced line items and cash advances. Return corrected_total as that number, or null if it cannot be computed from the evidence. Never invent missing amounts.`;

/** word_negotiation — derived from App A.3 + §5.7 + config negotiation_policy. */
export const WORD_NEGOTIATION_SYSTEM = `You are the Grace Closer Agent preparing ONE honest price ask and ONE non-price fallback for a provider negotiation. Values are synthetic.

INPUT: verified_leverage (an audited comparable quote's supported_amount and its allowed_disclosure_sentence) and the negotiation policy.

ASK (one only): Use ONLY the verified_leverage. State the verified comparable total honestly and ask the provider to match or approach it, or to waive a specific fee (after-hours, mileage, container, admin) without raising the price. Use the allowed_disclosure_sentence; never invent a competitor, a bid, or a budget.

FALLBACK (one only, non-price): Ask for a non-price improvement — include certificates, language support, or transport miles; hold the price for a stated period; or improve the pickup window.

NEVER: invent a competitor or quote, claim the family cannot afford it, use guilt/threats/pressure, misstate legal requirements, or promise selection, payment, or commitment. Return exactly one ask and one fallback.`;

/** explain_report — derived from App A.3 consumer mode + §5.9. */
export const EXPLAIN_REPORT_SYSTEM = `You are the Grace Closer Agent explaining a deterministic ranked report to the family in plain language. Values are synthetic.

Summarize, in plain language: the recommendation (if any) with its one-sentence reason, comparable totals with price type and assumptions, must-have coverage (met/not met/unknown), key audit flags (missing fees, package-only pricing, inconsistent totals, unverified law claims), any negotiation delta, and the next human action.

TIES: When the report is a tie, present BOTH options and the material trade-off. NEVER choose for the family. Do not add facts beyond the report. Do not use platitudes or claim to feel grief. End by noting the next human action (review the written statement and contact the provider directly).`;

// ---------- Public function inputs ----------

/** Input for {@link graceTextTurn} (App A.4: compact CaseSpec + latest SMS). */
export interface GraceTextTurnInput {
  /**
   * The confirmed or draft CaseSpec to preserve and extend. Null on the very
   * first text turn, before any spec exists — treated as start-of-intake.
   */
  case_spec: CaseSpec | null;
  /** The latest inbound SMS from the family (already keyword-filtered). */
  latest_sms: string;
  /** Fields still unresolved in intake, to steer the next question. */
  unresolved_fields?: string[];
}

/** Minimal negotiation policy shape (config/vertical.json .negotiation_policy). */
export interface NegotiationPolicy {
  policy_id: string;
  max_rounds: number;
  max_price_asks_per_provider: number;
  max_nonprice_fallbacks_per_provider: number;
  allowed: string[];
  not_allowed: string[];
}

// ---------- 1. grace_text_turn (App A.4) — OPENAI_MODEL_FAST ----------
export async function graceTextTurn(
  input: GraceTextTurnInput,
): Promise<GraceTextTurnResult> {
  const userContent = [
    "COMPACT CASESPEC (preserve confirmed fields and permissions):",
    input.case_spec ? JSON.stringify(input.case_spec) : "(no CaseSpec yet — this is the start of intake)",
    input.unresolved_fields && input.unresolved_fields.length > 0
      ? `\nUNRESOLVED INTAKE FIELDS: ${input.unresolved_fields.join(", ")}`
      : "",
    "\nLATEST SMS FROM FAMILY:",
    input.latest_sms,
  ].join("\n");

  const result = await callStructured<GraceTextTurnResult>(
    fastModel(),
    "grace_text_turn",
    graceTextTurnSchema,
    [
      { role: "system", content: GRACE_TEXT_TURN_SYSTEM },
      { role: "user", content: userContent },
    ],
  );

  // Defensive: strip a fully-null patch down to null so callers apply nothing.
  if (result.case_patch && isEmptyPatch(result.case_patch)) {
    result.case_patch = null;
  }
  return result;
}

function isEmptyPatch(patch: CasePatch): boolean {
  return Object.values(patch).every((v) => v === null || v === undefined);
}

// ---------- 2. normalize_quote (strict QuoteResult) — OPENAI_MODEL_AUDIT ----------
export async function normalizeQuote(
  task: ProviderCallTask,
  transcript: string,
): Promise<QuoteResult> {
  const userContent = [
    "PROVIDER CALL TASK:",
    JSON.stringify(task),
    "\nCALL TRANSCRIPT (source of all evidence):",
    transcript,
  ].join("\n");

  return await callStructured<QuoteResult>(
    auditModel(),
    "normalize_quote",
    quoteResultSchema,
    [
      { role: "system", content: NORMALIZE_QUOTE_SYSTEM },
      { role: "user", content: userContent },
    ],
  );
}

// ---------- 3. audit_quote — OPENAI_MODEL_AUDIT ----------
export async function auditQuote(
  quote: QuoteResult,
  transcript: string,
): Promise<{ flags: AuditFlag[]; corrected_total: number | null }> {
  const userContent = [
    "NORMALIZED QUOTE:",
    JSON.stringify(quote),
    "\nTRANSCRIPT EVIDENCE:",
    transcript,
  ].join("\n");

  return await callStructured<{ flags: AuditFlag[]; corrected_total: number | null }>(
    auditModel(),
    "audit_quote",
    auditResultSchema,
    [
      { role: "system", content: AUDIT_QUOTE_SYSTEM },
      { role: "user", content: userContent },
    ],
  );
}

// ---------- 4. word_negotiation (§5.7) — OPENAI_MODEL_AUDIT ----------
export async function wordNegotiation(
  leverage: VerifiedLeverage,
  policy: NegotiationPolicy,
): Promise<{ ask: string; fallback: string }> {
  const userContent = [
    "VERIFIED LEVERAGE (the only competitive fact you may use):",
    JSON.stringify(leverage),
    "\nNEGOTIATION POLICY:",
    JSON.stringify(policy),
  ].join("\n");

  return await callStructured<{ ask: string; fallback: string }>(
    auditModel(),
    "word_negotiation",
    negotiationSchema,
    [
      { role: "system", content: WORD_NEGOTIATION_SYSTEM },
      { role: "user", content: userContent },
    ],
  );
}

// ---------- 5. explain_report — OPENAI_MODEL_AUDIT ----------
export async function explainReport(report: RankedReport): Promise<string> {
  const userContent = [
    "DETERMINISTIC RANKED REPORT:",
    JSON.stringify(report),
  ].join("\n");

  const result = await callStructured<{ summary: string }>(
    auditModel(),
    "explain_report",
    explainReportSchema,
    [
      { role: "system", content: EXPLAIN_REPORT_SYSTEM },
      { role: "user", content: userContent },
    ],
  );
  return result.summary;
}
