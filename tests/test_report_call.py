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


def main() -> int:
    report_call.OpenAI = _BoomOpenAI
    test_summary()
    test_unagreed_negotiation_ignored()
    test_corrupt_quote_file_never_raises()
    test_happy_path()
    test_guards()
    test_failures_never_raise()
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
