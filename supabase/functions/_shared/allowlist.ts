// =====================================================================
// Grace — outbound destination allowlist (spec §10 "Allowlist", INV-02)
// Every outbound SMS/call destination MUST be in DEMO_ALLOWED_E164.
// =====================================================================

import { demoAllowedE164Raw } from "./env.ts";

/** Parse DEMO_ALLOWED_E164 (comma-separated) into a trimmed, non-empty set. */
function allowedNumbers(): Set<string> {
  return new Set(
    demoAllowedE164Raw()
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0),
  );
}

/**
 * Assert an E.164 destination is on the demo allowlist (INV-02, §10).
 * @param e164 destination phone number in E.164 form.
 * @throws Error if the number is not present in DEMO_ALLOWED_E164.
 */
export function assertAllowedNumber(e164: string): void {
  const target = e164.trim();
  if (!allowedNumbers().has(target)) {
    throw new Error(`INV-02: destination not in allowlist: ${target}`);
  }
}
