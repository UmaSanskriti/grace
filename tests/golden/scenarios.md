# Grace — Golden Conversation Scenarios (spec §11.2)

These are the nine golden conversation tests. Each row states the trigger and the
**expected result** Grace must produce. All data is **synthetic**; prices trace to
`config/personas.json`. This is a product/engineering spec, **not legal advice**.

Two scenarios ship with machine-readable transcript fixtures in
[`fixtures.json`](./fixtures.json) so `normalize` / `audit` / `rank` can be driven
**offline** without a live backend: the **hidden-fee (Persona C)** scenario and the
**verified-leverage waiver** scenario. The remaining scenarios are behavioral
expectations for the live agents and the intake/SMS flow; verify them during the
golden-call rehearsal (build order §12.2, 17–20 h) and check them off in
[`../../docs/acceptance-checklist.md`](../../docs/acceptance-checklist.md).

## Scenario matrix

| # | Scenario | Trigger | Expected result | Where checked |
|---|----------|---------|-----------------|---------------|
| 1 | Consumer declines budget | Consumer refuses to state a spending limit | Grace **accepts it** and asks **cost posture** instead (`lowest_comparable_total` / `balanced` / `prioritize_fit`); never asks "how much are you willing to spend"; `mention_budget` stays `false` (INV-04). | `casespec_test.ts` (INV-04); live intake |
| 2 | Consumer says pause | Consumer says "pause" / "stop for now" mid-intake | **State saves** (draft CaseSpec persists) and Grace **stops asking questions**; no data loss on resume. | Live intake; DB draft persistence |
| 3 | Provider interrupts | Provider cuts in during quote gathering | Grace answers the immediate question in **one sentence**, then asks the **highest-priority missing item** in one sentence (§5.4 "Handle interruption"). | Live Caller call |
| 4 | Package-only quote | Provider (Persona B) offers only a package/range | Grace **requests itemization once**, then requests a **written GPL/estimate**, then **documents the outcome** — no arguing (§5.4 "Ask once more"). | Live Caller call (Persona B) |
| 5 | "Are you a robot?" | Provider asks if Grace is a robot/AI | Grace **says yes** (`operational_replies.robot_question`) and **preserves the quote request** (returns to pricing). | Live Caller call; `config/disclosure.json` string |
| 6 | Hidden fees | Persona C quotes a low headline, omits fees | Auditor **identifies missing after-hours/transfer**; **total changes** after clarification ($1,795 headline → $4,440 resolved). | **`fixtures.json` → `hidden_fee_persona_c`** (offline) |
| 7 | Verified leverage | Persona C shown Persona A's audited quote | Persona C **waives $450** only **after** Grace cites Persona A's verified comparable quote; revised total $4,440 → $3,990; Persona C requests written confirmation. | **`fixtures.json` → `verified_leverage_waiver`** (offline); INV-05 in `invariants_test.ts` |
| 8 | Consent declined | Provider/consumer declines transcription at call start | **No transcript stored**; call **ends**; only metadata retained (INV-07). | Live call; `webhooks-elevenlabs` handler |
| 9 | Tie | Two providers within the tie threshold | Grace **presents two options and the material trade-off** — no forced recommendation (score delta ≤ 3, or totals within 5% with different fit advantages). | Ranking fixtures (`tests/ranking/`, owned separately); `expected_ranking_inputs` here |

## Offline-drivable fixtures (detail)

### Scenario 6 — Hidden fees (Persona C) · `hidden_fee_persona_c`
- **Input:** abbreviated call transcript with source turns for every category.
- **Drive:** `normalizeQuote(task, transcript)` → expect `expected_normalized_quote`
  (subtotal `4220` + cash advances `220` == total `4440`, so **no**
  `line_items_do_not_sum_to_total` flag). `auditQuote(quote, transcript)` on the
  **headline** must surface `missing_transfer_fee` and `missing_after_hours_fee`.
- **Assert:** headline `1795` ≠ resolved `4440`; every non-null amount carries a
  `source` (INV-08).

### Scenario 7 — Verified-leverage waiver · `verified_leverage_waiver`
- **Input:** Persona A's `AUDITED` comparable quote (`q_a_golden`, total `3940`),
  the `verified_leverage` object, and the negotiation transcript.
- **Drive:** validate leverage (INV-05: quote exists + audited + comparable),
  then `wordNegotiation` / `log_revised_terms` → expect `expected_revised_terms`
  (`after_hours_admin` waived, `4440` → `3990`, delta `-450`).
- **Assert:** the `-450` waiver only unlocks **after** the audited Persona A quote
  is cited (`requires_verified_leverage`); Persona C's revised quote sets
  `written_confirmation: "requested"` (persona `post_condition`).

### Scenario 9 — Tie inputs · `expected_ranking_inputs`
- Comparable totals after Persona C's waiver: transparent `3940`, hidden-fee
  `3990`, package-first `4250`. Transparent vs. hidden-fee are within 5% — feed to
  `rankProviders` (weights from `config/vertical.json`) to exercise tie logic.
  Ranking assertions live in `tests/ranking/` (owned by the ranking agent);
  these inputs are provided for cross-reference only.
