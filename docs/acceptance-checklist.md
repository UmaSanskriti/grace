# Grace — Judge-Ready Acceptance Checklist (spec §11.3, §12.1, §12.3)

Run this end-to-end before judging. Pair it with the automated contract tests
(`tests/`, see [`../tests/README.md`](../tests/README.md)) and the telephony canary
([`telephony-canary.md`](./telephony-canary.md)).

> Synthetic data + pre-consented, allowlisted numbers only. Not legal advice.

## §11.3 Acceptance checklist

- [ ] Initial Grace SMS reaches the consumer phone and supports **TEXT / CALL**.
- [ ] **CALL launches the Grace Intake Agent within 10 seconds.**
- [ ] ElevenLabs voice intake **creates a confirmed CaseSpec**.
- [ ] The **exact CaseSpec hash is visible on all three provider tasks** (INV-03).
- [ ] **Three distinct ElevenLabs agent IDs** have different prompts, tool allowlists,
      and evals (INV-13).
- [ ] Three **live roleplayer calls** demonstrate distinct styles (Personas A/B/C).
- [ ] **Every call has AI/transcription consent on the transcript** (INV-07).
- [ ] Each call ends in a **structured outcome** (itemized_quote / callback / declined
      / unavailable / consent_declined).
- [ ] **Hidden fee is caught and the total corrected** (Persona C: $1,795 → $4,440).
- [ ] **Verified leverage changes a price or a material term** (Persona C waives $450
      → $3,990 after citing Persona A's audited quote; INV-05).
- [ ] Report **ranks cost, fit, certainty, timing, and trust**.
- [ ] **Tie logic is demonstrated** in a fixture or test.
- [ ] Grace sends a **report-ready SMS** and offers a call.
- [ ] **Markdown ledger** contains metadata, consent, evidence, and result.
- [ ] **No booking/payment/authorization control exists** (INV-06).

## §12.1 Five-minute judge script

| Time | Demo action |
|------|-------------|
| 00:00–00:35 | Show the consent screen; Grace sends the preference SMS; consumer replies **CALL**. |
| 00:35–01:10 | Consumer answers the **Grace Intake Agent**; play concise voice intake + the confirmed CaseSpec. |
| 01:10–01:35 | Show **three provider tasks with the identical CaseSpec hash**. |
| 01:35–03:05 | Play live/excerpts from **three parallel Grace Caller sessions**; highlight distinct behavior + the **hidden fee**. |
| 03:05–03:55 | Launch the **Grace Closer Agent**; it cites a verified quote, **Persona C waives $450**, revised quote is audited. |
| 03:55–04:35 | Show the **ranked report + evidence links**; explain the recommendation or tie. |
| 04:35–05:00 | Consumer receives SMS, selects **CALL**, hears the **Grace Closer** explain the result; show the **Markdown ledger**. |

## §12.3 Fallback ladder

| Failure | Fallback |
|---------|----------|
| SMS carrier block | Obtain organizer Twilio promo/upgrade. Engineering fallback: **Lovable text; keep voice**. |
| No SMS-capable trial number | Release/reprovision **once** if allowed; otherwise upgrade/promo. |
| ElevenLabs native import fails | Use the official register-call pattern **only if necessary**; do **not** build a custom media bridge first. |
| Only one provider phone | Run **three sequential calls** to the same roleplayer with three persona cards. |
| Concurrency error | Launch **sequential** calls; **preserve the same task IDs**. |
| Post-call webhook slow | **Poll** `GET` conversation details and enqueue normalization. |
| Live demo instability | Use recordings from **consented golden calls** plus one live call; **disclose this clearly**. |
| Tavily unavailable | Use **cached synthetic provider fixtures** + official-source URLs. |

## Post-judging teardown (INV-12)

- [ ] Run `DELETE /cases/{id}` for every demo case.
- [ ] Delete ElevenLabs conversations.
- [ ] Confirm the storage bucket is empty.
- [ ] Set `DEMO_MODE=false`.
