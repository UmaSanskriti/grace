# Report Delivery Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the final report is generated, call the family with a fourth ElevenLabs agent and read them the outcome, passing the report content as a dynamic variable.

**Architecture:** A new module `app/report_call.py` owns delivery — the spoken-summary LLM pass, the phone/DEMO guards, and ElevenLabs failure handling. `app/report.py` is untouched and keeps its single job (writing `report.md`). `start_next_nego_call()` gains one call between report generation and `set_status(..., "done")`.

**Tech Stack:** Python 3.12, FastAPI, httpx, OpenAI `responses` API, ElevenLabs Agents Platform.

**Spec:** `docs/superpowers/specs/2026-07-19-report-call-design.md`

## Global Constraints

- **This repo has no pytest.** Tests are standalone scripts with a `main() -> int`, run as `./.venv/bin/python tests/test_x.py`. Follow `tests/test_nego_leverage.py` exactly: module docstring stating the invariants, a `failures: list[str]` accumulator, a `check(cond, msg)` helper, `PASS:`/`FAIL:` printing, `raise SystemExit(main())`.
- **Tests must not hit the network.** Monkeypatch `report_call.outbound_call` and `report_call.OpenAI` in every test. Redirect `storage.DATA_DIR` and `storage.INDEX_PATH` into a `tempfile.TemporaryDirectory()`, as `_seed()` in `test_nego_leverage.py` does.
- **`deliver_report` must never raise.** Every guard, every failure, and every unanticipated exception returns a dict and writes `report_call.json`. The case must reach `status == "done"` regardless.
- **No dynamic variable may be empty.** Each is a complete true value or an explicit denial sentence — the `_competing_disclosure` lesson in `app/calls.py`.
- **Do not touch** `scripts/deploy_agents.py` or add `agents/report.json`. Out of scope per the spec.
- Match the house style: `from __future__ import annotations`, module docstring explaining *why*, `log = logging.getLogger("grace")`, `log.info` on every state change.

---

### Task 1: Spoken summary

Turns `report.md` into plain prose for the phone, with a deterministic fallback so the call is never blocked by a bad LLM response.

**Files:**
- Create: `prompts/report_speech.md`
- Create: `app/report_call.py`
- Test: `tests/test_report_call.py`

**Interfaces:**
- Consumes: `storage.read_json`, `storage.case_dir`, `app.extraction._extraction_prompt`, `app.extraction._EXTRACTION_MODEL_DEFAULT`, `app.config.settings`.
- Produces:
  - `summarize_for_speech(case_id: str, md: str) -> tuple[str, str]` — `(prose, source)` where `source` is `"llm"` or `"fallback"`. Never raises, never returns an empty first element.
  - `_best_home(case_id: str) -> tuple[str, object]` — `(name, price)` of the cheapest home with a confirmed number, else `("", None)`.
  - `_homes_called(case_id: str) -> int`
  - `_money(x: object) -> str`

- [ ] **Step 1: Write the prompt**

Create `prompts/report_speech.md`:

```markdown
# Spoken report prompt

You convert a written Markdown report into plain prose to be SPOKEN aloud over the phone by
Grace, an AI assistant who has been arranging a funeral for a grieving family.

Output rules:
- Plain spoken English only. No Markdown, no tables, no bullet characters, no headings, no
  asterisks, no pound signs. Never say the word "table".
- 90 to 130 words. This is a phone call, not a document.
- Open with the recommendation: which funeral home, and the final price.
- Then, in one or two sentences: how many homes were called, and roughly what was saved.
- Close by telling them the full written report is ready for them.
- Warm and plain. This family is grieving. No sales language, no filler.

TRUTH: Use ONLY figures that appear in the report. Never introduce, estimate, round beyond the
nearest dollar, or average a number that is not written there. If the report has no confirmed
price, say so plainly rather than producing one.
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_report_call.py`. This file grows across all three tasks; start with the summary invariants.

```python
"""Guards on the report delivery call (design doc 2026-07-19).

The written report is the deliverable of record. A phone call that cannot be
placed, or an LLM that returns nothing, must never leave a case short of `done`
or hand the report agent a blank variable to fill in itself.

Invariants under test:
  1. A failing LLM still yields a non-empty spoken summary, marked "fallback".
  2. The fallback names the cheapest home with a confirmed number.
  3. `_best_home` ignores unreached homes and prefers the negotiated price.

Run: ./.venv/bin/python tests/test_report_call.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import report_call, storage  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


class _BoomOpenAI:
    """Stands in for OpenAI so no test ever reaches the network."""

    def __init__(self, *a, **kw):
        raise RuntimeError("LLM down")


def _seed(tmp: Path, *, status: str = "negotiating", user_phone: str = "+14155550123") -> str:
    """A case with three homes: one unreached, one negotiated down, one quote-only."""
    storage.DATA_DIR = tmp
    storage.INDEX_PATH = tmp / "_index.json"
    case_id = "case_test_001"
    d = tmp / case_id
    storage._write_json(d / "case.json", {
        "case_id": case_id, "status": status, "user_phone": user_phone,
    })
    storage._write_json(d / "user_info.json", {"contact_name": "Dana Reyes"})
    storage._write_json(d / "quotes" / "fh_001.json", {
        "funeral_home_id": "fh_001", "funeral_home_name": "Oak Hill",
        "reached": True, "quoted_price_usd": 4200,
    })
    storage._write_json(d / "quotes" / "fh_002.json", {
        "funeral_home_id": "fh_002", "funeral_home_name": "Cedar Rest",
        "reached": False, "quoted_price_usd": None,
    })
    storage._write_json(d / "quotes" / "fh_003.json", {
        "funeral_home_id": "fh_003", "funeral_home_name": "Riverside",
        "reached": True, "quoted_price_usd": 5000,
    })
    # Oak Hill negotiated down to 3650 — still the cheapest, and the negotiated
    # number must win over its own 4200 quote.
    storage._write_json(d / "negotiations" / "fh_001.json", {
        "funeral_home_id": "fh_001", "funeral_home_name": "Oak Hill",
        "agreed": True, "final_price_usd": 3650,
    })
    return case_id


def test_summary() -> None:
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))

        name, price = report_call._best_home(case_id)
        check(name == "Oak Hill", f"expected cheapest home Oak Hill, got {name!r}")
        check(price == 3650, f"expected the negotiated 3650, got {price!r}")
        check(report_call._homes_called(case_id) == 3,
              f"expected 3 quote records, got {report_call._homes_called(case_id)}")

        summary, source = report_call.summarize_for_speech(case_id, "# report")

    check(source == "fallback", f"LLM raised but source is {source!r}")
    check(summary.strip() != "", "fallback summary is empty — the agent would have a blank to fill")
    check("Oak Hill" in summary, f"fallback omits the recommended home: {summary!r}")
    check("$3,650" in summary, f"fallback omits the final price: {summary!r}")
    check("3" in summary, f"fallback omits the number of homes called: {summary!r}")


def main() -> int:
    report_call.OpenAI = _BoomOpenAI
    test_summary()

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: spoken summary degrades safely and never returns blank")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `./.venv/bin/python tests/test_report_call.py`
Expected: `ModuleNotFoundError: No module named 'app.report_call'`

- [ ] **Step 4: Write the implementation**

Create `app/report_call.py`:

```python
"""Deliver the finished report to the family by voice (spec 2026-07-19).

SMS was the original plan (the Twilio settings in config.py are its remnant),
but it isn't available to us, so a fourth ElevenLabs agent calls the family and
reads them the outcome.

report.py turns case data into a document; this module gets that document
spoken down a phone line. Keeping them apart means the document generator never
learns about phone numbers, DEMO_MODE, or ElevenLabs failures — and it means
`generate_report` stays testable without a phone.
"""

from __future__ import annotations

import logging

from openai import OpenAI

from . import storage
from .config import settings
from .elevenlabs_client import ElevenLabsError, outbound_call
from .extraction import _EXTRACTION_MODEL_DEFAULT, _extraction_prompt

log = logging.getLogger("grace")

# Denials, not blanks. An empty variable inside an assertive sentence is what
# let the negotiation agent invent a competitor quote (see _competing_disclosure
# in calls.py); the report agent gets the same treatment.
NO_RECOMMENDATION = "no clear recommendation — see the written report"
NO_PRICE = "no confirmed price"
DEFAULT_CONTACT_NAME = "there"  # "Hello there" reads naturally; "Hello " does not


def _money(x: object) -> str:
    return f"${x:,.0f}" if isinstance(x, (int, float)) else ""


def _homes_called(case_id: str) -> int:
    qdir = storage.case_dir(case_id) / "quotes"
    return len(list(qdir.glob("*.json"))) if qdir.exists() else 0


def _best_home(case_id: str) -> tuple[str, object]:
    """(name, price) of the cheapest home with a confirmed number, else ("", None).

    Derived from the quote/negotiation records rather than parsed out of the
    report markdown, so the agent's opening line is right even when the spoken
    summary is the fallback string. A negotiated price supersedes the home's
    original quote; homes we never reached are ignored.
    """
    negos: dict[str, dict] = {}
    ndir = storage.case_dir(case_id) / "negotiations"
    if ndir.exists():
        for p in sorted(ndir.glob("*.json")):
            n = storage.read_json(case_id, f"negotiations/{p.name}") or {}
            if n.get("funeral_home_id"):
                negos[n["funeral_home_id"]] = n

    best_name, best_price = "", None
    qdir = storage.case_dir(case_id) / "quotes"
    if not qdir.exists():
        return best_name, best_price
    for p in sorted(qdir.glob("*.json")):
        q = storage.read_json(case_id, f"quotes/{p.name}") or {}
        if not q.get("reached"):
            continue
        fh_id = q.get("funeral_home_id") or ""
        nego = negos.get(fh_id, {})
        price = nego.get("final_price_usd")
        if price is None:
            price = q.get("quoted_price_usd")
        if not isinstance(price, (int, float)):
            continue
        if best_price is None or price < best_price:
            best_price = price
            best_name = (
                nego.get("funeral_home_name") or q.get("funeral_home_name") or fh_id
            )
    return best_name, best_price


def _fallback_summary(case_id: str) -> str:
    """Deterministic prose if the LLM is unavailable — flat, but never blank."""
    name, price = _best_home(case_id)
    if name and price is not None:
        rec = f"Our recommendation is {name} at {_money(price)}."
    else:
        rec = "We were not able to confirm a price."
    return (
        f"We called {_homes_called(case_id)} funeral homes for you. {rec} "
        "The full written report is ready for you."
    )


def summarize_for_speech(case_id: str, md: str) -> tuple[str, str]:
    """Turn report.md into spoken prose. Returns (text, "llm" | "fallback").

    Never raises and never returns an empty string: a degraded summary is always
    better than handing the agent a blank to improvise around.
    """
    try:
        client = OpenAI(api_key=settings.openai_api_key)
        model = getattr(settings, "openai_extraction_model", "") or _EXTRACTION_MODEL_DEFAULT
        resp = client.responses.create(
            model=model,
            input=[
                {"role": "system", "content": _extraction_prompt("report_speech.md")},
                {"role": "user", "content": "REPORT:\n" + md},
            ],
        )
        text = (resp.output_text or "").strip()
        if text:
            return text, "llm"
        log.error("speech summary empty case=%s — using fallback", case_id)
    except Exception as e:  # LLM down / model unavailable — still make the call
        log.error("speech summary failed case=%s: %s — using fallback", case_id, e)
    return _fallback_summary(case_id), "fallback"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./.venv/bin/python tests/test_report_call.py`
Expected: `PASS: spoken summary degrades safely and never returns blank`

- [ ] **Step 6: Commit**

```bash
git add prompts/report_speech.md app/report_call.py tests/test_report_call.py
git commit -m "Add the spoken-report summary, with a deterministic fallback"
```

---

### Task 2: Guards, dynamic variables, and the call

Places the call, or records exactly why it didn't happen. Every path writes `report_call.json`.

**Files:**
- Modify: `app/config.py` (add `elevenlabs_report_agent_id`, extend `agent_id_for`)
- Modify: `.env.sample` (add `ELEVENLABS_REPORT_AGENT_ID=`)
- Modify: `app/report_call.py` (append `_record`, `_dynamic_vars`, `_deliver`, `deliver_report`)
- Test: `tests/test_report_call.py` (append)

**Interfaces:**
- Consumes: `summarize_for_speech`, `_best_home`, `_money`, `NO_RECOMMENDATION`, `NO_PRICE`, `DEFAULT_CONTACT_NAME` from Task 1; `elevenlabs_client.outbound_call`, `ElevenLabsError`; `storage.read_case`, `storage.is_aborted`, `storage.save_json`, `storage.index_conversation`.
- Produces:
  - `deliver_report(case_id: str, md: str) -> dict` — the `report_call.json` record. Never raises.
  - `_dynamic_vars(case_id: str, summary: str) -> dict[str, str]`
  - `settings.elevenlabs_report_agent_id: str`

- [ ] **Step 1: Add the setting**

In `app/config.py`, after `elevenlabs_nego_agent_id`:

```python
    elevenlabs_nego_agent_id: str = ""
    elevenlabs_report_agent_id: str = ""
```

And extend `agent_id_for`:

```python
        return {
            "intake": self.elevenlabs_intake_agent_id,
            "quote": self.elevenlabs_quote_agent_id,
            "nego": self.elevenlabs_nego_agent_id,
            "report": self.elevenlabs_report_agent_id,
        }[agent_type]
```

In `.env.sample`, after `ELEVENLABS_NEGO_AGENT_ID=`:

```
ELEVENLABS_REPORT_AGENT_ID=
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/test_report_call.py`, above `main()`:

```python
class _Recorder:
    """Captures outbound_call kwargs instead of dialing."""

    def __init__(self, exc: Exception | None = None):
        self.calls: list[dict] = []
        self.exc = exc

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.exc:
            raise self.exc
        return {"success": True, "conversation_id": "conv_test_1"}


def test_happy_path() -> None:
    rec = _Recorder()
    report_call.outbound_call = rec
    settings.elevenlabs_report_agent_id = "agent_report_1"
    settings.demo_mode = False

    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        result = report_call.deliver_report(case_id, "# report")
        saved = storage.read_json(case_id, "report_call.json")

    check(result["status"] == "placed", f"expected placed, got {result!r}")
    check(result["call_id"] == "conv_test_1", f"conversation id not recorded: {result!r}")
    check(saved == result, f"report_call.json disagrees with the return value: {saved!r}")
    check(len(rec.calls) == 1, f"expected exactly one call, got {len(rec.calls)}")

    kw = rec.calls[0]
    check(kw["agent_id"] == "agent_report_1", f"wrong agent id: {kw['agent_id']!r}")
    check(kw["to_number"] == "+14155550123", f"wrong number: {kw['to_number']!r}")

    dyn = kw["dynamic_variables"]
    expected = {"case_id", "agent_type", "contact_name", "report_summary",
                "recommended_home", "final_price"}
    check(set(dyn) == expected, f"variable set drifted: {sorted(dyn)}")
    blank = [k for k, v in dyn.items() if not str(v).strip()]
    check(not blank, f"blank variables the agent could fill in itself: {blank}")
    check(dyn["agent_type"] == "report", f"agent_type is {dyn['agent_type']!r}")
    check(dyn["contact_name"] == "Dana Reyes", f"contact_name is {dyn['contact_name']!r}")
    check(dyn["recommended_home"] == "Oak Hill", f"recommended_home is {dyn['recommended_home']!r}")
    check(dyn["final_price"] == "$3,650", f"final_price is {dyn['final_price']!r}")


def test_guards() -> None:
    report_call.outbound_call = _Recorder()

    # No agent id configured.
    settings.elevenlabs_report_agent_id = ""
    settings.demo_mode = False
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        r = report_call.deliver_report(case_id, "# report")
    check(r["status"] == "skipped" and "REPORT_AGENT_ID" in r["notes"],
          f"missing agent id not reported: {r!r}")

    # No phone on file.
    settings.elevenlabs_report_agent_id = "agent_report_1"
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td), user_phone="")
        r = report_call.deliver_report(case_id, "# report")
    check(r["status"] == "skipped" and "phone" in r["notes"],
          f"missing phone not reported: {r!r}")

    # DEMO_MODE with a number that isn't a demo target.
    settings.demo_mode = True
    settings.demo_targets = "+16505559876"
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        r = report_call.deliver_report(case_id, "# report")
    check(r["status"] == "skipped" and "DEMO_TARGET" in r["notes"],
          f"non-demo number not blocked: {r!r}")
    settings.demo_mode = False

    # Aborted case. Read report_call.json back INSIDE the block — once the
    # TemporaryDirectory closes, storage.DATA_DIR points at nothing.
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        storage.set_aborted(case_id)
        r = report_call.deliver_report(case_id, "# report")
        # Every guard must write the record for the dashboard to read.
        saved = storage.read_json(case_id, "report_call.json")
    check(r["status"] == "aborted", f"aborted case still dialed: {r!r}")
    check(saved == r, "a guard returned without writing report_call.json")


def test_failures_never_raise() -> None:
    settings.elevenlabs_report_agent_id = "agent_report_1"
    settings.demo_mode = False

    # ElevenLabs rejects the call.
    report_call.outbound_call = _Recorder(exc=report_call.ElevenLabsError("402 no credits"))
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        r = report_call.deliver_report(case_id, "# report")
    check(r["status"] == "failed" and "402" in r["notes"], f"call failure not recorded: {r!r}")
    check(r["call_id"] is None, f"call_id set on a failed call: {r!r}")

    # An unanticipated exception must still be swallowed.
    report_call.outbound_call = _Recorder(exc=ValueError("something unforeseen"))
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        r = report_call.deliver_report(case_id, "# report")
    check(r["status"] == "failed", f"unexpected exception escaped as {r!r}")

    # A dead LLM must not stop the call going out.
    rec = _Recorder()
    report_call.outbound_call = rec
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        r = report_call.deliver_report(case_id, "# report")
    check(r["status"] == "placed", f"dead LLM blocked the call: {r!r}")
    check(r["summary_source"] == "fallback", f"summary_source is {r['summary_source']!r}")
    check(rec.calls[0]["dynamic_variables"]["report_summary"].strip() != "",
          "call placed with an empty report_summary")
```

Update the imports at the top of the file:

```python
from app import report_call, storage  # noqa: E402
from app.config import settings  # noqa: E402
```

And extend `main()`:

```python
def main() -> int:
    report_call.OpenAI = _BoomOpenAI
    test_summary()
    test_happy_path()
    test_guards()
    test_failures_never_raise()

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: report call guards hold; no blank variables; nothing raises")
    return 0
```

- [ ] **Step 3: Run to verify it fails**

Run: `./.venv/bin/python tests/test_report_call.py`
Expected: `AttributeError: module 'app.report_call' has no attribute 'deliver_report'`

- [ ] **Step 4: Write the implementation**

Append to `app/report_call.py`:

```python
def _dynamic_vars(case_id: str, summary: str) -> dict[str, str]:
    user_info = storage.read_json(case_id, "user_info.json") or {}
    name, price = _best_home(case_id)
    return {
        "case_id": case_id,
        "agent_type": "report",
        "contact_name": (user_info.get("contact_name") or "").strip() or DEFAULT_CONTACT_NAME,
        "report_summary": summary,
        "recommended_home": name or NO_RECOMMENDATION,
        "final_price": _money(price) or NO_PRICE,
    }


def _record(
    case_id: str,
    status: str,
    *,
    call_id: str | None = None,
    to_number: str | None = None,
    summary_source: str | None = None,
    notes: str = "",
) -> dict:
    rec = {
        "status": status,
        "call_id": call_id,
        "to_number": to_number,
        "summary_source": summary_source,
        "notes": notes,
    }
    storage.save_json(case_id, "report_call.json", rec)
    log.info("report call case=%s status=%s notes=%s", case_id, status, notes)
    return rec


def _deliver(case_id: str, md: str) -> dict:
    if storage.is_aborted(case_id):
        return _record(case_id, "aborted", notes="case aborted")
    if not settings.elevenlabs_report_agent_id:
        return _record(case_id, "skipped", notes="ELEVENLABS_REPORT_AGENT_ID not set")

    phone = (storage.read_case(case_id) or {}).get("user_phone") or ""
    if not phone:
        return _record(case_id, "skipped", notes="no user phone on file")
    if settings.demo_mode and phone not in settings.demo_target_list:
        return _record(
            case_id, "skipped", to_number=phone,
            notes="skipped: not a DEMO_TARGET in DEMO_MODE",
        )

    summary, source = summarize_for_speech(case_id, md)
    try:
        resp = outbound_call(
            agent_id=settings.elevenlabs_report_agent_id,
            to_number=phone,
            dynamic_variables=_dynamic_vars(case_id, summary),
        )
    except ElevenLabsError as e:
        return _record(
            case_id, "failed", to_number=phone, summary_source=source, notes=str(e),
        )

    conv = resp.get("conversation_id", "")
    if conv:
        storage.index_conversation(conv, case_id, "report")
    log.info("placed report call case=%s to=%s conversation_id=%s", case_id, phone, conv)
    return _record(
        case_id, "placed", call_id=conv or None, to_number=phone, summary_source=source,
    )


def deliver_report(case_id: str, md: str) -> dict:
    """Call the family and read them the report. Returns the report_call.json record.

    Never raises. The written report is the deliverable of record, so a call
    that cannot be placed must not leave the case short of `done`.
    """
    try:
        return _deliver(case_id, md)
    except Exception as e:  # nothing here may break the pipeline's path to done
        log.exception("report call crashed case=%s", case_id)
        return _record(case_id, "failed", notes=f"unexpected error: {e}")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./.venv/bin/python tests/test_report_call.py`
Expected: `PASS: report call guards hold; no blank variables; nothing raises`

- [ ] **Step 6: Confirm nothing else regressed**

Run: `./.venv/bin/python tests/test_nego_leverage.py`
Expected: `PASS: competitor disclosure is evidence-backed; target price never leaks`

- [ ] **Step 7: Commit**

```bash
git add app/config.py .env.sample app/report_call.py tests/test_report_call.py
git commit -m "Place the report call, or record exactly why it was skipped"
```

---

### Task 3: Wire it into the pipeline

The end of the negotiation loop delivers the report; the report call's webhook terminates rather than advancing.

**Files:**
- Modify: `app/calls.py:348-353` (tail of `start_next_nego_call`)
- Modify: `app/main.py` (webhook dispatch, the `elif agent_type == "nego":` block's neighbour)
- Test: `tests/test_report_call.py` (append)

**Interfaces:**
- Consumes: `report_call.deliver_report` from Task 2, `report.generate_report`.
- Produces: `start_next_nego_call` returns `{"done": True, "status": "done", "report_call": <record>}` when the shortlist is exhausted.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_report_call.py`, above `main()`:

```python
def test_pipeline_reaches_done() -> None:
    """A failing report call must not strand the case before `done`."""
    from app import calls, report

    settings.elevenlabs_report_agent_id = "agent_report_1"
    settings.demo_mode = False
    report_call.outbound_call = _Recorder(exc=report_call.ElevenLabsError("503"))

    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td), status="negotiating")
        # An empty shortlist means the loop falls straight through to reporting.
        storage._write_json(Path(td) / case_id / "strategy.json",
                            {"shortlist": [], "per_home_strategy": []})
        # generate_report would call OpenAI; its own fallback is tested elsewhere.
        report.generate_report = lambda cid: "# Grace — Funeral Quote Report\n"

        result = calls.start_next_nego_call(case_id)
        case = storage.read_case(case_id)

    check(case["status"] == "done", f"case stranded at {case['status']!r} by a failed call")
    check(result.get("report_call", {}).get("status") == "failed",
          f"report_call outcome not surfaced in the return value: {result!r}")
```

Add `test_pipeline_reaches_done()` to `main()`, after `test_failures_never_raise()`.

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python tests/test_report_call.py`
Expected: FAIL — `report_call outcome not surfaced in the return value` (the case does reach `done` already, but nothing calls `deliver_report`).

- [ ] **Step 3: Wire the negotiation loop**

In `app/calls.py`, replace the tail of `start_next_nego_call` (currently lines 348-353):

```python
    # Shortlist exhausted -> produce the final report, then read it to the family.
    from . import report, report_call  # lazy imports to avoid a cycle
    md = report.generate_report(case_id)
    rc = report_call.deliver_report(case_id, md)
    storage.set_status(case_id, "done")
    log.info("negotiations complete case=%s report_call=%s -> done", case_id, rc["status"])
    return {"done": True, "status": "done", "report_call": rc}
```

Also update the function's docstring:

```python
    """Place a negotiation call to the next shortlisted home, or finish: report + deliver."""
```

- [ ] **Step 4: Handle the report webhook**

In `app/main.py`, add a branch after the `elif agent_type == "nego":` block and before the `else:`:

```python
    elif agent_type == "report":
        # Terminal. The case was set `done` when this call was placed, and the
        # transcript is already saved above — there is nothing to advance.
        log.info(
            "report call finished case=%s conversation_id=%s",
            case_id, parsed.conversation_id,
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./.venv/bin/python tests/test_report_call.py`
Expected: `PASS: report call guards hold; no blank variables; nothing raises`

- [ ] **Step 6: Confirm the app still boots and nothing regressed**

Run: `./.venv/bin/python -c "from app.main import app; print('ok')"`
Expected: `ok`

Run: `./.venv/bin/python tests/test_nego_leverage.py`
Expected: `PASS: competitor disclosure is evidence-backed; target price never leaks`

- [ ] **Step 7: Commit**

```bash
git add app/calls.py app/main.py tests/test_report_call.py
git commit -m "Read the final report to the family after the last negotiation"
```

---

## After implementation

The ElevenLabs dashboard prompt for the report agent must reference these variables, all of which
are guaranteed non-empty:

| Variable | Contains |
|---|---|
| `{{contact_name}}` | The family contact's name, or `there` |
| `{{report_summary}}` | The spoken report — the substance of the call |
| `{{recommended_home}}` | Cheapest home with a confirmed price, or an explicit denial |
| `{{final_price}}` | That home's price, e.g. `$3,650`, or `no confirmed price` |
| `{{case_id}}`, `{{agent_type}}` | Routing only — the agent should never say these |

Set `ELEVENLABS_REPORT_AGENT_ID` in `.env`, and make sure the family's number is in
`DEMO_TARGETS` if `DEMO_MODE=true` — otherwise the call is skipped and `report_call.json` will say
so.
