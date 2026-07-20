"""Guards on unexpected call termination (issue #16).

The pipeline used to advance only on a clean webhook and had no notion of a
call that failed: a conversation that errored, or was cut off after two
seconds, was fed to extraction exactly like a complete one, and if every
funeral home failed the case still walked into strategy with nothing to
negotiate over.

Field names under test were confirmed against saved post-call payloads in
data/<case_id>/raw/<conversation_id>.json (5 real conversations, 2026-07-19):
data.status, data.analysis.call_successful, data.metadata.termination_reason,
data.metadata.error, data.metadata.call_duration_secs.

Invariants under test:
  1. The four outcome fields are parsed off the real payload shape.
  2. A real completed conversation is NOT flagged as a failure (no false
     positives — verified against the shape of all five saved payloads).
  3. Each documented negative signal IS flagged: bad status, an explicit
     call_successful="failure", a metadata.error, a sub-5s call, a <2-turn call.
  4. Fail-open on the unknown: an unrecognised status, and the tri-state's
     "unknown", must not condemn a call that otherwise looks complete.
  5. failure_reason never raises, whatever shape the payload is.
  6. A failed quote/nego call is routed to the unreachable path and its
     transcript is NEVER handed to extraction — a truncated call can carry a
     plausible number, and extracting it would record a price nobody quoted.
  7. Such a record still carries the conversation_id, since the phone did ring.
  8. If not one home yields a usable quote the case stops at `quotes_failed`
     and strategy is never run — rather than advancing to quotes_collected.
  9. `quotes_failed` is terminal: a webhook retry cannot bounce the case out.
 10. One usable quote is enough to proceed (the stop is not over-eager).
 11. Every failure status is mapped in web_api._PROGRESS, or the dashboard
     pipeline goes dark for a stopped case.

Run: ./.venv/bin/python tests/test_call_failure.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import calls, state_machine, storage, web_api, webhook  # noqa: E402
from app.config import settings  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


# --- payload builders -------------------------------------------------------

def _payload(
    *,
    status: str = "done",
    call_successful: str = "success",
    termination_reason: str = "Call ended by remote party",
    error: object = None,
    duration: object = 96,
    turns: int = 11,
    agent_type: str = "quote",
) -> dict:
    """A post-call webhook shaped like the saved real ones, healthy by default."""
    return {
        "type": "post_call_transcription",
        "data": {
            "conversation_id": "conv_test_1",
            "agent_id": "agent_1",
            "status": status,
            "transcript": [
                {"role": "agent" if i % 2 == 0 else "user", "message": f"line {i}"}
                for i in range(turns)
            ],
            "analysis": {
                "call_successful": call_successful,
                "transcript_summary": "a summary",
                "data_collection_results": {},
            },
            "metadata": {
                "call_duration_secs": duration,
                "termination_reason": termination_reason,
                "error": error,
                "phone_call": {
                    "direction": "outbound",
                    "external_number": "+14155550100",
                    "agent_number": "+14155550199",
                },
            },
            "conversation_initiation_client_data": {
                "dynamic_variables": {
                    "case_id": "case_test_001",
                    "agent_type": agent_type,
                    "fh_id": "fh_001",
                },
            },
        },
    }


# --- 1, 2, 3, 4: parsing and the failure verdict ----------------------------

def test_parses_outcome_fields() -> None:
    p = webhook.parse_webhook(_payload())
    check(p.status == "done", f"status not parsed: {p.status!r}")
    check(p.call_successful == "success",
          f"analysis.call_successful not parsed: {p.call_successful!r}")
    check(p.termination_reason == "Call ended by remote party",
          f"metadata.termination_reason not parsed: {p.termination_reason!r}")
    check(p.call_duration_secs == 96,
          f"metadata.call_duration_secs not parsed: {p.call_duration_secs!r}")
    check(p.call_error == "", f"healthy call reported an error: {p.call_error!r}")


def test_completed_call_is_not_a_failure() -> None:
    p = webhook.parse_webhook(_payload())
    check(p.failure_reason is None,
          f"healthy call flagged as failed: {p.failure_reason!r}")
    check(p.call_failed is False, "call_failed disagrees with failure_reason")

    # The exact shape of every saved real payload: status done / success, a
    # remote-party hangup, no error, comfortably long. None may be rejected.
    for dur, turns in ((96, 11), (175, 21), (118, 16), (165, 31), (90, 15)):
        q = webhook.parse_webhook(_payload(duration=dur, turns=turns))
        check(q.failure_reason is None,
              f"real completed call ({dur}s/{turns} turns) flagged: "
              f"{q.failure_reason!r}")


def test_negative_signals_are_flagged() -> None:
    cases = {
        "bad status": _payload(status="failed"),
        "error status": _payload(status="error"),
        "call_successful=failure": _payload(call_successful="failure"),
        "metadata.error string": _payload(error="twilio: no answer"),
        "metadata.error dict": _payload(error={"message": "carrier rejected"}),
        # Issue #16's "cut off after two seconds".
        "two-second call": _payload(duration=2, termination_reason="Call failed"),
        "single turn": _payload(turns=1),
        "no turns": _payload(turns=0),
    }
    for label, payload in cases.items():
        p = webhook.parse_webhook(payload)
        check(p.failure_reason is not None, f"{label}: not flagged as a failure")
        check(p.call_failed is True, f"{label}: call_failed disagrees")

    # The recorded reason has to be diagnosable on-call, not just truthy.
    p = webhook.parse_webhook(_payload(duration=2, termination_reason="Call failed"))
    check("2s" in (p.failure_reason or ""),
          f"truncation reason omits the duration: {p.failure_reason!r}")
    check("Call failed" in (p.failure_reason or ""),
          f"truncation reason omits the termination reason: {p.failure_reason!r}")


def test_unknown_signals_fail_open() -> None:
    """A status or enum member ElevenLabs adds later must not start discarding
    calls that actually worked. Only known-bad values condemn a call."""
    p = webhook.parse_webhook(_payload(status="completed_with_summary"))
    check(p.failure_reason is None,
          f"unrecognised status treated as failure: {p.failure_reason!r}")

    # "unknown" is what short or ambiguous conversations report; the transcript
    # may still hold a usable quote, so it is not on its own a failure.
    p = webhook.parse_webhook(_payload(call_successful="unknown"))
    check(p.failure_reason is None,
          f"call_successful=unknown treated as failure: {p.failure_reason!r}")

    # Missing duration must not be read as zero.
    p = webhook.parse_webhook(_payload(duration=None))
    check(p.failure_reason is None,
          f"absent duration treated as truncation: {p.failure_reason!r}")


def test_initialization_failure_is_caught_even_when_status_lies() -> None:
    """The decisive real-world case, from 33 saved payloads across 26 cases.

    Eleven of them failed with termination_reason "Conversation initialization
    failed" — the agent never got its dynamic variables, so nothing was said.
    Only TWO of those eleven report status="failed"/call_successful="failure".
    The other NINE report status="done" and call_successful="success": the
    outcome enums say the call went fine when it did not.

    So the enums alone would have let 9 of 11 real failures through into
    extraction. What actually catches them is the independent truncation
    check — every one ran 0-3s and produced 0-1 turns. This test exists to stop
    anyone "simplifying" that check away as redundant with the enums.
    """
    lying = _payload(
        status="done",              # says fine
        call_successful="success",  # says fine
        termination_reason="Conversation initialization failed",
        error={
            "code": 1008,
            "reason": "Missing required dynamic variables in tools: {'case_id'}",
        },
        duration=1,
        turns=1,
    )
    p = webhook.parse_webhook(lying)
    check(p.failure_reason is not None,
          "initialization failure passed as healthy because status/enum lied")

    # The 1008 reason is the actual diagnosis; burying it in an escaped dict
    # repr is what makes this class of outage hard to spot in the logs.
    check("case_id" in p.call_error,
          f"error detail lost — reason not surfaced: {p.call_error!r}")
    check("1008" in p.call_error,
          f"error code lost: {p.call_error!r}")

    # And the zero-duration variant seen in the same corpus.
    q = webhook.parse_webhook(_payload(
        status="done", call_successful="success",
        termination_reason="Conversation initialization failed",
        duration=0, turns=0,
    ))
    check(q.failure_reason is not None,
          "0s / 0-turn initialization failure passed as healthy")


def test_failure_reason_never_raises() -> None:
    """Whatever the payload, deciding the verdict must not throw — this runs
    inside the webhook handler, and an exception there is a 5xx that makes
    ElevenLabs retry-storm the endpoint."""
    garbage: list[dict] = [
        {},
        {"data": None},
        {"data": {}},
        {"data": {"metadata": None, "analysis": None, "transcript": None}},
        {"data": {"metadata": {"call_duration_secs": "ninety"}}},
        {"data": {"metadata": {"call_duration_secs": True}}},
        {"data": {"metadata": {"error": []}}},
        {"data": {"analysis": {"call_successful": 17}}},
        {"data": {"status": None, "transcript": [{"role": "agent"}]}},
    ]
    for i, payload in enumerate(garbage):
        try:
            p = webhook.parse_webhook(payload)
            reason = p.failure_reason
        except Exception as e:
            failures.append(f"garbage payload #{i} raised {type(e).__name__}: {e}")
            continue
        check(reason is None or isinstance(reason, str),
              f"garbage payload #{i}: reason is {reason!r}")
        check(reason != "", f"garbage payload #{i}: empty-string reason is falsy")


# --- 6, 7: a failed call never reaches extraction ---------------------------

class _ExtractorSpy:
    """Stands in for the extractors. Being called at all is the failure."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def __call__(self, transcript: str) -> dict:
        self.calls.append(transcript)
        # A truncated call really can contain a number — that is the whole
        # danger. Return a confident-looking result so a leak is visible.
        return {"reached": True, "quoted_price_usd": 1234, "agreed": True,
                "final_price_usd": 1234, "price_type": "total",
                "includes": [], "excludes": [], "notes": ""}


def _seed_case(tmp: Path, status: str) -> str:
    storage.DATA_DIR = tmp
    storage.INDEX_PATH = tmp / "_index.json"
    case_id = "case_test_001"
    storage._write_json(tmp / case_id / "case.json",
                        {"case_id": case_id, "status": status})
    storage._write_json(tmp / case_id / "funeral_homes.json",
                        [{"id": "fh_001", "name": "Oak Hill", "phone": "+14155550100"}])
    storage._write_json(tmp / case_id / "user_info.json", {"contact_name": "Dana"})
    return case_id


def test_failed_quote_call_skips_extraction() -> None:
    spy = _ExtractorSpy()
    real_extract = calls.extract_quote
    real_auto = settings.auto_advance
    calls.extract_quote = spy
    settings.auto_advance = False  # keep this test off the network
    try:
        with tempfile.TemporaryDirectory() as td:
            # Not `calling_for_quotes`, so the chained start_next_quote_call
            # early-returns and this test cannot dial.
            case_id = _seed_case(Path(td), "quotes_collected")
            calls.handle_quote_result(
                case_id, "fh_001", "conv_test_1",
                "agent: hello?",  # a real, non-empty, but truncated transcript
                failure_reason="conversation truncated: 2s (Call failed)",
            )
            rec = storage.read_json(case_id, "quotes/fh_001.json")
    finally:
        calls.extract_quote = real_extract
        settings.auto_advance = real_auto

    check(spy.calls == [], f"extraction ran on a failed call: {spy.calls!r}")
    check(rec is not None, "no quote record written for a failed call")
    rec = rec or {}
    check(rec.get("reached") is False, f"failed call recorded as reached: {rec!r}")
    check(rec.get("quoted_price_usd") is None,
          f"failed call recorded a price: {rec.get('quoted_price_usd')!r}")
    check(rec.get("status") == "unreachable",
          f"failed call not marked unreachable: {rec.get('status')!r}")
    # It really was dialed, so it must count as a dial attempt.
    check(rec.get("call_id") == "conv_test_1",
          f"dialed-but-failed home lost its call_id: {rec.get('call_id')!r}")
    check("2s" in (rec.get("notes") or ""),
          f"record does not say why it failed: {rec.get('notes')!r}")


def test_failed_nego_call_skips_extraction() -> None:
    spy = _ExtractorSpy()
    real_extract = calls.extract_final_price
    real_auto = settings.auto_advance
    calls.extract_final_price = spy
    settings.auto_advance = False
    try:
        with tempfile.TemporaryDirectory() as td:
            # Not strategy_ready/negotiating, so the chained
            # start_next_nego_call early-returns: no report, no call.
            case_id = _seed_case(Path(td), "quotes_collected")
            calls.handle_nego_result(
                case_id, "fh_001", "conv_test_1",
                "agent: are you there?",
                failure_reason="call_successful='failure'",
            )
            rec = storage.read_json(case_id, "negotiations/fh_001.json")
    finally:
        calls.extract_final_price = real_extract
        settings.auto_advance = real_auto

    check(spy.calls == [], f"extraction ran on a failed nego call: {spy.calls!r}")
    check(rec is not None, "no negotiation record written for a failed call")
    rec = rec or {}
    check(rec.get("agreed") is False,
          f"failed nego call recorded as AGREED: {rec!r}")
    check(rec.get("final_price_usd") is None,
          f"failed nego call recorded a final price: {rec.get('final_price_usd')!r}")
    check(rec.get("call_id") == "conv_test_1",
          f"dialed-but-failed nego lost its call_id: {rec.get('call_id')!r}")


# --- 8, 9, 10: no usable quote is a terminal stop ---------------------------

class _StrategySpy:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def __call__(self, case_id: str) -> dict:
        self.calls.append(case_id)
        return {"ok": True}


def _seed_exhausted(tmp: Path, quotes: list[dict]) -> str:
    """A case whose every home already has a quote record — the quote round is
    over, so start_next_quote_call falls straight through to the verdict."""
    storage.DATA_DIR = tmp
    storage.INDEX_PATH = tmp / "_index.json"
    case_id = "case_test_001"
    storage._write_json(tmp / case_id / "case.json",
                        {"case_id": case_id, "status": "calling_for_quotes"})
    storage._write_json(
        tmp / case_id / "funeral_homes.json",
        [{"id": q["funeral_home_id"], "name": q.get("funeral_home_name", ""),
          "phone": "+14155550100"} for q in quotes],
    )
    storage._write_json(tmp / case_id / "user_info.json", {"contact_name": "Dana"})
    for q in quotes:
        storage._write_json(tmp / case_id / "quotes" / f"{q['funeral_home_id']}.json", q)
    return case_id


def _unreachable(fh_id: str, notes: str = "call failed") -> dict:
    return {"funeral_home_id": fh_id, "funeral_home_name": fh_id.upper(),
            "call_id": "conv_x", "reached": False, "quoted_price_usd": None,
            "status": "unreachable", "notes": notes}


def _priced(fh_id: str, price: int) -> dict:
    return {"funeral_home_id": fh_id, "funeral_home_name": fh_id.upper(),
            "call_id": "conv_y", "reached": True, "quoted_price_usd": price}


def _run_quote_round(quotes: list[dict]) -> tuple[str, dict, _StrategySpy]:
    """Drive start_next_quote_call to the end of the round with auto-advance ON
    (the real cascade), returning the final status and whether strategy ran."""
    from app import strategy as strategy_mod

    spy = _StrategySpy()
    real_run = strategy_mod.run_strategy
    real_auto = settings.auto_advance
    strategy_mod.run_strategy = spy
    settings.auto_advance = True
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed_exhausted(Path(td), quotes)
            result = calls.start_next_quote_call(case_id)
            case = storage.read_case(case_id) or {}
    finally:
        strategy_mod.run_strategy = real_run
        settings.auto_advance = real_auto
    return case.get("status", ""), result, spy


def test_all_homes_failed_stops_the_case() -> None:
    status, result, spy = _run_quote_round(
        [_unreachable("fh_001"), _unreachable("fh_002", "no phone number")]
    )
    check(status == "quotes_failed",
          f"every home failed but case advanced to {status!r}")
    check(status != "quotes_collected",
          "case walked into strategy with nothing to negotiate over")
    check(spy.calls == [],
          f"strategy ran on zero usable quotes: {spy.calls!r}")
    check(result.get("status") == "quotes_failed",
          f"return value hides the failure: {result!r}")


def test_reached_but_unpriced_is_not_usable() -> None:
    """A home that answered but never gave a number leaves the strategy LLM no
    price to target and the negotiator nothing to cite."""
    answered_no_price = {
        "funeral_home_id": "fh_001", "funeral_home_name": "Oak Hill",
        "call_id": "conv_z", "reached": True, "quoted_price_usd": None,
    }
    status, _, spy = _run_quote_round([answered_no_price])
    check(status == "quotes_failed",
          f"reached-but-unpriced treated as a usable quote (status {status!r})")
    check(spy.calls == [], "strategy ran with no price anywhere")


def test_one_usable_quote_still_proceeds() -> None:
    """The stop must not be over-eager: one real quote is enough to continue."""
    status, _, spy = _run_quote_round([_unreachable("fh_001"), _priced("fh_002", 4200)])
    check(status == "quotes_collected",
          f"a usable quote existed but the case stopped at {status!r}")
    check(spy.calls != [], "strategy did not run despite a usable quote")


def test_corrupt_quote_file_never_raises() -> None:
    """An unreadable quote file must not take the webhook down; it is simply
    not usable."""
    real_auto = settings.auto_advance
    settings.auto_advance = False
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed_exhausted(Path(td), [_unreachable("fh_001")])
            (Path(td) / case_id / "quotes" / "fh_002.json").write_text("{not json")
            try:
                calls.start_next_quote_call(case_id)
            except Exception as e:
                failures.append(f"corrupt quote file raised {type(e).__name__}: {e}")
            status = (storage.read_case(case_id) or {}).get("status")
    finally:
        settings.auto_advance = real_auto
    check(status == "quotes_failed",
          f"corrupt file counted as a usable quote (status {status!r})")


def test_quotes_failed_is_terminal() -> None:
    """A webhook retry re-entering the loop must not bounce the case back out
    of its terminal status and into strategy."""
    from app import strategy as strategy_mod

    spy = _StrategySpy()
    real_run = strategy_mod.run_strategy
    real_auto = settings.auto_advance
    strategy_mod.run_strategy = spy
    settings.auto_advance = True
    try:
        with tempfile.TemporaryDirectory() as td:
            case_id = _seed_exhausted(Path(td), [_unreachable("fh_001")])
            calls.start_next_quote_call(case_id)
            first = (storage.read_case(case_id) or {}).get("status")
            # Retry, exactly as a duplicate webhook would.
            calls.start_next_quote_call(case_id)
            second = (storage.read_case(case_id) or {}).get("status")
    finally:
        strategy_mod.run_strategy = real_run
        settings.auto_advance = real_auto

    check(first == "quotes_failed", f"first pass: {first!r}")
    check(second == "quotes_failed",
          f"retry moved the case off its terminal status: {second!r}")
    check(spy.calls == [], f"retry ran strategy anyway: {spy.calls!r}")


# --- 11: the dashboard can see a stopped case ------------------------------

def test_failure_statuses_are_mapped_for_the_dashboard() -> None:
    for status in state_machine.FAILURE_STATUSES:
        check(status in web_api._PROGRESS,
              f"status {status!r} missing from web_api._PROGRESS — the dashboard "
              f"pipeline nodes go dark and a stopped case reads as merely slow")


def main() -> int:
    test_parses_outcome_fields()
    test_completed_call_is_not_a_failure()
    test_negative_signals_are_flagged()
    test_unknown_signals_fail_open()
    test_failure_reason_never_raises()
    test_failed_quote_call_skips_extraction()
    test_failed_nego_call_skips_extraction()
    test_all_homes_failed_stops_the_case()
    test_reached_but_unpriced_is_not_usable()
    test_one_usable_quote_still_proceeds()
    test_corrupt_quote_file_never_raises()
    test_quotes_failed_is_terminal()
    test_failure_statuses_are_mapped_for_the_dashboard()

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: failed/truncated calls never reach extraction; "
          "a quote round with nothing usable stops at quotes_failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
