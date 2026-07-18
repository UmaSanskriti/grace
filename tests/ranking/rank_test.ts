// =====================================================================
// Grace ranking tests (spec §11.1 ranking rows, §5.8 tie policy, App B.3).
//
// PURE / OFFLINE: no network, no clock. Runs under `deno test`.
// Fixtures are built from the §7.6 synthetic price matrix:
//   A Transparent  — resolved total $3,940, firm, fully itemized, clean.
//   B Package-first — total $4,250, package pricing, package-only flag.
//   C Hidden-fee    — total $4,440, estimate, audit flags (hidden fees).
//
// Weights are hardcoded from config/vertical.json .ranking.weights for
// determinism (the code reads them from the argument, not from config).
// =====================================================================

import {
  assert,
  assertEquals,
  assertFalse,
} from "std/assert/mod.ts";
import { rankProviders } from "../../supabase/functions/_shared/ranking/rank.ts";
import type { RankingWeights } from "../../supabase/functions/_shared/ranking/rank.ts";
import type {
  AuditFlag,
  CaseSpec,
  QuoteLineItem,
  QuoteResult,
} from "../../supabase/functions/_shared/types.ts";

// ---- weights (config/vertical.json .ranking.weights) ----------------
const WEIGHTS: RankingWeights = {
  must_have_fit: 0.30,
  comparable_total: 0.25,
  completeness_certainty: 0.20,
  timing_capacity: 0.15,
  communication_trust: 0.10,
};

// ---------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------
function baseSpec(overrides: Partial<CaseSpec> = {}): CaseSpec {
  return {
    case_id: "case_demo_1",
    version: 3,
    mode: "at_need",
    jurisdiction: { country: "US", state: "CA" },
    location: { pickup_zip: "94110", search_radius_miles: 25 },
    custody: { current_location_type: "hospital", transfer_deadline_at: null },
    authority: { confirmed_for_demo: true, role: "next_of_kin" },
    disposition: "direct_cremation",
    must_haves: [],
    service_preferences: {},
    cost_posture: "lowest_comparable_total",
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
    facts_disallowed: [],
    unknowns: [],
    confirmed_at: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

function li(
  category: string,
  amount: number | null,
  required = true,
): QuoteLineItem {
  return {
    category,
    description: category,
    amount,
    required_for_case: required,
    source: null,
  };
}

interface QuoteOpts {
  provider_id: string;
  total: number | null;
  price_type?: QuoteResult["price_type"];
  written?: QuoteResult["written_confirmation"];
  confidence?: number;
  line_items?: QuoteLineItem[];
  missing_fields?: string[];
  assumptions?: string[];
  audit_flags?: AuditFlag[];
  outcome?: QuoteResult["outcome"];
}

function quote(o: QuoteOpts): QuoteResult {
  return {
    quote_id: `q_${o.provider_id}`,
    provider_id: o.provider_id,
    case_spec_version: 3,
    outcome: o.outcome ?? "itemized_quote",
    price_type: o.price_type ?? "firm",
    currency: "USD",
    line_items: o.line_items ?? [],
    funeral_home_subtotal: o.total,
    cash_advance_total: 0,
    total: o.total,
    assumptions: o.assumptions ?? [],
    missing_fields: o.missing_fields ?? [],
    written_confirmation: o.written ?? "received",
    audit_flags: o.audit_flags ?? [],
    confidence: o.confidence ?? 0.9,
  };
}

// ---- §7.6 personas --------------------------------------------------
const A_ITEMS: QuoteLineItem[] = [
  li("basic_services", 1700),
  li("transfer", 495),
  li("care_refrigeration", 250),
  li("private_goodbye", 450),
  li("crematory", 425),
  li("container", 150),
  li("permits_certificates", 190),
  li("taxes_fees", 280), // six certificates added -> resolved $3,940
];

const B_ITEMS: QuoteLineItem[] = [
  li("basic_services", 1550),
  li("transfer", 450),
  li("care_refrigeration", 250),
  li("private_goodbye", 400),
  li("crematory", 450),
  li("container", 150),
  li("permits_certificates", 200),
  li("distance_after_hours", 800),
];

const C_ITEMS: QuoteLineItem[] = [
  li("basic_services", 1150),
  li("transfer", 695),
  li("care_refrigeration", 350),
  li("private_goodbye", 600),
  li("crematory", 500),
  li("container", 250),
  li("permits_certificates", 220),
  li("distance_after_hours", 675),
];

function transparentA(overrides: Partial<QuoteOpts> = {}): QuoteResult {
  return quote({
    provider_id: "prov_A",
    total: 3940,
    price_type: "firm",
    written: "received",
    confidence: 0.95,
    line_items: A_ITEMS,
    audit_flags: [],
    ...overrides,
  });
}

function packageB(overrides: Partial<QuoteOpts> = {}): QuoteResult {
  return quote({
    provider_id: "prov_B",
    total: 4250,
    price_type: "package",
    written: "requested",
    confidence: 0.7,
    line_items: B_ITEMS,
    audit_flags: [{
      code: "package_only_pricing",
      severity: "warn",
      message: "Provider quoted a bundled package rather than itemized prices.",
      evidence: null,
    }],
    ...overrides,
  });
}

function hiddenFeeC(overrides: Partial<QuoteOpts> = {}): QuoteResult {
  return quote({
    provider_id: "prov_C",
    total: 4440,
    price_type: "estimate",
    written: "none",
    confidence: 0.55,
    line_items: C_ITEMS,
    assumptions: ["After-hours fee estimated; not confirmed in writing."],
    audit_flags: [
      {
        code: "missing_after_hours_fee",
        severity: "error",
        message: "After-hours fee was not disclosed up front.",
        evidence: null,
      },
      {
        code: "inconsistent_totals",
        severity: "warn",
        message: "Stated total did not match the sum of line items.",
        evidence: null,
      },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------
// §11.1 — Ranking hard filters:
// "Provider failing a must-have cannot win on low price."
// ---------------------------------------------------------------------
Deno.test("hard filter: cheapest provider that fails a must-have cannot win", () => {
  const spec = baseSpec({ must_haves: ["spanish_language_support"] });

  // Cheapest by far, but cannot meet the non-negotiable must-have.
  const cheapButFails = quote({
    provider_id: "prov_cheap",
    total: 2500,
    price_type: "firm",
    written: "received",
    confidence: 0.95,
    line_items: [li("basic_services", 2500)],
    missing_fields: ["spanish_language_support"],
  });

  // A meets everything at $3,940.
  const a = transparentA();

  const report = rankProviders([cheapButFails, a], spec, WEIGHTS);

  const cheap = report.scores.find((s) => s.provider_id === "prov_cheap")!;
  assert(cheap.hard_failed, "cheap provider must be hard-failed");
  assertEquals(report.recommended_provider_id, "prov_A");
  assert(
    report.recommended_provider_id !== "prov_cheap",
    "hard-failed provider cannot win on low price",
  );
  // Hard-failed provider sorts below the eligible one.
  assertEquals(report.scores[report.scores.length - 1].provider_id, "prov_cheap");
});

// ---------------------------------------------------------------------
// §11.1 — Clear winner: delta > 3 => recommendation set.
// ---------------------------------------------------------------------
Deno.test("clear winner: margin > 3 recommends the top provider", () => {
  const spec = baseSpec();
  const report = rankProviders([transparentA(), hiddenFeeC()], spec, WEIGHTS);

  assertFalse(report.is_tie);
  assertEquals(report.recommended_provider_id, "prov_A");
  assertEquals(report.runner_up_provider_id, "prov_C");
  assertEquals(report.material_tradeoff, null);

  const a = report.scores.find((s) => s.provider_id === "prov_A")!;
  const c = report.scores.find((s) => s.provider_id === "prov_C")!;
  assert(a.score - c.score > 3, `expected margin > 3, got ${a.score - c.score}`);
});

// ---------------------------------------------------------------------
// §11.1 / §5.8 — Tie behavior: delta <= 3 => is_tie, no forced recommendation.
// ---------------------------------------------------------------------
Deno.test("tie: score delta <= 3 yields options, not a recommendation", () => {
  const spec = baseSpec();
  // Two near-identical transparent quotes ($3,940 vs $4,000, ~1.5% apart).
  const a = transparentA();
  const aClose = transparentA({ provider_id: "prov_A2", total: 4000 });

  const report = rankProviders([a, aClose], spec, WEIGHTS);

  assert(report.is_tie, "near-identical quotes must be a tie");
  assertEquals(report.recommended_provider_id, null);
  assert(report.runner_up_provider_id !== null);
  assert(
    report.material_tradeoff !== null && report.material_tradeoff.length > 0,
    "tie must include a material trade-off",
  );
  assert(report.tie_reason !== null);

  const top = report.scores[0];
  const second = report.scores[1];
  assert(top.score - second.score <= 3);
});

// ---------------------------------------------------------------------
// §5.8 rule 2 — Cost not normalized while mandatory categories unresolved.
// ---------------------------------------------------------------------
Deno.test("cost not normalized when mandatory fee categories are unresolved", () => {
  const spec = baseSpec();

  // Same price band as A, but a mandatory category is still open.
  const unresolved = quote({
    provider_id: "prov_unresolved",
    total: 3900,
    price_type: "firm",
    written: "received",
    confidence: 0.9,
    line_items: [li("basic_services", 1700), li("transfer", 495)],
    missing_fields: ["cash_advances"], // mandatory fee category unresolved
  });

  const report = rankProviders([transparentA(), unresolved], spec, WEIGHTS);

  const u = report.scores.find((s) => s.provider_id === "prov_unresolved")!;
  // Comparable total is NOT normalized: numeric total withheld + penalized component.
  assertEquals(u.comparable_total, null);
  assertEquals(u.breakdown.comparable_total, 20); // UNRESOLVED_COST_FLOOR
  assert(
    u.audit_flags.some((f) => f.code === "comparable_total_unresolved"),
    "unresolved cost must be flagged",
  );

  // The resolved transparent quote is normalized to the cheapest = 100.
  const a = report.scores.find((s) => s.provider_id === "prov_A")!;
  assertEquals(a.comparable_total, 3940);
  assertEquals(a.breakdown.comparable_total, 100);
});

// ---------------------------------------------------------------------
// §11.1 / §5.8 rule 3 — Audit penalties applied before scoring:
// hidden-fee persona C scores below transparent persona A.
// ---------------------------------------------------------------------
Deno.test("audit penalty: hidden-fee quote scores below the transparent quote", () => {
  const spec = baseSpec();
  const report = rankProviders(
    [hiddenFeeC(), packageB(), transparentA()],
    spec,
    WEIGHTS,
  );

  const a = report.scores.find((s) => s.provider_id === "prov_A")!;
  const b = report.scores.find((s) => s.provider_id === "prov_B")!;
  const c = report.scores.find((s) => s.provider_id === "prov_C")!;

  assert(a.score > c.score, `transparent (${a.score}) must beat hidden-fee (${c.score})`);
  assert(a.score > b.score, `transparent (${a.score}) must beat package-only (${b.score})`);
  // Communication/trust reflects the audit penalty on C.
  assert(
    a.breakdown.communication_trust > c.breakdown.communication_trust,
    "audit flags must lower communication_trust for the hidden-fee quote",
  );
  // Sorted: A first overall.
  assertEquals(report.scores[0].provider_id, "prov_A");
});

// ---------------------------------------------------------------------
// Report shape invariants (§5.9): generated_at null, next_human_action set.
// ---------------------------------------------------------------------
Deno.test("report shape: generated_at null, next_human_action fixed string", () => {
  const spec = baseSpec();
  const report = rankProviders([transparentA(), hiddenFeeC()], spec, WEIGHTS);

  assertEquals(report.generated_at, null);
  assertEquals(
    report.next_human_action,
    "Review the written statement and contact the provider directly.",
  );
  assertEquals(report.case_id, "case_demo_1");
  assertEquals(report.case_spec_version, 3);
  // Scores sorted descending among eligible providers.
  for (let i = 1; i < report.scores.length; i++) {
    if (!report.scores[i - 1].hard_failed && !report.scores[i].hard_failed) {
      assert(report.scores[i - 1].score >= report.scores[i].score);
    }
  }
});
