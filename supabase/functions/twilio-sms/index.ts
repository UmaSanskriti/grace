// =====================================================================
// Grace Edge Function — POST /twilio/sms  (spec §4.2 routing, App B.2, §6.3)
// Verify Twilio signature, route SMS keywords (TEXT/CALL/STOP/HELP/YES/EDIT/
// SUMMARY) or run a one-question intake text turn.
// Enforces: signature verify (§6.7), INV-10 (STOP blocks later outbound),
// INV-01/02 (no call without voice consent + allowlist), idempotency by
// MessageSid (§7 idempotency keys).
// State touches: PREFERENCE_SMS_SENT->TEXT_INTAKE, ->INTAKE_AGENT_ACTIVE (CALL),
// CASE_DRAFT->CASE_CONFIRMED (YES), REPORT_READY->CONSUMER_TEXT_SUMMARY (SUMMARY).
// =====================================================================
import { corsHeaders } from "../_shared/cors.ts";
import { error } from "../_shared/respond.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { verifyTwilioSignature, twimlMessage } from "../_shared/twilio.ts";
import { ensureIdempotent } from "../_shared/idempotency.ts";
import { assertAllowedNumber } from "../_shared/allowlist.ts";
import { hashPhone } from "../_shared/crypto.ts";
import { graceTextTurn } from "../_shared/openai/functions.ts";
import { appBaseUrl, supabaseServiceRoleKey } from "../_shared/env.ts";
import type { CaseSpec, CaseStatus, RankedReport } from "../_shared/types.ts";
import disclosure from "../../../config/disclosure.json" with { type: "json" };
import vertical from "../../../config/vertical.json" with { type: "json" };

// deno-lint-ignore no-explicit-any
type Supa = any;

/** Persist an outbound SMS row, then return the TwiML reply Response. */
async function reply(supa: Supa, caseId: string | null, text: string): Promise<Response> {
  if (caseId) {
    await supa.from("messages").insert({
      message_id: crypto.randomUUID(),
      case_id: caseId,
      direction: "outbound",
      channel: "sms",
      provider_id: null,
      body: text,
      status: "sent",
      timestamp: new Date().toISOString(),
    });
  }
  return twimlMessage(text);
}

/** Fire an internal orchestration Edge Function (server-to-server). */
function invoke(path: string, payload: unknown): Promise<Response> {
  const key = supabaseServiceRoleKey();
  return fetch(`${appBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify(payload),
  });
}

async function transition(supa: Supa, caseId: string, to: CaseStatus, type: string) {
  await supa.from("cases").update({ status: to }).eq("case_id", caseId);
  await supa.from("events").insert({
    event_id: crypto.randomUUID(),
    case_id: caseId,
    type,
    actor: "twilio-sms",
    payload_json: { to },
    timestamp: new Date().toISOString(),
    idempotency_key: `${type}:${caseId}:${Date.now()}`,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  // 1) Verify the X-Twilio-Signature BEFORE doing anything else (§6.7).
  if (!(await verifyTwilioSignature(req))) {
    return error("Invalid Twilio signature", 403);
  }

  const form = await req.formData();
  const from = String(form.get("From") ?? "").trim();
  const rawBody = String(form.get("Body") ?? "").trim();
  const messageSid = String(form.get("MessageSid") ?? "").trim();

  if (!from || !messageSid) return twimlMessage(""); // malformed; ack silently

  // 2) Idempotency: MessageSid dedupes Twilio retries (returns false if seen).
  if (!(await ensureIdempotent(messageSid))) return twimlMessage("");

  const supa = supabaseAdmin();

  // 3) Find the active (non-CLOSED) case by phone hash. (async — Web Crypto)
  const phoneHash = await hashPhone(from);
  const { data: participant } = await supa
    .from("participants")
    .select("participant_id, case_id")
    .eq("phone_hash", phoneHash)
    .maybeSingle();

  if (!participant) return twimlMessage(""); // unknown sender: never engage (no cold contact)

  const caseId: string = participant.case_id;
  const { data: caseRow } = await supa
    .from("cases")
    .select("case_id, status, preferred_channel, current_version")
    .eq("case_id", caseId)
    .neq("status", "CLOSED")
    .maybeSingle();

  if (!caseRow) return twimlMessage("");

  const keyword = rawBody.toUpperCase();

  // Persist the inbound message.
  await supa.from("messages").insert({
    message_id: crypto.randomUUID(),
    case_id: caseId,
    direction: "inbound",
    channel: "sms",
    provider_id: null,
    body: rawBody,
    status: "received",
    timestamp: new Date().toISOString(),
  });

  // 4) INV-10: once revoked, block all later outbound contact.
  const { data: consentRow } = await supa
    .from("consents")
    .select("revoked_at, ai_voice_opt_in")
    .eq("participant_id", participant.participant_id)
    .maybeSingle();
  const revoked = !!consentRow?.revoked_at;

  if (revoked) {
    // Only informational HELP is answered after revocation; everything else stays silent.
    if (keyword === "HELP") return reply(supa, caseId, disclosure.messages.help);
    return twimlMessage(""); // INV-10: no further outbound
  }

  // ---- Keyword routing (§4.2) ----

  // STOP -> revoke + exactly one confirmation (INV-10).
  if (keyword === "STOP") {
    await supa
      .from("consents")
      .update({ revoked_at: new Date().toISOString() })
      .eq("participant_id", participant.participant_id);
    await transition(supa, caseId, "CLOSED", "contact.revoked");
    return reply(supa, caseId, disclosure.messages.stop_confirmation);
  }

  // HELP -> demo identity + data handling + how to stop.
  if (keyword === "HELP") {
    return reply(supa, caseId, disclosure.messages.help);
  }

  // CALL -> set voice channel + launch Grace Intake Agent immediately.
  if (keyword === "CALL") {
    // INV-01: never launch a voice call without recorded voice consent.
    if (consentRow?.ai_voice_opt_in !== true) {
      return reply(supa, caseId, "I don't have voice-call consent on file, so I'll continue by text. " + disclosure.messages.reask_channel);
    }
    // INV-02: destination must be allowlisted.
    try {
      assertAllowedNumber(from);
    } catch {
      return reply(supa, caseId, "This number is not enabled for calls in the demo.");
    }
    await supa.from("cases").update({ preferred_channel: "voice" }).eq("case_id", caseId);
    // Launch intake by calling our own /calls/intake. `to` is the inbound sender
    // (Twilio provides the E.164 in plaintext) so we never need to decrypt at rest.
    try {
      await invoke("/calls/intake", { case_id: caseId, to: from });
    } catch {
      return reply(supa, caseId, "I hit a problem starting the call. Reply CALL to retry or TEXT to continue by text.");
    }
    return reply(supa, caseId, disclosure.messages.calling_now_ack); // "Calling now."
  }

  // TEXT -> set text channel + send the first one-question intake turn.
  if (keyword === "TEXT") {
    await supa.from("cases").update({ preferred_channel: "text" }).eq("case_id", caseId);
    await transition(supa, caseId, "TEXT_INTAKE", "intake.text_started");
    const firstQ = vertical.intake_questions[0]?.intent ??
      "Has a death occurred, where is your loved one now, and is there a transfer deadline?";
    return reply(supa, caseId, `Thank you. To start: ${firstQ}`);
  }

  // Confirmation gate (§4.5): YES/EDIT only meaningful while awaiting confirmation.
  if (caseRow.status === "CASE_DRAFT" && (keyword === "YES" || keyword === "EDIT")) {
    if (keyword === "YES") {
      // Freeze the CaseSpec version (immutable) via the intake confirm tool,
      // then launch the provider caller batch. Passing consumer_to lets
      // /calls/callers send the consumer update SMS without decrypting at rest.
      try {
        await invoke("/tools/intake/confirm", { case_id: caseId });
        await transition(supa, caseId, "CASE_CONFIRMED", "case.confirmed");
        await invoke("/calls/callers", { case_id: caseId, consumer_to: from });
      } catch {
        return reply(supa, caseId, "I couldn't start the provider calls just now. Please reply YES to retry.");
      }
      return reply(supa, caseId, "Confirmed. I'm contacting providers now and will text you when I have comparable results.");
    }
    // EDIT -> reopen intake for patching.
    await transition(supa, caseId, "TEXT_INTAKE", "case.edit_requested");
    return reply(supa, caseId, "Sure — what would you like to change?");
  }

  // SUMMARY -> only when a ranked report is ready.
  if (keyword === "SUMMARY" && caseRow.status === "REPORT_READY") {
    const { data: reportRow } = await supa
      .from("reports")
      .select("report_json")
      .eq("case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const report = reportRow?.report_json as RankedReport | undefined;
    let summary: string;
    if (!report) {
      summary = "Your ranked results aren't ready yet. I'll text you the moment they are.";
    } else if (report.is_tie) {
      summary = disclosure.messages.consumer_updates.tie;
    } else {
      const top = report.scores?.find((s) => s.provider_id === report.recommended_provider_id);
      const total = top?.comparable_total != null ? `~$${top.comparable_total}` : "an itemized total";
      summary =
        `Recommended: ${report.recommended_provider_id} at ${total} comparable. ` +
        (report.material_tradeoff ? `Trade-off: ${report.material_tradeoff}. ` : "") +
        `Reply CALL to talk it through with the Grace Closer Agent.`;
    }
    await transition(supa, caseId, "CONSUMER_TEXT_SUMMARY", "consumer.summary_sent");
    return reply(supa, caseId, summary.slice(0, 320));
  }

  // ---- Default: one structured intake text turn (§3.4: one OpenAI call, no web search) ----
  const { data: versionRow } = await supa
    .from("case_versions")
    .select("case_spec_json, version")
    .eq("case_id", caseId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const caseSpec = (versionRow?.case_spec_json ?? null) as CaseSpec | null;

  const result = await graceTextTurn({
    case_spec: caseSpec,
    latest_sms: rawBody,
  });

  // Persist any CaseSpec patch through the validated case-patch tool.
  // INV-04: mention_budget is never inferred here; graceTextTurn/the tool enforce it.
  if (result.case_patch) {
    try {
      await invoke("/tools/intake/case-patch", { case_id: caseId, patch: result.case_patch });
    } catch {
      // Non-fatal for the reply; the patch tool logs its own failure.
    }
  }

  // Advance state as directed by the turn (e.g. to CASE_DRAFT for the confirmation gate).
  if (result.next_state && result.next_state !== caseRow.status) {
    await transition(supa, caseId, result.next_state, "intake.turn");
  }

  return reply(supa, caseId, result.reply_sms);
});
