"""Guards on the report delivery call (design doc 2026-07-19).

The written report is the deliverable of record. A phone call that cannot be
placed, or an LLM that returns nothing, must never leave a case short of `done`
or hand the report agent a blank variable to fill in itself.

Invariants under test:
  1. A failing LLM still yields a non-empty spoken summary, marked "fallback".
  2. The fallback names the cheapest home with a confirmed number.
  3. `_best_home` ignores unreached homes, ignores unagreed negotiations, and
     prefers the negotiated price over the home's own quote.
  3b. The LLM summarization call is bound to that same gated recommendation
     via an explicit constraint, so report_summary cannot name a different
     home/price than recommended_home/final_price on the same call — even
     though report.md itself applies no such gate.
  4. `_homes_called` counts only quote records with a real dial attempt
     (`call_id` set) — never homes that were skipped without ever being
     called (no phone number, or not a DEMO_TARGET in DEMO_MODE).
  5. Every guard (missing agent id, missing phone, non-demo number in
     DEMO_MODE, an aborted case) writes `report_call.json` before returning.
  6. Nothing — ElevenLabs errors, unexpected exceptions, a dead LLM, a
     persistent storage failure, or a failing post-call indexing step — ever
     escapes `deliver_report`.
  7. A failed report call still leaves the case at `done`.
  8. The wiring in `start_next_nego_call` actually places the report call on
     the success path, and a second entrant during the race window between a
     placed call and `set_status(case_id, "done")` does not phone the family
     twice.

Run: ./.venv/bin/python tests/test_report_call.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import report_call, storage  # noqa: E402
from app.config import settings  # noqa: E402

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
        "call_id": "conv_fh001", "reached": True, "quoted_price_usd": 4200,
    })
    # Never dialed at all — shaped like a real _mark_unreachable record
    # (calls.py: call_id always None, status/notes always present), not a
    # hand-rolled shortcut, so _homes_called exercises the real discriminator.
    storage._write_json(d / "quotes" / "fh_002.json", {
        "funeral_home_id": "fh_002", "funeral_home_name": "Cedar Rest",
        "call_id": None, "reached": False, "quoted_price_usd": None,
        "status": "unreachable", "notes": "no phone number",
    })
    storage._write_json(d / "quotes" / "fh_003.json", {
        "funeral_home_id": "fh_003", "funeral_home_name": "Riverside",
        "call_id": "conv_fh003", "reached": True, "quoted_price_usd": 5000,
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
        d = Path(td) / case_id

        name, price = report_call._best_home(case_id)
        check(name == "Oak Hill", f"expected cheapest home Oak Hill, got {name!r}")
        check(price == 3650, f"expected the negotiated 3650, got {price!r}")
        # Of the 3 quotes/*.json records, only fh_001 and fh_003 were actually
        # dialed (call_id set); fh_002 is a real _mark_unreachable shape
        # (call_id: None) — a home whose phone never rang at all.
        check(report_call._homes_called(case_id) == 2,
              f"expected 2 actually-dialed homes, got {report_call._homes_called(case_id)}")

        # A DEMO-skipped home is exactly the same shape — never dialed, so
        # call_id is None — and must not inflate the count either. This is
        # the shape that made the fallback claim "We called 5 funeral homes"
        # in DEMO_MODE when only one was ever dialed.
        storage._write_json(d / "quotes" / "fh_004.json", {
            "funeral_home_id": "fh_004", "funeral_home_name": "Never Dialed",
            "call_id": None, "reached": False, "quoted_price_usd": None,
            "status": "unreachable", "notes": "skipped: not a DEMO_TARGET in DEMO_MODE",
        })
        check(report_call._homes_called(case_id) == 2,
              f"DEMO-skipped record inflated homes_called: "
              f"{report_call._homes_called(case_id)}")

        summary, source = report_call.summarize_for_speech(case_id, "# report")

    check(source == "fallback", f"LLM raised but source is {source!r}")
    check(summary.strip() != "", "fallback summary is empty — the agent would have a blank to fill")
    check("Oak Hill" in summary, f"fallback omits the recommended home: {summary!r}")
    check("$3,650" in summary, f"fallback omits the final price: {summary!r}")
    check("We called 2 funeral homes" in summary,
          f"fallback omits the number of actually-dialed homes: {summary!r}")


class _CapturingOpenAI:
    """Stands in for OpenAI on the LLM-success path, capturing what it was sent.

    Unlike _BoomOpenAI (which forces the fallback path everywhere else in this
    file), this lets a test inspect exactly what summarize_for_speech hands the
    model — needed to prove the derived recommendation actually reaches it.
    """

    last_kwargs: dict = {}

    def __init__(self, *a, **kw):
        pass

    class responses:
        @staticmethod
        def create(**kwargs):
            _CapturingOpenAI.last_kwargs = kwargs

            class _Resp:
                output_text = "Riverside is our recommendation at $9,999. We called some homes."

            return _Resp()


def test_llm_summary_bound_to_best_home() -> None:
    """summarize_for_speech must hand the LLM the same recommendation the
    dynamic variables (recommended_home/final_price) state — not just the raw,
    ungated report body.

    report.md (app/report.py) applies no `agreed` filter and its LLM may
    recommend a different, higher-value home than the strictly-cheapest
    _best_home. Without passing the gated truth into this call as a binding
    constraint, the agent could open with the correctly-gated final_price
    variable and then read a report_summary built from the ungated report —
    naming a different home and price on the same call. This is the same
    class of defect as the confidential-figure leak in _competing_disclosure
    (calls.py): an assertive sentence that isn't tied to evidence.
    """
    real_openai = report_call.OpenAI
    report_call.OpenAI = _CapturingOpenAI
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed(Path(td))
            # A report body that recommends a different home/price than
            # _best_home would ever allow, so a passing test actually proves
            # the constraint governs rather than merely being vacuously true.
            conflicting_md = "# Report\n\nWe recommend Riverside at $9,999.\n"
            summary, source = report_call.summarize_for_speech(case_id, conflicting_md)
    finally:
        report_call.OpenAI = real_openai

    check(source == "llm", f"expected the LLM path, got {source!r}")
    sent = _CapturingOpenAI.last_kwargs.get("input") or []
    user_msg = next((m.get("content", "") for m in sent if m.get("role") == "user"), "")
    check("AUTHORITATIVE CONSTRAINT" in user_msg,
          f"summarization call was not given the derived recommendation as a "
          f"binding constraint: {user_msg!r}")
    check("Oak Hill" in user_msg,
          f"constraint omits the gated recommendation (Oak Hill): {user_msg!r}")
    check("$3,650" in user_msg,
          f"constraint omits the gated final price ($3,650): {user_msg!r}")


def test_unagreed_negotiation_ignored() -> None:
    """agreed: false with a non-null final_price_usd must not win as the best price.

    _validate_final_price (extraction.py) only type-checks the field; it never
    enforces the extraction prompt's "if nothing was agreed, use null" rule. So
    this record shape is reachable, and _best_home must not trust it.
    """
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        d = Path(td) / case_id
        # Oak Hill's negotiation didn't actually land, but final_price_usd is
        # (wrongly) populated anyway — this must be ignored in favor of the
        # home's quoted_price_usd (4200), not trusted as the confirmed price.
        storage._write_json(d / "negotiations" / "fh_001.json", {
            "funeral_home_id": "fh_001", "funeral_home_name": "Oak Hill",
            "agreed": False, "final_price_usd": 1,
        })

        name, price = report_call._best_home(case_id)
        check(price != 1, f"unagreed final_price_usd of 1 was trusted: {price!r}")
        check(name == "Oak Hill", f"expected cheapest home Oak Hill, got {name!r}")
        check(price == 4200, f"expected Oak Hill's quoted 4200, not the unagreed figure, got {price!r}")


def test_corrupt_quote_file_never_raises() -> None:
    """A corrupt JSON file under quotes/ must not escape summarize_for_speech.

    storage._read_json is a bare json.loads with no error handling, and
    _fallback_summary reaches it via _best_home/_homes_called. The function's
    contract is that it never raises and never returns an empty string, so the
    fallback path must be guarded independently of the LLM try/except.
    """
    with tempfile.TemporaryDirectory() as td:
        case_id = _seed(Path(td))
        d = Path(td) / case_id
        (d / "quotes" / "fh_001.json").write_text("{not valid json")

        try:
            summary, source = report_call.summarize_for_speech(case_id, "# report")
        except Exception as e:
            check(False, f"summarize_for_speech raised on corrupt quote JSON: {e!r}")
        else:
            check(source == "fallback", f"expected fallback source, got {source!r}")
            check(summary.strip() != "", "summary is empty despite corrupt JSON on disk")


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
    real_outbound_call = report_call.outbound_call
    real_elevenlabs_report_agent_id = settings.elevenlabs_report_agent_id
    real_demo_mode = settings.demo_mode

    rec = _Recorder()
    report_call.outbound_call = rec
    settings.elevenlabs_report_agent_id = "agent_report_1"
    settings.demo_mode = False

    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed(Path(td))
            result = report_call.deliver_report(case_id, "# report")
            saved = storage.read_json(case_id, "report_call.json")
    finally:
        report_call.outbound_call = real_outbound_call
        settings.elevenlabs_report_agent_id = real_elevenlabs_report_agent_id
        settings.demo_mode = real_demo_mode

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
    real_outbound_call = report_call.outbound_call
    real_elevenlabs_report_agent_id = settings.elevenlabs_report_agent_id
    real_demo_mode = settings.demo_mode
    real_demo_targets = settings.demo_targets

    try:
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
    finally:
        report_call.outbound_call = real_outbound_call
        settings.elevenlabs_report_agent_id = real_elevenlabs_report_agent_id
        settings.demo_mode = real_demo_mode
        settings.demo_targets = real_demo_targets


def test_failures_never_raise() -> None:
    real_outbound_call = report_call.outbound_call
    real_elevenlabs_report_agent_id = settings.elevenlabs_report_agent_id
    real_demo_mode = settings.demo_mode

    try:
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
    finally:
        report_call.outbound_call = real_outbound_call
        settings.elevenlabs_report_agent_id = real_elevenlabs_report_agent_id
        settings.demo_mode = real_demo_mode


def test_save_json_failure_never_raises() -> None:
    """A persistent storage failure (disk full, permissions) must not escape
    deliver_report — not even from the outer catch-all's own attempt to
    record the failure.

    Forces a guard path (no agent id) so _record is called with
    storage.save_json patched to always raise. Before the fix, that raise
    propagates out of _record, is caught by deliver_report's outer except,
    which calls _record again to log "failed" — and that save_json call
    raises too, escaping deliver_report unhandled. After the fix, the first
    _record call swallows the storage failure internally and still returns
    a well-formed "skipped" record.
    """
    settings.elevenlabs_report_agent_id = ""
    settings.demo_mode = False

    real_save_json = storage.save_json
    storage.save_json = lambda *a, **kw: (_ for _ in ()).throw(OSError("disk full"))
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed(Path(td))
            try:
                r = report_call.deliver_report(case_id, "# report")
            except Exception as e:
                check(False, f"deliver_report raised despite persistent storage failure: {e!r}")
                return
    finally:
        storage.save_json = real_save_json

    check(isinstance(r, dict), f"expected a dict even when nothing could be persisted, got {r!r}")
    check(set(r) == {"status", "call_id", "to_number", "summary_source", "notes"},
          f"record shape drifted when storage failed: {sorted(r)}")
    check(r["status"] == "skipped" and "REPORT_AGENT_ID" in r["notes"],
          f"guard status/notes lost when storage kept raising: {r!r}")


def test_index_conversation_failure_still_placed() -> None:
    """A successfully placed call must be recorded as placed even if the
    post-call bookkeeping (index_conversation) blows up — the family's phone
    is already ringing by the time indexing runs, so its failure must not
    contradict reality in the recorded status.
    """
    settings.elevenlabs_report_agent_id = "agent_report_1"
    settings.demo_mode = False

    rec = _Recorder()
    report_call.outbound_call = rec

    real_index_conversation = storage.index_conversation
    storage.index_conversation = lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError("index corrupted"))
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed(Path(td))
            r = report_call.deliver_report(case_id, "# report")
            saved = storage.read_json(case_id, "report_call.json")
    finally:
        storage.index_conversation = real_index_conversation

    check(r["status"] == "placed",
          f"a placed call was recorded as {r['status']!r} because indexing failed: {r!r}")
    check(r["call_id"] == "conv_test_1", f"call_id lost when indexing failed: {r!r}")
    check(saved == r, f"report_call.json disagrees with the return value: {saved!r}")


def test_pipeline_reaches_done() -> None:
    """A failing report call must not strand the case before `done`."""
    from app import calls, report

    real_generate_report = report.generate_report
    real_outbound_call = report_call.outbound_call
    real_elevenlabs_report_agent_id = settings.elevenlabs_report_agent_id
    real_demo_mode = settings.demo_mode

    settings.elevenlabs_report_agent_id = "agent_report_1"
    settings.demo_mode = False
    report_call.outbound_call = _Recorder(exc=report_call.ElevenLabsError("503"))
    report.generate_report = lambda cid: "# Grace — Funeral Quote Report\n"
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed(Path(td), status="negotiating")
            # An empty shortlist means the loop falls straight through to reporting.
            storage._write_json(Path(td) / case_id / "strategy.json",
                                {"shortlist": [], "per_home_strategy": []})
            # generate_report would call OpenAI; its own fallback is tested elsewhere.

            result = calls.start_next_nego_call(case_id)
            case = storage.read_case(case_id)
    finally:
        report.generate_report = real_generate_report
        report_call.outbound_call = real_outbound_call
        settings.elevenlabs_report_agent_id = real_elevenlabs_report_agent_id
        settings.demo_mode = real_demo_mode

    check(case["status"] == "done", f"case stranded at {case['status']!r} by a failed call")
    check(result.get("report_call", {}).get("status") == "failed",
          f"report_call outcome not surfaced in the return value: {result!r}")


def test_pipeline_places_report_call() -> None:
    """Mirror of test_pipeline_reaches_done for the success path.

    That test only exercises a *failing* report call, so a regression that
    dropped deliver_report from start_next_nego_call entirely would still
    pass the suite — the case would still reach `done`. This asserts the
    wiring actually places a call.

    It doubles as the regression test for Finding 1 (duplicate report calls):
    start_next_nego_call's own status guard only stops a second call once
    set_status(case_id, "done") has landed, which happens *after*
    deliver_report returns. A second entrant that read status=="negotiating"
    before that write — a retried webhook, or a genuine race — reaches
    deliver_report again with the shortlist still exhausted. We simulate that
    exact window by putting the case back to "negotiating" (the state a
    racing entrant would have observed) and re-entering; without the guard in
    report_call._deliver, this dials the family a second time.
    """
    from app import calls, report

    real_generate_report = report.generate_report
    real_outbound_call = report_call.outbound_call
    real_elevenlabs_report_agent_id = settings.elevenlabs_report_agent_id
    real_demo_mode = settings.demo_mode

    settings.elevenlabs_report_agent_id = "agent_report_1"
    settings.demo_mode = False
    rec = _Recorder()
    report_call.outbound_call = rec
    report.generate_report = lambda cid: "# Grace — Funeral Quote Report\n"
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed(Path(td), status="negotiating")
            storage._write_json(Path(td) / case_id / "strategy.json",
                                {"shortlist": [], "per_home_strategy": []})

            result = calls.start_next_nego_call(case_id)
            case = storage.read_case(case_id)

            # Simulate the race: put the case back into the state a second
            # entrant would have observed before set_status(..., "done")
            # landed, then re-enter the exact same code path.
            storage.set_status(case_id, "negotiating")
            result2 = calls.start_next_nego_call(case_id)
            saved = storage.read_json(case_id, "report_call.json")
    finally:
        report.generate_report = real_generate_report
        report_call.outbound_call = real_outbound_call
        settings.elevenlabs_report_agent_id = real_elevenlabs_report_agent_id
        settings.demo_mode = real_demo_mode

    check(case["status"] == "done", f"case did not reach done: {case['status']!r}")
    check(result.get("report_call", {}).get("status") == "placed",
          f"report call not placed on the success path: {result!r}")
    check(len(rec.calls) == 1,
          f"expected exactly one call placed after the first entrant, got {len(rec.calls)}")

    check(result2.get("report_call", {}).get("status") == "placed",
          f"second entrant lost the prior placed record: {result2!r}")
    check(len(rec.calls) == 1,
          f"second entrant during the race window phoned the family again: "
          f"{len(rec.calls)} calls placed")
    check((saved or {}).get("call_id") == result.get("report_call", {}).get("call_id"),
          f"second entrant's record diverged from the original placed call: {saved!r}")


def main() -> int:
    report_call.OpenAI = _BoomOpenAI
    test_summary()
    test_llm_summary_bound_to_best_home()
    test_unagreed_negotiation_ignored()
    test_corrupt_quote_file_never_raises()
    test_happy_path()
    test_guards()
    test_failures_never_raise()
    test_pipeline_reaches_done()
    test_pipeline_places_report_call()
    test_save_json_failure_never_raises()
    test_index_conversation_failure_still_placed()

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: report call guards hold; no blank variables; nothing raises")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
