// =====================================================================
// Grace — Caller tool: save the structured call outcome
// Endpoint: POST /tools/caller/finalize  (spec §6.3, §5.5, §5.4)
// Owner: task 8. Serves BOTH `finalize_call_outcome` (itemized_quote) and
// `mark_callback_or_decline` (callback|declined|unavailable|consent_declined) —
// the server branches on `outcome`.
//
// Invariants enforced here:
//   INV-06  no binding action — this only records a structured outcome.
//   INV-07  consent_declined stores NO transcript (handled here + webhook).
//   Normalization is deliberately DEFERRED to the webhook pipeline; the raw
//   structured outcome is persisted with audit_status = PENDING.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { QuoteOutcome } from "../_shared/types.ts";

const OUTCOME_TO_STATE: Record<QuoteOutcome, string> = {
  itemized_quote: "QUOTE_CAPTURED",
  callback: "CALLBACK",
  declined: "DECLINED",
  unavailable: "UNAVAILABLE",
  consent_declined: "DECLINED", // no transcript retained (INV-07)
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const taskId: string | undefined = body.task_id;
  const outcome: QuoteOutcome | undefined = body.outcome;
  if (!taskId) return error("task_id is required", 400);
  if (!outcome || !(outcome in OUTCOME_TO_STATE)) {
    return error("outcome must be itemized_quote|callback|declined|unavailable|consent_declined", 400);
  }

  const admin = supabaseAdmin();

  const { data: taskRow, error: taskErr } = await admin
    .from("provider_call_tasks")
    .select("task_id, provider_id, case_version, task_json, attempt")
    .eq("task_id", taskId)
    .maybeSingle();
  if (taskErr) return error(`DB error loading task: ${taskErr.message}`, 500);
  if (!taskRow) return error("provider_call_task not found", 404);

  const task = (taskRow.task_json ?? {}) as Record<string, any>;
  const caseId: string = task.case_id;
  const providerId: string = body.provider_id ?? taskRow.provider_id ?? task.provider_id;
  const caseVersion: number = taskRow.case_version ?? task.case_spec_version;
  const nextState = OUTCOME_TO_STATE[outcome];

  let quoteId: string | null = null;

  if (outcome === "itemized_quote") {
    // Persist the RAW structured outcome. Line items were streamed via quote-item.
    // Leave normalization/audit to the webhook pipeline => audit_status PENDING.
    const rawOutcome = {
      outcome,
      price_type: body.price_type ?? "estimate",
      currency: body.currency ?? "USD",
      funeral_home_subtotal: body.funeral_home_subtotal ?? null,
      cash_advance_total: body.cash_advance_total ?? null,
      total: body.total ?? null,
      assumptions: body.assumptions ?? [],
      missing_fields: body.missing_fields ?? [],
      written_confirmation: body.written_confirmation ?? "none",
    };

    const { data: existing } = await admin
      .from("quotes")
      .select("quote_id, quote_json")
      .eq("case_id", caseId)
      .eq("provider_id", providerId)
      .eq("case_spec_version", caseVersion)
      .eq("audit_status", "PENDING")
      .order("quote_id", { ascending: true })
      .maybeSingle();

    if (existing?.quote_id) {
      quoteId = existing.quote_id;
      const merged = { ...(existing.quote_json as Record<string, unknown>), ...rawOutcome };
      const { error: upErr } = await admin
        .from("quotes")
        .update({
          quote_json: merged,
          total: rawOutcome.total,
          outcome,
          audit_status: "PENDING",
        })
        .eq("quote_id", quoteId);
      if (upErr) return error(`DB error updating quote: ${upErr.message}`, 500);
    } else {
      quoteId = crypto.randomUUID();
      const { error: insErr } = await admin.from("quotes").insert({
        quote_id: quoteId,
        case_id: caseId,
        provider_id: providerId,
        case_spec_version: caseVersion,
        outcome,
        audit_status: "PENDING",
        quote_json: { quote_id: quoteId, provider_id: providerId, ...rawOutcome },
        total: rawOutcome.total,
        confidence: null,
      });
      if (insErr) return error(`DB error creating quote: ${insErr.message}`, 500);
    }
  } else {
    // Non-quote terminal outcome: record a lightweight quote row for the ledger.
    // consent_declined / declined / unavailable / callback keep no line items.
    quoteId = crypto.randomUUID();
    await admin.from("quotes").insert({
      quote_id: quoteId,
      case_id: caseId,
      provider_id: providerId,
      case_spec_version: caseVersion,
      outcome,
      audit_status: "PENDING",
      quote_json: {
        quote_id: quoteId,
        provider_id: providerId,
        outcome,
        reason: body.reason ?? null,
        callback_at: body.callback_at ?? null,
      },
      total: null,
      confidence: null,
    });
  }

  await admin.from("cases").update({ status: nextState }).eq("case_id", caseId);

  await admin.from("events").insert({
    case_id: caseId,
    type: "caller_outcome_finalized",
    actor: "caller_agent",
    payload_json: { provider_id: providerId, outcome, quote_id: quoteId, next_state: nextState },
    idempotency_key: `finalize:${taskId}:${outcome}`,
  });

  return json({ recorded: true, quote_id: quoteId, next_state: nextState });
});
