// =====================================================================
// Grace — Caller tool: persist one evidence-linked quote line item
// Endpoint: POST /tools/caller/quote-item  (spec §6.3, §5.5, tool `log_quote_item`)
// Owner: task 8. Called by the Grace Caller Agent while the call is active.
//
// Invariants enforced here:
//   INV-08  every material amount carries transcript evidence OR is explicit null.
//           A non-null amount without an EvidenceRef.source is rejected.
//   INV-06  this tool only records data — it never accepts, books, or commits.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { QuoteLineItem } from "../_shared/types.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  let body: { task_id?: string; provider_id?: string; line_item?: QuoteLineItem };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const { task_id, line_item } = body;
  if (!task_id) return error("task_id is required", 400);
  if (!line_item || typeof line_item !== "object") return error("line_item is required", 400);
  if (!line_item.category) return error("line_item.category is required", 400);

  // ---- INV-08: an amount must be evidence-backed or explicitly null/unknown. ----
  const hasAmount = line_item.amount !== null && line_item.amount !== undefined;
  const hasEvidence =
    line_item.source != null &&
    typeof line_item.source.conversation_id === "string" &&
    Number.isInteger(line_item.source.turn_index);
  if (hasAmount && !hasEvidence) {
    return error(
      "INV-08: a non-null amount requires an EvidenceRef (source.conversation_id + turn_index)",
      422,
    );
  }

  const admin = supabaseAdmin();

  // Resolve case + version from the ProviderCallTask (task_json carries case_id).
  const { data: taskRow, error: taskErr } = await admin
    .from("provider_call_tasks")
    .select("task_id, provider_id, case_version, task_json")
    .eq("task_id", task_id)
    .maybeSingle();
  if (taskErr) return error(`DB error loading task: ${taskErr.message}`, 500);
  if (!taskRow) return error("provider_call_task not found", 404);

  const task = (taskRow.task_json ?? {}) as Record<string, any>;
  const caseId: string = task.case_id;
  const providerId: string = body.provider_id ?? taskRow.provider_id ?? task.provider_id;
  const caseVersion: number = taskRow.case_version ?? task.case_spec_version;
  const conversationId: string | null = line_item.source?.conversation_id ?? null;

  // Find-or-create the provisional PENDING quote for this provider + version.
  // Normalization/audit run later in the webhook pipeline; this stays PENDING.
  let quoteId: string;
  const { data: existing } = await admin
    .from("quotes")
    .select("quote_id")
    .eq("case_id", caseId)
    .eq("provider_id", providerId)
    .eq("case_spec_version", caseVersion)
    .eq("audit_status", "PENDING")
    .order("quote_id", { ascending: true })
    .maybeSingle();

  if (existing?.quote_id) {
    quoteId = existing.quote_id;
  } else {
    quoteId = crypto.randomUUID();
    const { error: qErr } = await admin.from("quotes").insert({
      quote_id: quoteId,
      case_id: caseId,
      provider_id: providerId,
      case_spec_version: caseVersion,
      conversation_id: conversationId,
      outcome: "itemized_quote",
      audit_status: "PENDING",
      quote_json: { quote_id: quoteId, provider_id: providerId, line_items: [] },
      total: null,
      confidence: null,
    });
    if (qErr) return error(`DB error creating quote: ${qErr.message}`, 500);
  }

  // Persist the evidence-linked line item (evidence_ref may be null when amount is null).
  const { error: liErr } = await admin.from("quote_line_items").insert({
    quote_id: quoteId,
    category: line_item.category,
    description: line_item.description ?? null,
    amount: hasAmount ? line_item.amount : null,
    required_for_case: line_item.required_for_case === true,
    evidence_ref: line_item.source ?? null,
  });
  if (liErr) return error(`DB error saving line item: ${liErr.message}`, 500);

  await admin.from("events").insert({
    case_id: caseId,
    type: "quote_item_logged",
    actor: "caller_agent",
    payload_json: { quote_id: quoteId, category: line_item.category, has_amount: hasAmount },
    idempotency_key: `qitem:${quoteId}:${line_item.category}:${crypto.randomUUID()}`,
  });

  return json({ logged: true, quote_id: quoteId });
});
