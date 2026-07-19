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


def main() -> int:
    report_call.OpenAI = _BoomOpenAI
    test_summary()
    test_unagreed_negotiation_ignored()
    test_corrupt_quote_file_never_raises()

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: spoken summary degrades safely and never returns blank")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
