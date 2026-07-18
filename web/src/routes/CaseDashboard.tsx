import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  RefreshCw,
  CircleCheck,
  CircleDot,
  Circle,
  TriangleAlert,
  ArrowRight,
  FileText,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Table, THead, TBody, TR, TH, TD } from "../components/ui/table";
import { Markdown } from "../components/Markdown";
import { api, ApiError, isApiConfigured } from "../lib/api";
import { demoContext, demoReport } from "../lib/fixtures";
import { formatUSD, maskPhone } from "../lib/utils";
import { personas } from "../lib/config";
import type {
  AuditFlag,
  CaseContextResponse,
  CaseReportResponse,
  CaseStatus,
  ProviderScore,
  QuoteResult,
} from "../types";

const STAGES: CaseStatus[] = [
  "NEW",
  "CONSENTED",
  "PREFERENCE_SMS_SENT",
  "TEXT_INTAKE",
  "INTAKE_AGENT_ACTIVE",
  "CASE_DRAFT",
  "CASE_CONFIRMED",
  "CALLER_BATCH_QUEUED",
  "CALLER_AGENT_ACTIVE",
  "QUOTE_CAPTURED",
  "QUOTES_NORMALIZED_AND_AUDITED",
  "CLOSER_READY",
  "CLOSER_NEGOTIATION_ACTIVE",
  "QUOTE_REVISED",
  "REPORT_READY",
  "CLOSER_CONSUMER_CALL_ACTIVE",
  "CONSUMER_UPDATED",
  "CLOSED",
];

const POLL_MS = 5000;

function providerLabel(providerId: string | null): string {
  if (!providerId) return "—";
  const p = personas.personas.find((x) => x.provider_id === providerId);
  return p ? p.label : providerId;
}

// -------------------- State machine --------------------
function StateMachine({ status }: { status: CaseStatus }) {
  const currentIdx = STAGES.indexOf(status);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Case progress (§3.3 state machine)</CardTitle>
        <CardDescription>
          Current stage: <Badge tone="accent">{status}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-wrap gap-x-2 gap-y-2">
          {STAGES.map((stage, i) => {
            const done = currentIdx >= 0 && i < currentIdx;
            const active = i === currentIdx;
            return (
              <li key={stage} className="flex items-center gap-1.5">
                <span
                  className={
                    active
                      ? "flex items-center gap-1 rounded-full bg-grace-accent px-2.5 py-1 text-xs font-semibold text-white"
                      : done
                      ? "flex items-center gap-1 rounded-full bg-grace-accentSoft px-2.5 py-1 text-xs font-medium text-grace-accent"
                      : "flex items-center gap-1 rounded-full bg-grace-bg px-2.5 py-1 text-xs text-grace-muted"
                  }
                >
                  {active ? (
                    <CircleDot className="h-3 w-3" />
                  ) : done ? (
                    <CircleCheck className="h-3 w-3" />
                  ) : (
                    <Circle className="h-3 w-3" />
                  )}
                  {stage}
                </span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

// -------------------- CaseSpec --------------------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-grace-border p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-grace-muted">
        {label}
      </div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function CaseSpecPanel({ ctx }: { ctx: CaseContextResponse }) {
  const spec = ctx.case_spec;
  const [showJson, setShowJson] = useState(false);
  if (!spec) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Confirmed CaseSpec</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-grace-muted">
            No confirmed CaseSpec yet. It is frozen at the YES confirmation gate
            (§4.5).
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>Confirmed CaseSpec</CardTitle>
          <CardDescription>
            Version {spec.version}
            {ctx.case_spec_hash ? (
              <>
                {" "}
                · hash <span className="font-mono">{ctx.case_spec_hash}</span>
              </>
            ) : null}
            {spec.confirmed_at ? ` · confirmed ${spec.confirmed_at}` : ""}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowJson((v) => !v)}>
          {showJson ? "Field cards" : "Raw JSON"}
        </Button>
      </CardHeader>
      <CardContent>
        {showJson ? (
          <pre className="max-h-96 overflow-auto rounded-md bg-grace-bg p-3 text-xs">
            {JSON.stringify(spec, null, 2)}
          </pre>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Mode">{spec.mode}</Field>
            <Field label="Jurisdiction">
              {spec.jurisdiction.country} / {spec.jurisdiction.state}
            </Field>
            <Field label="Disposition">{spec.disposition ?? "—"}</Field>
            <Field label="Cost posture">{spec.cost_posture}</Field>
            <Field label="Pickup ZIP">
              {spec.location.pickup_zip ?? "—"} · {spec.location.search_radius_miles} mi radius
            </Field>
            <Field label="Custody">
              {spec.custody.current_location_type ?? "—"}
              {spec.custody.transfer_deadline_at
                ? ` · deadline ${spec.custody.transfer_deadline_at}`
                : " · no deadline"}
            </Field>
            <Field label="Authority">
              {spec.authority.confirmed_for_demo ? "confirmed" : "not confirmed"}
              {spec.authority.role ? ` · ${spec.authority.role}` : ""}
            </Field>
            <Field label="Budget (never shared)">
              {spec.budget_user_stated ?? "not shared"} · mention_budget=
              {String(spec.permissions.mention_budget)}
            </Field>
            <Field label="Must-haves">
              <div className="flex flex-wrap gap-1">
                {spec.must_haves.length
                  ? spec.must_haves.map((m) => (
                      <Badge key={m} tone="accent">
                        {m}
                      </Badge>
                    ))
                  : "—"}
              </div>
            </Field>
            <Field label="Service preferences">
              <div className="flex flex-wrap gap-1">
                {Object.entries(spec.service_preferences).map(([k, v]) => (
                  <Badge key={k} tone="muted">
                    {k}: {String(v)}
                  </Badge>
                ))}
              </div>
            </Field>
            <Field label="Permissions">
              <div className="flex flex-wrap gap-1">
                {Object.entries(spec.permissions).map(([k, v]) => (
                  <Badge key={k} tone={v ? "ok" : "muted"}>
                    {v ? "✓" : "✗"} {k}
                  </Badge>
                ))}
              </div>
            </Field>
            <Field label="Facts disallowed">
              <div className="flex flex-wrap gap-1">
                {spec.facts_disallowed.map((f) => (
                  <Badge key={f} tone="danger">
                    {f}
                  </Badge>
                ))}
              </div>
            </Field>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// -------------------- Audit flags --------------------
function AuditFlags({ flags }: { flags: AuditFlag[] }) {
  if (!flags.length) return <Badge tone="ok">none</Badge>;
  const tone = flags.some((f) => f.severity === "error")
    ? "danger"
    : flags.some((f) => f.severity === "warn")
    ? "warn"
    : "muted";
  return (
    <div className="flex flex-col gap-1">
      {flags.map((f, i) => (
        <span key={i} className="flex items-start gap-1">
          <Badge tone={tone}>{f.code}</Badge>
          <span className="text-xs text-grace-muted">{f.message}</span>
        </span>
      ))}
    </div>
  );
}

// must-have coverage from breakdown.must_have_fit
function MustHaveCoverage({ fit }: { fit: number }) {
  if (fit >= 0.99) return <Badge tone="ok">met</Badge>;
  if (fit <= 0) return <Badge tone="danger">not met</Badge>;
  if (fit < 0.5) return <Badge tone="danger">not met (partial)</Badge>;
  return <Badge tone="warn">partial / unknown</Badge>;
}

// -------------------- Comparison table --------------------
function ComparisonTable({
  scores,
  quotes,
}: {
  scores: ProviderScore[];
  quotes: QuoteResult[];
}) {
  const quoteById = new Map(quotes.map((q) => [q.quote_id, q]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Three-provider comparison</CardTitle>
        <CardDescription>
          Comparable totals after required fees are resolved and audit penalties
          applied. Amounts without evidence are marked <em>unknown</em> (INV-08).
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <THead>
            <TR>
              <TH>Provider</TH>
              <TH>Price type</TH>
              <TH>Comparable total</TH>
              <TH>Must-have coverage</TH>
              <TH>Score</TH>
              <TH>Audit flags</TH>
            </TR>
          </THead>
          <TBody>
            {scores.map((s) => {
              const q = s.quote_id ? quoteById.get(s.quote_id) : undefined;
              return (
                <TR key={s.provider_id}>
                  <TD className="font-medium">
                    {providerLabel(s.provider_id)}
                    {s.hard_failed && (
                      <div className="mt-1">
                        <Badge tone="danger">
                          hard fail: {s.hard_fail_reason}
                        </Badge>
                      </div>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={q?.price_type === "firm" ? "ok" : "muted"}>
                      {q?.price_type ?? "—"}
                    </Badge>
                  </TD>
                  <TD className="font-mono">
                    {formatUSD(s.comparable_total)}
                  </TD>
                  <TD>
                    <MustHaveCoverage fit={s.breakdown.must_have_fit} />
                  </TD>
                  <TD className="font-mono">{Math.round(s.score)}</TD>
                  <TD>
                    <AuditFlags flags={s.audit_flags} />
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// -------------------- Ranked report --------------------
function RankedReportPanel({ report }: { report: CaseReportResponse }) {
  const r = report.report;
  if (!r) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Ranked report</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-grace-muted">
            Report not ready yet. Grace ranks options only after quotes are
            normalized and audited.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ranked report</CardTitle>
        <CardDescription>
          {r.is_tie ? "Effective tie — trade-off, no forced choice" : "Recommendation"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {r.is_tie ? (
          <div className="rounded-md border border-grace-warn/30 bg-[#f4ecd2]/50 p-3">
            <div className="flex items-center gap-2 font-medium text-grace-warn">
              <TriangleAlert className="h-4 w-4" />
              Two providers are effectively tied
            </div>
            <p className="mt-1 text-sm">{r.tie_reason}</p>
            {r.material_tradeoff && (
              <p className="mt-2 text-sm">
                <strong>Trade-off:</strong> {r.material_tradeoff}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-grace-ok/30 bg-grace-accentSoft p-3">
            <div className="flex items-center gap-2 font-medium text-grace-ok">
              <CircleCheck className="h-4 w-4" />
              Recommended: {providerLabel(r.recommended_provider_id)}
            </div>
            {r.runner_up_provider_id && (
              <p className="mt-1 text-sm text-grace-muted">
                Runner-up: {providerLabel(r.runner_up_provider_id)}
              </p>
            )}
            {r.material_tradeoff && (
              <p className="mt-2 text-sm">
                <strong>Material trade-off:</strong> {r.material_tradeoff}
              </p>
            )}
          </div>
        )}
        <div className="flex items-start gap-2 rounded-md bg-grace-bg p-3 text-sm">
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-grace-accent" />
          <span>
            <strong>Next human action:</strong> {r.next_human_action}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// -------------------- Negotiation deltas --------------------
function NegotiationPanel({ ctx }: { ctx: CaseContextResponse }) {
  const revised = ctx.revised_terms ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Negotiation — before / after</CardTitle>
        <CardDescription>
          Bounded, non-binding. Grace cannot book or authorize anything (INV-06).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ctx.verified_leverage && (
          <div className="rounded-md border border-grace-border p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-grace-muted">
              Verified leverage used
            </div>
            <p className="mt-1">
              &ldquo;{ctx.verified_leverage.allowed_disclosure_sentence}&rdquo;
            </p>
            <p className="mt-1 text-xs text-grace-muted">
              From {providerLabel(ctx.verified_leverage.provider_id)} · supported{" "}
              {formatUSD(ctx.verified_leverage.supported_amount)} (audited, INV-05)
            </p>
          </div>
        )}
        {revised.length === 0 ? (
          <p className="text-sm text-grace-muted">No revisions recorded.</p>
        ) : (
          revised.map((rt, i) => (
            <div
              key={i}
              className="rounded-md border border-grace-border p-3 text-sm"
            >
              <div className="font-medium">{providerLabel(rt.provider_id)}</div>
              <div className="mt-2 flex items-center gap-3">
                <span className="font-mono line-through text-grace-muted">
                  {formatUSD(rt.before_amount)}
                </span>
                <ArrowRight className="h-4 w-4 text-grace-accent" />
                <span className="font-mono font-semibold text-grace-ok">
                  {formatUSD(rt.after_amount)}
                </span>
                {rt.before_amount != null && rt.after_amount != null && (
                  <Badge tone="ok">
                    {formatUSD(rt.after_amount - rt.before_amount)}
                  </Badge>
                )}
              </div>
              {rt.term_change && (
                <p className="mt-2 text-grace-muted">
                  {rt.changed_category ? (
                    <span className="font-medium">{rt.changed_category}: </span>
                  ) : null}
                  {rt.term_change}
                </p>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// -------------------- Ledger --------------------
function LedgerPanel({ ctx }: { ctx: CaseContextResponse }) {
  const [tab, setTab] = useState<"evidence" | "context">("evidence");
  const md =
    tab === "evidence" ? ctx.evidence_markdown : ctx.context_markdown;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-grace-accent" />
          <CardTitle>Markdown evidence ledger</CardTitle>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === "evidence" ? "secondary" : "ghost"}
            onClick={() => setTab("evidence")}
          >
            evidence.md
          </Button>
          <Button
            size="sm"
            variant={tab === "context" ? "secondary" : "ghost"}
            onClick={() => setTab("context")}
          >
            context.md
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {md ? (
          <div className="max-h-[520px] overflow-auto rounded-md border border-grace-border bg-grace-surface p-4">
            <Markdown source={md} />
          </div>
        ) : (
          <p className="text-sm text-grace-muted">No ledger available yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ==================== Page ====================
export default function CaseDashboard() {
  const { caseId = "" } = useParams();
  const [ctx, setCtx] = useState<CaseContextResponse | null>(null);
  const [report, setReport] = useState<CaseReportResponse | null>(null);
  const [usingDemo, setUsingDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timer = useRef<number | null>(null);

  const loadDemo = useCallback(() => {
    setCtx(demoContext(caseId || "demo-case"));
    setReport(demoReport(caseId || "demo-case"));
    setUsingDemo(true);
    setError(null);
    setLoading(false);
    setLastUpdated(new Date());
  }, [caseId]);

  const poll = useCallback(async () => {
    if (!isApiConfigured()) {
      loadDemo();
      return;
    }
    try {
      const [c, r] = await Promise.all([
        api.getContext(caseId),
        api.getReport(caseId).catch(() => null),
      ]);
      setCtx(c);
      if (r) setReport(r);
      setUsingDemo(false);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      // Fall back to synthetic demo data so the UI is always demonstrable.
      const msg = err instanceof ApiError ? err.message : String(err);
      setError(msg);
      if (!ctx) loadDemo();
    } finally {
      setLoading(false);
    }
  }, [caseId, ctx, loadDemo]);

  useEffect(() => {
    poll();
    timer.current = window.setInterval(poll, POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Case dashboard</h1>
          <p className="text-sm text-grace-muted">
            Case <span className="font-mono">{caseId}</span>
            {ctx?.masked_phone ? (
              <>
                {" "}
                · consumer <span className="font-mono">{maskPhone(ctx.masked_phone)}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-xs text-grace-muted">
              updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={poll}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {usingDemo && (
        <div className="flex gap-2 rounded-md border border-grace-border bg-grace-bg p-3 text-xs text-grace-muted">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-grace-warn" />
          <span>
            Showing <strong>synthetic demo data</strong>
            {error ? ` (live fetch failed: ${error})` : " (no backend configured)"}
            . Set <code>VITE_APP_BASE_URL</code> to poll live case data.
          </span>
        </div>
      )}

      {loading && !ctx ? (
        <p className="text-sm text-grace-muted">Loading case…</p>
      ) : ctx ? (
        <>
          <StateMachine status={ctx.status} />
          <CaseSpecPanel ctx={ctx} />
          {ctx.comparison && ctx.comparison.length > 0 && (
            <ComparisonTable scores={ctx.comparison} quotes={ctx.quotes} />
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {report && <RankedReportPanel report={report} />}
            <NegotiationPanel ctx={ctx} />
          </div>
          <LedgerPanel ctx={ctx} />
        </>
      ) : (
        <p className="text-sm text-grace-danger">
          Could not load case. {error}
        </p>
      )}
    </div>
  );
}
