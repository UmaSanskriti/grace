"""Funeral-home discovery + market research.

- Google Places Text Search + Place Details -> name, phone, address (cap 3-5).
- Tavily -> local market prices for negotiation ammunition.
- DEMO_MODE: swap Places results for settings.demo_target_list (teammate numbers).

Slice 3 (v0-instruction.md §7 M3). TODO.
"""

from __future__ import annotations


def find_funeral_homes(city: str, state: str, limit: int = 5) -> list[dict]:
    """funeral_homes.json shape. Honors DEMO_MODE override. TODO(Slice 3)."""
    raise NotImplementedError


def market_prices(city: str, service_type: str) -> dict:
    """Tavily market-context summary. TODO(Slice 3)."""
    raise NotImplementedError
