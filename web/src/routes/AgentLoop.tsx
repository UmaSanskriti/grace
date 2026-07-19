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
const ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";

type NodeState = "idle" | "active" | "done";
interface ActNode { id: string; label: string; kind: string; state: string; activity: string; output: string }
interface Activity {
  case: { case_id: string; status: string; progress: number; preferred_channel: string; current_version: number };
  active_node: string | null;
  nodes: ActNode[];
  calls: { purpose: string; provider_id: string | null; status: string }[];
  events: { type: string; actor: string; timestamp: string }[];
  summary: { quotes: number; audited: number; audit_flags: number; is_tie: boolean | null; recommended: string | null };
}
interface CaseRow { case_id: string; status: string; current_version: number; created_at: string }

const authHeaders: Record<string, string> = ANON ? { apikey: ANON, Authorization: `Bearer ${ANON}` } : {};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

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
    n: 5, id: "caller", title: "Grace Caller Agent ×3", sub: "same brief to every provider",
    kind: "voice", color: "#0d9488", Icon: PhoneCall,
    derive: (d) => { const x = nodeById(d, "caller"); return { state: asState(x?.state), activity: x?.activity ?? "Idle", output: x?.output ?? "—" }; },
  },
  {
    n: 6, id: "homes", title: "Three Demo Funeral Homes", sub: "Transparent · Package-first · Hidden-fee",
    kind: "tool", color: "#4338ca", Icon: Building2,
    derive: (d) => ({
      state: d.case.progress >= 6 && d.case.progress <= 8 ? "active" : d.case.progress >= 9 ? "done" : "idle",
      activity: d.case.progress >= 9 ? "All outcomes captured" : d.case.progress >= 6 ? "Answering itemized questions" : "Standby",
      output: `${d.summary.quotes}/3 quote outcomes`,
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
    id: "lovable", title: "Lovable App", sub: "UI + backend", kind: "tool", color: "#0d9488", Icon: Laptop,
    derive: () => ({ state: "active", activity: "Serving UI + Edge Functions", output: "live" }),
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

// ---- Simulation: step a synthetic case through the loop for demos ----
function simulate(progress: number): Activity {
  const STATES = ["NEW","CONSENTED","PREFERENCE_SMS_SENT","INTAKE_AGENT_ACTIVE","CASE_DRAFT","CASE_CONFIRMED",
    "CALLER_BATCH_QUEUED","CALLER_AGENT_ACTIVE","QUOTE_CAPTURED","QUOTES_NORMALIZED_AND_AUDITED","CLOSER_READY",
    "CLOSER_NEGOTIATION_ACTIVE","QUOTE_REVISED","REPORT_READY","CLOSER_CONSUMER_CALL_ACTIVE","CONSUMER_UPDATED","CLOSED"];
  const status = STATES[Math.min(progress, STATES.length - 1)];
  const quotes = progress >= 8 ? 3 : progress >= 7 ? 2 : progress >= 6 ? 1 : 0;
  const mk = (id: string, state: string, activity: string, output: string): ActNode =>
    ({ id, label: id, kind: "tool", state, activity, output });
  const A = (lo: number, hi: number) => (progress >= lo && progress <= hi ? "active" : progress > hi ? "done" : "idle");
  return {
    case: { case_id: "SIMULATION", status, progress, preferred_channel: "voice", current_version: progress >= 5 ? 4 : 0 },
    active_node: null,
    nodes: [
      mk("intake", progress >= 3 && progress <= 4 ? "active" : progress >= 5 ? "done" : "idle",
        progress >= 3 && progress <= 4 ? "On call — running voice intake" : progress >= 5 ? "CaseSpec confirmed" : "Idle",
        progress >= 5 ? "CaseSpec v4 confirmed" : "—"),
      mk("caller", A(6, 8), progress >= 6 && progress <= 8 ? "3 live provider calls" : progress >= 9 ? "outcomes captured" : "Idle", `${quotes}/3 quotes`),
      mk("normalizer", A(8, 8), "Structuring transcripts", progress >= 9 ? "3 normalized" : "—"),
      mk("auditor", A(8, 8), "Flagging hidden fees", progress >= 9 ? "2 flags" : "—"),
      mk("ranker", progress === 9 || progress === 12 ? "active" : progress >= 13 ? "done" : "idle", "Scoring fit/cost/certainty", progress >= 13 ? "recommend demo_transparent" : "—"),
      mk("closer", progress === 11 || progress === 14 ? "active" : progress >= 15 ? "done" : "idle",
        progress === 11 ? "Negotiating with verified leverage" : progress === 14 ? "Explaining ranked result" : progress >= 15 ? "Consumer updated" : "Ready",
        progress === 12 ? "revised terms logged" : "—"),
      mk("research", A(4, 6), "Loading cached fixtures", progress >= 4 ? "fixtures cached" : "—"),
      mk("ledger", "active", "Regenerating evidence.md", `${progress} events`),
    ],
    calls: progress >= 6 && progress <= 8 ? [{ purpose: "initial_quote", provider_id: "demo_hidden_fee", status: "active" }] : [],
    events: [],
    summary: { quotes, audited: progress >= 9 ? 3 : 0, audit_flags: progress >= 9 ? 2 : 0,
      is_tie: false, recommended: progress >= 13 ? "demo_transparent" : null },
  };
}

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
        width: big ? 220 : 172, minHeight: big ? 168 : 150,
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
          <div className="truncate text-[13px] font-semibold leading-tight" style={{ color: "#1f2937" }}>{def.title}</div>
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
  const [sim, setSim] = useState(false);
  const simProg = useRef(0);
  const [, force] = useState(0);

  // "Run it live" controls.
  const [consumerNum, setConsumerNum] = useState("+16172330662");
  const [houseNum, setHouseNum] = useState("+16507327964");
  const [providerId, setProviderId] = useState("demo_transparent");
  const [launching, setLaunching] = useState("");
  const [launchMsg, setLaunchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [launched, setLaunched] = useState<LaunchedCall[]>([]);

  const callConsumer = async () => {
    setLaunching("intake"); setLaunchMsg(null);
    try {
      const r = await post<{ case_id: string; conversation_id: string | null; status: string }>(
        "/demo-call", { kind: "intake", to: consumerNum });
      setCaseId(r.case_id); setSim(false);
      if (r.conversation_id) setLaunched((p) => [{ label: `Grace Intake → consumer ${consumerNum.slice(-4)}`, conversation_id: r.conversation_id! }, ...p]);
      setLaunchMsg({ ok: true, text: `Intake call ringing ${consumerNum}. Pick up!` });
    } catch (e) { setLaunchMsg({ ok: false, text: String(e instanceof Error ? e.message : e) }); }
    finally { setLaunching(""); }
  };

  const callHouse = async () => {
    if (!caseId) { setLaunchMsg({ ok: false, text: "Run the consumer intake call first (it creates the case)." }); return; }
    setLaunching("caller"); setLaunchMsg(null);
    try {
      const r = await post<{ case_id: string; provider_id: string; conversation_id: string | null; status: string }>(
        "/demo-call", { kind: "caller", to: houseNum, provider_id: providerId, case_id: caseId });
      setSim(false);
      if (r.conversation_id) setLaunched((p) => [{ label: `Grace Caller → ${r.provider_id} (${houseNum.slice(-4)})`, conversation_id: r.conversation_id!, provider_id: r.provider_id }, ...p]);
      setLaunchMsg({ ok: true, text: `Caller call ringing ${houseNum} as ${providerId}. Answer as the funeral home!` });
    } catch (e) { setLaunchMsg({ ok: false, text: String(e instanceof Error ? e.message : e) }); }
    finally { setLaunching(""); }
  };

  // Load recent cases once.
  useEffect(() => {
    get<{ cases: CaseRow[] }>("/agent-activity")
      .then((r) => { setCases(r.cases); if (!caseId && r.cases[0]) setCaseId(r.cases[0].case_id); })
      .catch((e) => setErr(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the selected case live (unless simulating).
  const poll = useCallback(() => {
    if (sim || !caseId) return;
    get<Activity>(`/agent-activity?case_id=${encodeURIComponent(caseId)}`)
      .then((r) => { setData(r); setErr(""); })
      .catch((e) => setErr(String(e)));
  }, [sim, caseId]);

  useEffect(() => {
    if (sim) return;
    poll();
    const t = setInterval(poll, 1600);
    return () => clearInterval(t);
  }, [poll, sim]);

  // Simulation ticker.
  useEffect(() => {
    if (!sim) return;
    simProg.current = 0;
    const t = setInterval(() => {
      simProg.current = (simProg.current + 1) % 17;
      setData(simulate(simProg.current));
      force((n) => n + 1);
    }, 1500);
    setData(simulate(0));
    return () => clearInterval(t);
  }, [sim]);

  const view = data;
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
          value={sim ? "SIM" : caseId}
          disabled={sim}
          onChange={(e) => setCaseId(e.target.value)}
          className="rounded-md border border-grace-border bg-white px-2 py-1 text-sm"
        >
          {sim && <option value="SIM">SIMULATION</option>}
          {cases.map((c) => (
            <option key={c.case_id} value={c.case_id}>
              {c.status} · {c.case_id.slice(0, 8)}
            </option>
          ))}
          {!cases.length && <option value="">no cases yet</option>}
        </select>
        {view && (
          <span className="rounded-full bg-grace-accentSoft px-2.5 py-1 text-xs font-semibold text-grace-accent">
            {view.case.status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-grace-muted">
            <span className={`h-2 w-2 rounded-full ${sim ? "bg-amber-500" : "bg-emerald-500"} grace-blink`} />
            {sim ? "SIMULATION" : "live · polling 1.6s"}
          </span>
          <button
            onClick={() => setSim((s) => !s)}
            className="rounded-md border border-grace-border px-3 py-1.5 text-sm font-medium hover:bg-grace-accentSoft"
          >
            {sim ? "Stop simulation" : "▶ Simulate loop"}
          </button>
        </div>
      </div>

      {/* Run it live: place the real calls */}
      <div className="rounded-xl border-2 border-teal-200 bg-teal-50/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-teal-700" />
          <span className="text-sm font-bold text-teal-900">Run it live — place the real calls</span>
          <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-800">1 consumer + 1 funeral house</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-grace-border bg-white p-3">
            <div className="mb-1 text-xs font-semibold text-grace-muted">1 · Consumer (Grace Intake Agent calls them)</div>
            <input value={consumerNum} onChange={(e) => setConsumerNum(e.target.value)}
              className="mb-2 w-full rounded-md border border-grace-border px-2 py-1 font-mono text-sm" />
            <button onClick={callConsumer} disabled={launching !== ""}
              className="w-full rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
              {launching === "intake" ? "Dialing…" : "📞 Call consumer (Intake)"}
            </button>
          </div>
          <div className="rounded-lg border border-grace-border bg-white p-3">
            <div className="mb-1 text-xs font-semibold text-grace-muted">2 · Funeral house (Grace Caller Agent calls them)</div>
            <div className="mb-2 flex gap-2">
              <input value={houseNum} onChange={(e) => setHouseNum(e.target.value)}
                className="w-full rounded-md border border-grace-border px-2 py-1 font-mono text-sm" />
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)}
                className="rounded-md border border-grace-border px-2 py-1 text-sm">
                <option value="demo_transparent">Transparent (A)</option>
                <option value="demo_package_first">Package-first (B)</option>
                <option value="demo_hidden_fee">Hidden-fee (C)</option>
              </select>
            </div>
            <button onClick={callHouse} disabled={launching !== "" || !caseId}
              className="w-full rounded-md bg-indigo-700 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50">
              {launching === "caller" ? "Dialing…" : "📞 Call funeral house (Caller)"}
            </button>
            {!caseId && <div className="mt-1 text-[10px] text-grace-muted">Run the consumer call first (creates the case).</div>}
          </div>
        </div>
        {launchMsg && (
          <div className={`mt-3 rounded-md px-3 py-2 text-sm ${launchMsg.ok ? "bg-emerald-50 text-emerald-800" : "bg-grace-dangerSoft text-grace-danger"}`}>
            {launchMsg.text}
          </div>
        )}
        <div className="mt-2 text-[11px] text-grace-muted">
          Both numbers must be allowlisted + consented. You’ll roleplay the funeral home when the Caller rings. 2 more numbers later → full 3-provider run.
        </div>
      </div>

      {err && !view && (
        <div className="rounded-lg border border-grace-dangerSoft bg-grace-dangerSoft p-3 text-sm text-grace-danger">
          Couldn’t load live activity ({err}). Pick a case or hit “Simulate loop”.
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

          {/* Call transcripts (real calls) */}
          {launched.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm font-bold" style={{ color: "#12213f" }}>Call transcripts</div>
              <div className="grid gap-3 lg:grid-cols-2">
                {launched.map((c) => <CallTranscript key={c.conversation_id} call={c} />)}
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
