// =====================================================================
// Grace — Intake tool: log an intake checkpoint event
// Endpoint: POST /tools/intake/event  (spec §3.2 tool `log_intake_event`)
// Called by the Grace Intake Agent at 3–5 answer checkpoints (§4.3).
//
// Records a lightweight, non-mutating event to the ledger. It never changes the
// CaseSpec, permissions, or state machine (that is patch/confirm's job), so it
// carries no invariant risk. INV-06: no binding action.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  let body: { case_id?: string; label?: string; summary?: string };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (!body.case_id) return error("case_id is required", 400);

  const admin = supabaseAdmin();
  const { error: e } = await admin.from("events").insert({
    case_id: body.case_id,
    type: "intake_checkpoint",
    actor: "intake_agent",
    payload_json: { label: body.label ?? "checkpoint", summary: body.summary ?? null },
    idempotency_key: `intake_event:${body.case_id}:${crypto.randomUUID()}`,
  });
  if (e) return error(`Failed to log intake event: ${e.message}`, 500);

  return json({ logged: true });
});
