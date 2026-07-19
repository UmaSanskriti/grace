"""LLM: negotiation strategy generation (Slice 5, v0-instruction.md §7 M5).

Input: the collected quotes + Tavily market data. Output: strategy.json
(shortlist + per-home target/walk-away price + true leverage). run_strategy is
the orchestration entrypoint; it advances the case to strategy_ready.
"""

from __future__ import annotations

import json
import logging

from . import storage
from .extraction import _call_structured, _extraction_prompt, _nullable, _str_array

log = logging.getLogger("grace")

STRATEGY_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["market_context", "shortlist", "per_home_strategy"],
    "properties": {
        "market_context": {"type": "string"},
        "shortlist": _str_array(),
        "per_home_strategy": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "funeral_home_id", "current_price_usd", "target_price_usd",
                    "walk_away_price_usd", "leverage",
                ],
                "properties": {
                    "funeral_home_id": {"type": "string"},
                    "current_price_usd": _nullable("number"),
                    "target_price_usd": _nullable("number"),
                    "walk_away_price_usd": _nullable("number"),
                    "leverage": _str_array(),
                },
            },
        },
    },
}


def build_strategy(quotes: list[dict], market_context: dict, user_info: dict) -> dict:
    """Produce strategy.json content from reached quotes + market data."""
    payload = {
        "quotes": quotes,
        "market_research": market_context,
        "family": {
            "budget_usd": user_info.get("budget_usd"),
            "cost_posture": user_info.get("cost_posture"),
            "service_type": user_info.get("service_type"),
        },
    }
    system_prompt = _extraction_prompt("strategy.md")
    user_content = "QUOTES + MARKET RESEARCH:\n" + json.dumps(payload, indent=2)
    return _call_structured(system_prompt, user_content, "strategy", STRATEGY_SCHEMA)


def _reached_quotes(case_id: str) -> list[dict]:
    quotes_dir = storage.case_dir(case_id) / "quotes"
    if not quotes_dir.exists():
        return []
    out = []
    for p in sorted(quotes_dir.glob("*.json")):
        q = json.loads(p.read_text())
        if q.get("reached") and q.get("quoted_price_usd") is not None:
            out.append(q)
    return out


def run_strategy(case_id: str) -> dict:
    """Read quotes + market -> write strategy.json, advance to strategy_ready.

    If no home gave a usable quote there's nothing to negotiate: generates the
    report and finishes the case.
    """
    reached = _reached_quotes(case_id)
    if not reached:
        log.warning("strategy case=%s: no reached quotes, skipping to report", case_id)
        from . import report  # lazy import to avoid a cycle
        report.generate_report(case_id)
        storage.set_status(case_id, "done")
        return {"ok": False, "reason": "no_quotes"}

    market = storage.read_json(case_id, "market_research.json") or {}
    user_info = storage.read_json(case_id, "user_info.json") or {}

    strategy = build_strategy(reached, market, user_info)
    storage.save_json(case_id, "strategy.json", strategy)
    storage.set_status(case_id, "strategy_ready")
    log.info(
        "strategy ready case=%s shortlist=%s",
        case_id, strategy.get("shortlist"),
    )
    return {"ok": True, "shortlist": strategy.get("shortlist", [])}
