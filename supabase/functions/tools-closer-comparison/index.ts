// =====================================================================
// Grace — Closer tool: audited quote comparison + verified leverage
// Endpoint: GET /tools/closer/comparison  (spec §6.3, §5.7)
// Owner: task 8. Read-only. START CONDITION for the Closer Agent.
//
// Invariants enforced here:
//   INV-05  verified_leverage is ONLY ever an AUDITED, comparable quote id +
//           its supported amount + an allowed disclosure sentence. Never a
//           fabricated or unaudited number.
//   INV-06  read-only: no action, no mutation.
//   Only quotes with audit_status = AUDITED are considered (§10.3: never surface
//           PENDING / PENDING_REVIEW quotes as leverage).
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { rankProviders } from "../_shared/ranking/rank.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { CaseSpec, QuoteResult, VerifiedLeverage } from "../_shared/types.ts";
import vertical from "../_shared/config/vertical.json" with { type: "json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const url = new URL(req.url);
  const caseId = url.searchParams.get("case_id");
  const comparisonId = url.searchParams.get("comparison_id");
  if (!caseId) return error("case_id is required", 400);

  const admin = supabaseAdmin();

  // Confirmed CaseSpec (permissions + ranking inputs).
  const { data: caseRow } = await admin
    .from("cases")
    .select("current_version")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return error("case not found", 404);

  const { data: verRow } = await admin
    .from("case_versions")
    .select("case_spec_json, version")
    .eq("case_id", caseId)
    .eq("version", caseRow.current_version)
    .maybeSingle();
  if (!verRow) return error("confirmed CaseSpec not found", 404);
  const spec = verRow.case_spec_json as unknown as CaseSpec;

  // AUDITED quotes only — the normalized QuoteResult lives in quote_json.
  const { data: quoteRows } = await admin
    .from("quotes")
    .select("quote_id, provider_id, quote_json, audit_status")
    .eq("case_id", caseId)
    .eq("case_spec_version", caseRow.current_version)
    .eq("audit_status", "AUDITED");

  const quotes: QuoteResult[] = (quoteRows ?? []).map(
    (r) => r.quote_json as unknown as QuoteResult,
  );

  if (quotes.length === 0) {
    return json({
      comparison_id: comparisonId,
      case_id: caseId,
      comparison: [],
      verified_leverage: null,
      note: "No audited quotes yet.",
    });
  }

  // Deterministic scoring gives us comparable_total / fit / audit flags per provider.
  const report = rankProviders(
    quotes,
    spec,
    vertical.ranking.weights as unknown as Parameters<typeof rankProviders>[2],
  );

  // ---- INV-05: verified leverage = best AUDITED, comparable, non-hard-failed quote. ----
  let verifiedLeverage: VerifiedLeverage | null = null;
  if (spec.permissions?.use_verified_quote === true) {
    const eligible = report.scores.filter(
      (s) => !s.hard_failed && s.quote_id != null && typeof s.comparable_total === "number",
    );
    eligible.sort((a, b) => (a.comparable_total! - b.comparable_total!));
    const best = eligible[0];
    if (best) {
      const amount = best.comparable_total!;
      verifiedLeverage = {
        quote_id: best.quote_id!,
        provider_id: best.provider_id,
        supported_amount: amount,
        allowed_disclosure_sentence:
          `We have a verified itemized quote of $${amount.toLocaleString("en-US")} ` +
          `for the same pickup area, private family goodbye, cremation, and return of ashes.`,
      };
    }
  }

  // Read-only comparison payload (totals, fit, missing fields, audit flags).
  return json({
    comparison_id: comparisonId,
    case_id: caseId,
    comparison: report.scores,
    verified_leverage: verifiedLeverage,
  });
});
