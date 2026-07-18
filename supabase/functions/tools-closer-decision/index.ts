// =====================================================================
// Grace — Closer tool: record the consumer's decision / follow-up request
// Endpoint: POST /tools/closer/decision  (tool `save_consumer_decision`)
// Called by the Grace Closer Agent in consumer-explanation mode.
//
// Invariants:
//   INV-06  This records ONLY a preference or a request to follow up. It NEVER
//           creates a provider commitment, booking, or payment. Any such intent
//           is rejected. The family always acts directly with the provider.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  let body: {
    case_id?: string;
    preferred_provider_id?: string | null;
    decision?: string; // e.g. "prefers_provider", "wants_followup", "undecided"
    followup_requested?: boolean;
    note?: string;
  };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (!body.case_id) return error("case_id is required", 400);

  // ---- INV-06: no binding action. A "decision" is a preference, not a commitment.
  if (body.decision && /accept|book|commit|pay|purchase|sign|authorize/i.test(body.decision)) {
    return error("INV-06: Grace cannot book, pay, or commit. Record a preference only.", 403);
  }

  const admin = supabaseAdmin();

  // Persist as a non-binding approval-style record + event; never a provider commitment.
  await admin.from("approvals").insert({
    case_id: body.case_id,
    action: "consumer_decision_recorded",
    scope_json: {
      preferred_provider_id: body.preferred_provider_id ?? null,
      decision: body.decision ?? "recorded",
      followup_requested: body.followup_requested ?? false,
      note: body.note ?? null,
    },
  });

  const { error: e } = await admin.from("events").insert({
    case_id: body.case_id,
    type: "consumer_decision",
    actor: "closer_agent",
    payload_json: {
      preferred_provider_id: body.preferred_provider_id ?? null,
      decision: body.decision ?? "recorded",
      followup_requested: body.followup_requested ?? false,
    },
    idempotency_key: `decision:${body.case_id}:${crypto.randomUUID()}`,
  });
  if (e) return error(`Failed to record decision: ${e.message}`, 500);

  await admin.from("cases").update({ status: "CONSUMER_UPDATED" }).eq("case_id", body.case_id);

  return json({ recorded: true, next_state: "CONSUMER_UPDATED" });
});
