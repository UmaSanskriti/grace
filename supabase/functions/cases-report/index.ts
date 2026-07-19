// =====================================================================
// Grace — ranked report JSON + Markdown
// Endpoint: GET /cases/{id}/report  (spec §6.3, §5.8, §5.9)
// Owner: task 8. Read-only.
//
// Invariants enforced here:
//   §10.3   ranks AUDITED quotes only.
//   §6.7    any free-text embedded in Markdown is sanitized (anti-injection).
//   INV-06  read-only; no binding action.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { rankProviders } from "../_shared/ranking/rank.ts";
import { sanitizeTranscript } from "../_shared/ledger/ledger.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { CaseSpec, QuoteResult, RankedReport } from "../_shared/types.ts";
import vertical from "../_shared/config/vertical.json" with { type: "json" };

function extractCaseId(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("cases");
  if (idx >= 0 && parts[idx + 1] && parts[idx + 1] !== "report") return parts[idx + 1];
  return url.searchParams.get("case_id") ?? url.searchParams.get("id");
}

/** §5.9 report Markdown. All free text is sanitized before embedding (§6.7). */
function renderReportMarkdown(report: RankedReport): string {
  const s = (t: unknown) => sanitizeTranscript(String(t ?? ""));
  const lines: string[] = [];
  lines.push(`# Grace Ranked Report — Case ${s(report.case_id)}`);
  lines.push("");
  lines.push(`- CaseSpec version: ${report.case_spec_version}`);
  lines.push(`- Generated: ${s(report.generated_at)}`);
  lines.push("");
  lines.push("## Recommendation");
  if (report.is_tie) {
    lines.push(`Effective tie. ${s(report.tie_reason ?? "")}`);
    if (report.material_tradeoff) lines.push(`Material trade-off: ${s(report.material_tradeoff)}`);
  } else if (report.recommended_provider_id) {
    const top = report.scores.find((x) => x.provider_id === report.recommended_provider_id);
    lines.push(
      `Recommended: ${s(report.recommended_provider_id)} (score ${top?.score ?? "n/a"}).`,
    );
    if (report.runner_up_provider_id) {
      lines.push(`Runner-up: ${s(report.runner_up_provider_id)}.`);
    }
  } else {
    lines.push("Pending — insufficient audited quotes.");
  }
  lines.push("");
  lines.push("## Scores");
  lines.push("| Provider | Score | Comparable total | Hard fail | Audit flags |");
  lines.push("|---|---|---|---|---|");
  for (const sc of report.scores) {
    lines.push(
      `| ${s(sc.provider_id)} | ${sc.score} | ${
        sc.comparable_total ?? "n/a"
      } | ${sc.hard_failed ? s(sc.hard_fail_reason ?? "yes") : "no"} | ${
        (sc.audit_flags ?? []).map((f) => s(f.code)).join(", ") || "none"
      } |`,
    );
  }
  lines.push("");
  lines.push("## Next human action");
  lines.push(s(report.next_human_action));
  return lines.join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const url = new URL(req.url);
  const caseId = extractCaseId(url);
  if (!caseId) return error("case_id is required", 400);

  const admin = supabaseAdmin();

  // Serve a previously persisted report + markdown if present.
  const { data: stored } = await admin
    .from("reports")
    .select("report_json, report_markdown")
    .eq("case_id", caseId)
    .maybeSingle();
  if (stored?.report_json) {
    const md = stored.report_markdown ??
      renderReportMarkdown(stored.report_json as unknown as RankedReport);
    return json({ report: stored.report_json, markdown: md });
  }

  // Otherwise compute deterministically from AUDITED quotes.
  const { data: caseRow } = await admin
    .from("cases")
    .select("current_version")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return error("case not found", 404);

  const { data: verRow } = await admin
    .from("case_versions")
    .select("case_spec_json")
    .eq("case_id", caseId)
    .eq("version", caseRow.current_version)
    .maybeSingle();
  if (!verRow) return error("confirmed CaseSpec not found", 404);
  const spec = verRow.case_spec_json as unknown as CaseSpec;

  const { data: quoteRows } = await admin
    .from("quotes")
    .select("quote_json")
    .eq("case_id", caseId)
    .eq("case_spec_version", caseRow.current_version)
    .eq("audit_status", "AUDITED");
  const quotes: QuoteResult[] = (quoteRows ?? []).map((r) => r.quote_json as unknown as QuoteResult);

  if (quotes.length < 2) {
    return json({ report: null, markdown: null, note: "Fewer than two audited quotes." });
  }

  const report = rankProviders(
    quotes,
    spec,
    vertical.ranking.weights as unknown as Parameters<typeof rankProviders>[2],
  );
  if (!report.generated_at) report.generated_at = new Date().toISOString();
  const markdown = renderReportMarkdown(report);

  await admin.from("reports").upsert(
    { case_id: caseId, report_json: report, report_markdown: markdown, created_at: report.generated_at },
    { onConflict: "case_id" },
  );

  return json({ report, markdown });
});
