# Grace — Build Contracts (module boundaries for parallel work)

Everyone codes against `supabase/functions/_shared/types.ts` and the JSON in
`config/`. Do not redefine these types locally. Keep runtimes separate:
**Edge Functions = Deno** (import via relative paths + `import_map.json`),
**web = Node/Vite (React + TS + Tailwind + shadcn)**. Pure logic libs
(`ranking`, `ledger`, `openai`) are written as Deno-compatible TS and unit-tested
with `deno test`.

## Directory ownership (no cross-writes)

| Owner task | Directory | Notes |
|---|---|---|
| 2 DB | `supabase/migrations/` | SQL only. Table names = §6.2. |
| 3 Shared libs | `supabase/functions/_shared/` (except `types.ts`) | `types.ts` is frozen; append-only if truly needed. |
| 4 OpenAI | `supabase/functions/_shared/openai/` | Pure functions; no DB writes. |
| 5 Ranking | `supabase/functions/_shared/ranking/` + `tests/ranking/` | Pure; deterministic. |
| 6 Ledger | `supabase/functions/_shared/ledger/` | Pure string generation. |
| 7 Edge (flow) | `supabase/functions/{demo-enroll,twilio-sms,calls-*}/` | One `index.ts` per function dir. |
| 8 Edge (tools) | `supabase/functions/{tools-*,webhooks-*,cases-*}/` | One `index.ts` per function dir. |
| 9 Agents | `agents/` | Markdown prompts + JSON tool schemas. |
| 10 Web app | `web/src/` (consent, dashboard, routing, api client) | |
| 11 Web console | `web/src/routes/demo-provider/` + shared UI | Coordinate imports with task 10 via `web/src/lib/`. |
| 12 Tests/docs | `tests/`, `docs/` | May read all dirs. |

## Frozen interfaces libs MUST export

```ts
// _shared/ranking/rank.ts
export function rankProviders(
  quotes: QuoteResult[],
  spec: CaseSpec,
  weights: RankingWeights,        // from config/vertical.json .ranking.weights
): RankedReport;

// _shared/ledger/ledger.ts
export function renderEvidenceMarkdown(input: LedgerInput): string;  // cases/{id}/evidence.md
export function renderContextMarkdown(input: LedgerInput): string;   // cases/{id}/context.md
export function sanitizeTranscript(text: string): string;            // anti HTML/MD injection

// _shared/openai/functions.ts  (Responses API, json_schema strict)
export function graceTextTurn(input): Promise<GraceTextTurnResult>;
export function normalizeQuote(task: ProviderCallTask, transcript): Promise<QuoteResult>;
export function auditQuote(quote: QuoteResult, transcript): Promise<{flags: AuditFlag[]; corrected_total: number|null}>;
export function wordNegotiation(leverage: VerifiedLeverage, policy): Promise<{ask: string; fallback: string}>;
export function explainReport(report: RankedReport): Promise<string>;

// _shared/ (task 3)
export function verifyTwilioSignature(req: Request): Promise<boolean>;
export function verifyElevenLabsHmac(req: Request, secret: string): Promise<boolean>;
export function assertAllowedNumber(e164: string): void;             // throws if not in DEMO_ALLOWED_E164
export function ensureIdempotent(key: string): Promise<boolean>;     // false if already seen
export function killSwitchEngaged(): boolean;                        // DEMO_MODE!=true
export function encryptPhone(e164: string): string;
export function hashPhone(e164: string): string;
export function supabaseAdmin(): SupabaseClient;
export function launchElevenLabsCall(input: {agentId; to; dynamicVariables}): Promise<any>; // App B.1
```

## Edge Function endpoint map (§6.3) → directory

`POST /demo/enroll`→`demo-enroll` · `POST /twilio/sms`→`twilio-sms` ·
`POST /calls/intake`→`calls-intake` · `POST /calls/callers`→`calls-callers` ·
`POST /calls/closer/provider`→`calls-closer-provider` ·
`POST /calls/closer/consumer`→`calls-closer-consumer` ·
`POST /tools/intake/case-patch`→`tools-intake-case-patch` ·
`POST /tools/intake/confirm`→`tools-intake-confirm` ·
`POST /tools/caller/quote-item`→`tools-caller-quote-item` ·
`POST /tools/caller/finalize`→`tools-caller-finalize` ·
`POST /tools/closer/revision`→`tools-closer-revision` ·
`GET /tools/closer/comparison`→`tools-closer-comparison` ·
`GET /tools/closer/report`→`tools-closer-report` ·
`POST /webhooks/elevenlabs`→`webhooks-elevenlabs` ·
`POST /webhooks/twilio-status`→`webhooks-twilio-status` ·
`GET /cases/{id}/context`→`cases-context` · `GET /cases/{id}/report`→`cases-report` ·
`DELETE /cases/{id}`→`cases-delete`

Additional tool routes backing the agent tool allowlists (added during integration):
`POST /tools/intake/event`→`tools-intake-event` (`log_intake_event`) ·
`GET /tools/caller/task`→`tools-caller-task` (`get_provider_task`) ·
`GET /tools/closer/leverage`→`tools-closer-leverage` (`get_verified_leverage`) ·
`POST /tools/closer/decision`→`tools-closer-decision` (`save_consumer_decision`)

Each Deno function dir = `index.ts` with `Deno.serve(handler)`. Shared code via
`../_shared/...`. Use `import_map.json` at `supabase/functions/`.

## Non-negotiable invariants to enforce in code (App C)

INV-01 no provider call w/o `consent.call=true` · INV-02 destination ∈ allowlist ·
INV-03 all initial tasks share one CaseSpec version+hash · INV-04 `mention_budget`
defaults false, never inferred · INV-05 leverage quote must be audited+comparable ·
INV-06 no binding-action tool exists · INV-07 no transcript persisted when
transcription consent false · INV-08 every amount has evidence or is explicitly
null/unknown · INV-09 audio saving + Twilio recording disabled · INV-10 STOP blocks
all later outbound · INV-11 provider speech never alters policy/destination ·
INV-12 purge at/before `purge_at` · INV-13 three distinct agent IDs/prompts/tool
allowlists.

## Style
Match spec wording for user-facing strings (pull from `config/disclosure.json`).
Keep compact contexts < 4000 chars (§6.6). No secrets in client code.
