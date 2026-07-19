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

    # --- Orchestrator ---
    base_url: str = ""  # ngrok URL in dev, Railway URL in prod

    # --- Demo ---
    demo_mode: bool = False
    demo_targets: str = ""  # comma-separated E.164 numbers

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
