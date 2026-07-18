// =====================================================================
// Grace — typed environment accessors (spec §8.2, §10 "Secrets"/"Kill switch")
// All secrets are server-side only; never import these into client code.
// Required getters throw immediately if the variable is missing/empty so a
// misconfigured Edge Function fails loud instead of silently mis-behaving.
// =====================================================================

/** Read a required env var; throw a clear error if unset or empty (§10 Secrets). */
function req(name: string): string {
  const v = Deno.env.get(name);
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/** Read an optional env var; undefined when unset or empty. */
function opt(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? undefined : v;
}

// ---------- Twilio (§8.2) ----------
/** @returns TWILIO_ACCOUNT_SID (required). */
export const twilioAccountSid = (): string => req("TWILIO_ACCOUNT_SID");
/** @returns TWILIO_AUTH_TOKEN — used for X-Twilio-Signature HMAC (§6.7). */
export const twilioAuthToken = (): string => req("TWILIO_AUTH_TOKEN");
/** @returns TWILIO_PHONE_NUMBER_E164 (required). */
export const twilioPhoneNumberE164 = (): string => req("TWILIO_PHONE_NUMBER_E164");
/** @returns TWILIO_MESSAGING_WEBHOOK_URL (optional). */
export const twilioMessagingWebhookUrl = (): string | undefined =>
  opt("TWILIO_MESSAGING_WEBHOOK_URL");
/** @returns TWILIO_STATUS_WEBHOOK_URL (optional). */
export const twilioStatusWebhookUrl = (): string | undefined => opt("TWILIO_STATUS_WEBHOOK_URL");

// ---------- ElevenLabs (§8.2, §8.5) ----------
/** @returns ELEVENLABS_API_KEY (required for outbound calls, App B.1). */
export const elevenLabsApiKey = (): string => req("ELEVENLABS_API_KEY");
/** @returns ELEVENLABS_PHONE_NUMBER_ID (required for outbound calls, App B.1). */
export const elevenLabsPhoneNumberId = (): string => req("ELEVENLABS_PHONE_NUMBER_ID");
/** @returns ELEVENLABS_INTAKE_AGENT_ID (grace-intake-v1, §8.5, INV-13). */
export const elevenLabsIntakeAgentId = (): string => req("ELEVENLABS_INTAKE_AGENT_ID");
/** @returns ELEVENLABS_CALLER_AGENT_ID (grace-caller-v1, §8.5, INV-13). */
export const elevenLabsCallerAgentId = (): string => req("ELEVENLABS_CALLER_AGENT_ID");
/** @returns ELEVENLABS_CLOSER_AGENT_ID (grace-closer-v1, §8.5, INV-13). */
export const elevenLabsCloserAgentId = (): string => req("ELEVENLABS_CLOSER_AGENT_ID");
/** @returns ELEVENLABS_WEBHOOK_SECRET — HMAC secret for post-call webhooks (§6.7). */
export const elevenLabsWebhookSecret = (): string => req("ELEVENLABS_WEBHOOK_SECRET");

// ---------- OpenAI (§8.2) ----------
/** @returns OPENAI_API_KEY (required). */
export const openAiApiKey = (): string => req("OPENAI_API_KEY");
/** @returns OPENAI_MODEL_FAST — fast structured-output model (required). */
export const openAiModelFast = (): string => req("OPENAI_MODEL_FAST");
/** @returns OPENAI_MODEL_AUDIT — audit model (required). */
export const openAiModelAudit = (): string => req("OPENAI_MODEL_AUDIT");

// ---------- Tavily (§8.2) ----------
/** @returns TAVILY_API_KEY (optional; fixtures may be used instead). */
export const tavilyApiKey = (): string | undefined => opt("TAVILY_API_KEY");

// ---------- Supabase (§8.2, §10 Secrets) ----------
/** @returns SUPABASE_URL (required). */
export const supabaseUrl = (): string => req("SUPABASE_URL");
/** @returns SUPABASE_SERVICE_ROLE_KEY — server-side only, never sent to client (§10). */
export const supabaseServiceRoleKey = (): string => req("SUPABASE_SERVICE_ROLE_KEY");
/** @returns SUPABASE_ANON_KEY (required). */
export const supabaseAnonKey = (): string => req("SUPABASE_ANON_KEY");
/** @returns PHONE_ENCRYPTION_KEY — 32-byte base64 AES-GCM key for phones at rest (§10 PII). */
export const phoneEncryptionKey = (): string => req("PHONE_ENCRYPTION_KEY");

// ---------- App / demo controls (§8.2) ----------
/** @returns APP_BASE_URL (required). */
export const appBaseUrl = (): string => req("APP_BASE_URL");
/** @returns DEMO_ALLOWED_E164 raw comma-separated string (required, INV-02). */
export const demoAllowedE164Raw = (): string => req("DEMO_ALLOWED_E164");
/** @returns DEMO_RETENTION_HOURS as a number (default 72, §10.2). */
export const demoRetentionHours = (): number => {
  const v = opt("DEMO_RETENTION_HOURS");
  const n = v === undefined ? 72 : Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`DEMO_RETENTION_HOURS must be a positive number, got: ${v}`);
  }
  return n;
};
/** @returns DISCLOSURE_VERSION string (required for consent records, §4.1). */
export const disclosureVersion = (): string => req("DISCLOSURE_VERSION");

/**
 * Kill switch (§10 "Kill switch", App C).
 * @returns true when outbound actions must be blocked, i.e. DEMO_MODE !== "true".
 */
export function killSwitchEngaged(): boolean {
  return (Deno.env.get("DEMO_MODE") ?? "") !== "true";
}
