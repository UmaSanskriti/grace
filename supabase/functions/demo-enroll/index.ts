// =====================================================================
// Grace Edge Function — POST /demo/enroll  (spec §4.1 entry & consent, §6.3)
// Validate allowlist, store consent, create case, send the exact first
// preference SMS. State: NEW -> CONSENTED -> PREFERENCE_SMS_SENT.
// Enforces INV-02 (allowlist), INV-01 (voice consent recorded up front),
// kill switch (§10), phone encryption at rest (§10 PII).
// =====================================================================
import { corsHeaders } from "../_shared/cors.ts";
import { json, error } from "../_shared/respond.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { assertAllowedNumber } from "../_shared/allowlist.ts";
import { encryptPhone, hashPhone } from "../_shared/crypto.ts";
import {
  killSwitchEngaged,
  disclosureVersion,
  demoRetentionHours,
  twilioAccountSid,
  twilioAuthToken,
  twilioPhoneNumberE164,
} from "../_shared/env.ts";
import type { ConsentRecord } from "../_shared/types.ts";
import disclosure from "../../../config/disclosure.json" with { type: "json" };

interface EnrollBody {
  phone_e164?: string;
  sms_opt_in?: boolean;
  ai_voice_opt_in?: boolean;
  transcription_opt_in?: boolean;
  marketing_opt_in?: boolean;
  ip?: string | null;
  user_agent?: string | null;
}

/** Send an SMS via the Twilio REST API (Messages resource). */
async function sendSms(to: string, body: string): Promise<string> {
  const sid = twilioAccountSid();
  const token = twilioAuthToken();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: twilioPhoneNumberE164(), Body: body });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Basic auth: base64(AccountSid:AuthToken)
      authorization: `Basic ${btoa(`${sid}:${token}`)}`,
    },
    body: form.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Twilio send failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.sid ?? "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  // Kill switch (§10): refuse to enroll/contact anyone when DEMO_MODE!=true.
  if (killSwitchEngaged()) return error("Kill switch engaged: outbound disabled", 403);

  let body: EnrollBody;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const phone = (body.phone_e164 ?? "").trim();
  if (!phone) return error("phone_e164 is required", 400);

  // INV-02: destination must be in DEMO_ALLOWED_E164; assertAllowedNumber throws otherwise.
  try {
    assertAllowedNumber(phone);
  } catch {
    return error("Phone number is not allowlisted for the demo (INV-02)", 403);
  }

  // §4.1: all three consents must be affirmatively true to proceed.
  // INV-01 is satisfied downstream because ai_voice_opt_in is required here before any call.
  if (body.sms_opt_in !== true || body.ai_voice_opt_in !== true || body.transcription_opt_in !== true) {
    return error(
      "sms_opt_in, ai_voice_opt_in, and transcription_opt_in must all be true (§4.1)",
      400,
    );
  }

  const supa = supabaseAdmin();
  const now = new Date().toISOString();
  const caseId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  // crypto helpers are async (Web Crypto) — see _shared/crypto.ts header note.
  const phoneHash = await hashPhone(phone);
  const phoneEnc = await encryptPhone(phone);

  // 1) Create case in NEW.
  const purgeAt = new Date(Date.now() + demoRetentionHours() * 3600 * 1000).toISOString();
  {
    const { error: e } = await supa.from("cases").insert({
      case_id: caseId,
      status: "NEW",
      preferred_channel: "unknown",
      current_version: 0,
      created_at: now,
      purge_at: purgeAt, // INV-12: purge at/before this timestamp.
    });
    if (e) return error(`Failed to create case: ${e.message}`, 500);
  }

  // 2) Participant (phone encrypted + hashed at rest; plaintext never stored).
  {
    const { error: e } = await supa.from("participants").insert({
      participant_id: participantId,
      case_id: caseId,
      role: "consumer",
      phone_e164_encrypted: phoneEnc,
      phone_hash: phoneHash,
    });
    if (e) return error(`Failed to create participant: ${e.message}`, 500);
  }

  // 3) Consent record (§4.1). Shape follows the frozen ConsentRecord type (types.ts).
  const consent: ConsentRecord & { participant_id: string } = {
    participant_id: participantId,
    scope: disclosure.consent_fields.scope, // "demo_sms_and_ai_voice"
    phone_hash: phoneHash,
    disclosure_version: disclosureVersion(), // from env (grace-demo-2026-07-18)
    sms_opt_in: true,
    ai_voice_opt_in: true,
    transcription_opt_in: true,
    marketing_opt_in: body.marketing_opt_in === true, // §4.1 default false
    granted_at: now,
    revoked_at: null,
    ip: body.ip ?? null,
    user_agent: body.user_agent ?? null,
  };
  {
    const { error: e } = await supa.from("consents").insert(consent);
    if (e) return error(`Failed to store consent: ${e.message}`, 500);
  }

  // Transition NEW -> CONSENTED.
  await supa.from("cases").update({ status: "CONSENTED" }).eq("case_id", caseId);
  await supa.from("events").insert({
    event_id: crypto.randomUUID(),
    case_id: caseId,
    type: "case.consented",
    actor: "demo-enroll",
    payload_json: { disclosure_version: consent.disclosure_version },
    timestamp: now,
    idempotency_key: `consented:${caseId}`,
  });

  // 4) Send the EXACT first preference SMS (disclosure.json messages.first_sms).
  let messageSid = "";
  try {
    messageSid = await sendSms(phone, disclosure.messages.first_sms);
  } catch (e) {
    return error(`Failed to send preference SMS: ${(e as Error).message}`, 502);
  }

  await supa.from("messages").insert({
    message_id: crypto.randomUUID(),
    case_id: caseId,
    direction: "outbound",
    channel: "sms",
    provider_id: null,
    body: disclosure.messages.first_sms,
    status: "sent",
    timestamp: new Date().toISOString(),
  });

  // Transition CONSENTED -> PREFERENCE_SMS_SENT.
  await supa.from("cases").update({ status: "PREFERENCE_SMS_SENT" }).eq("case_id", caseId);
  await supa.from("events").insert({
    event_id: crypto.randomUUID(),
    case_id: caseId,
    type: "preference_sms.sent",
    actor: "demo-enroll",
    payload_json: { twilio_sid: messageSid },
    timestamp: new Date().toISOString(),
    idempotency_key: `pref_sms:${caseId}`,
  });

  return json({ case_id: caseId, status: "PREFERENCE_SMS_SENT", message_sid: messageSid }, 201);
});
