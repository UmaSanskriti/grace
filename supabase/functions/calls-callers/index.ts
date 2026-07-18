// =====================================================================
// Grace Edge Function — POST /calls/callers  (spec §5.2, §8.6, §8.7, §6.3)
// Only after CASE_CONFIRMED. Create three ProviderCallTasks that all
// reference the SAME confirmed case_spec_version + input_hash (INV-03),
// with facts_allowed from the confirmed disclosure allowlist (NOT the raw
// transcript) and questions_required from config/vertical.json. Launch up
// to 3 Grace Caller sessions with Promise.allSettled, concurrency cap 3.
// The Closer is NEVER in this batch (§8.7).
// Enforces INV-01 (call permission), INV-02 (allowlist), INV-03, INV-11,
// kill switch, INV-13 (distinct caller agent id).
// State: CASE_CONFIRMED -> CALLER_BATCH_QUEUED -> CALLER_AGENT_ACTIVE.
// =====================================================================
import { corsHeaders } from "../_shared/cors.ts";
import { json, error } from "../_shared/respond.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { launchElevenLabsCall } from "../_shared/elevenlabs.ts";
import { assertAllowedNumber } from "../_shared/allowlist.ts";
import { hashPhone } from "../_shared/crypto.ts";
import {
  killSwitchEngaged,
  elevenLabsCallerAgentId,
  twilioAccountSid,
  twilioAuthToken,
  twilioPhoneNumberE164,
} from "../_shared/env.ts";
import type { CaseSpec, ProviderCallTask } from "../_shared/types.ts";
import disclosure from "../../../config/disclosure.json" with { type: "json" };
import vertical from "../../../config/vertical.json" with { type: "json" };

// deno-lint-ignore no-explicit-any
type Supa = any;

interface CallersBody {
  case_id?: string;
  consumer_to?: string; // consumer E.164 for the update SMS (from Twilio inbound)
}

/**
 * Build the disclosure allowlist (facts_allowed) from the CONFIRMED CaseSpec.
 * INV: ProviderCallTasks never receive the free-form intake transcript (§4.5);
 * every allowed fact is derived from the frozen spec fields only.
 */
function buildFactsAllowed(spec: CaseSpec): string[] {
  const facts: string[] = [];
  const loc = spec.custody?.current_location_type ?? "hospital";
  if (spec.location?.pickup_zip) facts.push(`${loc} pickup near ZIP ${spec.location.pickup_zip}`);
  if (spec.disposition) facts.push(spec.disposition.replace(/_/g, " "));
  for (const m of spec.must_haves ?? []) facts.push(m);
  const sp = spec.service_preferences ?? {};
  if (sp["ceremony"] === "memorial_later") facts.push("memorial will occur later");
  if (sp["return_of_ashes"] === true) facts.push("return of ashes requested");
  return facts;
}

/** Twilio REST send for the async consumer update SMS. */
async function sendSms(to: string, body: string): Promise<void> {
  const sid = twilioAccountSid();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: twilioPhoneNumberE164(), Body: body });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${sid}:${twilioAuthToken()}`)}`,
    },
    body: form.toString(),
  });
  if (!resp.ok) throw new Error(`Twilio send failed: ${resp.status}`);
}

/** Run tasks with a hard concurrency cap (§8.7). cap=3 here. */
async function runCapped<T, R>(
  items: T[],
  cap: number,
  fn: (t: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += cap) {
    const batch = items.slice(i, i + cap);
    // Promise.allSettled so one provider failure never aborts the others.
    const settled = await Promise.allSettled(batch.map(fn));
    out.push(...settled);
  }
  return out;
  // Sequential fallback: if ElevenLabs batch calling / concurrency is
  // unavailable, call runCapped(tasks, 1, launchOne) to dial strictly one at a time.
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  if (killSwitchEngaged()) return error("Kill switch engaged: outbound disabled", 403);

  let body: CallersBody;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const caseId = (body.case_id ?? "").trim();
  if (!caseId) return error("case_id is required", 400);

  const supa: Supa = supabaseAdmin();

  // Gate: only after CASE_CONFIRMED.
  const { data: caseRow } = await supa
    .from("cases")
    .select("case_id, status, current_version")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return error("Case not found", 404);
  if (caseRow.status !== "CASE_CONFIRMED") {
    return error(`Case must be CASE_CONFIRMED (is ${caseRow.status})`, 409);
  }

  // Load the single confirmed CaseSpec version + input_hash (INV-03: all tasks share these).
  const { data: versionRow } = await supa
    .from("case_versions")
    .select("version, case_spec_json, input_hash, confirmed_at")
    .eq("case_id", caseId)
    .eq("version", caseRow.current_version)
    .maybeSingle();
  if (!versionRow || !versionRow.confirmed_at) {
    return error("No confirmed CaseSpec version to dispatch (INV-03)", 409);
  }
  const spec = versionRow.case_spec_json as CaseSpec;

  // INV-01: family must have granted call permission in the confirmed spec.
  if (spec.permissions?.call !== true) {
    return error("consent.call=false: provider calls not permitted (INV-01)", 403);
  }

  const caseSpecVersion: number = versionRow.version;
  const inputHash: string = versionRow.input_hash; // shared by all three tasks (INV-03)
  const factsAllowed = buildFactsAllowed(spec); // disclosure allowlist, NOT the transcript
  const questionsRequired = vertical.questions_required as string[];
  const negotiationPolicyId = vertical.negotiation_policy.policy_id;

  // Load up to three allowlisted demo providers.
  const { data: providers } = await supa
    .from("providers")
    .select("provider_id, destination, persona_id, allowlisted")
    .eq("allowlisted", true)
    .limit(3);
  if (!providers || providers.length === 0) {
    return error("No allowlisted providers configured", 409);
  }

  // Build ProviderCallTasks (purpose ALWAYS initial_quote; Closer never here — §8.7).
  const tasks: (ProviderCallTask & { destination_e164: string })[] = [];
  for (const p of providers) {
    // INV-02: every destination must be allowlisted.
    try {
      assertAllowedNumber(p.destination);
    } catch {
      continue; // skip a non-allowlisted provider rather than dial it
    }
    const task: ProviderCallTask = {
      task_id: crypto.randomUUID(),
      case_id: caseId,
      provider_id: p.provider_id,
      case_spec_version: caseSpecVersion, // INV-03
      purpose: "initial_quote",
      destination_e164: p.destination,
      facts_allowed: factsAllowed, // INV-11: fixed here; provider speech cannot alter it
      questions_required: questionsRequired,
      verified_leverage: null, // no leverage in the initial batch (INV-05 applies to Closer only)
      negotiation_policy_id: negotiationPolicyId,
      transcription_policy: "announce_and_affirmative_consent",
    };
    tasks.push(task);
  }
  if (tasks.length === 0) return error("No allowlisted provider destinations (INV-02)", 403);

  // Persist tasks (all referencing the one confirmed version+hash — INV-03).
  for (const t of tasks) {
    await supa.from("provider_call_tasks").insert({
      task_id: t.task_id,
      provider_id: t.provider_id,
      case_version: caseSpecVersion,
      task_json: { ...t, input_hash: inputHash },
      attempt: 1,
      status: "queued",
    });
  }

  // Transition CASE_CONFIRMED -> CALLER_BATCH_QUEUED.
  await supa.from("cases").update({ status: "CALLER_BATCH_QUEUED" }).eq("case_id", caseId);
  await supa.from("events").insert({
    event_id: crypto.randomUUID(),
    case_id: caseId,
    type: "caller.batch_queued",
    actor: "calls-callers",
    payload_json: { task_ids: tasks.map((t) => t.task_id), case_spec_version: caseSpecVersion, input_hash: inputHash },
    timestamp: new Date().toISOString(),
    idempotency_key: `batch_queued:${caseId}:${caseSpecVersion}`,
  });

  // Launch up to 3 Caller sessions, concurrency cap 3, Promise.allSettled (§8.7).
  const settled = await runCapped(tasks, 3, async (t) => {
    // App B.1 dynamic variables (caller set, §8.5).
    const launch = await launchElevenLabsCall({
      agentId: elevenLabsCallerAgentId(), // INV-13: distinct caller agent id (never the Closer)
      to: t.destination_e164,
      dynamicVariables: {
        case_id: caseId,
        task_id: t.task_id,
        provider_id: t.provider_id,
        purpose: "initial_quote",
        compact_task_json: JSON.stringify(t),
      },
    });
    const callId = crypto.randomUUID();
    await supa.from("call_sessions").insert({
      call_id: callId,
      case_id: caseId,
      purpose: "initial_quote",
      elevenlabs_conversation_id: launch?.conversation_id ?? null,
      consent: null, // affirmative consent captured at call start (announce_and_affirmative_consent)
      status: "active",
    });
    await supa.from("provider_call_tasks").update({ status: "launched" }).eq("task_id", t.task_id);
    return { task_id: t.task_id, provider_id: t.provider_id, call_id: callId };
  });

  const launched = settled.filter((s) => s.status === "fulfilled").length;
  const failed = settled.length - launched;

  // Transition -> CALLER_AGENT_ACTIVE if at least one launched.
  if (launched > 0) {
    await supa.from("cases").update({ status: "CALLER_AGENT_ACTIVE" }).eq("case_id", caseId);
    await supa.from("events").insert({
      event_id: crypto.randomUUID(),
      case_id: caseId,
      type: "caller.agent_active",
      actor: "calls-callers",
      payload_json: { launched, failed },
      timestamp: new Date().toISOString(),
      idempotency_key: `caller_active:${caseId}:${caseSpecVersion}`,
    });
  }

  // Consumer update SMS 'after_call_launch' (§4.6). Requires the consumer E.164;
  // passed in by twilio-sms so we avoid decrypting phones at rest.
  const consumerTo = (body.consumer_to ?? "").trim();
  if (consumerTo) {
    try {
      assertAllowedNumber(consumerTo); // INV-02
      const { data: participant } = await supa
        .from("participants")
        .select("phone_hash")
        .eq("case_id", caseId)
        .eq("role", "consumer")
        .maybeSingle();
      // Only text the verified consumer number for this case.
      if (participant?.phone_hash === await hashPhone(consumerTo)) {
        await sendSms(consumerTo, disclosure.messages.consumer_updates.after_call_launch);
        await supa.from("messages").insert({
          message_id: crypto.randomUUID(),
          case_id: caseId,
          direction: "outbound",
          channel: "sms",
          provider_id: null,
          body: disclosure.messages.consumer_updates.after_call_launch,
          status: "sent",
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Non-fatal: the calls are already launching.
    }
  }

  return json({ status: "CALLER_AGENT_ACTIVE", launched, failed, task_ids: tasks.map((t) => t.task_id) }, 201);
});
