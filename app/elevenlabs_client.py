"""Thin client over the ElevenLabs Agents Platform outbound-call API.

Endpoint verified against docs 2026-07-18:
    POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
    headers: xi-api-key, Content-Type: application/json
    body:    { agent_id, agent_phone_number_id, to_number,
               conversation_initiation_client_data: { dynamic_variables: {..} },
               call_recording_enabled }
    returns: { success, message, conversation_id, callSid }

Custom dynamic variables echo back in the post-call webhook under
data.conversation_initiation_client_data.dynamic_variables — that's how we route.
"""

from __future__ import annotations

import httpx

from .config import settings

API_BASE = "https://api.elevenlabs.io"
OUTBOUND_CALL_PATH = "/v1/convai/twilio/outbound-call"


class ElevenLabsError(RuntimeError):
    pass


def outbound_call(
    *,
    agent_id: str,
    to_number: str,
    dynamic_variables: dict[str, str] | None = None,
    call_recording_enabled: bool = True,
    timeout: float = 30.0,
) -> dict:
    """Place an outbound call. Returns the parsed JSON response.

    Raises ElevenLabsError on non-2xx or a non-success body.
    """
    if not settings.elevenlabs_api_key:
        raise ElevenLabsError("ELEVENLABS_API_KEY is not set")
    if not settings.elevenlabs_phone_number_id:
        raise ElevenLabsError("ELEVENLABS_PHONE_NUMBER_ID is not set")

    body: dict = {
        "agent_id": agent_id,
        "agent_phone_number_id": settings.elevenlabs_phone_number_id,
        "to_number": to_number,
        "call_recording_enabled": call_recording_enabled,
    }
    if dynamic_variables:
        body["conversation_initiation_client_data"] = {
            "dynamic_variables": dynamic_variables,
        }

    resp = httpx.post(
        f"{API_BASE}{OUTBOUND_CALL_PATH}",
        headers={
            "xi-api-key": settings.elevenlabs_api_key,
            "Content-Type": "application/json",
        },
        json=body,
        timeout=timeout,
    )
    if resp.status_code >= 300:
        raise ElevenLabsError(
            f"outbound-call failed [{resp.status_code}]: {resp.text}"
        )
    data = resp.json()
    if data.get("success") is False:
        raise ElevenLabsError(f"outbound-call not successful: {data}")
    return data
