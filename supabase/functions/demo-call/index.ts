// =====================================================================
// Grace — POST /demo-call  (demo driver for the Live Agent Loop buttons)
// Places a REAL call and drives the visible loop:
//   kind="intake"  -> Grace Intake Agent calls the consumer; ensures a case;
//                     status -> INTAKE_AGENT_ACTIVE.
//   kind="caller"  -> Grace Caller Agent calls a funeral-house roleplayer;
//                     creates a ProviderCallTask; status -> CALLER_AGENT_ACTIVE.
// Records a call_sessions row (status='active') so the Agent Loop tab lights
// the right node live. Enforces INV-02 (allowlist) + kill switch.
// =====================================================================

import { corsHeaders } from "../_shared/cors.ts";
import { json, error } from "../_shared/respond.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { launchElevenLabsCall } from "../_shared/elevenlabs.ts";
import { assertAllowedNumber } from "../_shared/allowlist.ts";
import { hashPhone, encryptPhone } from "../_shared/crypto.ts";
import {
  killSwitchEngaged, elevenLabsIntakeAgentId, elevenLabsCallerAgentId,
  disclosureVersion, demoRetentionHours,
} from "../_shared/env.ts";
import type { ProviderCallTask } from "../_shared/types.ts";
import vertical from "../_shared/config/vertical.json" with { type: "json" };

interface Body { kind?: "intake" | "caller"; to?: string; provider_id?: string; case_id?: string }
const PERSONA: Record<string, string> = {
  demo_transparent: "A", demo_package_first: "B", demo_hidden_fee: "C",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);
  if (killSwitchEngaged()) return error("Kill switch engaged: outbound disabled", 403);

  let body: Body;
  try { body = await req.json(); } catch { return error("Invalid JSON body", 400); }

  const kind = body.kind;
  const to = (body.to ?? "").trim();
  if (kind !== "intake" && kind !== "caller") return error("kind must be 'intake' or 'caller'", 400);
  if (!to) return error("to (E.164) is required", 400);
  try { assertAllowedNumber(to); } catch { return error(`${to} is not allowlisted (INV-02)`, 403); }

  const supa = supabaseAdmin();
  const now = new Date().toISOString();

  // -------------------------------------------------- INTAKE (consumer) --------
  if (kind === "intake") {
    let caseId = body.case_id ?? "";
    const phoneHash = await hashPhone(to);

    if (!caseId) {
      const { data: p } = await supa.from("participants")
        .select("case_id").eq("phone_hash", phoneHash).limit(1).maybeSingle();
      if (p?.case_id) caseId = p.case_id;
    }
    if (!caseId) {
      // Create a minimal consented case for this consumer (voice-first demo).
      caseId = crypto.randomUUID();
      const participantId = crypto.randomUUID();
      const purgeAt = new Date(Date.now() + demoRetentionHours() * 3600 * 1000).toISOString();
      await supa.from("cases").insert({
        case_id: caseId, status: "CONSENTED", preferred_channel: "voice",
        current_version: 0, created_at: now, purge_at: purgeAt,
      });
      await supa.from("participants").insert({
        participant_id: participantId, case_id: caseId, role: "consumer",
        phone_e164_encrypted: await encryptPhone(to), phone_hash: phoneHash,
      });
      await supa.from("consents").insert({
        participant_id: participantId, scope: "demo_sms_and_ai_voice", phone_hash: phoneHash,
        disclosure_version: disclosureVersion(), sms_opt_in: true, ai_voice_opt_in: true,
        transcription_opt_in: true, marketing_opt_in: false, granted_at: now, revoked_at: null,
      });
    }

    const callId = crypto.randomUUID();
    const launch = await launchElevenLabsCall({
      agentId: elevenLabsIntakeAgentId(), // INV-13
      to,
      dynamicVariables: {
        case_id: caseId, purpose: "consumer_intake", case_version: "0",
        intake_context: "(live demo intake)",
      },
    });
    await supa.from("call_sessions").insert({
      call_id: callId, case_id: caseId, purpose: "consumer_intake",
      elevenlabs_conversation_id: launch.conversation_id ?? null, consent: true, status: "active",
    });
    await supa.from("cases").update({ status: "INTAKE_AGENT_ACTIVE" }).eq("case_id", caseId);
    await supa.from("events").insert({
      case_id: caseId, type: "intake.call_launched", actor: "demo-call",
      payload_json: { conversation_id: launch.conversation_id, to_last4: to.slice(-4) },
      idempotency_key: `intakecall:${callId}`,
    });
    return json({ case_id: caseId, conversation_id: launch.conversation_id ?? null, status: "INTAKE_AGENT_ACTIVE" }, 201);
  }

  // --------------------------------------------------- CALLER (provider) -------
  const caseId = (body.case_id ?? "").trim();
  if (!caseId) return error("case_id is required for a caller call (run the intake call first)", 400);
  const providerId = body.provider_id ?? "demo_transparent";

  // Ensure a provider row mapped to this roleplayer number (allowlisted).
  await supa.from("providers").upsert({
    provider_id: providerId, type: "demo", label: providerId,
    destination: to, allowlisted: true, persona_id: PERSONA[providerId] ?? "A",
  }, { onConflict: "provider_id" });

  const { data: caseRow } = await supa.from("cases")
    .select("current_version").eq("case_id", caseId).maybeSingle();
  const version = caseRow?.current_version ?? 0;

  const taskId = crypto.randomUUID();
  const task: ProviderCallTask = {
    task_id: taskId, case_id: caseId, provider_id: providerId, case_spec_version: version,
    purpose: "initial_quote", destination_e164: to,
    facts_allowed: [
      "hospital pickup near ZIP 94304", "cremation with private family goodbye",
      "Spanish-language support preferred", "memorial will occur later",
    ],
    questions_required: vertical.questions_required as string[],
    verified_leverage: null, // INV-05: leverage belongs only to the Closer
    negotiation_policy_id: vertical.negotiation_policy.policy_id,
    transcription_policy: "announce_and_affirmative_consent",
  };
  await supa.from("provider_call_tasks").insert({
    task_id: taskId, case_id: caseId, provider_id: providerId, case_version: version,
    task_json: task, attempt: 1, status: "launched",
  });

  const callId = crypto.randomUUID();
  const launch = await launchElevenLabsCall({
    agentId: elevenLabsCallerAgentId(), // INV-13
    to,
    dynamicVariables: {
      case_id: caseId, task_id: taskId, provider_id: providerId,
      purpose: "initial_quote", compact_task_json: JSON.stringify(task),
    },
  });
  await supa.from("call_sessions").insert({
    call_id: callId, case_id: caseId, purpose: "initial_quote", provider_id: providerId,
    elevenlabs_conversation_id: launch.conversation_id ?? null, consent: null, status: "active",
  });
  await supa.from("cases").update({ status: "CALLER_AGENT_ACTIVE" }).eq("case_id", caseId);
  await supa.from("events").insert({
    case_id: caseId, type: "caller.call_launched", actor: "demo-call",
    payload_json: { provider_id: providerId, conversation_id: launch.conversation_id, to_last4: to.slice(-4) },
    idempotency_key: `callercall:${callId}`,
  });
  return json({ case_id: caseId, provider_id: providerId, conversation_id: launch.conversation_id ?? null, status: "CALLER_AGENT_ACTIVE" }, 201);
});
