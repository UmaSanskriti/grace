// =====================================================================
// Grace — agent-specific COMPACT context
// Endpoint: GET /cases/{id}/context?purpose=...  (spec §6.3, §6.6)
// Owner: task 8. Selects the agent by ?purpose=.
//
// Invariants enforced here:
//   §6.6    NEVER returns the full transcript ledger; target < 4000 chars/agent.
//   INV-05  Closer leverage is only an AUDITED, comparable quote.
//   INV-13  distinct shape per agent (Intake / Caller / Closer) prevents
//           cross-stage disclosure.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { rankProviders } from "../_shared/ranking/rank.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type {
  CaseSpec,
  EventSummary,
  ProviderCallTask,
  QuoteResult,
  VerifiedLeverage,
} from "../_shared/types.ts";
import vertical from "../../../config/vertical.json" with { type: "json" };

const MAX_CHARS = 4000;

function extractCaseId(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("cases");
  if (idx >= 0 && parts[idx + 1] && parts[idx + 1] !== "context") return parts[idx + 1];
  return url.searchParams.get("case_id") ?? url.searchParams.get("id");
}

function unresolvedFields(spec: Record<string, any>): string[] {
  const u: string[] = [];
  if (!spec.disposition) u.push("disposition");
  if (!spec.authority?.confirmed_for_demo) u.push("authority");
  if (!spec.location?.pickup_zip) u.push("location.pickup_zip");
  if (spec.custody?.current_location_type == null) u.push("custody.current_location_type");
  if (!spec.permissions?.call) u.push("permissions.call");
  if (!spec.permissions?.transcribe_if_all_parties_consent) u.push("permissions.transcription");
  if (!Array.isArray(spec.must_haves) || spec.must_haves.length === 0) u.push("must_haves");
  for (const k of (spec.unknowns as string[]) ?? []) u.push(k);
  return [...new Set(u)];
}

/** Guard §6.6: keep the compact context under the char budget. */
function sizeGuarded(payload: unknown): Response {
  const body = JSON.stringify(payload);
  if (body.length > MAX_CHARS) {
    return json({ ...(payload as Record<string, unknown>), _truncated: true, _size: body.length });
  }
  return json(payload);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const url = new URL(req.url);
  const caseId = extractCaseId(url);
  const purpose = url.searchParams.get("purpose") ?? "consumer_intake";
  if (!caseId) return error("case_id is required", 400);

  const admin = supabaseAdmin();

  const { data: caseRow } = await admin
    .from("cases")
    .select("current_version, status")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return error("case not found", 404);

  // ---------- Intake: draft CaseSpec + unresolved fields ----------
  if (purpose === "consumer_intake") {
    const { data: draft } =
      (await admin
        .from("case_versions")
        .select("version, case_spec_json, confirmed_at")
        .eq("case_id", caseId)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()) ?? {};
    const spec = (draft?.case_spec_json ?? {}) as Record<string, any>;
    return sizeGuarded({
      case_id: caseId,
      purpose: "consumer_intake",
      case_version: draft?.version ?? caseRow.current_version ?? 0,
      case_spec_draft: spec as unknown as CaseSpec,
      unresolved_fields: unresolvedFields(spec),
    });
  }

  // ---------- Caller: exactly ONE ProviderCallTask ----------
  if (purpose === "initial_quote") {
    const taskId = url.searchParams.get("task_id");
    let taskRow: { task_id: string; provider_id: string; task_json: any } | null = null;
    if (taskId) {
      const { data } = await admin
        .from("provider_call_tasks")
        .select("task_id, provider_id, task_json")
        .eq("task_id", taskId)
        .maybeSingle();
      taskRow = data;
    }
    if (!taskRow) return error("task_id required and must resolve to a ProviderCallTask", 400);
    const task = taskRow.task_json as unknown as ProviderCallTask;
    // Caller never receives competitor leverage (§5.4, INV-11): task.verified_leverage is null.
    return sizeGuarded({
      case_id: caseId,
      purpose: "initial_quote",
      task_id: taskRow.task_id,
      provider_id: taskRow.provider_id,
      compact_task_json: JSON.stringify({ ...task, verified_leverage: null }),
    });
  }

  // ---------- Closer: audited comparison + leverage + permissions + last 5 events ----------
  if (purpose === "negotiation" || purpose === "consumer_explanation") {
    const { data: verRow } = await admin
      .from("case_versions")
      .select("case_spec_json, version")
      .eq("case_id", caseId)
      .eq("version", caseRow.current_version)
      .maybeSingle();
    const spec = (verRow?.case_spec_json ?? {}) as unknown as CaseSpec;

    const { data: quoteRows } = await admin
      .from("quotes")
      .select("quote_json")
      .eq("case_id", caseId)
      .eq("case_spec_version", caseRow.current_version)
      .eq("audit_status", "AUDITED"); // §10.3: audited only
    const quotes: QuoteResult[] = (quoteRows ?? []).map((r) => r.quote_json as unknown as QuoteResult);

    let scores: any[] = [];
    let verifiedLeverage: VerifiedLeverage | null = null;
    if (quotes.length > 0) {
      const report = rankProviders(
        quotes,
        spec,
        vertical.ranking.weights as unknown as Parameters<typeof rankProviders>[2],
      );
      scores = report.scores;
      // INV-05: leverage only from an audited, comparable, non-hard-failed quote.
      if (spec.permissions?.use_verified_quote === true) {
        const eligible = report.scores
          .filter((s) => !s.hard_failed && s.quote_id && typeof s.comparable_total === "number")
          .sort((a, b) => a.comparable_total! - b.comparable_total!);
        const best = eligible[0];
        if (best) {
          verifiedLeverage = {
            quote_id: best.quote_id!,
            provider_id: best.provider_id,
            supported_amount: best.comparable_total!,
            allowed_disclosure_sentence:
              `We have a verified itemized quote of $${best.comparable_total!.toLocaleString("en-US")} ` +
              `for the same pickup area, private goodbye, cremation, and return of ashes.`,
          };
        }
      }
    }

    // Last 5 material events (metadata summaries only — NOT the transcript, §6.6).
    const { data: evRows } = await admin
      .from("events")
      .select("type, actor, timestamp, payload_json")
      .eq("case_id", caseId)
      .order("timestamp", { ascending: false })
      .limit(5);
    const lastEvents: EventSummary[] = (evRows ?? []).map((e: any) => ({
      type: e.type,
      actor: e.actor,
      timestamp: e.timestamp,
      summary: typeof e.payload_json?.summary === "string"
        ? e.payload_json.summary
        : e.type.replaceAll("_", " "),
    }));

    return sizeGuarded({
      case_id: caseId,
      purpose,
      comparison_id: `${caseId}:${caseRow.current_version}`,
      verified_leverage_id: verifiedLeverage ? verifiedLeverage.quote_id : null,
      audited_comparison: scores,
      verified_leverage: verifiedLeverage,
      permissions: spec.permissions,
      last_material_events: lastEvents,
    });
  }

  return error(`Unknown purpose: ${purpose}`, 400);
});
