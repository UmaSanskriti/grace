// =====================================================================
// Grace — deterministic ranking engine (spec §5.8 / §5.9, App B.3)
//
// Pure, deterministic, side-effect-free. NO randomness, NO LLM, NO clock.
// Given normalized + audited quotes it produces a RankedReport. The caller
// is responsible for stamping `generated_at` (Date.now is intentionally not
// used here so the output is byte-stable for a given input).
//
// Scoring model (each component is scaled to 0..100; the weighted sum is
// therefore also 0..100):
//
//   score = 0.30*mustHaveFit
//         + 0.25*comparableCost
//         + 0.20*completenessAndCertainty
//         + 0.15*timingAndCapacity
//         + 0.10*communicationTrust
//
// (Weights are supplied by the caller from config/vertical.json .ranking.weights.)
// =====================================================================

import type {
  AuditFlag,
  CaseSpec,
  ProviderScore,
  QuoteResult,
  RankedReport,
  ScoreBreakdown,
} from "../types.ts";

/** Ranking weights — mirrors config/vertical.json .ranking.weights (§5.8). */
export interface RankingWeights {
  must_have_fit: number;
  comparable_total: number;
  completeness_certainty: number;
  timing_capacity: number;
  communication_trust: number;
}

// ---------------------------------------------------------------------
// Tunable constants (kept local so the lib is self-contained / testable).
// These mirror config/vertical.json .ranking so behaviour matches the spec.
// ---------------------------------------------------------------------

/** §5.8 rule 4: recommend only when topScore - secondScore > this many points. */
const RECOMMEND_MARGIN_POINTS = 3;

/** §5.8: totals within this fraction with different fit advantages => tie. */
const TIE_TOTAL_PCT = 0.05;

/**
 * Mandatory fee categories that must be resolved before a quote's comparable
 * total can be normalized (§5.8 rule 2). Mirrors config .questions_required
 * fee categories (the Funeral-Rule line items a caller must nail down). If any
 * of these is listed in `missing_fields`, the total is treated as unresolved.
 */
const MANDATORY_FEE_CATEGORIES = [
  "basic_services",
  "transfer",
  "care_and_refrigeration",
  "care_refrigeration",
  "crematory",
  "container",
  "permits_and_certificates",
  "permits_certificates",
  "distance_and_after_hours",
  "distance_after_hours",
  "cash_advances",
  "taxes",
  "taxes_fees",
];

/**
 * Comparable-cost component floor for a quote whose mandatory categories are
 * NOT yet resolved. Such a quote is explicitly excluded from cost
 * normalization (§5.8 rule 2) and given this penalized value plus an audit
 * flag, rather than being allowed to look "cheap" on an incomplete total.
 */
const UNRESOLVED_COST_FLOOR = 20;

// Audit-flag penalties by severity (§5.8 rule 3 — applied as inputs to the
// communication/trust and completeness components BEFORE the weighted sum).
const AUDIT_PENALTY = { error: 25, warn: 12, info: 4 } as const;

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100): number =>
  Math.max(lo, Math.min(hi, n));

const round1 = (n: number): number => Math.round(n * 10) / 10;

const norm = (s: string): string => s.toLowerCase().replace(/[\s/]+/g, "_");

/** Sum of audit penalties for a quote, by severity weight. */
function auditPenalty(flags: AuditFlag[]): number {
  return flags.reduce((sum, f) => sum + (AUDIT_PENALTY[f.severity] ?? 0), 0);
}

// ---------------------------------------------------------------------
// Must-have fit + hard filter (§5.8 component 1, App B.3 rule 1)
// ---------------------------------------------------------------------

interface MustHaveEval {
  score: number; // 0..100
  hardFailed: boolean;
  reason: string | null;
  metCount: number;
  total: number;
}

/**
 * Determine which of the family's non-negotiable must-haves the quote meets.
 *
 * Deterministic heuristic (documented so it is auditable):
 *  - A non-itemized outcome (declined / unavailable / consent_declined) means
 *    the provider cannot serve the case at all => HARD FAIL.
 *  - A must-have is UNMET if its token appears in `missing_fields`, or if an
 *    error-severity audit flag's code/message references it, or if it is
 *    hedged away in an assumption ("cannot", "not able", "unable to").
 *  - In the demo every entry in spec.must_haves is treated as non-negotiable,
 *    so any unmet must-have is a HARD FAIL: the provider cannot win on price
 *    (§11.1 hard-filter test). mustHaveFit = 0 when hard-failed.
 *  - Otherwise mustHaveFit = 100 (all requirements met).
 */
function evaluateMustHaves(quote: QuoteResult, spec: CaseSpec): MustHaveEval {
  const musts = spec.must_haves ?? [];
  const total = musts.length;

  if (
    quote.outcome === "declined" ||
    quote.outcome === "unavailable" ||
    quote.outcome === "consent_declined"
  ) {
    return {
      score: 0,
      hardFailed: true,
      reason: `Provider outcome "${quote.outcome}" — cannot serve this case.`,
      metCount: 0,
      total,
    };
  }

  const missing = new Set(quote.missing_fields.map(norm));
  const errorText = quote.audit_flags
    .filter((f) => f.severity === "error")
    .map((f) => norm(`${f.code} ${f.message}`))
    .join(" ");
  const assumptionText = quote.assumptions.map((a) => a.toLowerCase()).join(" ");
  const hedged = /\b(cannot|can not|not able|unable to|won't|will not)\b/;

  const unmet: string[] = [];
  for (const m of musts) {
    const token = norm(m);
    const inMissing = missing.has(token) ||
      [...missing].some((f) => f.includes(token) || token.includes(f));
    const inErrors = token.length > 0 && errorText.includes(token);
    const hedgedAway = hedged.test(assumptionText) &&
      assumptionText.includes(m.toLowerCase());
    if (inMissing || inErrors || hedgedAway) unmet.push(m);
  }

  if (unmet.length > 0) {
    return {
      score: 0,
      hardFailed: true,
      reason: `Unmet non-negotiable must-have(s): ${unmet.join(", ")}.`,
      metCount: total - unmet.length,
      total,
    };
  }

  return { score: 100, hardFailed: false, reason: null, metCount: total, total };
}

// ---------------------------------------------------------------------
// Cost resolution (§5.8 rule 2)
// ---------------------------------------------------------------------

/**
 * A quote's comparable total may only be normalized when its mandatory fee
 * categories are resolved. Unresolved when: not an itemized quote, total is
 * null, a required line item has a null amount, or a mandatory fee category
 * appears in `missing_fields`.
 */
function isCostResolved(quote: QuoteResult): boolean {
  if (quote.outcome !== "itemized_quote") return false;
  if (quote.total === null) return false;

  const requiredHasNull = quote.line_items.some(
    (li) => li.required_for_case && li.amount === null,
  );
  if (requiredHasNull) return false;

  const mandatory = new Set(MANDATORY_FEE_CATEGORIES.map(norm));
  const missingMandatory = quote.missing_fields.some((f) =>
    mandatory.has(norm(f))
  );
  if (missingMandatory) return false;

  return true;
}

// ---------------------------------------------------------------------
// Component sub-scores (each 0..100)
// ---------------------------------------------------------------------

/**
 * completenessAndCertainty (§5.8 component 3): firm + written + fully itemized
 * + high confidence scores highest. Estimates/ranges/packages, missing fields,
 * null line amounts, PENDING/unresolved signals and low confidence lower it.
 */
function completenessScore(quote: QuoteResult): number {
  let base = 100;

  // Price firmness.
  switch (quote.price_type) {
    case "firm":
      break;
    case "estimate":
      base -= 20;
      break;
    case "range":
      base -= 30;
      break;
    case "package":
      base -= 25;
      break;
  }

  // Written confirmation.
  if (quote.written_confirmation === "requested") base -= 10;
  else if (quote.written_confirmation === "none") base -= 20;

  // Itemization completeness — penalize null (unknown / PENDING) amounts.
  const nullAmounts = quote.line_items.filter((li) => li.amount === null).length;
  base -= Math.min(30, nullAmounts * 6);
  if (quote.line_items.length === 0) base -= 30;

  // Missing fields & open assumptions add uncertainty.
  base -= Math.min(24, quote.missing_fields.length * 8);
  base -= Math.min(12, quote.assumptions.length * 3);

  base = clamp(base);

  // Blend in the model's own confidence (0..1) as a certainty multiplier.
  const certainty = 0.6 + 0.4 * clamp(quote.confidence, 0, 1);
  return clamp(base * certainty);
}

/**
 * timingAndCapacity (§5.8 component 4): pickup-deadline fit, service
 * availability and callback certainty. We use the quote outcome + written
 * confirmation + assumptions as proxies (documented heuristic).
 */
function timingScore(quote: QuoteResult, spec: CaseSpec): number {
  let s: number;
  switch (quote.outcome) {
    case "itemized_quote":
      s = 90; // gave a concrete answer now => high capacity certainty
      break;
    case "callback":
      s = 50; // deferred => uncertain
      break;
    default:
      s = 0; // declined / unavailable / consent_declined
  }

  if (quote.outcome === "itemized_quote") {
    if (quote.written_confirmation === "received") s += 10;
    else if (quote.written_confirmation === "none") s -= 5;
  }

  // Assumptions signalling delay / limited capacity reduce timing certainty.
  const txt = quote.assumptions.join(" ").toLowerCase();
  if (/\b(delay|waitlist|backlog|no capacity|next week|booked)\b/.test(txt)) {
    s -= 20;
  }

  // If the case has a custody transfer deadline, unresolved timing is riskier.
  if (spec.custody?.transfer_deadline_at && quote.outcome !== "itemized_quote") {
    s -= 15;
  }

  return clamp(s);
}

/**
 * communicationTrust (§5.8 component 5): clear, consistent, pressure-free
 * communication. Penalize audit flags by severity (hidden fees, package-only,
 * inconsistent totals, unverified law claims); reward clean, fully itemized
 * quotes with written confirmation. This is where audit penalties enter the
 * score (§5.8 rule 3 — before the weighted sum).
 */
function communicationTrustScore(quote: QuoteResult): number {
  let s = 100 - auditPenalty(quote.audit_flags);

  // Reward a clean, transparent quote.
  if (
    quote.audit_flags.length === 0 &&
    quote.written_confirmation === "received" &&
    quote.price_type === "firm"
  ) {
    s += 0; // already at ceiling; kept explicit for readability
  }

  // Package-only pricing is itself a trust concern even absent a flag.
  if (quote.price_type === "package") s -= 8;

  return clamp(s);
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

export function rankProviders(
  quotes: QuoteResult[],
  spec: CaseSpec,
  weights: RankingWeights,
): RankedReport {
  // ---- Pass 1: per-quote must-have fit, cost resolution, comparable totals.
  interface Row {
    quote: QuoteResult;
    mh: MustHaveEval;
    costResolved: boolean;
    comparableTotal: number | null; // numeric only when resolved
    extraFlags: AuditFlag[]; // ranking-injected flags (e.g. unresolved cost)
  }

  const rows: Row[] = quotes.map((quote) => {
    const mh = evaluateMustHaves(quote, spec);
    const costResolved = isCostResolved(quote);
    return {
      quote,
      mh,
      costResolved,
      comparableTotal: costResolved ? quote.total : null,
      extraFlags: [],
    };
  });

  // ---- Cost normalization (§5.8 rule 2): only among resolved comparable
  //      totals of providers that did NOT hard-fail.
  const resolvedTotals = rows
    .filter((r) => !r.mh.hardFailed && r.costResolved && r.comparableTotal !== null)
    .map((r) => r.comparableTotal as number);
  const cheapest = resolvedTotals.length > 0 ? Math.min(...resolvedTotals) : null;

  // ---- Pass 2: assemble ProviderScore for each quote.
  const scores: ProviderScore[] = rows.map((r) => {
    const { quote, mh } = r;

    // comparableCost component.
    let comparableCost: number;
    if (r.costResolved && r.comparableTotal !== null && cheapest !== null) {
      // Cheapest resolved total = 100; others scale down linearly.
      comparableCost = clamp(100 * (cheapest / r.comparableTotal));
    } else {
      // §5.8 rule 2: cannot normalize an unresolved total — penalize + flag.
      comparableCost = UNRESOLVED_COST_FLOOR;
      r.extraFlags.push({
        code: "comparable_total_unresolved",
        severity: "warn",
        message:
          "Mandatory fee categories are unresolved; comparable total was not normalized.",
        evidence: null,
      });
    }

    const breakdown: ScoreBreakdown = {
      must_have_fit: round1(mh.score),
      comparable_total: round1(comparableCost),
      completeness_certainty: round1(completenessScore(quote)),
      timing_capacity: round1(timingScore(quote, spec)),
      communication_trust: round1(communicationTrustScore(quote)),
    };

    const raw =
      weights.must_have_fit * breakdown.must_have_fit +
      weights.comparable_total * breakdown.comparable_total +
      weights.completeness_certainty * breakdown.completeness_certainty +
      weights.timing_capacity * breakdown.timing_capacity +
      weights.communication_trust * breakdown.communication_trust;

    return {
      provider_id: quote.provider_id,
      quote_id: quote.quote_id,
      score: round1(clamp(raw)),
      breakdown,
      hard_failed: mh.hardFailed,
      hard_fail_reason: mh.reason,
      comparable_total: r.comparableTotal,
      audit_flags: [...quote.audit_flags, ...r.extraFlags],
    };
  });

  // ---- Sort: eligible (not hard-failed) first, then by score desc.
  //      Ties broken by lower comparable total, then provider_id (stable/deterministic).
  scores.sort((a, b) => {
    if (a.hard_failed !== b.hard_failed) return a.hard_failed ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    const at = a.comparable_total ?? Number.POSITIVE_INFINITY;
    const bt = b.comparable_total ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.provider_id.localeCompare(b.provider_id);
  });

  // ---- Winner selection: only among eligible providers (hard-fail = removed
  //      from contention; cannot win on low price — §5.8 rule 1 / §11.1).
  const eligible = scores.filter((s) => !s.hard_failed);

  const next_human_action =
    "Review the written statement and contact the provider directly.";

  const base = {
    case_id: spec.case_id,
    case_spec_version: spec.version,
    scores,
    next_human_action,
    generated_at: null as string | null,
  };

  // No eligible provider met the non-negotiables.
  if (eligible.length === 0) {
    return {
      ...base,
      is_tie: false,
      tie_reason: null,
      recommended_provider_id: null,
      runner_up_provider_id: null,
      material_tradeoff:
        "No provider met all non-negotiable must-haves; none can be recommended.",
    };
  }

  const top = eligible[0];
  const second = eligible[1] ?? null;

  // Only one eligible provider — clear winner, nothing to tie against.
  if (!second) {
    return {
      ...base,
      is_tie: false,
      tie_reason: null,
      recommended_provider_id: top.provider_id,
      runner_up_provider_id: null,
      material_tradeoff: null,
    };
  }

  const margin = round1(top.score - second.score);

  // §5.8 additional tie rule: comparable totals within TIE_TOTAL_PCT with
  // different fit advantages => tie, even if the raw margin exceeds 3.
  let closeTotalsDifferentFit = false;
  if (top.comparable_total !== null && second.comparable_total !== null) {
    const lo = Math.min(top.comparable_total, second.comparable_total);
    const pct = lo > 0
      ? Math.abs(top.comparable_total - second.comparable_total) / lo
      : 0;
    const differentFit =
      top.breakdown.must_have_fit !== second.breakdown.must_have_fit ||
      top.breakdown.completeness_certainty !==
        second.breakdown.completeness_certainty ||
      top.breakdown.timing_capacity !== second.breakdown.timing_capacity;
    closeTotalsDifferentFit = pct <= TIE_TOTAL_PCT && differentFit;
  }

  const isTie = margin <= RECOMMEND_MARGIN_POINTS || closeTotalsDifferentFit;

  if (isTie) {
    const tie_reason = closeTotalsDifferentFit && margin > RECOMMEND_MARGIN_POINTS
      ? `Comparable totals within ${Math.round(TIE_TOTAL_PCT * 100)}% with different fit advantages.`
      : `Score margin ${margin} <= ${RECOMMEND_MARGIN_POINTS} points; no clear winner.`;

    return {
      ...base,
      is_tie: true,
      tie_reason,
      recommended_provider_id: null,
      runner_up_provider_id: second.provider_id,
      material_tradeoff: buildTradeoff(top, second),
    };
  }

  // Clear winner (§5.8 rule 4).
  return {
    ...base,
    is_tie: false,
    tie_reason: null,
    recommended_provider_id: top.provider_id,
    runner_up_provider_id: second.provider_id,
    material_tradeoff: null,
  };
}

/**
 * Build a one-line material trade-off between the two leading options,
 * describing the axis on which they differ (§5.9 "Runner-up / tie").
 */
function buildTradeoff(a: ProviderScore, b: ProviderScore): string {
  const at = a.comparable_total;
  const bt = b.comparable_total;
  const cheaper = at !== null && bt !== null
    ? (at <= bt ? a : b)
    : a;
  const other = cheaper === a ? b : a;

  const parts: string[] = [];
  if (cheaper.comparable_total !== null && other.comparable_total !== null) {
    parts.push(
      `${cheaper.provider_id} has the lower comparable total ($${cheaper.comparable_total.toLocaleString("en-US")} vs $${other.comparable_total.toLocaleString("en-US")})`,
    );
  } else {
    parts.push(`${cheaper.provider_id} and ${other.provider_id} are closely matched`);
  }

  if (other.breakdown.completeness_certainty > cheaper.breakdown.completeness_certainty) {
    parts.push(`${other.provider_id} offers a firmer, more complete quote`);
  } else if (other.breakdown.timing_capacity > cheaper.breakdown.timing_capacity) {
    parts.push(`${other.provider_id} offers better timing/availability`);
  } else if (
    other.breakdown.communication_trust > cheaper.breakdown.communication_trust
  ) {
    parts.push(`${other.provider_id} communicated more transparently`);
  } else {
    parts.push(`${other.provider_id} is a comparable alternative`);
  }

  return `${parts.join("; ")}. Review both and contact the provider directly.`;
}
