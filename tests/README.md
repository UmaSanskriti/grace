# Grace — Tests

Contract tests (spec §11.1) and golden fixtures (§11.2). Everything here is written
as Deno-compatible TypeScript and imports the frozen contracts from
`../supabase/functions/_shared/types.ts`. **Do not** redefine those types locally.

> Ownership: task 12 owns `tests/` and `docs/`. `tests/ranking/` is owned by the
> ranking agent — the tie-logic assertions live there, not here.

## How to run

Requires [Deno](https://deno.com/) (matching the version pinned by the Edge
Functions, std `0.224.0`).

The test files import `std/` (assertions) via an import alias, so a config that
defines that alias must be in scope. Any of these entry points work; pick one:

**Simplest — from `tests/`** (Deno auto-discovers `tests/deno.json`):

```bash
cd tests && deno task test          # runs contract/ with the right flags
```

**A) From the repo root, pointing at `tests/deno.json`** (defines the `std/` alias):

```bash
# All contract tests
deno test --config tests/deno.json tests/contract/ --allow-read --allow-env

# A single file
deno test --config tests/deno.json tests/contract/casespec_test.ts --allow-read

# Type-check without executing
deno check --config tests/deno.json tests/contract/*.ts
```

**B) Via the Edge-Functions task** (applies `supabase/functions/import_map.json`,
which also aliases `std/`, and runs `_shared/` + `../../tests/`):

```bash
cd supabase/functions && deno task test
```

> Note: a bare `deno test tests/` from the repo root will **fail** with
> `Import "std/assert/mod.ts" not a dependency` because Deno auto-discovers the
> config nearest the current directory (repo root has none) rather than
> `tests/deno.json`. Always pass `--config tests/deno.json` (option A) or use the
> Edge-Functions task (option B). Both configs map `std/` →
> `https://deno.land/std@0.224.0/`, so the two paths are equivalent.
>
> Last run: **38 contract tests passed** (`casespec` 7, `invariants` 20,
> `sms_routing` 8, `webhook_replay` 3) via both entry points.

## What is pure vs. what needs a backend

**All tests currently in `tests/contract/` are PURE / OFFLINE.** They require no
Twilio, ElevenLabs, OpenAI, Supabase, or network access. Each re-implements the
*decision logic* it guards as a small local stub that mirrors the documented server
contract (e.g. `ensureIdempotent`, the launch gate, the auditor's arithmetic), so
the invariant is validated independently of production code. The only file read is
the local `config/disclosure.json` (a module import, not a network call).

| File | Type | Needs backend? | Covers |
|------|------|----------------|--------|
| `contract/casespec_test.ts` | Pure | No | §11.1 CaseSpec schema; version-on-confirm; **INV-04** |
| `contract/invariants_test.ts` | Pure | No | App C **INV-01..INV-13** (AUTO assertions + documented MANUAL entries) |
| `contract/webhook_replay_test.ts` | Pure | No | §11.1 webhook replay / idempotency (200, no duplicate rows) |
| `contract/sms_routing_test.ts` | Pure | No | §4.2 TEXT/CALL/HELP/STOP routing; exact first SMS; **INV-10** |
| `golden/fixtures.json` | Data | No | Persona C hidden-fee + verified-leverage transcripts for offline normalize/audit/rank |
| `golden/scenarios.md` | Docs | — | The nine §11.2 golden scenarios + expected results |

### Invariant coverage: AUTO vs. MANUAL

`invariants_test.ts` encodes the full App C table. Some invariants are verified by
real assertions (**AUTO**); others are provider-console/config or live-stack
controls (**MANUAL**) — those are encoded as documented tests that assert what *is*
checkable in-repo and carry a `TODO[MANUAL]` marker pointing at the runbook /
compliance doc / acceptance checklist.

- **AUTO:** INV-01, INV-02, INV-03, INV-04 (in `casespec_test.ts`), INV-05, INV-08,
  INV-10, INV-11, INV-12.
- **MANUAL (documented + partial assertion):** INV-06 (no binding-action tool),
  INV-07 (transcript gating), INV-09 (audio/recording disabled), INV-13 (three
  distinct agents). Verify these against `agents/`, the ElevenLabs/Twilio consoles,
  and the live deploy; record results in `docs/acceptance-checklist.md`.

### Backend-dependent tests (not yet present)

End-to-end checks that *do* need a live backend are intentionally **not** in this
suite (they can't run in CI without secrets and allowlisted numbers). Run them
manually via the acceptance checklist and telephony canary:

- SMS actually reaches the consumer phone and supports TEXT/CALL (`docs/telephony-canary.md`).
- CALL launches the Intake agent < 10 s; voice intake produces a confirmed CaseSpec.
- Live post-call webhook → normalize/audit round-trip.
- Distinct live ElevenLabs agent IDs with different prompts/tools (INV-13, live half).

See `docs/acceptance-checklist.md` for the full judge-ready list.

## Golden fixtures

`golden/fixtures.json` contains a confirmed CaseSpec (v4) and two fully specified
scenarios — `hidden_fee_persona_c` and `verified_leverage_waiver` — with abbreviated
transcripts, expected normalized quotes, expected audit flags, and expected revised
terms. They are designed to drive `normalizeQuote`, `auditQuote`, `wordNegotiation`,
and `rankProviders` offline. See `golden/scenarios.md` for how to wire each one.
