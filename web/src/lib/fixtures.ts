// Synthetic demo fixtures so the Case Dashboard renders meaningfully without a
// live backend (hackathon demo). Values are derived from config/personas.json
// (all synthetic). When VITE_APP_BASE_URL is set and reachable, live data from
// the Edge Functions replaces these.

import type {
  CaseContextResponse,
  CaseReportResponse,
  QuoteResult,
  ProviderScore,
} from "../types";
import { personas } from "./config";

const A = personas.personas.find((p) => p.persona_id === "A")!;
const B = personas.personas.find((p) => p.persona_id === "B")!;
const C = personas.personas.find((p) => p.persona_id === "C")!;

function itemsFromPrices(
  prices: Record<string, number>,
  requiredKeys: string[]
): QuoteResult["line_items"] {
  return Object.entries(prices).map(([category, amount]) => ({
    category,
    description: category.replace(/_/g, " "),
    amount,
    required_for_case: requiredKeys.includes(category),
    source: {
      conversation_id: `conv_${category}`,
      turn_index: 3,
      start_seconds: null,
      end_seconds: null,
    },
  }));
}

const REQUIRED = [
  "basic_services",
  "hospital_transfer",
  "care_refrigeration",
  "private_goodbye",
  "crematory",
  "alternative_container",
  "permits_certificates",
];

const quoteA: QuoteResult = {
  quote_id: "q_A",
  provider_id: A.provider_id,
  case_spec_version: 4,
  outcome: "itemized_quote",
  price_type: "firm",
  currency: "USD",
  line_items: itemsFromPrices(A.prices, REQUIRED),
  funeral_home_subtotal: A.resolved_total,
  cash_advance_total: 0,
  total: A.resolved_total,
  assumptions: ["Six certified copies included at no added cost."],
  missing_fields: [],
  written_confirmation: "received",
  audit_flags: [],
  confidence: 0.95,
};

const quoteB: QuoteResult = {
  quote_id: "q_B",
  provider_id: B.provider_id,
  case_spec_version: 4,
  outcome: "itemized_quote",
  price_type: "package",
  currency: "USD",
  line_items: itemsFromPrices(B.prices, REQUIRED),
  funeral_home_subtotal: B.resolved_total,
  cash_advance_total: 0,
  total: B.resolved_total,
  assumptions: ["Spanish-language staff available after 2 p.m. only."],
  missing_fields: [],
  written_confirmation: "requested",
  audit_flags: [
    {
      code: "package_only_pricing",
      severity: "warn",
      message:
        "Started with a $3,600 package/range; itemization disclosed only after a second request.",
    },
  ],
  confidence: 0.78,
};

const quoteC: QuoteResult = {
  quote_id: "q_C",
  provider_id: C.provider_id,
  case_spec_version: 4,
  outcome: "itemized_quote",
  price_type: "estimate",
  currency: "USD",
  line_items: itemsFromPrices(C.prices, REQUIRED),
  funeral_home_subtotal: C.resolved_total,
  cash_advance_total: 0,
  total: C.resolved_total,
  assumptions: [
    "$1,795 'direct cremation' headline omitted transfer, goodbye, and after-hours.",
  ],
  missing_fields: [],
  written_confirmation: "requested",
  audit_flags: [
    {
      code: "missing_after_hours_fee",
      severity: "error",
      message:
        "After-hours/admin fee ($675) was omitted from the headline and disclosed only when asked directly.",
    },
  ],
  confidence: 0.7,
};

const scoreA: ProviderScore = {
  provider_id: A.provider_id,
  quote_id: "q_A",
  score: 88,
  breakdown: {
    must_have_fit: 1,
    comparable_total: 0.82,
    completeness_certainty: 0.95,
    timing_capacity: 0.9,
    communication_trust: 0.95,
  },
  hard_failed: false,
  hard_fail_reason: null,
  comparable_total: A.resolved_total,
  audit_flags: [],
};

const scoreB: ProviderScore = {
  provider_id: B.provider_id,
  quote_id: "q_B",
  score: 71,
  breakdown: {
    must_have_fit: 0.6,
    comparable_total: 0.7,
    completeness_certainty: 0.7,
    timing_capacity: 0.6,
    communication_trust: 0.5,
  },
  hard_failed: false,
  hard_fail_reason: null,
  comparable_total: B.resolved_total,
  audit_flags: quoteB.audit_flags,
};

const scoreC: ProviderScore = {
  provider_id: C.provider_id,
  quote_id: "q_C",
  score: 76,
  breakdown: {
    must_have_fit: 1,
    comparable_total: 0.9,
    completeness_certainty: 0.6,
    timing_capacity: 0.7,
    communication_trust: 0.55,
  },
  hard_failed: false,
  hard_fail_reason: null,
  comparable_total: 3990, // after verified-leverage negotiation
  audit_flags: quoteC.audit_flags,
};

const evidenceMarkdown = `# Evidence Ledger — Case (synthetic demo)

**CaseSpec version:** 4 · **Hash:** \`sha256:9f2c…a41\` · **Jurisdiction:** US / CA

## Confirmed scope
- Cremation with a private family goodbye before cremation
- Spanish-language support preferred
- Hospital pickup near ZIP 94304; memorial later; return of ashes
- Six certified copies requested for comparison
- Budget: **not shared** (mention_budget = false)

## Provider outcomes

| Provider | Price type | Comparable total | Audit flags |
| --- | --- | --- | --- |
| Transparent family-owned (A) | firm | $3,940 | none |
| Package-first (B) | package | $4,250 | package_only_pricing |
| Low headline / hidden-fee (C) | estimate | $4,440 → $3,990 | missing_after_hours_fee |

## Negotiation
- Cited a **verified comparable quote** of $3,940 (Provider A, audited).
- Provider C **waived the $450 after-hours fee**; revised comparable total **$3,990**.
- Written confirmation **requested**. No booking or payment authorized (INV-06).

## Notes
- Provider C's headline of $1,795 omitted transfer, goodbye, and after-hours until asked directly.
- All amounts carry evidence references or are marked unknown (INV-08).
`;

const contextMarkdown = `## Compact case context (masked)

- **Status:** REPORT_READY
- **Consumer contact:** •••••••4477 (masked, §9.7)
- **Permissions:** call ✓ · use_verified_quote ✓ · negotiate_within_policy ✓ · mention_budget ✗
- **Facts disallowed:** cause_of_death, social_security_number, payment_data

_Full transcripts are never returned by this endpoint (§6.3)._
`;

export function demoContext(caseId: string): CaseContextResponse {
  return {
    case_id: caseId,
    status: "REPORT_READY",
    masked_phone: "+1••••••4477",
    case_spec: {
      case_id: caseId,
      version: 4,
      mode: "at_need",
      jurisdiction: { country: "US", state: "CA" },
      location: { pickup_zip: "94304", search_radius_miles: 25 },
      custody: { current_location_type: "hospital", transfer_deadline_at: null },
      authority: { confirmed_for_demo: true, role: "adult_child" },
      disposition: "cremation_with_service",
      must_haves: ["private family goodbye", "Spanish-language support"],
      service_preferences: {
        viewing: "private",
        ceremony: "memorial_later",
        return_of_ashes: true,
      },
      cost_posture: "balanced",
      budget_user_stated: null,
      benefits_to_check: [],
      permissions: {
        research: true,
        call: true,
        mention_budget: false,
        use_verified_quote: true,
        negotiate_within_policy: true,
        transcribe_if_all_parties_consent: true,
      },
      facts_disallowed: [
        "cause_of_death",
        "social_security_number",
        "payment_data",
      ],
      unknowns: [],
      confirmed_at: "2026-07-18T17:12:00Z",
    },
    quotes: [quoteA, quoteB, quoteC],
    comparison: [scoreA, scoreC, scoreB],
    verified_leverage: {
      quote_id: "q_A",
      provider_id: A.provider_id,
      supported_amount: A.resolved_total,
      allowed_disclosure_sentence:
        "A comparable provider quoted a fully itemized total of $3,940.",
    },
    revised_terms: [
      {
        provider_id: C.provider_id,
        quote_id: "q_C",
        before_amount: C.resolved_total,
        after_amount: 3990,
        changed_category: "after_hours_admin",
        term_change:
          "Waived the $450 after-hours fee after a verified comparable quote was cited.",
        evidence: {
          conversation_id: "conv_neg_C",
          turn_index: 7,
          start_seconds: null,
          end_seconds: null,
        },
      },
    ],
    evidence_markdown: evidenceMarkdown,
    context_markdown: contextMarkdown,
    case_spec_hash: "sha256:9f2c…a41",
    updated_at: "2026-07-18T17:40:00Z",
  };
}

export function demoReport(caseId: string): CaseReportResponse {
  return {
    case_id: caseId,
    status: "REPORT_READY",
    report: {
      case_id: caseId,
      case_spec_version: 4,
      scores: [scoreA, scoreC, scoreB],
      is_tie: false,
      tie_reason: null,
      recommended_provider_id: A.provider_id,
      runner_up_provider_id: C.provider_id,
      material_tradeoff:
        "Provider C is now $50 lower after negotiation but had an omitted fee and lower communication trust; Provider A leads on certainty and clarity.",
      next_human_action:
        "Reply SUMMARY for a text recap, or CALL to have the Grace Closer Agent walk through the recommendation.",
      generated_at: "2026-07-18T17:40:00Z",
    },
    report_markdown: `# Ranked report (synthetic demo)

**Recommendation: Transparent family-owned director (A) — score 88/100.**

Runner-up: Low headline / hidden-fee operator (C) — score 76/100 after negotiation.

**Why A:** best completeness/certainty and communication trust, fully itemized firm total of $3,940, both must-haves met.

**Material trade-off:** C's negotiated total ($3,990) is close, but it omitted an after-hours fee until asked and scores lower on trust.

_Grace cannot book or authorize anything (INV-06). Next: reply SUMMARY or CALL._
`,
  };
}
