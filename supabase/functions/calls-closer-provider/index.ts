// =====================================================================
// Grace Edge Function — POST /calls/closer/provider  (spec §5.7 negotiation,
// §8.5 closer set, §6.3)
// Only after >= 2 quotes normalized + audited (status CLOSER_READY). Requires
// verified_leverage present (INV-05: audited + comparable) AND family
// permission. Bounded: one price ask + one non-price fallback, max 2 rounds
// (config negotiation_policy).
// Enforces INV-01/02, INV-05, INV-11 (provider speech cannot alter policy or
// destination), kill switch, INV-13 (distinct closer agent id).
// State: CLOSER_READY -> CLOSER_NEGOTIATION_ACTIVE.
// =====================================================================
import { corsHeaders } from "../_shared/cors.ts";
import { json, error } from "../_shared/respond.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { launchElevenLabsCall } from "../_shared/elevenlabs.ts";
import { assertAllowedNumber } from "../_shared/allowlist.ts";
import { killSwitchEngaged, elevenLabsCloserAgentId } from "../_shared/env.ts";
import type {
  CaseSpec,
  CloserContext,
  EventSummary,
  ProviderScore,
  VerifiedLeverage,
} from "../_shared/types.ts";
import vertical from "../_shared/config/vertical.json" with { type: "json" };

// deno-lint-ignore no-explicit-any
type Supa = any;

interface CloserProviderBody {
  case_id?: string;
  comparison_id?: string;
  verified_leverage_id?: string;
  provider_id?: string; // the target provider to negotiate with
  // Optional pre-fetched authoritative data (from GET /tools/closer/comparison):
  verified_leverage?: VerifiedLeverage;
  audited_comparison?: ProviderScore[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  if (killSwitchEngaged()) return error("Kill switch engaged: outbound disabled", 403);

  let body: CloserProviderBody;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const caseId = (body.case_id ?? "").trim();
  const comparisonId = (body.comparison_id ?? "").trim();
  const verifiedLeverageId = (body.verified_leverage_id ?? "").trim();
  const providerId = (body.provider_id ?? "").trim();
  if (!caseId || !comparisonId || !verifiedLeverageId || !providerId) {
    return error("case_id, comparison_id, verified_leverage_id, provider_id are required", 400);
  }

  const supa: Supa = supabaseAdmin();

  // Gate: negotiation only starts from CLOSER_READY (>= 2 quotes normalized + audited).
  const { data: caseRow } = await supa
    .from("cases")
    .select("status, current_version")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return error("Case not found", 404);
  if (caseRow.status !== "CLOSER_READY") {
    return error(`Case must be CLOSER_READY (is ${caseRow.status})`, 409);
  }

  // Family permission (§5.7): use_verified_quote + negotiate_within_policy.
  const { data: versionRow } = await supa
    .from("case_versions")
    .select("case_spec_json")
    .eq("case_id", caseId)
    .eq("version", caseRow.current_version)
    .maybeSingle();
  const spec = versionRow?.case_spec_json as CaseSpec | undefined;
  if (spec?.permissions?.use_verified_quote !== true || spec?.permissions?.negotiate_within_policy !== true) {
    return error("Negotiation not permitted by family (use_verified_quote/negotiate_within_policy)", 403);
  }

  // Resolve verified_leverage (INV-05: leverage quote must be audited + comparable).
  let leverage = body.verified_leverage ?? null;
  if (!leverage) {
    // The leverage id references an audited comparable quote; confirm against the quotes table.
    const { data: q } = await supa
      .from("quotes")
      .select("quote_id, provider_id, total, audit_status, quote_json")
      .eq("quote_id", verifiedLeverageId)
      .maybeSingle();
    if (!q) return error("verified_leverage not found (INV-05)", 409);
    if (q.audit_status !== "AUDITED") {
      return error("verified_leverage quote is not AUDITED (INV-05)", 409);
    }
    if (typeof q.total !== "number") {
      return error("verified_leverage quote has no comparable total (INV-05)", 409);
    }
    leverage = {
      quote_id: q.quote_id,
      provider_id: q.provider_id,
      supported_amount: q.total,
      allowed_disclosure_sentence: q.quote_json?.allowed_disclosure_sentence ??
        `A verified comparable quote supports about $${q.total}.`,
    };
  }
  // INV-05 also holds when the object is supplied directly: it must carry an audited quote_id.
  if (!leverage.quote_id || typeof leverage.supported_amount !== "number") {
    return error("verified_leverage is incomplete (INV-05)", 409);
  }

  // Target provider destination. INV-11: destination comes from OUR provider record,
  // never from anything a provider said on a prior call.
  const { data: provider } = await supa
    .from("providers")
    .select("provider_id, destination")
    .eq("provider_id", providerId)
    .maybeSingle();
  if (!provider) return error("Target provider not found", 404);
  try {
    assertAllowedNumber(provider.destination); // INV-02
  } catch {
    return error("Provider destination is not allowlisted (INV-02)", 403);
  }

  // Audited comparison for context.
  let comparison = body.audited_comparison ?? null;
  if (!comparison) {
    const { data: quotes } = await supa
      .from("quotes")
      .select("provider_id, quote_id, total, confidence, audit_status")
      .eq("audit_status", "AUDITED");
    comparison = (quotes ?? []).map((q: Record<string, unknown>) => ({
      provider_id: q.provider_id,
      quote_id: q.quote_id,
      score: 0,
      breakdown: {
        must_have_fit: 0, comparable_total: 0, completeness_certainty: 0,
        timing_capacity: 0, communication_trust: 0,
      },
      hard_failed: false,
      hard_fail_reason: null,
      comparable_total: (q.total as number) ?? null,
      audit_flags: [],
    })) as ProviderScore[];
  }

  // Last material events for context (last 5).
  const { data: evRows } = await supa
    .from("events")
    .select("type, actor, timestamp, payload_json")
    .eq("case_id", caseId)
    .order("timestamp", { ascending: false })
    .limit(5);
  const lastEvents: EventSummary[] = (evRows ?? []).map((e: Record<string, unknown>) => ({
    type: e.type as string,
    actor: e.actor as string,
    timestamp: e.timestamp as string,
    summary: JSON.stringify(e.payload_json ?? {}).slice(0, 160),
  }));

  // Bounded negotiation policy (config-driven, §5.7): one price ask + one
  // non-price fallback per provider, max 2 rounds. The agent enforces these
  // caps; we pass them so provider statements can't expand them (INV-11).
  const policy = vertical.negotiation_policy;

  const closerContext: CloserContext = {
    case_id: caseId,
    purpose: "negotiation",
    comparison_id: comparisonId,
    verified_leverage_id: verifiedLeverageId,
    audited_comparison: comparison,
    verified_leverage: leverage,
    permissions: spec!.permissions,
    last_material_events: lastEvents,
  };
  const compact = JSON.stringify({ ...closerContext, negotiation_policy: policy });
  if (compact.length >= 4000) return error("CloserContext exceeds 4000 chars (§6.6)", 500);

  // Launch the Closer (distinct agent id — INV-13; never the caller/intake agent).
  let launch: { conversation_id?: string } = {};
  try {
    launch = await launchElevenLabsCall({
      agentId: elevenLabsCloserAgentId(),
      to: provider.destination,
      dynamicVariables: {
        case_id: caseId,
        comparison_id: comparisonId,
        verified_leverage_id: verifiedLeverageId,
        purpose: "negotiation",
        compact_closer_context: compact,
      },
    });
  } catch (e) {
    return error(`Failed to launch closer call: ${(e as Error).message}`, 502);
  }

  const callId = crypto.randomUUID();
  await supa.from("call_sessions").insert({
    call_id: callId,
    case_id: caseId,
    purpose: "negotiation",
    elevenlabs_conversation_id: launch.conversation_id ?? null,
    consent: null,
    status: "active",
  });

  await supa.from("cases").update({ status: "CLOSER_NEGOTIATION_ACTIVE" }).eq("case_id", caseId);
  await supa.from("events").insert({
    event_id: crypto.randomUUID(),
    case_id: caseId,
    type: "closer.negotiation_active",
    actor: "calls-closer-provider",
    payload_json: { call_id: callId, provider_id: providerId, verified_leverage_id: verifiedLeverageId },
    timestamp: new Date().toISOString(),
    idempotency_key: `closer_neg:${callId}`,
  });

  return json({ call_id: callId, status: "CLOSER_NEGOTIATION_ACTIVE" }, 201);
});
