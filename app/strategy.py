"""LLM: negotiation strategy generation.

Input: all quotes + Tavily market data. Output: strategy.json (shortlist +
per-home target price + leverage). Slice 5 (v0-instruction.md §7 M5). TODO.
"""

from __future__ import annotations


def build_strategy(quotes: list[dict], market_context: dict) -> dict:
    """Produce strategy.json. TODO(Slice 5)."""
    raise NotImplementedError
