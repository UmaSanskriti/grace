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


def _turns_to_text(turns: list[dict]) -> str:
    lines = []
    for turn in turns:
        role = turn.get("role", "?")
        msg = turn.get("message") or ""
        if msg:
            lines.append(f"{role}: {msg}")
    return "\n".join(lines)


def parse_webhook(payload: dict) -> ParsedWebhook:
    data = payload.get("data", {}) or {}
    turns = data.get("transcript") or []
    analysis = data.get("analysis") or {}
    cicd = data.get("conversation_initiation_client_data") or {}
    return ParsedWebhook(
        type=payload.get("type", ""),
        conversation_id=data.get("conversation_id", ""),
        agent_id=data.get("agent_id", ""),
        status=data.get("status", ""),
        transcript_turns=turns,
        transcript_text=_turns_to_text(turns),
        summary=analysis.get("transcript_summary", "") or "",
        data_collection=analysis.get("data_collection_results", {}) or {},
        dynamic_variables=cicd.get("dynamic_variables", {}) or {},
        raw=payload,
    )
