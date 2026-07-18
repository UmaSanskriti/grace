# Grace

**A family-controlled funeral-arrangements advocate.** Grace gathers requirements
by text or voice, calls providers with the same confirmed brief, obtains comparable
itemized quotes, negotiates within a pre-authorized honesty policy, ranks providers
by fit and certainty as well as cost, and reports back — **it never signs, pays,
books, authorizes disposition, or transfers remains.**

> Hackathon MVP · Jurisdiction: California · Synthetic data + pre-consented team
> members only. This is a product/engineering spec implementation, **not legal advice**.

## Architecture (exactly three live voice agents)

```
Consumer ──SMS/voice──► Grace Intake ──► confirmed CaseSpec (frozen version+hash)
                                            │
                                            ▼
                         Grace Caller ×3 (parallel) ──► itemized quotes
                                            │
                          normalize + audit (deterministic tools)
                                            │
                         Grace Closer ──► verified-leverage negotiation
                                            │
                       deterministic ranking + tie logic ──► report
                                            │
                         Grace Closer (consumer explanation) + SMS summary
```

Intake, Caller, and Closer are the **only** conversational agents (distinct
ElevenLabs agent IDs, prompts, tool allowlists, eval rubrics — INV-13). Research,
normalization, audit, ranking, scheduling, ledger, and the demo funeral home are
**tools / deterministic services / human roleplayers**, never additional agents.

## Stack
- **Backend:** Lovable Cloud / Supabase — PostgreSQL, Deno Edge Functions, private storage, secrets.
- **Voice:** ElevenLabs Agents over Twilio (μ-law 8 kHz). Recording OFF, audio saving OFF.
- **SMS:** Twilio Programmable Messaging (feasibility-gated — see canary runbook).
- **Structured text:** OpenAI Responses API, `json_schema` strict mode.
- **Research:** Tavily (cached official/fixture facts only; never on the live voice turn).
- **Frontend:** React + Vite + Tailwind + shadcn (Lovable-compatible).

## Repo layout
```
config/                 versioned JSON: personas+price matrix, questions/weights, disclosure
supabase/
  migrations/           canonical DB schema + RLS (§6.2)
  functions/
    _shared/            types.ts (frozen contracts), auth, clients, openai, ranking, ledger
    <endpoint>/         one Deno function per §6.3 endpoint
agents/                 three agent prompts + tool schemas + eval rubrics
web/                    consent/enrollment, case dashboard, roleplayer console
tests/                  contract tests (§11.1) + golden fixtures (§11.2)
docs/                   telephony canary, setup runbook, architecture, acceptance checklist
```

## Getting to a running demo
1. **Human account setup** (cannot be automated — §8.1): create Twilio trial,
   ElevenLabs (redeem hackathon credit), Lovable Cloud/Supabase, OpenAI, Tavily.
   Follow [`docs/runbook.md`](docs/runbook.md).
2. **Twilio canary first hour** — [`docs/telephony-canary.md`](docs/telephony-canary.md).
   SMS is a go/no-go gate; voice proceeds regardless.
3. `cp .env.example .env` and fill in keys. Add allowlisted numbers to `DEMO_ALLOWED_E164`.
4. Apply DB migration, deploy Edge Functions, create the three ElevenLabs agents
   from `agents/`, point the Twilio Messaging webhook at `/twilio/sms`.
5. `cd web && npm install && npm run dev` for the consent screen + dashboard + console.
6. Run the acceptance checklist in [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md).

See [`CONTRACTS.md`](CONTRACTS.md) for module boundaries and the full spec at
`Grace_Three_Agent_Execution_Ready_Technical_Specification.docx`.
