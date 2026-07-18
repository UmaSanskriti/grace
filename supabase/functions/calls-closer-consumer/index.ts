// =====================================================================
// Grace Edge Function — POST /calls/closer/consumer  (spec §5.7, §4.6 tie,
// §8.5 closer consumer mode, §6.3)
// Launch the Grace Closer Agent in consumer_explanation mode to walk the
// family through the deterministic ranked report (or explain a tie).
// Enforces INV-01 (voice consent), INV-02 (allowlist), kill switch,
// INV-13 (distinct closer agent id).
// State: REPORT_READY -> CLOSER_CONSUMER_CALL_ACTIVE.
// =====================================================================
import { corsHeaders } from "../_shared/cors.ts";
import { json, error } from "../_shared/respond.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { launchElevenLabsCall } from "../_shared/elevenlabs.ts";
import { assertAllowedNumber } from "../_shared/allowlist.ts";
import { hashPhone } from "../_shared/crypto.ts";
import { killSwitchEngaged, elevenLabsCloserAgentId } from "../_shared/env.ts";
import type { CaseSpec, CloserContext, RankedReport } from "../_shared/types.ts";

// deno-lint-ignore no-explicit-any
type Supa = any;

interface CloserConsumerBody {
  case_id?: string;
  consumer_to?: string; // consumer E.164 (from Twilio inbound; avoids decrypt-at-rest)
  comparison_id?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  if (killSwitchEngaged()) return error("Kill switch engaged: outbound disabled", 403);

  let body: CloserConsumerBody;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const caseId = (body.case_id ?? "").trim();
  const to = (body.consumer_to ?? "").trim();
  if (!caseId || !to) return error("case_id and consumer_to are required", 400);

  // INV-02: allowlist.
  try {
    assertAllowedNumber(to);
  } catch {
    return error("Destination is not allowlisted (INV-02)", 403);
  }

  const supa: Supa = supabaseAdmin();

  // Gate: a ranked report must exist.
  const { data: caseRow } = await supa
    .from("cases")
    .select("status, current_version")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return error("Case not found", 404);
  if (caseRow.status !== "REPORT_READY") {
    return error(`Case must be REPORT_READY (is ${caseRow.status})`, 409);
  }

  // Verify destination belongs to the case consumer + INV-01 voice consent + INV-10 not revoked.
  const { data: participant } = await supa
    .from("participants")
    .select("participant_id, phone_hash")
    .eq("case_id", caseId)
    .eq("role", "consumer")
    .maybeSingle();
  if (!participant || participant.phone_hash !== await hashPhone(to)) {
    return error("Destination does not match the case consumer", 403);
  }
  const { data: consentRow } = await supa
    .from("consents")
    .select("ai_voice_opt_in, revoked_at")
    .eq("participant_id", participant.participant_id)
    .maybeSingle();
  if (consentRow?.revoked_at) return error("Contact revoked (INV-10)", 403);
  if (consentRow?.ai_voice_opt_in !== true) return error("Voice consent not on file (INV-01)", 403);

  // Load report + spec for the compact explanation context.
  const { data: reportRow } = await supa
    .from("reports")
    .select("report_json")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const report = reportRow?.report_json as RankedReport | undefined;
  if (!report) return error("No ranked report to explain", 409);

  const { data: versionRow } = await supa
    .from("case_versions")
    .select("case_spec_json")
    .eq("case_id", caseId)
    .eq("version", caseRow.current_version)
    .maybeSingle();
  const spec = versionRow?.case_spec_json as CaseSpec | undefined;

  const comparisonId = (body.comparison_id ?? report.case_id ?? caseId).toString();

  const closerContext: CloserContext = {
    case_id: caseId,
    purpose: "consumer_explanation",
    comparison_id: comparisonId,
    verified_leverage_id: null, // consumer explanation never negotiates
    audited_comparison: report.scores ?? [],
    verified_leverage: null,
    permissions: spec?.permissions ?? {
      research: true, call: true, mention_budget: false, use_verified_quote: true,
      negotiate_within_policy: true, transcribe_if_all_parties_consent: true,
    },
    last_material_events: [],
  };
  // Include the tie/recommendation facts the agent must explain (§4.6).
  const compact = JSON.stringify({
    ...closerContext,
    report_summary: {
      is_tie: report.is_tie,
      tie_reason: report.tie_reason,
      recommended_provider_id: report.recommended_provider_id,
      runner_up_provider_id: report.runner_up_provider_id,
      material_tradeoff: report.material_tradeoff,
      next_human_action: report.next_human_action,
    },
  });
  if (compact.length >= 4000) return error("CloserContext exceeds 4000 chars (§6.6)", 500);

  let launch: { conversation_id?: string } = {};
  try {
    launch = await launchElevenLabsCall({
      agentId: elevenLabsCloserAgentId(), // INV-13: distinct closer agent id
      to,
      dynamicVariables: {
        case_id: caseId,
        comparison_id: comparisonId,
        verified_leverage_id: "", // none in consumer mode
        purpose: "consumer_explanation",
        compact_closer_context: compact,
      },
    });
  } catch (e) {
    return error(`Failed to launch consumer explanation call: ${(e as Error).message}`, 502);
  }

  const callId = crypto.randomUUID();
  await supa.from("call_sessions").insert({
    call_id: callId,
    case_id: caseId,
    purpose: "consumer_explanation",
    elevenlabs_conversation_id: launch.conversation_id ?? null,
    consent: true,
    status: "active",
  });

  await supa.from("cases").update({ status: "CLOSER_CONSUMER_CALL_ACTIVE" }).eq("case_id", caseId);
  await supa.from("events").insert({
    event_id: crypto.randomUUID(),
    case_id: caseId,
    type: "closer.consumer_call_active",
    actor: "calls-closer-consumer",
    payload_json: { call_id: callId, is_tie: report.is_tie },
    timestamp: new Date().toISOString(),
    idempotency_key: `closer_consumer:${callId}`,
  });

  return json({ call_id: callId, status: "CLOSER_CONSUMER_CALL_ACTIVE" }, 201);
});
