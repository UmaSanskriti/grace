"""Guard: the negotiation agent may only cite competitor amounts a provider really quoted.

Regression test for the 2026-07-19 incident. On both negotiation calls the agent
announced "a verified quote of $X from another provider" where $X was the
CONFIDENTIAL `target_price` — $2,500 for fh_001 and $3,500 for fh_003. No provider
quoted either number.

Root cause: the live prompt read `{{competing_quote_disclosure}} (a verified quote
of {{competing_quote_total}})`, but calls.py sent neither variable, so both rendered
empty. The prompt asserted a verified competing quote existed, ordered the agent to
state it, and gave it a blank — which it filled with the nearest salient number, the
target price it had been told to keep confidential.

Invariants under test:
  1. Every dollar figure the agent may cite as a competitor quote is backed by a
     `quoted_price_usd` in this case's quote records.
  2. `target_price` / `walk_away_price` NEVER appear in the citable disclosure.
  3. With no competitors, the disclosure is an explicit denial containing no digits
     at all — no blank to fill.
  4. The old conflated `leverage` var and the bare-number `competing_quote_total`
     hole are both gone.

Run: ./.venv/bin/python tests/test_nego_leverage.py
"""

from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import calls, storage  # noqa: E402

# fh_003 must UNDERCUT fh_001, otherwise it is not leverage and the disclosure
# is correctly suppressed — which would make the positive path here vacuous.
REAL_QUOTES = {"fh_001": 3000, "fh_003": 2800}
TARGET_PRICE = 2500      # the number the agent actually leaked
WALK_AWAY = 3000
MARKET_ONLY = {2000, 3500}  # from Tavily; nobody quoted these

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def _amounts(text: str) -> set[int]:
    return {int(m.replace(",", "")) for m in re.findall(r"\$([\d,]+)", text or "")}


def _seed(tmp: Path, *, with_competitor: bool) -> str:
    storage.DATA_DIR = tmp
    storage.INDEX_PATH = tmp / "_index.json"
    case_id = "case_test_001"
    d = tmp / case_id
    storage._write_json(d / "case.json", {"case_id": case_id, "status": "negotiating"})
    storage._write_json(d / "user_info.json", {
        "service_type": "cremation", "must_haves": [], "flexible_if_savings": [],
    })
    storage._write_json(d / "funeral_homes.json", [
        {"id": "fh_001", "name": "Demo Funeral Home 1"},
        {"id": "fh_003", "name": "Demo Funeral Home 3"},
    ])
    storage._write_json(d / "quotes" / "fh_001.json", {
        "funeral_home_id": "fh_001", "funeral_home_name": "Demo Funeral Home 1",
        "reached": True, "quoted_price_usd": 3000, "price_type": "total_package",
        "includes": ["Cremation for ~50 people"], "excludes": ["Transportation fee"],
    })
    if with_competitor:
        storage._write_json(d / "quotes" / "fh_003.json", {
            "funeral_home_id": "fh_003", "funeral_home_name": "Demo Funeral Home 3",
            "reached": True, "quoted_price_usd": REAL_QUOTES["fh_003"],
        })
    else:
        # Reached, but gave no number — must NOT become citable leverage.
        storage._write_json(d / "quotes" / "fh_003.json", {
            "funeral_home_id": "fh_003", "funeral_home_name": "Demo Funeral Home 3",
            "reached": True, "quoted_price_usd": None,
        })
    return case_id


def _vars(tmp: Path, *, with_competitor: bool) -> dict:
    case_id = _seed(tmp, with_competitor=with_competitor)
    home = {"id": "fh_001", "name": "Demo Funeral Home 1"}
    quote = storage.read_json(case_id, "quotes/fh_001.json")
    hs = {
        "funeral_home_id": "fh_001", "current_price_usd": 3000,
        "target_price_usd": TARGET_PRICE, "walk_away_price_usd": WALK_AWAY,
        "leverage": [f"Typical local pricing is roughly $2,000-${TARGET_PRICE}."],
    }
    user_info = storage.read_json(case_id, "user_info.json")
    return calls._nego_dynamic_vars(case_id, home, quote, hs, user_info)


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        dyn = _vars(Path(td), with_competitor=True)

    check("competing_quote_disclosure" in dyn,
          f"missing `competing_quote_disclosure`; keys={sorted(dyn)}")
    check("leverage" not in dyn, "`leverage` still sent (conflated blob)")
    check("competing_quote_total" not in dyn,
          "`competing_quote_total` reintroduced — a bare-number slot is the hole "
          "the agent filled with the target price")

    disclosure = dyn.get("competing_quote_disclosure", "")
    cited = _amounts(disclosure)

    # Guard against this path silently degrading to the denial branch, which would
    # make every assertion below trivially true.
    check(disclosure != calls.NO_COMPETING_QUOTE,
          "positive path returned the denial — fixture no longer exercises a real "
          "competing quote, so the assertions below prove nothing")
    check(REAL_QUOTES["fh_003"] in cited,
          f"expected the undercutting competitor quote ${REAL_QUOTES['fh_003']} to "
          f"be cited; got {disclosure!r}")

    check(cited <= set(REAL_QUOTES.values()),
          f"cited amounts not backed by a quote record: "
          f"{sorted(cited - set(REAL_QUOTES.values()))} in {disclosure!r}")
    check(TARGET_PRICE not in cited,
          f"CONFIDENTIAL target_price ${TARGET_PRICE} leaked into the competitor "
          f"disclosure — this is the original bug: {disclosure!r}")
    check(WALK_AWAY not in cited or WALK_AWAY in REAL_QUOTES.values(),
          f"walk_away_price ${WALK_AWAY} leaked into disclosure: {disclosure!r}")
    check(not (cited & MARKET_ONLY),
          f"market-research figures cited as a quote: {sorted(cited & MARKET_ONLY)}")

    # No-competitor path: an explicit denial, with no number to misread as a quote.
    with tempfile.TemporaryDirectory() as td:
        dyn2 = _vars(Path(td), with_competitor=False)
    d2 = dyn2.get("competing_quote_disclosure", "")
    check(d2 == calls.NO_COMPETING_QUOTE,
          f"expected explicit denial when no competitor quoted; got {d2!r}")
    check(not re.search(r"\d", d2),
          f"denial contains digits the agent could cite as a price: {d2!r}")

    # A competitor who quoted MORE is not leverage — citing it would produce
    # "can you match their $10,000?" to a provider quoting $3,000.
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        case_id = _seed(tmp, with_competitor=True)
        storage._write_json(tmp / case_id / "quotes" / "fh_003.json", {
            "funeral_home_id": "fh_003", "funeral_home_name": "Demo Funeral Home 3",
            "reached": True, "quoted_price_usd": 10000,
        })
        home = {"id": "fh_001", "name": "Demo Funeral Home 1"}
        q = storage.read_json(case_id, "quotes/fh_001.json")
        hs = {"current_price_usd": 3000, "target_price_usd": TARGET_PRICE,
              "walk_away_price_usd": WALK_AWAY}
        ui = storage.read_json(case_id, "user_info.json")
        d3 = calls._nego_dynamic_vars(case_id, home, q, hs, ui)["competing_quote_disclosure"]
    check(d3 == calls.NO_COMPETING_QUOTE,
          f"higher competitor quote treated as leverage: {d3!r}")

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1

    print("PASS: competitor disclosure is evidence-backed; target price never leaks")
    print(f"      with competitor : {disclosure!r}")
    print(f"      without         : {d2!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
