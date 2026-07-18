// =====================================================================
// Grace — ElevenLabs post-call webhook + post-call pipeline
// Endpoint: POST /webhooks/elevenlabs  (spec §6.3, §6.7, §10.3)
// Owner: task 8. Handles `post_call_transcription` and `call_initiation_failure`.
//
// Invariants enforced here:
//   INV-07  transcript_turns are stored ONLY when transcription consent is true.
//   INV-08  audit flags a line-items + cash-advances vs total mismatch.
//   §6.7    HMAC verified + stale rejected; idempotent on conversation_id+type;
//           raw vendor payload stored in encrypted private storage for 72h only.
//   §10.3   normalizer failure -> store transcript, mark quote PENDING_REVIEW,
//           DO NOT rank.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { verifyElevenLabsHmac } from "../_shared/elevenlabs.ts";
import { ensureIdempotent } from "../_shared/idempotency.ts";
import { elevenLabsWebhookSecret } from "../_shared/env.ts";
import { normalizeQuote, auditQuote } from "../_shared/openai/functions.ts";
import { renderEvidenceMarkdown, renderContextMarkdown } from "../_shared/ledger/ledger.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { ProviderCallTask, QuoteResult } from "../_shared/types.ts";

const PRIVATE_BUCKET = "grace-private";

/** Dig a value out of the (varied) ElevenLabs payload shapes. */
function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const seg of p.split(".")) {
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
      else { ok = false; break; }
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

/** Assemble the ledger projection input from the DB (DB is canonical, §6.5). */
async function buildLedgerInput(admin: ReturnType<typeof supabaseAdmin>, caseId: string) {
  const [caseRes, verRes, evRes, quoteRes, sessRes, reportRes] = await Promise.all([
    admin.from("cases").select("*").eq("case_id", caseId).maybeSingle(),
    admin.from("case_versions").select("*").eq("case_id", caseId),
    admin.from("events").select("*").eq("case_id", caseId).order("timestamp", { ascending: true }),
    admin.from("quotes").select("*").eq("case_id", caseId),
    admin.from("call_sessions").select("call_id, consent").eq("case_id", caseId),
    admin.from("reports").select("*").eq("case_id", caseId).maybeSingle(),
  ]);
  // Scope transcript turns to THIS case's calls (transcript_turns keys on call_id).
  const callIds = (sessRes.data ?? []).map((s: any) => s.call_id).filter(Boolean);
  let turns: any[] = [];
  if (callIds.length > 0) {
    const { data } = await admin.from("transcript_turns").select("*").in("call_id", callIds);
    turns = data ?? [];
  }
  const confirmed = (verRes.data ?? []).find((v: any) => v.confirmed_at) ?? null;
  return {
    case: caseRes.data,
    case_id: caseId,
    case_spec: confirmed?.case_spec_json ?? null,
    case_spec_version: confirmed?.version ?? caseRes.data?.current_version ?? 0,
    versions: verRes.data ?? [],
    events: evRes.data ?? [],
    quotes: quoteRes.data ?? [],
    transcript_turns: turns,
    report: reportRes.data ?? null,
  };
}

/** Regenerate + store the Markdown ledger projections (best-effort; DB is canonical). */
async function regenerateLedger(admin: ReturnType<typeof supabaseAdmin>, caseId: string) {
  try {
    const input = await buildLedgerInput(admin, caseId);
    const evidenceMd = renderEvidenceMarkdown(
      input as unknown as Parameters<typeof renderEvidenceMarkdown>[0],
    );
    const contextMd = renderContextMarkdown(
      input as unknown as Parameters<typeof renderContextMarkdown>[0],
    );
    await admin.storage
      .from(PRIVATE_BUCKET)
      .upload(`cases/${caseId}/evidence.md`, new Blob([evidenceMd], { type: "text/markdown" }), {
        upsert: true,
      });
    await admin.storage
      .from(PRIVATE_BUCKET)
      .upload(`cases/${caseId}/context.md`, new Blob([contextMd], { type: "text/markdown" }), {
        upsert: true,
      });
  } catch (e) {
    console.error("ledger regeneration failed (non-fatal):", e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  // ---- §6.7: verify HMAC + reject stale timestamps. ----
  const rawBody = await req.clone().text();
  const valid = await verifyElevenLabsHmac(req, elevenLabsWebhookSecret());
  if (!valid) return error("Invalid or stale ElevenLabs signature", 401);

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return error("Invalid JSON body", 400);
  }

  const eventType: string = payload.type ?? payload.event_type ?? "unknown";
  const conversationId: string | undefined = pick(
    payload,
    "data.conversation_id",
    "conversation_id",
    "data.metadata.conversation_id",
  );
  if (!conversationId) return error("conversation_id missing from payload", 400);

  // ---- §6.7: idempotency on conversation_id + event type. ----
  const idemKey = `el:${conversationId}:${eventType}`;
  const fresh = await ensureIdempotent(idemKey);
  if (!fresh) return json({ status: "duplicate_ignored" });

  const admin = supabaseAdmin();

  // Store the RAW vendor payload in encrypted private storage (72h retention, §6.7).
  try {
    await admin.storage
      .from(PRIVATE_BUCKET)
      .upload(
        `raw/${conversationId}/${eventType}-${Date.now()}.json`,
        new Blob([rawBody], { type: "application/json" }),
        { upsert: true },
      );
  } catch (e) {
    console.error("raw payload storage failed (non-fatal):", e);
  }

  // Resolve the call session for routing + consent.
  const { data: session } = await admin
    .from("call_sessions")
    .select("call_id, case_id, purpose, consent")
    .eq("elevenlabs_conversation_id", conversationId)
    .maybeSingle();

  const caseId: string | undefined =
    session?.case_id ??
    pick(payload, "data.conversation_initiation_client_data.dynamic_variables.case_id");
  const purpose: string = session?.purpose ??
    pick(payload, "data.conversation_initiation_client_data.dynamic_variables.purpose") ??
    "initial_quote";
  // INV-07: consent is authoritative from the call session; default false (no transcript).
  const transcriptionConsent = session?.consent === true;

  // ---------- call_initiation_failure ----------
  if (eventType === "call_initiation_failure") {
    if (session) {
      await admin
        .from("call_sessions")
        .update({ status: "failed" })
        .eq("elevenlabs_conversation_id", conversationId);
    }
    if (caseId) {
      await admin.from("events").insert({
        case_id: caseId,
        type: "call_initiation_failure",
        actor: "system",
        payload_json: { conversation_id: conversationId, reason: pick(payload, "data.reason") },
        idempotency_key: idemKey,
      });
      // Retry policy (retry once only) is enforced by the call-launcher (task 7).
      await admin.from("cases").update({ status: "UNAVAILABLE" }).eq("case_id", caseId);
      await regenerateLedger(admin, caseId);
    }
    return json({ status: "failure_recorded" });
  }

  // ---------- post_call_transcription ----------
  if (eventType !== "post_call_transcription") {
    return json({ status: "ignored", event_type: eventType });
  }

  const rawTurns: any[] = pick(payload, "data.transcript", "transcript") ?? [];

  // ---- INV-07: persist transcript_turns ONLY with transcription consent. ----
  if (transcriptionConsent && session?.call_id && rawTurns.length > 0) {
    const rows = rawTurns.map((t: any, i: number) => ({
      call_id: session.call_id,
      turn_index: typeof t.turn_index === "number" ? t.turn_index : i,
      role: t.role ?? t.speaker ?? "unknown",
      text: t.message ?? t.text ?? "",
      start_seconds: t.time_in_call_secs ?? t.start_seconds ?? null,
      end_seconds: t.end_seconds ?? null,
    }));
    await admin.from("transcript_turns").insert(rows);
  }

  // Non-caller conversations: just refresh the ledger and finish.
  if (purpose !== "initial_quote") {
    if (caseId) await regenerateLedger(admin, caseId);
    return json({ status: "processed", purpose });
  }

  if (!caseId) return json({ status: "processed_no_case" });

  // ---- Caller post-call pipeline: normalize -> audit -> persist AUDITED. ----
  // The provisional PENDING quote was created during the live call.
  const { data: quoteRow } = await admin
    .from("quotes")
    .select("quote_id, provider_id, case_spec_version, quote_json, audit_status")
    .eq("case_id", caseId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  const targetQuote = quoteRow ??
    (
      await admin
        .from("quotes")
        .select("quote_id, provider_id, case_spec_version, quote_json, audit_status")
        .eq("case_id", caseId)
        .eq("audit_status", "PENDING")
        .order("quote_id", { ascending: true })
        .maybeSingle()
    ).data;

  if (!targetQuote) {
    if (caseId) await regenerateLedger(admin, caseId);
    return json({ status: "processed_no_quote" });
  }

  // Load the ProviderCallTask for the normalizer.
  const { data: taskRow } = await admin
    .from("provider_call_tasks")
    .select("task_json")
    .eq("provider_id", targetQuote.provider_id)
    .eq("case_version", targetQuote.case_spec_version)
    .maybeSingle();
  const task = (taskRow?.task_json ?? {}) as unknown as ProviderCallTask;

  const transcriptForModel = rawTurns.map((t: any, i: number) => ({
    turn_index: typeof t.turn_index === "number" ? t.turn_index : i,
    role: t.role ?? t.speaker ?? "unknown",
    text: t.message ?? t.text ?? "",
    start_seconds: t.time_in_call_secs ?? null,
  }));

  let normalized: QuoteResult;
  try {
    normalized = await normalizeQuote(
      task,
      transcriptForModel as unknown as Parameters<typeof normalizeQuote>[1],
    );
  } catch (e) {
    // §10.3: normalizer failed -> keep transcript, mark PENDING_REVIEW, DO NOT rank.
    console.error("normalizeQuote failed:", e);
    await admin
      .from("quotes")
      .update({ audit_status: "PENDING_REVIEW" })
      .eq("quote_id", targetQuote.quote_id);
    await admin.from("events").insert({
      case_id: caseId,
      type: "normalizer_failed",
      actor: "system",
      payload_json: { quote_id: targetQuote.quote_id, conversation_id: conversationId },
      idempotency_key: `normfail:${targetQuote.quote_id}`,
    });
    await regenerateLedger(admin, caseId);
    return json({ status: "pending_review", quote_id: targetQuote.quote_id });
  }

  // Audit for red flags + a corrected total.
  let auditFlags = normalized.audit_flags ?? [];
  let correctedTotal: number | null = normalized.total ?? null;
  try {
    const audit = await auditQuote(
      normalized,
      transcriptForModel as unknown as Parameters<typeof auditQuote>[1],
    );
    auditFlags = [...auditFlags, ...(audit.flags ?? [])];
    if (audit.corrected_total != null) correctedTotal = audit.corrected_total;
  } catch (e) {
    console.error("auditQuote failed (non-fatal):", e);
  }

  // ---- INV-08: recompute the total from line items + cash advances; flag drift. ----
  const lineSum = (normalized.line_items ?? []).reduce(
    (acc, li) => acc + (typeof li.amount === "number" ? li.amount : 0),
    0,
  );
  const cashAdvance = normalized.cash_advance_total ?? 0;
  const computedTotal = lineSum + cashAdvance;
  const statedTotal = correctedTotal ?? normalized.total;
  if (statedTotal != null && Math.abs(computedTotal - statedTotal) > 0.5) {
    auditFlags = [
      ...auditFlags,
      {
        code: "line_items_do_not_sum_to_total",
        severity: "warn",
        message:
          `Line items + cash advances ($${computedTotal}) do not match stated total ($${statedTotal}).`,
        evidence: null,
      },
    ];
  }

  const finalQuote: QuoteResult = {
    ...normalized,
    audit_flags: auditFlags,
    total: statedTotal ?? computedTotal,
  };

  await admin
    .from("quotes")
    .update({
      quote_json: finalQuote,
      total: finalQuote.total,
      confidence: finalQuote.confidence ?? null,
      audit_status: "AUDITED",
    })
    .eq("quote_id", targetQuote.quote_id);

  await admin.from("cases").update({ status: "QUOTES_NORMALIZED_AND_AUDITED" }).eq("case_id", caseId);

  await admin.from("events").insert({
    case_id: caseId,
    type: "quote_audited",
    actor: "system",
    payload_json: {
      quote_id: targetQuote.quote_id,
      total: finalQuote.total,
      flag_count: auditFlags.length,
    },
    idempotency_key: `audited:${targetQuote.quote_id}`,
  });

  await regenerateLedger(admin, caseId);

  return json({ status: "audited", quote_id: targetQuote.quote_id, total: finalQuote.total });
});
