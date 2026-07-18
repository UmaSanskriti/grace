// =====================================================================
// Grace — Closer tool: deterministic ranked report
// Endpoint: GET /tools/closer/report  (spec §6.3, §5.8, §5.9, tool `get_ranked_report`)
// Owner: task 8. Read-only ranking over AUDITED quotes.
//
// Invariants enforced here:
//   INV-06  read-only: returns scores, tie state, evidence, next human action.
//   §10.3   only AUDITED quotes are ranked; PENDING / PENDING_REVIEW are excluded.
//   Ranking is fully deterministic — rankProviders() + config weights only.
//   State -> REPORT_READY once a report is produced.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { rankProviders } from "../_shared/ranking/rank.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { CaseSpec, QuoteResult } from "../_shared/types.ts";
import vertical from "../../../config/vertical.json" with { type: "json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const url = new URL(req.url);
  const caseId = url.searchParams.get("case_id");
  if (!caseId) return error("case_id is required", 400);

  const admin = supabaseAdmin();

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

  // §10.3: rank AUDITED quotes only.
  const { data: quoteRows } = await admin
    .from("quotes")
    .select("quote_json, audit_status")
    .eq("case_id", caseId)
    .eq("case_spec_version", caseRow.current_version)
    .eq("audit_status", "AUDITED");

  const quotes: QuoteResult[] = (quoteRows ?? []).map(
    (r) => r.quote_json as unknown as QuoteResult,
  );

  if (quotes.length < 2) {
    return json({
      case_id: caseId,
      case_spec_version: caseRow.current_version,
      scores: [],
      is_tie: false,
      tie_reason: null,
      recommended_provider_id: null,
      runner_up_provider_id: null,
      material_tradeoff: null,
      next_human_action: "Await at least two audited quotes before ranking.",
      generated_at: new Date().toISOString(),
    });
  }

  const report = rankProviders(
    quotes,
    spec,
    vertical.ranking.weights as unknown as Parameters<typeof rankProviders>[2],
  );
  if (!report.generated_at) report.generated_at = new Date().toISOString();

  // Persist the deterministic report + advance state (idempotent upsert).
  await admin.from("reports").upsert(
    {
      case_id: caseId,
      report_json: report,
      report_markdown: null, // full Markdown is rendered by cases-report / ledger
      created_at: report.generated_at,
    },
    { onConflict: "case_id" },
  );
  await admin.from("cases").update({ status: "REPORT_READY" }).eq("case_id", caseId);

  await admin.from("events").insert({
    case_id: caseId,
    type: "report_generated",
    actor: "closer_agent",
    payload_json: {
      is_tie: report.is_tie,
      recommended: report.recommended_provider_id,
      runner_up: report.runner_up_provider_id,
    },
    idempotency_key: `report:${caseId}:${caseRow.current_version}:${crypto.randomUUID()}`,
  });

  return json(report);
});
