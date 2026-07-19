// =====================================================================
// Grace — Closer tool: deterministic ranked report
// Endpoint: GET /tools/closer/report  (spec §6.3, §5.8, §5.9, tool `get_ranked_report`)
// Owner: task 8. Read-only ranking over AUDITED quotes.
//
// Invariants enforced here:
//   INV-06  read-only: returns scores, tie state, evidence, next human action.
//   §10.3   only AUDITED quotes are ranked; PENDING / PENDING_REVIEW are excluded.
//   Ranking is fully deterministic — rankProviders() + config weights only.
//   State -> REPORT_READY once a report is produced.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { rankProviders } from "../_shared/ranking/rank.ts";
import { decryptPhone } from "../_shared/crypto.ts";
import { twilioAccountSid, twilioAuthToken, twilioPhoneNumberE164 } from "../_shared/env.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { CaseSpec, QuoteResult, RankedReport } from "../_shared/types.ts";
import vertical from "../_shared/config/vertical.json" with { type: "json" };
import disclosure from "../_shared/config/disclosure.json" with { type: "json" };

/** Build the proactive consumer update text (<=320 chars) from the ranked report. */
function buildConsumerSummary(report: RankedReport): string {
  if (report.is_tie) {
    return (disclosure.messages.consumer_updates.tie +
      " Reply CALL to have the Grace Closer Agent walk you through it.").slice(0, 320);
  }
  const top = report.scores?.find((s) => s.provider_id === report.recommended_provider_id);
  const total = top?.comparable_total != null ? `~$${top.comparable_total}` : "an itemized total";
  return (
    `I've compared the providers. Top option: ${report.recommended_provider_id ?? "see details"} at ${total} comparable. ` +
    (report.material_tradeoff ? `${report.material_tradeoff} ` : "") +
    `Reply CALL to have the Grace Closer Agent explain the ranked results.`
  ).slice(0, 320);
}

/** Best-effort Twilio SMS (voice-first: no-ops cleanly if SMS creds are absent). */
async function sendSmsBestEffort(to: string, body: string): Promise<boolean> {
  try {
    const sid = twilioAccountSid();
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const form = new URLSearchParams({ To: to, From: twilioPhoneNumberE164(), Body: body });
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${sid}:${twilioAuthToken()}`)}`,
      },
      body: form.toString(),
    });
    return resp.ok;
  } catch (e) {
    console.log(`report-ready SMS skipped (voice-first): ${(e as Error).message}`);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const url = new URL(req.url);
  const caseId = url.searchParams.get("case_id");
  if (!caseId) return error("case_id is required", 400);

  const admin = supabaseAdmin();

  const { data: caseRow } = await admin
    .from("cases")
    .select("current_version, status")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return error("case not found", 404);

  const { data: verRow } = await admin
    .from("case_versions")
    .select("case_spec_json, version")
    .eq("case_id", caseId)
    .eq("version", caseRow.current_version)
    .maybeSingle();
  if (!verRow) return error("confirmed CaseSpec not found", 404);
  const spec = verRow.case_spec_json as unknown as CaseSpec;

  // §10.3: rank AUDITED quotes only.
  const { data: quoteRows } = await admin
    .from("quotes")
    .select("quote_json, audit_status")
    .eq("case_id", caseId)
    .eq("case_spec_version", caseRow.current_version)
    .eq("audit_status", "AUDITED");

  const quotes: QuoteResult[] = (quoteRows ?? []).map(
    (r) => r.quote_json as unknown as QuoteResult,
  );

  if (quotes.length < 2) {
    return json({
      case_id: caseId,
      case_spec_version: caseRow.current_version,
      scores: [],
      is_tie: false,
      tie_reason: null,
      recommended_provider_id: null,
      runner_up_provider_id: null,
      material_tradeoff: null,
      next_human_action: "Await at least two audited quotes before ranking.",
      generated_at: new Date().toISOString(),
    });
  }

  const report = rankProviders(
    quotes,
    spec,
    vertical.ranking.weights as unknown as Parameters<typeof rankProviders>[2],
  );
  if (!report.generated_at) report.generated_at = new Date().toISOString();

  // Persist the deterministic report + advance state (idempotent upsert).
  await admin.from("reports").upsert(
    {
      case_id: caseId,
      report_json: report,
      report_markdown: null, // full Markdown is rendered by cases-report / ledger
      created_at: report.generated_at,
    },
    { onConflict: "case_id" },
  );
  await admin.from("cases").update({ status: "REPORT_READY" }).eq("case_id", caseId);

  await admin.from("events").insert({
    case_id: caseId,
    type: "report_generated",
    actor: "closer_agent",
    payload_json: {
      is_tie: report.is_tie,
      recommended: report.recommended_provider_id,
      runner_up: report.runner_up_provider_id,
    },
    idempotency_key: `report:${caseId}:${caseRow.current_version}:${crypto.randomUUID()}`,
  });

  // ---- Proactive consumer update (§2.3 P0 #8, §4.6) ----
  // Send the ranked-result text the FIRST time the report becomes ready. Gated on
  // prior status so re-fetching get_ranked_report never re-texts. Best-effort:
  // no-ops until Twilio SMS creds are set (voice-first), then delivers.
  const alreadyNotified = ["REPORT_READY", "CLOSER_CONSUMER_CALL_ACTIVE", "CONSUMER_TEXT_SUMMARY", "CONSUMER_UPDATED", "CLOSED"].includes(caseRow.status);
  if (!alreadyNotified) {
    const { data: consumer } = await admin
      .from("participants")
      .select("phone_e164_encrypted")
      .eq("case_id", caseId)
      .eq("role", "consumer")
      .limit(1)
      .maybeSingle();
    if (consumer?.phone_e164_encrypted) {
      const body = buildConsumerSummary(report);
      let to = "";
      try { to = await decryptPhone(consumer.phone_e164_encrypted); } catch { /* skip */ }
      const sent = to ? await sendSmsBestEffort(to, body) : false;
      await admin.from("messages").insert({
        message_id: crypto.randomUUID(), case_id: caseId, direction: "outbound", channel: "sms",
        provider_id: null, body, status: sent ? "sent" : "skipped_no_sms",
        timestamp: new Date().toISOString(),
      });
      await admin.from("events").insert({
        case_id: caseId, type: "consumer.report_ready_sms", actor: "closer_agent",
        payload_json: { sent, is_tie: report.is_tie },
        idempotency_key: `report_sms:${caseId}:${caseRow.current_version}`,
      });
    }
  }

  return json(report);
});
