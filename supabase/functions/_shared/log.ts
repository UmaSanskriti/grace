// =====================================================================
// Grace — structured logging with PII scrubbing (spec §10 "Observability")
// "Structured logs without transcript bodies or full phone numbers."
// =====================================================================

/** Keys whose values are transcript/raw bodies and must never be logged (§6.7, §10). */
const DROP_KEY = /(transcript|raw_payload|raw_body|audio|body|reply_sms|message_body)/i;

/** Keys that carry phone numbers and should be masked to the last 4 digits. */
const PHONE_KEY = /(phone|e164|from|to|destination|caller|callee|number|msisdn)/i;

/** Matches an E.164-ish run of digits anywhere in a string value. */
const E164_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;

/** Mask a phone number to `***last4`, preserving only the final 4 digits. */
function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

/** Recursively scrub an arbitrary value: drop transcripts, mask phone numbers. */
function scrub(value: unknown, keyHint = ""): unknown {
  if (typeof value === "string") {
    if (PHONE_KEY.test(keyHint)) return maskPhone(value);
    return value.replace(E164_PATTERN, (m) => maskPhone(m));
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEY.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = scrub(v, k);
    }
    return out;
  }
  return value;
}

/**
 * Emit a structured log line with transcript bodies dropped and phone numbers
 * masked to their last 4 digits (spec §10 "Observability").
 * @param event any serializable object; scrubbed before `console.log`.
 */
export function logStructured(event: object): void {
  const safe = scrub(event);
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...(safe as object) }));
}
