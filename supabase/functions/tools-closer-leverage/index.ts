// =====================================================================
// Grace — Closer tool: return ONLY verified leverage
// Endpoint: GET /tools/closer/leverage?case_id=...  (tool `get_verified_leverage`)
// A focused view of the same audited data as /tools/closer/comparison, returning
// just the single allowed leverage object so the Closer prompt stays compact.
//
// Invariants:
//   INV-05  leverage is ONLY an AUDITED, comparable, non-hard-failed quote id +
//           supported amount + allowed disclosure sentence. Never fabricated.
//   INV-06  read-only.
//   Gated on permissions.use_verified_quote (§4.4).
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { rankProviders } from "../_shared/ranking/rank.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { CaseSpec, QuoteResult, VerifiedLeverage } from "../_shared/types.ts";
import vertical from "../../../config/vertical.json" with { type: "json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const caseId = new URL(req.url).searchParams.get("case_id");
  if (!caseId) return error("case_id is required", 400);

  const admin = supabaseAdmin();

  const { data: caseRow } = await admin
    .from("cases").select("current_version").eq("case_id", caseId).maybeSingle();
  if (!caseRow) return error("case not found", 404);

  const { data: verRow } = await admin
    .from("case_versions")
    .select("case_spec_json")
    .eq("case_id", caseId)
    .eq("version", caseRow.current_version)
    .maybeSingle();
  if (!verRow) return error("confirmed CaseSpec not found", 404);
  const spec = verRow.case_spec_json as unknown as CaseSpec;

  // ---- INV-05 gate: leverage only when the family authorized verified-quote use.
  if (spec.permissions?.use_verified_quote !== true) {
    return json({ case_id: caseId, verified_leverage: null, note: "use_verified_quote not permitted" });
  }

  const { data: quoteRows } = await admin
    .from("quotes")
    .select("quote_id, provider_id, quote_json, audit_status")
    .eq("case_id", caseId)
    .eq("case_spec_version", caseRow.current_version)
    .eq("audit_status", "AUDITED"); // §10.3: never surface non-audited quotes
  const quotes: QuoteResult[] = (quoteRows ?? []).map((r) => r.quote_json as unknown as QuoteResult);
  if (quotes.length === 0) return json({ case_id: caseId, verified_leverage: null, note: "no audited quotes" });

  const report = rankProviders(
    quotes, spec,
    vertical.ranking.weights as unknown as Parameters<typeof rankProviders>[2],
  );

  const eligible = report.scores
    .filter((s) => !s.hard_failed && s.quote_id != null && typeof s.comparable_total === "number")
    .sort((a, b) => a.comparable_total! - b.comparable_total!);
  const best = eligible[0];

  const verified_leverage: VerifiedLeverage | null = best
    ? {
        quote_id: best.quote_id!,
        provider_id: best.provider_id,
        supported_amount: best.comparable_total!,
        allowed_disclosure_sentence:
          `We have a verified itemized quote of $${best.comparable_total!.toLocaleString("en-US")} ` +
          `for the same pickup area, private family goodbye, cremation, and return of ashes.`,
      }
    : null;

  return json({ case_id: caseId, verified_leverage });
});
