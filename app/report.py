"""LLM: final comparison report (Slice 6, v0-instruction.md §7 M6).

generate_report reads all case data and writes report.md — the family-facing
deliverable. Falls back to a deterministic template if the LLM call fails, so
the final artifact is always produced.
"""

from __future__ import annotations

import json
import logging

from openai import OpenAI

from . import storage
from .config import settings
from .extraction import _EXTRACTION_MODEL_DEFAULT, _extraction_prompt

log = logging.getLogger("grace")


def _gather(case_id: str) -> dict:
    d = storage.case_dir(case_id)
    quotes = [json.loads(p.read_text()) for p in sorted((d / "quotes").glob("*.json"))] if (d / "quotes").exists() else []
    negos = [json.loads(p.read_text()) for p in sorted((d / "negotiations").glob("*.json"))] if (d / "negotiations").exists() else []
    return {
        "user_info": storage.read_json(case_id, "user_info.json") or {},
        "funeral_homes": storage.read_json(case_id, "funeral_homes.json") or [],
        "quotes": quotes,
        "negotiations": negos,
        "strategy": storage.read_json(case_id, "strategy.json") or {},
        "market_research": storage.read_json(case_id, "market_research.json") or {},
    }


def _fallback_report(case_id: str, data: dict) -> str:
    """Deterministic template report if the LLM is unavailable."""
    negos = {n["funeral_home_id"]: n for n in data["negotiations"]}
    lines = [f"# Grace — Funeral Quote Report", "", "## Comparison", "",
             "| Funeral Home | Original Quote | Negotiated | Notes |",
             "|---|---|---|---|"]
    for q in data["quotes"]:
        fid = q.get("funeral_home_id")
        name = q.get("funeral_home_name") or fid
        orig = q.get("quoted_price_usd")
        neg = negos.get(fid, {}).get("final_price_usd")
        orig_s = f"${orig:,.0f}" if isinstance(orig, (int, float)) else (q.get("status") or "—")
        neg_s = f"${neg:,.0f}" if isinstance(neg, (int, float)) else "—"
        lines.append(f"| {name} | {orig_s} | {neg_s} | {(q.get('notes') or '')[:60]} |")
    market = data["market_research"].get("answer")
    if market:
        lines += ["", "## Market context", "", market]
    return "\n".join(lines) + "\n"


def generate_report(case_id: str) -> str:
    """Write report.md for the case and return its contents."""
    data = _gather(case_id)
    try:
        client = OpenAI(api_key=settings.openai_api_key)
        model = getattr(settings, "openai_extraction_model", "") or _EXTRACTION_MODEL_DEFAULT
        resp = client.responses.create(
            model=model,
            input=[
                {"role": "system", "content": _extraction_prompt("report.md")},
                {"role": "user", "content": "CASE DATA:\n" + json.dumps(data, indent=2)},
            ],
        )
        md = resp.output_text
    except Exception as e:  # LLM down / model unavailable — still ship a report
        log.error("report LLM failed case=%s: %s — using template", case_id, e)
        md = _fallback_report(case_id, data)

    path = storage.case_dir(case_id) / "report.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(md)
    log.info("report written case=%s (%d chars)", case_id, len(md))
    return md
