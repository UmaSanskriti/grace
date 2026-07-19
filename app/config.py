"""Typed settings loaded from .env.

Anything unset falls back to empty string / sensible default so the app still
boots for local development (e.g. before Google/Tavily keys are ready).
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- ElevenLabs Agents Platform ---
    elevenlabs_api_key: str = ""
    elevenlabs_intake_agent_id: str = ""
    elevenlabs_quote_agent_id: str = ""
    elevenlabs_nego_agent_id: str = ""
    elevenlabs_phone_number_id: str = ""
    # Optional: enables HMAC verification of post-call webhooks when set.
    elevenlabs_webhook_secret: str = ""

    # --- LLM ---
    openai_api_key: str = ""
    # Optional override for structured extraction (defaults in app/extraction.py).
    openai_extraction_model: str = ""

    # --- Research APIs ---
    google_places_api_key: str = ""
    tavily_api_key: str = ""

    # --- Twilio (SMS progress notifications) ---
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_sms_from: str = ""  # SMS-capable Twilio number, E.164

    @property
    def sms_configured(self) -> bool:
        return bool(self.twilio_account_sid and self.twilio_auth_token and self.twilio_sms_from)

    # --- Orchestrator ---
    base_url: str = ""  # ngrok URL in dev, Railway URL in prod

    # --- Demo ---
    demo_mode: bool = False
    demo_targets: str = ""  # comma-separated E.164 numbers

    # Auto-cascade the pipeline (research -> quotes -> strategy -> negotiation
    # -> report) without manual /advance. Set false to step each stage by hand
    # for a narrated demo.
    auto_advance: bool = True

    @property
    def demo_target_list(self) -> list[str]:
        return [n.strip() for n in self.demo_targets.split(",") if n.strip()]

    def agent_id_for(self, agent_type: str) -> str:
        """Map a logical agent type to its configured ElevenLabs agent id."""
        return {
            "intake": self.elevenlabs_intake_agent_id,
            "quote": self.elevenlabs_quote_agent_id,
            "nego": self.elevenlabs_nego_agent_id,
        }[agent_type]


settings = Settings()
