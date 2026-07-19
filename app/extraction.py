"""LLM: transcript -> structured JSON (OpenAI).

Slice 2+ (v0-instruction.md §7 M2/M4). Validate output against the target
schema; on failure retry once with the validation error appended to the prompt.
"""

from __future__ import annotations


def extract_user_info(transcript: str) -> dict:
    """Intake transcript -> user_info.json shape. TODO(Slice 2)."""
    raise NotImplementedError


def extract_quote(transcript: str) -> dict:
    """Quote-call transcript -> quotes/{fh_id}.json shape. TODO(Slice 4)."""
    raise NotImplementedError


def extract_final_price(transcript: str) -> dict:
    """Negotiation transcript -> negotiations/{fh_id}.json shape. TODO(Slice 5)."""
    raise NotImplementedError
