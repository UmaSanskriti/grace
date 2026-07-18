// =====================================================================
// Grace — Closer tool: persist a revised price/term
// Endpoint: POST /tools/closer/revision  (spec §6.3, §5.7, tool `log_revised_terms`)
// Owner: task 8. Called by the Grace Closer Agent during bounded negotiation.
//
// Invariants enforced here:
//   INV-06  CANNOT accept or book — this only records a before/after change with
//           transcript evidence. Any "accept"/"book"/"commit" intent is rejected.
//   INV-08  a non-null after_amount requires transcript evidence.
//   INV-11  provider speech is data; it never mutates policy or destination here.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { RevisedTerms } from "../_shared/types.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  let body: RevisedTerms & { action?: string };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const { provider_id, quote_id } = body;
  if (!provider_id) return error("provider_id is required", 400);
  if (!quote_id) return error("quote_id is required", 400);

  // ---- INV-06: no binding action exists. Reject any attempt to accept/book. ----
  if (body.action && /accept|book|commit|select|pay|purchase/i.test(body.action)) {
    return error("INV-06: no binding action (accept/book/commit) is permitted", 403);
  }

  // ---- INV-08: a changed amount must be evidence-backed. ----
  const hasAfter = body.after_amount !== null && body.after_amount !== undefined;
  const hasEvidence =
    body.evidence != null &&
    typeof body.evidence.conversation_id === "string" &&
    Number.isInteger(body.evidence.turn_index);
  if (hasAfter && !hasEvidence) {
    return error("INV-08: after_amount requires transcript evidence (evidence ref)", 422);
  }

  const admin = supabaseAdmin();

  // Resolve the case from the quote (revisions attach to an existing quote).
  const { data: quoteRow, error: qErr } = await admin
    .from("quotes")
    .select("quote_id, case_id, provider_id, quote_json")
    .eq("quote_id", quote_id)
    .maybeSingle();
  if (qErr) return error(`DB error loading quote: ${qErr.message}`, 500);
  if (!quoteRow) return error("quote not found", 404);

  const revised: RevisedTerms = {
    provider_id,
    quote_id,
    before_amount: body.before_amount ?? null,
    after_amount: body.after_amount ?? null,
    changed_category: body.changed_category ?? null,
    term_change: body.term_change ?? null,
    evidence: body.evidence ?? null,
  };

  // A material change (new amount or term) => QUOTE_REVISED; otherwise the round
  // yielded nothing => NEGOTIATION_DECLINED.
  const changed = hasAfter || !!revised.term_change || !!revised.changed_category;
  const nextState = changed ? "QUOTE_REVISED" : "NEGOTIATION_DECLINED";

  // Store the revision on the quote_json (append-only revisions log) + event.
  const qJson = (quoteRow.quote_json as Record<string, any>) ?? {};
  const revisions = Array.isArray(qJson.revisions) ? qJson.revisions : [];
  revisions.push({ ...revised, recorded_at: new Date().toISOString() });
  await admin
    .from("quotes")
    .update({ quote_json: { ...qJson, revisions } })
    .eq("quote_id", quote_id);

  await admin
    .from("cases")
    .update({ status: nextState })
    .eq("case_id", quoteRow.case_id);

  await admin.from("events").insert({
    case_id: quoteRow.case_id,
    type: "revised_terms_logged",
    actor: "closer_agent",
    payload_json: revised as unknown as Record<string, unknown>,
    idempotency_key: `revision:${quote_id}:${crypto.randomUUID()}`,
  });

  return json({ recorded: true, next_state: nextState });
});
