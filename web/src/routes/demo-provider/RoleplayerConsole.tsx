import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  TriangleAlert,
  Eye,
  PhoneOutgoing,
  HandCoins,
  Ban,
  Check,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Table, THead, TBody, TR, TH, TD } from "../../components/ui/table";
import {
  personas,
  personaById,
  vertical,
  categoryLabel,
} from "../../lib/config";
import { formatUSD } from "../../lib/utils";

interface LogEntry {
  ts: string;
  action: string;
  detail: string;
}

export default function RoleplayerConsole() {
  const { personaId = "A" } = useParams();
  const navigate = useNavigate();
  const persona = personaById(personaId);

  const [log, setLog] = useState<LogEntry[]>([]);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const prohibited = useMemo(() => {
    const set = new Set<string>();
    (persona?.prohibited_disclosures ?? []).forEach((p) => set.add(p));
    vertical.data_minimization_never_collect.forEach((p) => set.add(p));
    set.add("real business identity");
    set.add("any non-synthetic detail");
    return Array.from(set);
  }, [persona]);

  if (!persona) {
    return (
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Unknown persona &ldquo;{personaId}&rdquo;</CardTitle>
            <CardDescription>Choose a synthetic demo persona:</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {personas.personas.map((p) => (
              <Button
                key={p.persona_id}
                variant="outline"
                onClick={() => navigate(`/demo-provider/${p.persona_id}`)}
              >
                {p.persona_id} — {p.label}
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  function addLog(action: string, detail: string) {
    const entry = {
      ts: new Date().toLocaleTimeString(),
      action,
      detail,
    };
    // Supporting telemetry only — never calls Grace (§7.7).
    // eslint-disable-next-line no-console
    console.log(`[roleplayer:${persona!.persona_id}]`, action, detail);
    setLog((l) => [entry, ...l].slice(0, 50));
  }

  const concession = persona.allowed_concession;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* RED synthetic banner (§7.7) */}
      <div
        role="alert"
        className="flex items-center gap-2 rounded-md bg-grace-danger px-4 py-3 text-sm font-semibold text-white"
      >
        <TriangleAlert className="h-5 w-5 shrink-0" />
        {personas.roleplayer_console.banner}
      </div>

      {/* Persona switcher */}
      <div className="flex flex-wrap gap-2">
        {personas.personas.map((p) => (
          <Button
            key={p.persona_id}
            size="sm"
            variant={p.persona_id === persona.persona_id ? "primary" : "outline"}
            onClick={() => navigate(`/demo-provider/${p.persona_id}`)}
          >
            Persona {p.persona_id}
          </Button>
        ))}
      </div>

      {/* Persona card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Badge tone="accent">Persona {persona.persona_id}</Badge>
            <CardTitle>{persona.label}</CardTitle>
          </div>
          <CardDescription>
            Provider ID <span className="font-mono">{persona.provider_id}</span>.
            Grace initiates all provider sessions — this console never calls
            Grace.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-grace-muted">
              Motivation
            </div>
            <p>{persona.motivation}</p>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-grace-muted">
              Capacity
            </div>
            <p>{persona.capacity}</p>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-grace-muted">
              Behavior
            </div>
            <p>{persona.behavior}</p>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-grace-muted">
              Hard constraint
            </div>
            <p>{persona.hard_constraint}</p>
          </div>
        </CardContent>
      </Card>

      {/* Shared synthetic case facts */}
      <Card>
        <CardHeader>
          <CardTitle>Shared synthetic case</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p>{personas.synthetic_case_summary}</p>
          <p className="mt-2 text-xs text-grace-muted">
            You may improvise wording, but never prices or constraints outside
            this card (§7.1 realism rule).
          </p>
        </CardContent>
      </Card>

      {/* Line items + concession floor */}
      <Card>
        <CardHeader>
          <CardTitle>Line items &amp; concession floor</CardTitle>
          <CardDescription>
            Reveal items only as Grace asks. Concede only what your card allows.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Category</TH>
                <TH>Amount</TH>
                <TH className="text-right">Revealed?</TH>
              </TR>
            </THead>
            <TBody>
              {Object.entries(persona.prices).map(([cat, amount]) => (
                <TR key={cat}>
                  <TD>{categoryLabel(cat)}</TD>
                  <TD className="font-mono">{formatUSD(amount)}</TD>
                  <TD className="text-right">
                    {revealed[cat] ? (
                      <Badge tone="ok">revealed</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRevealed((r) => ({ ...r, [cat]: true }));
                          addLog("reveal_item", `${cat} = ${formatUSD(amount)}`);
                        }}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        reveal
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
        <CardContent className="border-t border-grace-border space-y-2 text-sm">
          <div className="flex flex-wrap gap-4">
            {persona.headline_quote != null && (
              <div>
                <span className="text-xs text-grace-muted">Headline quote</span>
                <div className="font-mono font-semibold">
                  {formatUSD(persona.headline_quote)}
                </div>
              </div>
            )}
            {persona.initial_total != null && (
              <div>
                <span className="text-xs text-grace-muted">
                  Initial total{persona.initial_total_is_package_range ? " (package/range)" : ""}
                </span>
                <div className="font-mono font-semibold">
                  {formatUSD(persona.initial_total)}
                </div>
              </div>
            )}
            <div>
              <span className="text-xs text-grace-muted">Resolved total</span>
              <div className="font-mono font-semibold">
                {formatUSD(persona.resolved_total)}
              </div>
            </div>
            {concession.revised_total != null && (
              <div>
                <span className="text-xs text-grace-muted">
                  Revised total (after concession)
                </span>
                <div className="font-mono font-semibold text-grace-ok">
                  {formatUSD(concession.revised_total)}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-md border border-grace-warn/30 bg-[#f4ecd2]/50 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-grace-warn">
              <HandCoins className="h-4 w-4" />
              Exact concession floor
            </div>
            <p className="mt-1">{concession.description}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <Badge tone="muted">type: {concession.type}</Badge>
              {concession.category && (
                <Badge tone="muted">category: {concession.category}</Badge>
              )}
              <Badge tone="muted">
                price delta: {formatUSD(concession.price_delta)}
              </Badge>
              {concession.requires_verified_leverage && (
                <Badge tone="danger">requires verified leverage</Badge>
              )}
              {concession.post_condition && (
                <Badge tone="warn">then: {concession.post_condition}</Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Allowed questions + prohibited disclosures */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Questions Grace may ask</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <ul className="list-disc space-y-1 pl-5">
              {vertical.consumer_rights_signals.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-grace-danger" />
              <CardTitle>Prohibited disclosures</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {prohibited.map((p) => (
                <Badge key={p} tone="danger">
                  {p}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Action buttons */}
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
          <CardDescription>
            Local telemetry only — logged to this console (and browser console).
            Grace records the real outcome through its post-call pipeline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                addLog("reveal_item", "roleplayer revealed an item on request")
              }
            >
              <Eye className="h-4 w-4" />
              Reveal item
            </Button>
            <Button
              variant="outline"
              onClick={() => addLog("offer_callback", "offered a callback")}
            >
              <PhoneOutgoing className="h-4 w-4" />
              Offer callback
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                addLog(
                  "concede",
                  concession.requires_verified_leverage
                    ? `conceded (requires verified leverage): ${concession.description}`
                    : `conceded: ${concession.description}`
                )
              }
            >
              <Check className="h-4 w-4" />
              Concede
            </Button>
            <Button
              variant="danger"
              onClick={() => addLog("end_decline", "ended or declined the call")}
            >
              <Ban className="h-4 w-4" />
              End / decline
            </Button>
          </div>

          {log.length > 0 && (
            <div className="rounded-md border border-grace-border">
              <div className="border-b border-grace-border px-3 py-2 text-xs font-medium text-grace-muted">
                Action log
              </div>
              <ul className="max-h-48 divide-y divide-grace-border overflow-auto text-sm">
                {log.map((e, i) => (
                  <li key={i} className="flex gap-3 px-3 py-2">
                    <span className="font-mono text-xs text-grace-muted">
                      {e.ts}
                    </span>
                    <Badge tone="muted">{e.action}</Badge>
                    <span className="text-grace-muted">{e.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
