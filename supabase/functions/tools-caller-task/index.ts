// =====================================================================
// Grace — Caller tool: fetch this session's ProviderCallTask
// Endpoint: GET /tools/caller/task?task_id=...  (tool `get_provider_task`)
// Called by the Grace Caller Agent at the start of a provider session.
//
// Invariants:
//   INV-11  The Caller receives ONLY its one task's facts. verified_leverage is
//           forced null here — leverage belongs solely to the Closer (INV-05).
//   §6.6    Compact context only; never the intake transcript.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { ProviderCallTask } from "../_shared/types.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const taskId = new URL(req.url).searchParams.get("task_id");
  if (!taskId) return error("task_id query param is required", 400);

  const admin = supabaseAdmin();
  const { data: row, error: e } = await admin
    .from("provider_call_tasks")
    .select("task_id, provider_id, case_id, task_json")
    .eq("task_id", taskId)
    .maybeSingle();
  if (e) return error(`DB error loading task: ${e.message}`, 500);
  if (!row) return error("task not found", 404);

  // INV-11: the Caller never receives competitor leverage.
  const task = { ...(row.task_json as ProviderCallTask), verified_leverage: null };
  return json({ task });
});
