// =====================================================================
// Grace — GET /agent-activity  (live agent-loop telemetry for the UI)
// Read-only projection of the current agent pipeline for a case:
//   - the 3 live VOICE agents (Intake, Caller, Closer)
//   - the non-calling backend TOOL/service "agents" (Orchestrator, Research,
//     Normalizer, Auditor, Ranker, Ledger)
// Derives each node's state (idle|active|done|error), a human activity line,
// and its latest output from cases.status + events + quotes + report.
//
// No case_id  -> returns { cases: [...] } (recent cases to pick from).
// With case_id -> returns { case, nodes, events, calls, summary }.
// Read-only; no invariant surface.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Ordering of the state machine (§3.3) so we can compute "upstream = done".
const ORDER: Record<string, number> = {
  NEW: 0, CONSENTED: 1, PREFERENCE_SMS_SENT: 2,
  TEXT_INTAKE: 3, INTAKE_AGENT_ACTIVE: 3, CASE_DRAFT: 4, CASE_CONFIRMED: 5,
  CALLER_BATCH_QUEUED: 6, CALLER_AGENT_ACTIVE: 7,
  QUOTE_CAPTURED: 8, CALLBACK: 8, DECLINED: 8, UNAVAILABLE: 8,
  QUOTES_NORMALIZED_AND_AUDITED: 9, CLOSER_READY: 10,
  CLOSER_NEGOTIATION_ACTIVE: 11, QUOTE_REVISED: 12, NEGOTIATION_DECLINED: 12,
  REPORT_READY: 13, CLOSER_CONSUMER_CALL_ACTIVE: 14,
  CONSUMER_TEXT_SUMMARY: 15, CONSUMER_UPDATED: 15, CLOSED: 16,
};

type NodeState = "idle" | "active" | "done" | "error";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const admin = supabaseAdmin();
  const caseId = new URL(req.url).searchParams.get("case_id");

  // ---- No case_id: list recent cases so the UI can offer a picker. ----
  if (!caseId) {
    const { data: cases } = await admin
      .from("cases")
      .select("case_id, status, preferred_channel, current_version, created_at")
      .order("created_at", { ascending: false })
      .limit(15);
    return json({ cases: cases ?? [] });
  }

  // ---- Load everything we project from. ----
  const [{ data: caseRow }, { data: quotes }, { data: reports }, { data: events }, { data: calls }] =
    await Promise.all([
      admin.from("cases").select("case_id, status, preferred_channel, current_version, created_at")
        .eq("case_id", caseId).maybeSingle(),
      admin.from("quotes").select("provider_id, total, audit_status, quote_json").eq("case_id", caseId),
      admin.from("reports").select("report_json, created_at").eq("case_id", caseId)
        .order("created_at", { ascending: false }).limit(1),
      admin.from("events").select("type, actor, payload_json, timestamp").eq("case_id", caseId)
        .order("timestamp", { ascending: false }).limit(20),
      admin.from("call_sessions").select("purpose, provider_id, status, elevenlabs_conversation_id, created_at")
        .eq("case_id", caseId).order("created_at", { ascending: false }).limit(6),
    ]);

  if (!caseRow) return error("case not found", 404);

  const status: string = caseRow.status;
  const prog = ORDER[status] ?? 0;
  const q = quotes ?? [];
  const audited = q.filter((r) => r.audit_status === "AUDITED");
  const report = reports?.[0]?.report_json as
    | { is_tie?: boolean; recommended_provider_id?: string | null; material_tradeoff?: string | null }
    | undefined;
  const flags = q.reduce((n, r) => {
    const f = (r.quote_json as { audit_flags?: unknown[] } | null)?.audit_flags;
    return n + (Array.isArray(f) ? f.length : 0);
  }, 0);

  // recent activity => make cross-cutting nodes pulse
  const lastEventMs = events?.[0]?.timestamp ? Date.parse(events[0].timestamp) : 0;
  const recentActivity = lastEventMs > 0 && Date.now() - lastEventMs < 15_000;

  const between = (a: number, b: number) => prog >= a && prog <= b;
  const st = (active: boolean, doneAt: number): NodeState =>
    active ? "active" : prog >= doneAt ? "done" : "idle";

  const liveCalls = (calls ?? []).filter((c) => c.status === "active" || c.status === "in-progress");
  const intakeCallLive = liveCalls.some((c) => c.purpose === "consumer_intake");
  const callerCallsLive = liveCalls.filter((c) => c.purpose === "initial_quote").length;
  const closerCallLive = liveCalls.some((c) =>
    c.purpose === "negotiation" || c.purpose === "consumer_explanation");

  const nodes = [
    // ---------------- non-calling: orchestrator ----------------
    {
      id: "orchestrator", label: "Event Orchestrator", kind: "tool", lane: "control",
      state: st(between(1, 2) || status === "CASE_CONFIRMED" || status === "CALLER_BATCH_QUEUED", 1),
      activity: between(1, 2) ? "Enrolled consent; routing preference"
        : status === "CASE_CONFIRMED" ? "CaseSpec frozen; dispatching provider batch"
        : status === "CALLER_BATCH_QUEUED" ? "Queuing 3 parallel Caller sessions"
        : prog >= 1 ? "Dispatching agents at stage boundaries" : "Waiting for enrollment",
      output: `state: ${status}`,
    },
    // ---------------- voice: intake ----------------
    {
      id: "intake", label: "Grace Intake Agent", kind: "voice", lane: "intake",
      state: (intakeCallLive || between(3, 4)) ? "active" : st(false, 5),
      activity: intakeCallLive ? "On call — running voice intake"
        : between(3, 4) ? "Collecting CaseSpec, one question at a time"
        : prog >= 5 ? "CaseSpec confirmed" : "Idle",
      output: prog >= 5 ? `CaseSpec v${caseRow.current_version} confirmed`
        : between(3, 4) ? "CaseSpec draft in progress" : "—",
    },
    // ---------------- non-calling: research ----------------
    {
      id: "research", label: "Tavily Research", kind: "tool", lane: "intake",
      state: (between(4, 6)) ? "active" : prog > 6 ? "done" : "idle",
      activity: between(4, 6) ? "Loading cached market/official fixtures"
        : prog > 6 ? "Market band prepared" : "Standby (off the live voice path)",
      output: prog >= 4 ? "official-source fixtures cached" : "—",
    },
    // ---------------- voice: caller (x3) ----------------
    {
      id: "caller", label: "Grace Caller Agent ×3", kind: "voice", lane: "quote",
      state: (callerCallsLive > 0 || between(6, 8)) ? "active" : st(false, 9),
      activity: callerCallsLive > 0 ? `${callerCallsLive} live provider call(s)`
        : between(6, 8) ? "Gathering itemized quotes from 3 providers"
        : prog >= 9 ? "All provider outcomes captured" : "Idle",
      output: q.length ? `${q.length}/3 quote outcomes` : "—",
    },
    // ---------------- non-calling: normalizer ----------------
    {
      id: "normalizer", label: "Quote Normalizer", kind: "tool", lane: "quote",
      state: between(8, 8) ? "active" : prog >= 9 ? "done" : "idle",
      activity: between(8, 8) ? "Structuring transcripts into itemized quotes"
        : prog >= 9 ? "Quotes normalized" : "Idle",
      output: prog >= 9 ? `${q.length} quotes normalized` : "—",
    },
    // ---------------- non-calling: auditor ----------------
    {
      id: "auditor", label: "Compliance Auditor", kind: "tool", lane: "quote",
      state: between(8, 8) ? "active" : prog >= 9 ? "done" : "idle",
      activity: between(8, 8) ? "Recomputing totals; flagging hidden fees"
        : prog >= 9 ? `${audited.length} audited, ${flags} flag(s)` : "Idle",
      output: prog >= 9 ? `${flags} audit flag(s)` : "—",
    },
    // ---------------- non-calling: ranker ----------------
    {
      id: "ranker", label: "Deterministic Ranker", kind: "tool", lane: "rank",
      state: (status === "QUOTES_NORMALIZED_AND_AUDITED" || status === "QUOTE_REVISED") ? "active"
        : prog >= 13 ? "done" : "idle",
      activity: prog >= 13
        ? (report?.is_tie ? "Result: TIE — two options" : "Result: recommendation ready")
        : between(9, 12) ? "Scoring fit/cost/certainty/timing/trust" : "Idle",
      output: prog >= 13
        ? (report?.is_tie ? "TIE (present two options)"
            : report?.recommended_provider_id ? `recommend ${report.recommended_provider_id}` : "report ready")
        : "—",
    },
    // ---------------- voice: closer ----------------
    {
      id: "closer", label: "Grace Closer Agent", kind: "voice", lane: "close",
      state: (closerCallLive || status === "CLOSER_NEGOTIATION_ACTIVE" || status === "CLOSER_CONSUMER_CALL_ACTIVE")
        ? "active" : prog >= 15 ? "done" : prog >= 10 ? "idle" : "idle",
      activity: status === "CLOSER_NEGOTIATION_ACTIVE" ? "Negotiating with verified leverage"
        : status === "CLOSER_CONSUMER_CALL_ACTIVE" ? "Explaining ranked result to family"
        : prog >= 15 ? "Consumer updated" : prog >= 10 ? "Ready (awaiting audits/leverage)" : "Idle",
      output: status === "QUOTE_REVISED" ? "revised terms logged"
        : prog >= 15 ? "consumer decision recorded" : "—",
    },
    // ---------------- non-calling: ledger ----------------
    {
      id: "ledger", label: "Evidence Ledger", kind: "tool", lane: "close",
      state: recentActivity ? "active" : prog >= 1 ? "done" : "idle",
      activity: recentActivity ? "Regenerating evidence.md projection"
        : prog >= 1 ? "Evidence ledger up to date" : "Idle",
      output: prog >= 1 ? `${events?.length ?? 0} events logged` : "—",
    },
  ];

  const activeNode = nodes.find((n) => n.state === "active")?.id ?? null;

  return json({
    case: {
      case_id: caseRow.case_id, status, progress: prog,
      preferred_channel: caseRow.preferred_channel, current_version: caseRow.current_version,
    },
    active_node: activeNode,
    nodes,
    calls: (calls ?? []).map((c) => ({
      purpose: c.purpose, provider_id: c.provider_id, status: c.status,
      conversation_id: c.elevenlabs_conversation_id,
    })),
    events: (events ?? []).map((e) => ({
      type: e.type, actor: e.actor, timestamp: e.timestamp,
    })),
    summary: {
      quotes: q.length, audited: audited.length, audit_flags: flags,
      is_tie: report?.is_tie ?? null,
      recommended: report?.recommended_provider_id ?? null,
    },
  });
});
