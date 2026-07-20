"""Parse and verify ElevenLabs post-call webhooks.

Signature header (docs 2026-07-18):
    ElevenLabs-Signature: t=<unix>,v0=<hex>
    <hex> = HMAC_SHA256(secret, f"{t}.{raw_body}")

Verification is skipped when ELEVENLABS_WEBHOOK_SECRET is unset so we can test
the loop before configuring the signing secret in the dashboard.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass, field

from .config import settings


class WebhookVerificationError(RuntimeError):
    pass


# --- call-outcome thresholds (issue #16) ------------------------------------
#
# Field names below were confirmed against saved post-call payloads in
# data/<case_id>/raw/<conversation_id>.json (5 real conversations, 2026-07-19),
# not guessed:
#     data.status                      -> "done" on a completed call
#     data.analysis.call_successful    -> "success" on a completed call
#     data.metadata.termination_reason -> "Call ended by remote party" (free text)
#     data.metadata.error              -> None on a completed call
#     data.metadata.call_duration_secs -> int seconds
# All five samples are *successful* calls, so the negative values are not
# observed here. Everything below therefore fails closed on values we know are
# bad and fails *open* on values we do not recognise — a status or enum member
# ElevenLabs adds later must not start discarding calls that actually worked.

# data.status values meaning the conversation did not complete normally.
FAILED_STATUSES = frozenset({"failed", "error"})

# data.analysis.call_successful is tri-state. "unknown" is deliberately absent:
# it is what short or ambiguous conversations report, and such a transcript may
# still carry a usable quote. Only an explicit negative counts.
FAILED_CALL_SUCCESSFUL = frozenset({"failure"})

# A conversation this brief collected nothing — issue #16's "cut off after two
# seconds". Either bound alone is sufficient; the duration check is skipped when
# the payload carries no duration.
MIN_USABLE_DURATION_SECS = 5
MIN_USABLE_TURNS = 2


def verify_signature(raw_body: bytes, signature_header: str | None) -> None:
    """Raise WebhookVerificationError if the signature is missing/invalid.

    No-op when no webhook secret is configured.
    """
    secret = settings.elevenlabs_webhook_secret
    if not secret:
        return  # verification disabled for local testing
    if not signature_header:
        raise WebhookVerificationError("missing ElevenLabs-Signature header")

    parts = dict(
        p.split("=", 1) for p in signature_header.split(",") if "=" in p
    )
    t = parts.get("t")
    v0 = parts.get("v0")
    if not t or not v0:
        raise WebhookVerificationError(f"malformed signature: {signature_header!r}")

    expected = hmac.new(
        secret.encode(),
        f"{t}.{raw_body.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, v0):
        raise WebhookVerificationError("signature mismatch")


@dataclass
class ParsedWebhook:
    type: str
    conversation_id: str
    agent_id: str
    status: str
    transcript_turns: list[dict]
    transcript_text: str
    summary: str
    data_collection: dict
    dynamic_variables: dict = field(default_factory=dict)
    # From metadata.phone_call: for an inbound call external_number is the
    # caller (the user); for outbound it's the number we dialed.
    call_direction: str = ""
    external_number: str = ""
    agent_number: str = ""
    # Call-outcome signals (issue #16). Coerced to plain str/int at parse time
    # so `failure_reason` below can never raise on a surprising payload shape.
    call_successful: str = ""
    termination_reason: str = ""
    call_error: str = ""
    call_duration_secs: int | None = None
    raw: dict = field(default_factory=dict)

    @property
    def case_id(self) -> str | None:
        return self.dynamic_variables.get("case_id")

    @property
    def fh_id(self) -> str | None:
        return self.dynamic_variables.get("fh_id")

    @property
    def agent_type(self) -> str | None:
        return self.dynamic_variables.get("agent_type")

    @property
    def failure_reason(self) -> str | None:
        """Why this conversation is unusable, or None if it looks complete.

        A non-None result means the transcript must NOT be handed to extraction:
        the caller routes it through the unreachable path instead (issue #16).
        Checks run most-specific-first so the reason we record is the
        informative one. Total function — never raises, never returns "".
        """
        if self.status.strip().lower() in FAILED_STATUSES:
            return f"conversation status {self.status!r}"
        if self.call_error:
            return f"conversation error: {self.call_error}"
        if self.call_successful.strip().lower() in FAILED_CALL_SUCCESSFUL:
            return f"call_successful={self.call_successful!r}"

        # Truncation. Reported with the termination reason when we have one,
        # because "0 turns (Call failed)" is far more actionable on-call than
        # either half alone.
        suffix = f" ({self.termination_reason})" if self.termination_reason else ""
        turns = len(self.transcript_turns)
        if turns < MIN_USABLE_TURNS:
            return f"conversation truncated: {turns} turn(s){suffix}"
        if (
            self.call_duration_secs is not None
            and self.call_duration_secs < MIN_USABLE_DURATION_SECS
        ):
            return f"conversation truncated: {self.call_duration_secs}s{suffix}"
        return None

    @property
    def call_failed(self) -> bool:
        return self.failure_reason is not None


def _turns_to_text(turns: list[dict]) -> str:
    lines = []
    for turn in turns:
        role = turn.get("role", "?")
        msg = turn.get("message") or ""
        if msg:
            lines.append(f"{role}: {msg}")
    return "\n".join(lines)


def _coerce_duration(value: object) -> int | None:
    """metadata.call_duration_secs as an int, or None if absent/unparseable."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _coerce_error(value: object) -> str:
    """metadata.error as a message string. None on healthy calls; on a real
    failure it is a dict, observed as:

        {"code": 1008, "reason": "Missing required dynamic variables in tools: {'case_id'}"}

    `reason` carries the human-readable half, so prefer it — falling through to
    str(dict) buries the diagnosis in an escaped repr. `message` is kept as an
    alternative key because the shape is not documented and may vary."""
    if not value:
        return ""
    if isinstance(value, dict):
        text = value.get("reason") or value.get("message")
        code = value.get("code")
        if text:
            return f"[{code}] {text}" if code is not None else str(text)
        return str(value)
    return str(value)


def parse_webhook(payload: dict) -> ParsedWebhook:
    data = payload.get("data", {}) or {}
    turns = data.get("transcript") or []
    analysis = data.get("analysis") or {}
    cicd = data.get("conversation_initiation_client_data") or {}
    metadata = data.get("metadata") or {}
    phone_call = metadata.get("phone_call") or {}
    return ParsedWebhook(
        # `or ""` rather than a get-default throughout: these keys are present
        # but explicitly null on some payloads, and a None here reaches
        # failure_reason as an AttributeError inside the webhook handler.
        type=str(payload.get("type") or ""),
        conversation_id=str(data.get("conversation_id") or ""),
        agent_id=str(data.get("agent_id") or ""),
        status=str(data.get("status") or ""),
        transcript_turns=turns,
        transcript_text=_turns_to_text(turns),
        summary=analysis.get("transcript_summary", "") or "",
        data_collection=analysis.get("data_collection_results", {}) or {},
        dynamic_variables=cicd.get("dynamic_variables", {}) or {},
        call_direction=phone_call.get("direction", "") or "",
        external_number=phone_call.get("external_number", "") or "",
        agent_number=phone_call.get("agent_number", "") or "",
        call_successful=str(analysis.get("call_successful") or ""),
        termination_reason=str(metadata.get("termination_reason") or ""),
        call_error=_coerce_error(metadata.get("error")),
        call_duration_secs=_coerce_duration(metadata.get("call_duration_secs")),
        raw=payload,
    )
