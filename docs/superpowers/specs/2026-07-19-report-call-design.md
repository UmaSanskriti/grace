# Report delivery call — design

**Date:** 2026-07-19
**Status:** approved, not yet implemented

## Problem

The pipeline's last act is `report.generate_report()`, which writes `report.md` into the case
directory. Nothing tells the family it exists. SMS was the original plan (the Twilio settings in
`app/config.py` are the remnant), but SMS is not available to us, so the report is delivered by
voice instead: a fourth ElevenLabs agent — the report agent — calls the family and reads them the
outcome.

## Scope

Place that call at the end of the pipeline, passing the report content as a dynamic variable.

Out of scope: `scripts/deploy_agents.py` and an `agents/report.json` mirror. The report agent's
prompt lives in the ElevenLabs dashboard. Adding it to the full-mirror deploy risks clobbering the
other implementation track's agents, and that is a separate decision. The dashboard prompt must
reference the variables listed under "Dynamic variables" below for this to work.

## Architecture

A new module `app/report_call.py` owns delivery. `report.py` keeps its single job — producing
`report.md` — and the call is a separate concern that consumes its output.

```
start_next_nego_call()            [shortlist exhausted]
  ├─ report.generate_report(case_id)         -> report.md          (unchanged)
  ├─ report_call.deliver_report(case_id, md) -> report_call.json    NEW
  │    ├─ summarize_for_speech(md)   — LLM, prompts/report_speech.md
  │    ├─ guards (abort / agent id / phone / DEMO_MODE)
  │    ├─ outbound_call(report agent, user_phone, dynamic_variables)
  │    └─ save report_call.json
  └─ storage.set_status(case_id, "done")                            (unchanged)
```

`deliver_report` is called between report generation and `set_status`, and returns a dict
describing what happened. `start_next_nego_call`'s return value gains that dict under a
`report_call` key; its existing `{"done": True, "status": "done"}` contract is otherwise unchanged.

### Why a separate module

`report.py` is about turning case data into a document. `report_call.py` is about phone
delivery — it owns the phone-number guards, the DEMO_MODE gate, and the ElevenLabs failure
handling, none of which the document generator should know about. The two are independently
testable: `generate_report` needs no phone, `deliver_report` takes markdown as an argument rather
than reading the file back.

## Speech summary

`summarize_for_speech(case_id, md) -> str` mirrors `generate_report`'s shape: an OpenAI
`responses.create` call using `settings.openai_extraction_model` (falling back to
`_EXTRACTION_MODEL_DEFAULT`), with the system prompt read from `prompts/report_speech.md` via
`_extraction_prompt`.

The prompt instructs: convert this markdown report into plain spoken prose for a phone call;
no markdown, no tables, no bullet characters, no headings; warm and brief; lead with the
recommendation and the final price; mention how many homes were called and roughly what was
saved; never introduce a figure that is not in the report.

On any exception, log the error and fall back to a deterministic sentence built from the same
quote/nego JSON `_fallback_report` uses:

> "We called {n} funeral homes for you. Our recommendation is {home} at {price}. The full written
> report is ready for you."

Degrading the summary is always preferable to skipping the call, matching the fallback discipline
already in `report.py`.

## Guards

Evaluated in this order. Each writes `report_call.json` and returns; none raises.

| Condition | `status` in `report_call.json` |
|---|---|
| `storage.is_aborted(case_id)` | `aborted` |
| `settings.elevenlabs_report_agent_id` empty | `skipped` — "ELEVENLABS_REPORT_AGENT_ID not set" |
| `case["user_phone"]` empty | `skipped` — "no user phone on file" |
| `DEMO_MODE` and phone not in `DEMO_TARGETS` | `skipped` — "not a DEMO_TARGET in DEMO_MODE" |
| `ElevenLabsError` from `outbound_call` | `failed` — the error text |
| call placed | `placed` |

**`deliver_report` must never raise into the pipeline.** The body is wrapped so that even an
unanticipated exception is logged and recorded as `failed`; `set_status(case_id, "done")` is
reached in every case. The written report is the deliverable of record, and a phone call that
cannot be placed must not leave the case stuck short of `done`.

### report_call.json

```json
{
  "status": "placed",
  "call_id": "conv_abc123",
  "to_number": "+14155550123",
  "summary_source": "llm",
  "notes": ""
}
```

`call_id` is null unless a call was placed. `summary_source` is `"llm"` or `"fallback"`, so a
flat-sounding demo call can be diagnosed from the case directory alone. `to_number` is null on the
guards that fire before a number is chosen.

## Dynamic variables

Following the negotiation-agent lesson documented in `_competing_disclosure` (`app/calls.py`) — an
unset variable left a blank inside an assertive sentence, and the agent filled it with the
confidential target price — every variable is either a complete, true value or an explicit denial
sentence. None may be blank.

| Variable | Source | When absent |
|---|---|---|
| `case_id` | the case | always present |
| `agent_type` | literal `"report"` | always present |
| `contact_name` | `user_info.contact_name` | `"there"` (so "Hello there" reads naturally) |
| `report_summary` | `summarize_for_speech` | never empty — falls back as above |
| `recommended_home` | lowest final/quoted price among reached homes | `"no clear recommendation — see the written report"` |
| `final_price` | that home's `final_price_usd` or `quoted_price_usd`, via `_money` | `"no confirmed price"` |

`recommended_home` and `final_price` are derived in `report_call.py` from the quote/negotiation
JSON — not parsed out of the markdown, and not taken from the LLM summary. They exist so the
agent's opening line is reliable even if the summary is the fallback string.

## Webhook

`app/main.py` gains an `elif agent_type == "report":` branch that logs and returns. The transcript
is already saved upstream by the generic path; this branch exists only to stop a report call
falling into the `no handler for agent=%s yet` warning, and to make it explicit that the report
call terminates the pipeline rather than advancing it.

The case is already `done` before the webhook arrives. Nothing downstream waits on the family
answering the phone.

## Config

- `Settings.elevenlabs_report_agent_id: str = ""`
- `"report"` added to the `agent_id_for()` map
- `ELEVENLABS_REPORT_AGENT_ID=` added to `.env.sample`, under the other agent ids

## Testing

`tests/test_report_call.py`, following the style of `tests/test_nego_leverage.py` — a temporary
case directory, `outbound_call` monkeypatched to record its arguments.

1. Each guard row above produces the expected `report_call.json` status without calling out.
2. Happy path: `outbound_call` receives the report agent id, `case["user_phone"]`, and a
   dynamic-variable dict whose keys match the table above, with no empty values.
3. `ElevenLabsError` is recorded as `failed` and `deliver_report` returns normally.
4. An exception from `summarize_for_speech` still places the call, with
   `summary_source == "fallback"` and a non-empty `report_summary`.
5. Through `start_next_nego_call`: an exhausted shortlist with a failing report call still ends at
   `status == "done"`.
