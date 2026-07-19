"""LLM: transcript -> structured JSON (OpenAI).

Slice 2+ (v0-instruction.md §7 M2/M4). Validate output against the target
schema; on failure retry once with the validation error appended to the prompt.

`extract_user_info` is implemented (M2). The system prompt lives in
`prompts/extract_user_info.md` (git is the source of truth, same as the agent
prompts). The JSON schema below is the Slice-2 slice of the tiered intake spec —
field definitions and the full taxonomy:
https://github.com/omarcontreras96/hacknation-negotiator/blob/main/docs/intake-spec.md
"""

from __future__ import annotations

import json
from pathlib import Path

from openai import OpenAI

from .config import settings

_PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"

# Sponsor-account model for structured extraction; override via .env if the
# exact snapshot differs on the account.
_EXTRACTION_MODEL_DEFAULT = "gpt-5.6-terra"


def _enum(*values: str) -> dict:
    return {"type": "string", "enum": list(values)}


def _nullable(t: str) -> dict:
    return {"type": [t, "null"]}


def _str_array() -> dict:
    return {"type": "array", "items": {"type": "string"}}


# Strict structured-output schema for user_info.json. Every property is
# required (strict mode); "not discussed" is expressed as null / "unknown",
# never omitted — mirrored by the `unknowns` list.
USER_INFO_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "contact_name", "mode", "service_type", "location", "timeline",
        "attendee_estimate", "budget_usd", "cost_posture", "must_haves",
        "flexible_if_savings", "service_preferences", "unknowns",
    ],
    "properties": {
        "contact_name": _nullable("string"),
        "mode": _enum("at_need", "pre_need"),
        "service_type": _enum("cremation", "burial", "memorial_only", "undecided"),
        "location": {
            "type": "object",
            "additionalProperties": False,
            "required": ["city", "state", "zip"],
            "properties": {
                "city": _nullable("string"),
                "state": _nullable("string"),
                "zip": _nullable("string"),
            },
        },
        "timeline": _nullable("string"),
        "attendee_estimate": _nullable("integer"),
        "budget_usd": _nullable("number"),
        "cost_posture": _enum(
            "lowest_comparable_total", "balanced", "prioritize_fit", "unknown",
        ),
        "must_haves": _str_array(),
        "flexible_if_savings": _str_array(),
        "service_preferences": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "disposition_detail", "viewing", "viewing_hours", "ceremony",
                "ceremony_location", "witness_cremation", "ashes_return",
                "urn_source", "casket_source", "cemetery_status", "embalming",
                "ritual_preparation", "religion_tradition", "language_needs",
                "service_date_window", "custody_location", "custody_deadline",
                "authority_confirmed",
            ],
            "properties": {
                "disposition_detail": _enum(
                    "direct_cremation", "cremation_with_service",
                    "burial_full_service", "immediate_burial", "green_burial",
                    "unknown",
                ),
                "viewing": _enum("none", "private_family", "public", "unknown"),
                "viewing_hours": _nullable("number"),
                "ceremony": _enum(
                    "none", "funeral_service", "memorial_service",
                    "graveside_only", "unknown",
                ),
                "ceremony_location": _enum(
                    "funeral_home_chapel", "place_of_worship", "graveside",
                    "other", "unknown",
                ),
                "witness_cremation": _nullable("boolean"),
                "ashes_return": _enum(
                    "pickup", "mail", "scatter_by_provider", "cemetery_niche",
                    "not_applicable", "unknown",
                ),
                "urn_source": _enum("funeral_home", "third_party", "unknown"),
                "casket_source": _enum(
                    "funeral_home", "third_party", "rental", "not_applicable",
                    "unknown",
                ),
                "cemetery_status": _enum(
                    "plot_owned", "cemetery_chosen_no_plot", "none",
                    "not_applicable", "unknown",
                ),
                "embalming": _enum("yes", "no", "undecided", "unknown"),
                "ritual_preparation": _enum(
                    "none", "tahara", "ghusl_kafan", "family_led", "other",
                    "unknown",
                ),
                "religion_tradition": _enum(
                    "none_secular", "catholic", "protestant",
                    "orthodox_christian", "jewish", "muslim", "hindu",
                    "buddhist", "sikh", "other", "prefer_not_to_say", "unknown",
                ),
                "language_needs": _str_array(),
                "service_date_window": _nullable("string"),
                "custody_location": _enum(
                    "hospital", "hospice", "home", "medical_examiner",
                    "other_facility", "not_applicable", "unknown",
                ),
                "custody_deadline": _nullable("string"),
                "authority_confirmed": _nullable("boolean"),
            },
        },
        "unknowns": _str_array(),
    },
}

# Cheap sanity checks beyond what strict mode guarantees (enum drift, shape).
_REQUIRED_TOP_LEVEL = USER_INFO_SCHEMA["required"]


def _validate_user_info(data: dict) -> list[str]:
    errors: list[str] = []
    for key in _REQUIRED_TOP_LEVEL:
        if key not in data:
            errors.append(f"missing required field: {key}")
    if not isinstance(data.get("must_haves"), list):
        errors.append("must_haves must be a list of strings")
    if not isinstance(data.get("flexible_if_savings"), list):
        errors.append("flexible_if_savings must be a list of strings")
    budget = data.get("budget_usd")
    if budget is not None and not isinstance(budget, (int, float)):
        errors.append("budget_usd must be a number or null (volunteered only)")
    return errors


def _extraction_prompt(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8")


def _call_structured(system_prompt: str, user_content: str, schema_name: str, schema: dict) -> dict:
    client = OpenAI(api_key=settings.openai_api_key)
    model = getattr(settings, "openai_extraction_model", "") or _EXTRACTION_MODEL_DEFAULT
    resp = client.responses.create(
        model=model,
        input=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        text={
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "strict": True,
                "schema": schema,
            },
        },
    )
    return json.loads(resp.output_text)


def extract_user_info(transcript: str) -> dict:
    """Intake transcript -> user_info.json shape (Slice 2, M2).

    Validates the model output; on failure retries once with the validation
    errors appended to the prompt (v0-instruction.md §7).
    """
    system_prompt = _extraction_prompt("extract_user_info.md")
    user_content = f"INTAKE CALL TRANSCRIPT:\n{transcript}"

    data = _call_structured(system_prompt, user_content, "user_info", USER_INFO_SCHEMA)
    errors = _validate_user_info(data)
    if errors:
        retry_content = (
            f"{user_content}\n\nYour previous output failed validation:\n- "
            + "\n- ".join(errors)
            + "\nReturn corrected JSON."
        )
        data = _call_structured(system_prompt, retry_content, "user_info", USER_INFO_SCHEMA)
        errors = _validate_user_info(data)
        if errors:
            raise ValueError(f"user_info extraction failed validation twice: {errors}")
    return data


# Structured-output schema for the LLM portion of a quote. Orchestration adds
# funeral_home_id / call_id / transcript_path around this (see app/calls.py).
QUOTE_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "reached", "quoted_price_usd", "price_type", "includes", "excludes",
        "availability", "notes",
    ],
    "properties": {
        "reached": {"type": "boolean"},
        "quoted_price_usd": _nullable("number"),
        "price_type": _enum("total_package", "starting_from", "per_item", "unknown"),
        "includes": _str_array(),
        "excludes": _str_array(),
        "availability": _nullable("string"),
        "notes": {"type": "string"},
    },
}


def _validate_quote(data: dict) -> list[str]:
    errors: list[str] = []
    for key in QUOTE_SCHEMA["required"]:
        if key not in data:
            errors.append(f"missing required field: {key}")
    price = data.get("quoted_price_usd")
    if price is not None and not isinstance(price, (int, float)):
        errors.append("quoted_price_usd must be a number or null")
    if not isinstance(data.get("reached"), bool):
        errors.append("reached must be a boolean")
    return errors


def extract_quote(transcript: str) -> dict:
    """Quote-call transcript -> the LLM portion of quotes/{fh_id}.json (Slice 4).

    Validates output; on failure retries once with the errors appended.
    """
    system_prompt = _extraction_prompt("extract_quote.md")
    user_content = f"QUOTE CALL TRANSCRIPT:\n{transcript}"

    data = _call_structured(system_prompt, user_content, "quote", QUOTE_SCHEMA)
    errors = _validate_quote(data)
    if errors:
        retry_content = (
            f"{user_content}\n\nYour previous output failed validation:\n- "
            + "\n- ".join(errors)
            + "\nReturn corrected JSON."
        )
        data = _call_structured(system_prompt, retry_content, "quote", QUOTE_SCHEMA)
        errors = _validate_quote(data)
        if errors:
            raise ValueError(f"quote extraction failed validation twice: {errors}")
    return data


def extract_final_price(transcript: str) -> dict:
    """Negotiation transcript -> negotiations/{fh_id}.json shape. TODO(Slice 5)."""
    raise NotImplementedError
