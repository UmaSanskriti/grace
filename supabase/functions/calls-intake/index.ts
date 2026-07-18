// =====================================================================
// Grace Edge Function — POST /calls/intake  (spec §4.2 CALL, §6.6, §3.4, §6.3)
// Launch the Grace Intake Agent with a compact precomputed IntakeContext
// (< 4000 chars). Call launch must be < 10s: no web search, context built
// from the DB only.
// Enforces INV-01 (voice consent), INV-02 (allowlist), kill switch (§10),
// INV-13 (distinct intake agent id). State: -> INTAKE_AGENT_ACTIVE.
// =====================================================================
import { corsHeaders } from "../_shared/cors.ts";
import { json, error } from "../_shared/respond.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { launchElevenLabsCall } from "../_shared/elevenlabs.ts";
import { assertAllowedNumber } from "../_shared/allowlist.ts";
import { hashPhone } from "../_shared/crypto.ts";
import { killSwitchEngaged, elevenLabsIntakeAgentId } from "../_shared/env.ts";
import type { CaseSpec, IntakeContext } from "../_shared/types.ts";

interface IntakeBody {
  case_id?: string;
  to?: string; // consumer E.164 (from the Twilio inbound webhook; avoids decrypt-at-rest)
}

/** Fields that still need to be resolved before the confirmation gate. */
function unresolvedFields(spec: CaseSpec | null): string[] {
  if (!spec) {
    return [
      "urgency_custody", "authority", "disposition", "service_preferences",
      "must_haves", "location", "cost_posture", "permissions",
    ];
  }
  const out = [...(spec.unknowns ?? [])];
  if (!spec.disposition) out.push("disposition");
  if (!spec.location?.pickup_zip) out.push("location.pickup_zip");
  if (spec.authority?.confirmed_for_demo !== true) out.push("authority");
  if (!spec.must_haves?.length) out.push("must_haves");
  return [...new Set(out)];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  // Kill switch (§10): no outbound calls when DEMO_MODE!=true.
  if (killSwitchEngaged()) return error("Kill switch engaged: outbound disabled", 403);

  let body: IntakeBody;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const caseId = (body.case_id ?? "").trim();
  const to = (body.to ?? "").trim();
  if (!caseId || !to) return error("case_id and to are required", 400);

  // INV-02: destination must be allowlisted.
  try {
    assertAllowedNumber(to);
  } catch {
    return error("Destination is not allowlisted (INV-02)", 403);
  }

  const supa = supabaseAdmin();

  // Verify the destination belongs to this case's consumer participant, and
  // check INV-01 (voice consent). Destination integrity is fixed by our records,
  // never by any external input (INV-11 spirit).
  const { data: participant } = await supa
    .from("participants")
    .select("participant_id, phone_hash")
    .eq("case_id", caseId)
    .eq("role", "consumer")
    .maybeSingle();
  if (!participant) return error("No consumer participant for case", 404);
  if (participant.phone_hash !== await hashPhone(to)) {
    return error("Destination does not match the case participant", 403);
  }

  const { data: consentRow } = await supa
    .from("consents")
    .select("ai_voice_opt_in, revoked_at")
    .eq("participant_id", participant.participant_id)
    .maybeSingle();
  if (consentRow?.revoked_at) return error("Contact revoked (INV-10)", 403);
  // INV-01: no voice call without recorded consent.
  if (consentRow?.ai_voice_opt_in !== true) {
    return error("Voice-call consent not on file (INV-01)", 403);
  }

  // Build the compact IntakeContext from the latest draft version (precomputed; §6.6).
  const { data: versionRow } = await supa
    .from("case_versions")
    .select("case_spec_json, version")
    .eq("case_id", caseId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const draft = (versionRow?.case_spec_json ?? null) as CaseSpec | null;
  const caseVersion = versionRow?.version ?? 0;

  const intakeContext: IntakeContext = {
    case_id: caseId,
    purpose: "consumer_intake",
    case_version: caseVersion,
    case_spec_draft: (draft ?? {
      case_id: caseId,
      version: 0,
      mode: "at_need",
      jurisdiction: { country: "US", state: "CA" },
      location: { pickup_zip: null, search_radius_miles: 25 },
      custody: { current_location_type: null, transfer_deadline_at: null },
      authority: { confirmed_for_demo: false, role: null },
      disposition: null,
      must_haves: [],
      service_preferences: {},
      cost_posture: "balanced",
      budget_user_stated: null, // INV-04: never inferred
      benefits_to_check: [],
      permissions: {
        research: true, call: true, mention_budget: false, use_verified_quote: true,
        negotiate_within_policy: true, transcribe_if_all_parties_consent: true,
      },
      facts_disallowed: ["cause_of_death", "social_security_number", "payment_data"],
      unknowns: [],
      confirmed_at: null,
    }) as CaseSpec,
    unresolved_fields: unresolvedFields(draft),
  };

  const intakeContextStr = JSON.stringify(intakeContext);
  // §6.6: keep compact contexts < 4000 chars.
  if (intakeContextStr.length >= 4000) {
    return error("IntakeContext exceeds 4000 chars; trim draft/unknowns", 500);
  }

  // Launch immediately (< 10s). Dynamic variables per §8.5 (intake set).
  let launch: { conversation_id?: string } = {};
  try {
    launch = await launchElevenLabsCall({
      agentId: elevenLabsIntakeAgentId(), // INV-13: distinct intake agent id
      to,
      dynamicVariables: {
        case_id: caseId,
        purpose: "consumer_intake",
        case_version: String(caseVersion),
        intake_context: intakeContextStr,
      },
    });
  } catch (e) {
    return error(`Failed to launch intake call: ${(e as Error).message}`, 502);
  }

  const callId = crypto.randomUUID();
  await supa.from("call_sessions").insert({
    call_id: callId,
    case_id: caseId,
    purpose: "consumer_intake",
    elevenlabs_conversation_id: launch.conversation_id ?? null,
    consent: true,
    status: "active",
  });

  // Transition -> INTAKE_AGENT_ACTIVE.
  await supa.from("cases").update({ status: "INTAKE_AGENT_ACTIVE" }).eq("case_id", caseId);
  await supa.from("events").insert({
    event_id: crypto.randomUUID(),
    case_id: caseId,
    type: "intake.agent_active",
    actor: "calls-intake",
    payload_json: { call_id: callId, conversation_id: launch.conversation_id ?? null },
    timestamp: new Date().toISOString(),
    idempotency_key: `intake_active:${callId}`,
  });

  return json({ call_id: callId, status: "INTAKE_AGENT_ACTIVE" }, 201);
});
