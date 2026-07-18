// =====================================================================
// Grace — Twilio status callback webhook
// Endpoint: POST /webhooks/twilio-status  (spec §6.3, §6.7)
// Owner: task 8. Idempotent delivery / call-status updates.
//
// Invariants enforced here:
//   §6.7    X-Twilio-Signature validated before processing; idempotency keyed on
//           MessageSid/CallSid + status.
//   INV-09  status only — no audio/recording is ever fetched or stored.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { verifyTwilioSignature } from "../_shared/twilio.ts";
import { ensureIdempotent } from "../_shared/idempotency.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  // ---- §6.7: validate the Twilio signature before touching any data. ----
  const ok = await verifyTwilioSignature(req);
  if (!ok) return error("Invalid X-Twilio-Signature", 401);

  const form = await req.formData();
  const messageSid = (form.get("MessageSid") ?? form.get("SmsSid")) as string | null;
  const callSid = form.get("CallSid") as string | null;
  const messageStatus = (form.get("MessageStatus") ?? form.get("SmsStatus")) as string | null;
  const callStatus = form.get("CallStatus") as string | null;

  const sid = messageSid ?? callSid;
  const status = messageStatus ?? callStatus;
  if (!sid || !status) return error("Missing SID or status", 400);

  // ---- §6.7: idempotency on SID + status (a given status arrives once). ----
  const fresh = await ensureIdempotent(`twilio:${sid}:${status}`);
  if (!fresh) return json({ status: "duplicate_ignored" });

  const admin = supabaseAdmin();

  if (messageSid) {
    // Delivery status update for an outbound/inbound SMS.
    await admin.from("messages").update({ status }).eq("twilio_sid", messageSid);
  }
  if (callSid) {
    // Voice call status update. INV-09: no recording is requested or stored.
    await admin.from("call_sessions").update({ status }).eq("twilio_sid", callSid);
  }

  return json({ status: "ok", sid, updated_status: status });
});
