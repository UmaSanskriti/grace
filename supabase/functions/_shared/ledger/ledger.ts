// =====================================================================
// Grace — Markdown evidence ledger generator (spec §6.5)
// PURE string generation. NO database access; the DB is canonical and
// callers pass in a fully-hydrated LedgerInput. This module regenerates
// the latest projection (evidence.md) and a compact context (context.md).
//
// Invariants enforced here:
//   INV-07  transcript turns are rendered ONLY when transcription consent
//           is true for that interaction.
//   §6.7    all transcript / free text is sanitized against HTML/Markdown
//           injection before rendering.
//   §6.6    context.md stays under 4000 characters.
// =====================================================================

import type {
  CaseSpec,
  CaseStatus,
  PreferredChannel,
  QuoteResult,
  RankedReport,
} from "../types.ts";

// ---------- Input contract (self-contained; designed from types.ts) ----------

/** Compact authorization summary for the ledger header. */
export interface LedgerConsentSummary {
  /** Combined SMS + AI-call opt-in (disclosure consent granted). */
  sms_ai_opt_in: boolean;
  /** permissions.call — provider calls allowed. */
  provider_call: boolean;
  /** permissions.negotiate_within_policy — verified-quote negotiation allowed. */
  negotiation: boolean;
  /** permissions.transcribe_if_all_parties_consent — transcription allowed. */
  transcription: boolean;
}

/** One timestamped conversational turn (voice or SMS). */
export interface TranscriptTurn {
  turn_index: number;
  speaker: string;
  /** Seconds into the call, when known (voice only). */
  start_seconds?: number | null;
  text: string;
}

/** A single interaction (SMS thread turn or voice call) attached to the case. */
export interface LedgerInteraction {
  interaction_id: string;
  timestamp: string;
  channel: "sms" | "voice";
  direction: "inbound" | "outbound";
  purpose: "consumer_intake" | "provider_quote" | "negotiation" | "report" | string;
  /** "consumer" or a provider_id. */
  participant: string;
  twilio_sid?: string | null;
  elevenlabs_conversation_id?: string | null;
  ai_disclosed: boolean;
  /** true = consent granted; false = declined; "not_applicable" = e.g. SMS. */
  transcription_consent: boolean | "not_applicable";
  /** Structured outcome label (e.g. "itemized_quote", "YES"). */
  outcome?: string | null;
  /** One-line human summary. */
  summary?: string | null;
  /** Turns are rendered ONLY when transcription_consent === true (INV-07). */
  transcript?: TranscriptTurn[];
  /** Validated structured event payload for this interaction. */
  structured_payload?: unknown;
}

/** Minimal case-row projection needed for the ledger header. */
export interface LedgerCaseRow {
  case_id: string;
  preferred_channel?: PreferredChannel | string | null;
  purge_at?: string | null;
}

export interface LedgerInput {
  case: LedgerCaseRow;
  status: CaseStatus;
  caseSpec: CaseSpec | null;
  consents: LedgerConsentSummary;
  interactions: LedgerInteraction[];
  quotes: QuoteResult[];
  report?: RankedReport | null;
}

// ---------- §6.7 sanitization ----------

/**
 * Neutralize HTML / Markdown injection in untrusted transcript text.
 * Strips control characters and escapes <, >, &, backticks, [], (), and pipe
 * so provider/consumer speech can never inject markup or break table cells.
 */
export function sanitizeTranscript(text: string): string {
  if (!text) return "";
  return text
    // Strip control chars (U+0000..U+001F except \t/\n, and U+007F).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\|/g, "\\|");
}

/** Sanitize and flatten to a single line for Markdown table cells. */
function cell(text: string | null | undefined): string {
  if (text === null || text === undefined || text === "") return "—";
  return sanitizeTranscript(String(text)).replace(/[\r\n]+/g, " ").trim() || "—";
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

function orNull(v: unknown): string {
  return v === null || v === undefined || v === "" ? "null" : String(v);
}

function money(v: number | null | undefined, currency = "USD"): string {
  if (v === null || v === undefined) return "unknown";
  return `${currency} ${v.toLocaleString("en-US")}`;
}

// ---------- Provider comparison table ----------

function buildComparisonTable(quotes: QuoteResult[], report?: RankedReport | null): string {
  if (!quotes || quotes.length === 0) {
    return "_No provider quotes captured yet._";
  }

  const scoreById = new Map<string, number>();
  const recommended = report?.recommended_provider_id ?? null;
  if (report) {
    for (const s of report.scores) scoreById.set(s.provider_id, s.score);
  }

  const header =
    "| Provider | Outcome | Price type | Comparable total | Written | Score | Audit flags |";
  const divider = "|---|---|---|---|---|---|---|";
  const rows = quotes.map((q) => {
    const flags = q.audit_flags && q.audit_flags.length > 0
      ? q.audit_flags.map((f) => `${f.severity}:${f.code}`).join("; ")
      : "none";
    const score = scoreById.has(q.provider_id) ? String(scoreById.get(q.provider_id)) : "—";
    const marker = recommended && q.provider_id === recommended ? " ⭐" : "";
    return `| ${cell(q.provider_id)}${marker} | ${cell(q.outcome)} | ${cell(q.price_type)} | ${
      money(q.total, q.currency)
    } | ${cell(q.written_confirmation)} | ${score} | ${cell(flags)} |`;
  });

  return [header, divider, ...rows].join("\n");
}

// ---------- Recommendation block ----------

function buildRecommendation(report?: RankedReport | null): string {
  if (!report) return "Pending — quotes not yet ranked.";

  const lines: string[] = [];
  if (report.is_tie) {
    lines.push("**Result: tie — two options presented, no choice made for the family.**");
    if (report.tie_reason) lines.push(`- Tie reason: ${sanitizeTranscript(report.tie_reason)}`);
    if (report.recommended_provider_id) {
      lines.push(`- Option A: ${cell(report.recommended_provider_id)}`);
    }
    if (report.runner_up_provider_id) {
      lines.push(`- Option B: ${cell(report.runner_up_provider_id)}`);
    }
    if (report.material_tradeoff) {
      lines.push(`- Material trade-off: ${sanitizeTranscript(report.material_tradeoff)}`);
    }
  } else if (report.recommended_provider_id) {
    lines.push(`**Recommended: ${cell(report.recommended_provider_id)}**`);
    if (report.runner_up_provider_id) {
      lines.push(`- Runner-up: ${cell(report.runner_up_provider_id)}`);
    }
    if (report.material_tradeoff) {
      lines.push(`- Trade-off: ${sanitizeTranscript(report.material_tradeoff)}`);
    }
  } else {
    lines.push("No recommendation — insufficient comparable data.");
  }

  lines.push(`- Next human action: ${sanitizeTranscript(report.next_human_action)}`);
  return lines.join("\n");
}

// ---------- Interaction block ----------

function buildInteractionBlock(it: LedgerInteraction): string {
  const parts: string[] = [];
  parts.push(`## Interaction ${cell(it.timestamp)} — ${cell(it.interaction_id)}`);
  parts.push(`- Channel: ${it.channel}`);
  parts.push(`- Direction: ${it.direction}`);
  parts.push(`- Purpose: ${cell(it.purpose)}`);
  parts.push(`- Participant: ${cell(it.participant)}`);
  parts.push(`- Twilio SID: ${orNull(it.twilio_sid)}`);
  parts.push(`- ElevenLabs conversation: ${orNull(it.elevenlabs_conversation_id)}`);
  parts.push(`- AI disclosed: ${yesNo(it.ai_disclosed)}`);
  parts.push(
    `- Transcription consent: ${
      it.transcription_consent === "not_applicable"
        ? "not_applicable"
        : yesNo(it.transcription_consent)
    }`,
  );
  parts.push(`- Outcome: ${cell(it.outcome)}`);
  parts.push(`- Summary: ${cell(it.summary)}`);

  // ### Transcript evidence (consented only) — INV-07
  parts.push("");
  parts.push("### Transcript evidence (consented only)");
  if (it.transcription_consent === true && it.transcript && it.transcript.length > 0) {
    for (const turn of it.transcript) {
      const ts = turn.start_seconds !== null && turn.start_seconds !== undefined
        ? ` @${turn.start_seconds}s`
        : "";
      parts.push(
        `- [${turn.turn_index}${ts}] **${cell(turn.speaker)}:** ${sanitizeTranscript(turn.text)}`,
      );
    }
  } else {
    parts.push("_Omitted — no transcription consent for this interaction (INV-07)._");
  }

  // ### Structured payload
  parts.push("");
  parts.push("### Structured payload");
  parts.push("```json");
  parts.push(safeJson(it.structured_payload));
  parts.push("```");

  return parts.join("\n");
}

function safeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch (_e) {
    return "null";
  }
}

// ---------- renderEvidenceMarkdown (full ledger, §6.5) ----------

export function renderEvidenceMarkdown(input: LedgerInput): string {
  const { case: row, status, caseSpec, consents, interactions, quotes, report } = input;
  const version = caseSpec?.version ?? "—";

  const out: string[] = [];
  out.push(`# Grace Case ${cell(row.case_id)}`);
  out.push("");

  // Status
  out.push("## Status");
  out.push(`- State: ${status}`);
  out.push(`- CaseSpec version: ${version}`);
  out.push(`- Preferred channel: ${orNull(row.preferred_channel)}`);
  out.push(`- Data purge at: ${orNull(row.purge_at)}`);
  out.push("");

  // Authorizations
  out.push("## Authorizations");
  out.push(`- SMS / AI call opt-in: ${yesNo(consents.sms_ai_opt_in)}`);
  out.push(`- Provider calls: ${yesNo(consents.provider_call)}`);
  out.push(`- Verified-quote negotiation: ${yesNo(consents.negotiation)}`);
  out.push(`- Transcription: ${yesNo(consents.transcription)}`);
  out.push("");

  // Confirmed CaseSpec
  out.push("## Confirmed CaseSpec");
  out.push("```json");
  out.push(safeJson(caseSpec));
  out.push("```");
  out.push("");

  // Interactions
  for (const it of interactions) {
    out.push(buildInteractionBlock(it));
    out.push("");
  }

  // Current provider comparison
  out.push("## Current provider comparison");
  out.push(buildComparisonTable(quotes, report));
  out.push("");

  // Recommendation
  out.push("## Recommendation");
  out.push(buildRecommendation(report));
  out.push("");

  return out.join("\n");
}

// ---------- renderContextMarkdown (compact, §6.6, < 4000 chars) ----------

const CONTEXT_CHAR_LIMIT = 4000;

export function renderContextMarkdown(input: LedgerInput): string {
  const { case: row, status, caseSpec, consents, quotes, report } = input;

  const out: string[] = [];
  out.push(`# Grace Case ${cell(row.case_id)} — context`);
  out.push(`- State: ${status}`);
  out.push(`- CaseSpec version: ${caseSpec?.version ?? "—"}`);
  out.push(
    `- Authorizations: call=${yesNo(consents.provider_call)}, negotiate=${
      yesNo(consents.negotiation)
    }, transcribe=${yesNo(consents.transcription)}`,
  );

  if (caseSpec) {
    out.push("");
    out.push("## Spec essentials");
    out.push(`- Mode: ${caseSpec.mode}`);
    out.push(
      `- Jurisdiction: ${caseSpec.jurisdiction.country}/${caseSpec.jurisdiction.state}`,
    );
    out.push(`- Disposition: ${orNull(caseSpec.disposition)}`);
    out.push(
      `- Must-haves: ${
        caseSpec.must_haves.length ? cell(caseSpec.must_haves.join("; ")) : "—"
      }`,
    );
    out.push(`- Cost posture: ${caseSpec.cost_posture}`);
    // INV-04: never surface a budget unless explicitly authorized.
    out.push(
      `- Budget mention: ${
        caseSpec.permissions.mention_budget ? "authorized" : "withheld"
      }`,
    );
    if (caseSpec.unknowns.length) {
      out.push(`- Unknowns: ${cell(caseSpec.unknowns.join("; "))}`);
    }
  }

  // Compact comparison
  out.push("");
  out.push("## Provider comparison");
  out.push(buildComparisonTable(quotes, report));

  // Recommendation
  out.push("");
  out.push("## Recommendation");
  out.push(buildRecommendation(report));

  let text = out.join("\n");
  if (text.length > CONTEXT_CHAR_LIMIT) {
    const marker = "\n\n…_truncated to keep context < 4000 chars (§6.6)_";
    text = text.slice(0, CONTEXT_CHAR_LIMIT - marker.length) + marker;
  }
  return text;
}
