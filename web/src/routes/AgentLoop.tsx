import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  User, Smartphone, Headphones, FileCheck2, PhoneCall, Building2,
  ClipboardCheck, MessageSquare, Laptop, Brain, Search, FileText,
  ShieldCheck, Users, CheckCircle2, Radio, Handshake,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Live Agent Loop — mirrors the "Grace — Overall System Flow" diagram, but the
// active agent glows in real time and each node shows its current activity +
// latest output. Polls /agent-activity for the selected case. Both the three
// live VOICE agents and the non-calling BACKEND tool "agents" are shown.
// ---------------------------------------------------------------------------

const BASE = (import.meta.env.VITE_APP_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

type NodeState = "idle" | "active" | "done";
interface ActNode { id: string; label: string; kind: string; state: string; activity: string; output: string }
interface Activity {
  case: {
    case_id: string; status: string; progress: number;
    preferred_channel: string; current_version: number; aborted?: boolean;
  };
  active_node: string | null;
  nodes: ActNode[];
  calls: {
    purpose: string;
    provider_id: string | null;
    status: string;
    conversation_id?: string | null;
  }[];
  events: { type: string; actor: string; timestamp: string }[];
  summary: {
    quotes: number; audited: number; audit_flags: number;
    is_tie: boolean | null; recommended: string | null;
    // Number of providers this case actually has (one per DEMO_TARGETS entry).
    providers?: number;
  };
}
interface CaseRow { case_id: string; status: string; current_version: number; created_at: string }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// No POST helper here on purpose: this view is read-only. The family dials
// Grace and the pipeline drives itself — nothing in the dashboard places a call.

interface LaunchedCall { label: string; conversation_id: string; provider_id?: string }

// Polls /call-transcript for one conversation and renders the turns once the
// call is done (or in progress). All calls are real; transcript shown for the
// consented demo (INV-07). React escapes text on render — no injection.
function CallTranscript({ call }: { call: LaunchedCall }) {
  const [status, setStatus] = useState("pending");
  const [turns, setTurns] = useState<{ role: string; message: string }[]>([]);
  const [dur, setDur] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await get<{ status: string; transcript: { role: string; message: string }[]; duration_secs: number | null }>(
          `/call-transcript?conversation_id=${encodeURIComponent(call.conversation_id)}`,
        );
        if (!alive) return;
        setStatus(r.status); setTurns(r.transcript); setDur(r.duration_secs);
      } catch { /* keep polling */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [call.conversation_id]);

  const done = status === "done" || status === "failed";
  const live = status === "in-progress" || status === "processing";
  return (
    <div className="rounded-xl border border-grace-border bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-grace-ink">{call.label}</div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
          done ? "bg-emerald-100 text-emerald-800" : live ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"
        }`}>
          {live ? "● on call" : done ? `✓ ${status}${dur ? ` · ${dur}s` : ""}` : status}
        </span>
      </div>
      {turns.length === 0 ? (
        <div className="text-[11px] text-grace-muted">
          {live ? "Call in progress — transcript will appear as it's spoken…" : "Waiting for transcript…"}
        </div>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.role === "grace" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[12px] leading-snug ${
                t.role === "grace" ? "bg-teal-50 text-teal-900" : "bg-blue-50 text-blue-900"
              }`}>
                <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wide opacity-60">
                  {t.role === "grace" ? "Grace" : "Caller"}
                </div>
                {t.message}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Visual model: 9-step pipeline + 4-box shared layer (matches diagram) ----
type Kind = "human" | "telephony" | "voice" | "checkpoint" | "tool";
interface StepDef {
  n?: number; id: string; title: string; sub: string; kind: Kind; color: string;
  Icon: typeof User;
  derive: (d: Activity) => { state: NodeState; activity: string; output: string };
}

const nodeById = (d: Activity, id: string) => d.nodes.find((n) => n.id === id);
const asState = (s?: string): NodeState =>
  s === "active" ? "active" : s === "done" ? "done" : "idle";

const PIPELINE: StepDef[] = [
  {
    n: 1, id: "consumer", title: "Consumer", sub: "receives SMS or CALL option",
    kind: "human", color: "#1e3a8a", Icon: User,
    derive: (d) => ({
      state: d.case.progress >= 2 ? "done" : "active",
      activity: d.case.progress >= 2 ? "Enrolled & routed" : "Enrolling / choosing TEXT or CALL",
      output: `channel: ${d.case.preferred_channel}`,
    }),
  },
  {
    n: 2, id: "twilio", title: "Twilio SMS + Voice", sub: "number · messaging · routing",
    kind: "telephony", color: "#1e3a8a", Icon: Smartphone,
    derive: (d) => {
      const live = d.calls.some((c) => c.status === "active" || c.status === "in-progress");
      return {
        state: live || d.case.status === "PREFERENCE_SMS_SENT" ? "active" : d.case.progress >= 3 ? "done" : "idle",
        activity: live ? "Carrying a live call" : d.case.progress >= 3 ? "Channel established" : "Routing",
        output: "+1 650 772 5745",
      };
    },
  },
  {
    n: 3, id: "intake", title: "Grace Intake Agent", sub: "voice/text · builds CaseSpec",
    kind: "voice", color: "#0d9488", Icon: Headphones,
    derive: (d) => { const x = nodeById(d, "intake"); return { state: asState(x?.state), activity: x?.activity ?? "Idle", output: x?.output ?? "—" }; },
  },
  {
    n: 4, id: "casespec", title: "Confirmed CaseSpec", sub: "one shared, frozen brief",
    kind: "checkpoint", color: "#047857", Icon: FileCheck2,
    derive: (d) => ({
      state: d.case.progress >= 5 ? "done" : d.case.progress === 4 ? "active" : "idle",
      activity: d.case.progress >= 5 ? "Frozen (version + hash)" : d.case.progress === 4 ? "Awaiting YES" : "Pending intake",
      output: d.case.progress >= 5 ? `v${d.case.current_version} confirmed` : "—",
    }),
  },
  {
    n: 5, id: "caller", title: "Grace Caller Agent", sub: "same brief to every provider",
    kind: "voice", color: "#0d9488", Icon: PhoneCall,
    derive: (d) => { const x = nodeById(d, "caller"); return { state: asState(x?.state), activity: x?.activity ?? "Idle", output: x?.output ?? "—" }; },
  },
  {
    n: 6, id: "homes", title: "Demo Funeral Homes", sub: "role-play providers",
    kind: "tool", color: "#4338ca", Icon: Building2,
    derive: (d) => ({
      state: d.case.progress >= 6 && d.case.progress <= 8 ? "active" : d.case.progress >= 9 ? "done" : "idle",
      activity: d.case.progress >= 9 ? "All outcomes captured" : d.case.progress >= 6 ? "Answering itemized questions" : "Standby",
      // Provider count comes from the case (one per DEMO_TARGETS entry), not a
      // hardcoded 3 — that assumed main's three-roleplayer spec.
      output: `${d.summary.quotes}/${d.summary.providers ?? d.summary.quotes} quote outcomes`,
    }),
  },
  {
    n: 7, id: "normaudit", title: "Normalize + Compliance", sub: "itemize · compare · flag fees",
    kind: "tool", color: "#0d9488", Icon: ClipboardCheck,
    derive: (d) => {
      const norm = nodeById(d, "normalizer"); const aud = nodeById(d, "auditor");
      const st = norm?.state === "active" || aud?.state === "active" ? "active"
        : d.case.progress >= 9 ? "done" : "idle";
      return { state: st as NodeState, activity: st === "active" ? "Recomputing totals; flagging hidden fees"
        : d.case.progress >= 9 ? "Quotes normalized & audited" : "Idle",
        output: d.case.progress >= 9 ? `${d.summary.audited} audited · ${d.summary.audit_flags} flag(s)` : "—" };
    },
  },
  {
    n: 8, id: "closer", title: "Grace Closer Agent", sub: "negotiate · rank · explain",
    kind: "voice", color: "#0d9488", Icon: Handshake,
    derive: (d) => {
      const x = nodeById(d, "closer"); const rank = nodeById(d, "ranker");
      const st = asState(x?.state);
      const out = d.summary.is_tie ? "TIE — two options"
        : d.summary.recommended ? `recommend ${d.summary.recommended}`
        : rank?.output && rank.output !== "—" ? rank.output : (x?.output ?? "—");
      return { state: st, activity: x?.activity ?? "Idle", output: out };
    },
  },
  {
    n: 9, id: "consumerupd", title: "Consumer Update", sub: "text summary or explanation call",
    kind: "human", color: "#1e3a8a", Icon: MessageSquare,
    derive: (d) => ({
      state: d.case.progress >= 15 ? "done" : d.case.progress === 14 ? "active" : "idle",
      activity: d.case.progress >= 15 ? "Family updated" : d.case.progress === 14 ? "On explanation call" : "Pending report",
      output: d.case.progress >= 15 ? "decision recorded" : "—",
    }),
  },
];

const SHARED: StepDef[] = [
  {
    id: "lovable", title: "Grace Orchestrator", sub: "FastAPI + React", kind: "tool", color: "#0d9488", Icon: Laptop,
    derive: () => ({ state: "active", activity: "Serving UI + pipeline API", output: "live" }),
  },
  {
    id: "openai", title: "OpenAI Structured Outputs", sub: "schemas + ranking", kind: "tool", color: "#2563eb", Icon: Brain,
    derive: (d) => {
      const busy = ["normalizer", "auditor", "ranker"].some((id) => nodeById(d, id)?.state === "active")
        || d.case.status === "TEXT_INTAKE";
      return { state: busy ? "active" : d.case.progress >= 9 ? "done" : "idle",
        activity: busy ? "Running strict-schema extraction / scoring" : "Standby", output: "json_schema strict" };
    },
  },
  {
    id: "research", title: "Tavily", sub: "provider research", kind: "tool", color: "#7c3aed", Icon: Search,
    derive: (d) => { const x = nodeById(d, "research"); return { state: asState(x?.state), activity: x?.activity ?? "Standby", output: x?.output ?? "—" }; },
  },
  {
    id: "ledger", title: "Markdown Evidence Ledger", sub: "calls · transcripts · quotes", kind: "tool", color: "#0d9488", Icon: FileText,
    derive: (d) => { const x = nodeById(d, "ledger"); return { state: asState(x?.state), activity: x?.activity ?? "Idle", output: x?.output ?? "—" }; },
  },
];

const KIND_LABEL: Record<Kind, string> = {
  human: "PERSON", telephony: "TELEPHONY", voice: "LIVE VOICE AGENT",
  checkpoint: "CHECKPOINT", tool: "BACKEND TOOL",
};

function Node({ def, d, big }: { def: StepDef; d: Activity; big?: boolean }) {
  const { state, activity, output } = def.derive(d);
  const { Icon, color } = def;
  const active = state === "active";
  const done = state === "done";
  return (
    <div
      className="grace-node relative flex flex-col rounded-2xl border bg-white p-3 transition-all duration-500"
      style={{
        // Wider than the original 220/172: node titles like "Grace Caller Agent"
        // were being ellipsed. Titles now wrap rather than truncate, so the
        // extra height covers a two-line title.
        width: big ? 244 : 196, minHeight: big ? 178 : 162,
        borderColor: active ? color : done ? "#cfe3d8" : "#e2e4e0",
        boxShadow: active ? `0 0 0 3px ${color}22, 0 10px 30px -8px ${color}66` : "0 1px 2px #0000000a",
        opacity: state === "idle" ? 0.62 : 1,
        transform: active ? "translateY(-2px)" : "none",
      }}
    >
      {def.n !== undefined && (
        <span className="absolute -top-3 -left-3 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold text-white shadow"
          style={{ background: color }}>{def.n}</span>
      )}
      {active && (
        <span className="absolute -top-2 right-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
          style={{ background: color }}>
          <Radio className="h-3 w-3 grace-blink" /> LIVE
        </span>
      )}
      {done && <CheckCircle2 className="absolute right-2 top-2 h-4 w-4" style={{ color: "#3d6b4a" }} />}
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: active ? color : `${color}14`, color: active ? "#fff" : color }}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-tight" style={{ color: "#1f2937" }}>{def.title}</div>
          <div className="text-[10px] font-semibold tracking-wide" style={{ color }}>{KIND_LABEL[def.kind]}</div>
        </div>
      </div>
      <div className="mt-1.5 text-[11px] leading-snug text-grace-muted">{def.sub}</div>
      <div className="mt-auto pt-2">
        <div className="text-[11px] font-medium leading-snug" style={{ color: active ? color : "#4b5563" }}>{activity}</div>
        <div className="mt-1 truncate rounded-md bg-grace-bg px-2 py-1 text-[11px] font-mono" title={output}>{output}</div>
      </div>
      {def.id === "homes" && (
        <div className="mt-2 flex flex-col gap-0.5">
          {["Transparent", "Package-first", "Hidden-fee"].map((p, i) => (
            <div key={p} className="flex items-center justify-between text-[10px]">
              <span className="text-grace-muted">{p}</span>
              <span className="font-mono" style={{ color: d.summary.quotes > i ? "#3d6b4a" : "#9aa39a" }}>
                {d.summary.quotes > i ? "✓ quote" : "…"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Arrow({ on }: { on: boolean }) {
  return (
    <div className="flex shrink-0 items-center" style={{ width: 26 }}>
      <div className="relative h-0.5 w-full rounded" style={{ background: on ? "#0d9488" : "#d5d9d4" }}>
        {on && <span className="grace-flow absolute inset-0 rounded" />}
      </div>
      <span style={{ color: on ? "#0d9488" : "#c3c8c2", marginLeft: -2 }}>▶</span>
    </div>
  );
}

export default function AgentLoop() {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [caseId, setCaseId] = useState<string>("");
  const [data, setData] = useState<Activity | null>(null);
  const [err, setErr] = useState<string>("");
  const [aborting, setAborting] = useState(false);

  // Case ids we have already seen, so a genuinely new one can be told apart
  // from the list simply reloading. Seeded on the first poll.
  const seenCases = useRef<Set<string> | null>(null);

  // Poll the case list and jump to any case that appears while we watch.
  // The demo is inbound: the family dials Grace, and the case only shows up
  // when the post-call webhook lands, so this is how the dashboard finds it.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      get<{ cases: CaseRow[] }>("/agent-activity")
        .then((r) => {
          if (!alive) return;
          setCases(r.cases);

          if (seenCases.current === null) {
            // First load: adopt the newest case without treating it as "new".
            seenCases.current = new Set(r.cases.map((c) => c.case_id));
            setCaseId((cur) => cur || r.cases[0]?.case_id || "");
            return;
          }
          const fresh = r.cases.find((c) => !seenCases.current!.has(c.case_id));
          r.cases.forEach((c) => seenCases.current!.add(c.case_id));
          if (fresh) setCaseId(fresh.case_id);
        })
        .catch((e) => { if (alive) setErr(String(e)); });
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Poll the selected case live.
  const poll = useCallback(() => {
    if (!caseId) return;
    get<Activity>(`/agent-activity?case_id=${encodeURIComponent(caseId)}`)
      .then((r) => { setData(r); setErr(""); })
      .catch((e) => setErr(String(e)));
  }, [caseId]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 1600);
    return () => clearInterval(t);
  }, [poll]);

  // Kill switch, and the way back out of it. Stop halts the NEXT call — one
  // already ringing still completes and still lands its transcript. Resume only
  // clears the flag; it does not restart the pipeline (POST /advance does).
  const toggleAbort = useCallback(async (action: "abort" | "resume") => {
    if (!caseId) return;
    setAborting(true);
    try {
      const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/${action}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      poll();
    } catch (e) {
      setErr(`${action} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAborting(false);
    }
  }, [caseId, poll]);

  const view = data;

  // Transcript panels for every call the case actually made. Intake first —
  // on an inbound demo that is the family's own call.
  const transcriptCalls = useMemo<LaunchedCall[]>(() => {
    const label = (c: Activity["calls"][number]) =>
      c.purpose === "intake"
        ? "Grace Intake ← family"
        : c.purpose === "negotiation"
          ? `Grace Closer → ${c.provider_id ?? "provider"}`
          : `Grace Caller → ${c.provider_id ?? "provider"}`;
    return (view?.calls ?? [])
      .filter((c): c is Activity["calls"][number] & { conversation_id: string } =>
        Boolean(c.conversation_id))
      .map((c) => ({
        label: label(c),
        conversation_id: c.conversation_id,
        provider_id: c.provider_id ?? undefined,
      }));
  }, [view]);
  const activePipe = useMemo(() => {
    if (!view) return -1;
    return PIPELINE.findIndex((s) => s.derive(view).state === "active");
  }, [view]);

  return (
    <div className="space-y-5">
      <style>{`
        @keyframes graceFlow { 0% { transform: translateX(-100%);} 100% { transform: translateX(100%);} }
        .grace-flow { background: linear-gradient(90deg, transparent, #14b8a6, transparent); animation: graceFlow 1.1s linear infinite; }
        @keyframes graceBlink { 0%,100%{opacity:1;} 50%{opacity:0.25;} }
        .grace-blink { animation: graceBlink 1s ease-in-out infinite; }
        @keyframes graceGlow { 0%,100%{ box-shadow:0 0 0 0 #14b8a600;} 50%{ box-shadow:0 0 0 6px #14b8a61a;} }
      `}</style>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "#12213f" }}>Grace — Live Agent Loop</h1>
          <p className="text-sm text-grace-muted">Three live voice agents, one shared case record — lit up in real time.</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-800">
          <Users className="h-4 w-4" /> Demo scope: consented team numbers only
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-grace-border bg-white p-3">
        <label className="text-xs font-semibold text-grace-muted">Case</label>
        <select
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          className="min-w-[19rem] rounded-md border border-grace-border bg-white px-2 py-1 text-sm"
        >
          {cases.map((c) => (
            // Full id: ours are readable (case_YYYYMMDD_NNN), not UUIDs, so the
            // old slice(0, 8) cut every one of them down to "case_202".
            <option key={c.case_id} value={c.case_id}>
              {c.status} · {c.case_id}
            </option>
          ))}
          {!cases.length && <option value="">no cases yet</option>}
        </select>
        {view && (
          <span className="rounded-full bg-grace-accentSoft px-2.5 py-1 text-xs font-semibold text-grace-accent">
            {view.case.status}
          </span>
        )}
        {view?.case.aborted && (
          <span className="rounded-full bg-grace-dangerSoft px-2.5 py-1 text-xs font-bold text-grace-danger">
            ⛔ STOPPED — no further calls
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-grace-muted">
            <span className="h-2 w-2 rounded-full bg-emerald-500 grace-blink" />
            live · polling 1.6s
          </span>
          <button
            onClick={() => toggleAbort(view?.case.aborted ? "resume" : "abort")}
            disabled={!caseId || aborting}
            title={view?.case.aborted
              ? "Clear the stop flag so this case can place calls again (does not restart the pipeline)."
              : "Stop this case placing any further calls. A call already ringing still finishes."}
            className={`rounded-md border px-3 py-1.5 text-sm font-semibold hover:brightness-95 disabled:opacity-40 ${
              view?.case.aborted
                ? "border-grace-accent bg-grace-accentSoft text-grace-accent"
                : "border-grace-danger bg-grace-dangerSoft text-grace-danger"
            }`}
          >
            {aborting ? "…" : view?.case.aborted ? "▶ Resume" : "⛔ Stop agents"}
          </button>
        </div>
      </div>

      {/* The consumer dials Grace; the loop starts itself. Outbound "run it
          live" controls were removed — nothing here places a call. */}
      <div className="flex items-center gap-2 rounded-xl border-2 border-teal-200 bg-teal-50/50 px-4 py-3">
        <PhoneCall className="h-4 w-4 shrink-0 text-teal-700" />
        <span className="text-sm font-semibold text-teal-900">Waiting for the family to call Grace</span>
        <span className="text-[11px] text-teal-800">
          The case appears here once the intake call ends, then the loop runs itself.
        </span>
      </div>

      {err && !view && (
        <div className="rounded-lg border border-grace-dangerSoft bg-grace-dangerSoft p-3 text-sm text-grace-danger">
          Couldn’t load live activity ({err}). Pick a case, or wait for the next one to arrive.
        </div>
      )}

      {view && (
        <>
          {/* Pipeline */}
          <div className="overflow-x-auto pb-2">
            <div className="flex items-stretch gap-0 pt-4" style={{ minWidth: "min-content" }}>
              {PIPELINE.map((def, i) => (
                <div key={def.id} className="flex items-center">
                  <Node def={def} d={view} />
                  {i < PIPELINE.length - 1 && <Arrow on={activePipe === i} />}
                </div>
              ))}
            </div>
          </div>

          {/* Shared layer */}
          <div className="rounded-2xl border border-dashed border-grace-border bg-grace-bg/60 p-4">
            <div className="mb-3 text-center text-xs font-bold uppercase tracking-wider text-grace-muted">
              Shared Case Record &amp; Evidence Layer
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {SHARED.map((def) => (
                <Node key={def.id} def={def} d={view} big />
              ))}
            </div>
          </div>

          {/* Guardrail banner + live event ticker */}
          <div className="flex flex-col gap-3 lg:flex-row">
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 lg:w-1/2">
              <ShieldCheck className="h-5 w-5" /> No booking, payment, or disposition authorization.
            </div>
            <div className="rounded-xl border border-grace-border bg-white p-3 lg:w-1/2">
              <div className="mb-1 text-xs font-semibold text-grace-muted">Recent events</div>
              <div className="max-h-28 space-y-1 overflow-y-auto">
                {view.events.length ? view.events.slice(0, 8).map((e, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-grace-ink">{e.type}</span>
                    <span className="text-grace-muted">{e.actor}</span>
                  </div>
                )) : <div className="text-[11px] text-grace-muted">No events yet for this case.</div>}
              </div>
            </div>
          </div>

          {/* Call transcripts — every call on this case, including the
              consumer's own inbound intake. Driven by the case record rather
              than by manual launches, so an inbound demo still shows them. */}
          {transcriptCalls.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm font-bold" style={{ color: "#12213f" }}>Call transcripts</div>
              <div className="grid gap-3 lg:grid-cols-2">
                {transcriptCalls.map((c) => <CallTranscript key={c.conversation_id} call={c} />)}
              </div>
            </div>
          )}

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-grace-muted">
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "#0d9488" }} /> Live voice agent (Intake · Caller · Closer)</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "#4338ca" }} /> Providers</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "#2563eb" }} /> OpenAI</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "#7c3aed" }} /> Tavily</span>
            <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" style={{ color: "#3d6b4a" }} /> done</span>
          </div>
        </>
      )}
    </div>
  );
}
