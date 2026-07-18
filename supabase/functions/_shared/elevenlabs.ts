// =====================================================================
// Grace — ElevenLabs webhook HMAC + outbound call launcher
// (spec §6.7 webhook integrity, App B.1, §8.6 outbound call, INV-02).
// Uses Web Crypto (crypto.subtle) only — no external crypto libraries.
// =====================================================================

import { encodeHex } from "std/encoding/hex.ts";
import { assertAllowedNumber } from "./allowlist.ts";
import { elevenLabsApiKey, elevenLabsPhoneNumberId } from "./env.ts";

/** Maximum accepted age of an ElevenLabs webhook timestamp: 30 minutes (§6.7). */
const MAX_SIGNATURE_AGE_SECONDS = 30 * 60;

/** Constant-time hex-digest comparison to avoid timing leaks (§10). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify an ElevenLabs post-call webhook HMAC (spec §6.7, §10 "Webhook auth").
 *
 * The `ElevenLabs-Signature` header carries `t=<unix-seconds>,v0=<hex>`. The
 * signed payload is `${t}.${rawBody}` under HMAC-SHA256 with the shared secret.
 * Stale timestamps (> 30 min old) are rejected to block replay (§6.7).
 *
 * The request is cloned so the caller can still read the original body.
 * @returns true only if the timestamp is fresh and the signature matches.
 */
export async function verifyElevenLabsHmac(req: Request, secret: string): Promise<boolean> {
  const header = req.headers.get("ElevenLabs-Signature") ??
    req.headers.get("elevenlabs-signature");
  if (!header) return false;

  let timestamp: string | undefined;
  let provided: string | undefined;
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") timestamp = v?.trim();
    else if (k?.trim() === "v0") provided = v?.trim();
  }
  if (!timestamp || !provided) return false;

  // Reject stale timestamps (replay protection, §6.7).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const body = await req.clone().text();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const expected = encodeHex(new Uint8Array(mac));
  return timingSafeEqual(expected, provided.toLowerCase());
}

/**
 * Launch an outbound ElevenLabs Conversational-AI call over Twilio (App B.1, §8.6).
 *
 * Enforces INV-02 by calling {@link assertAllowedNumber} on the destination
 * before any dial, and INV-09 by hard-coding `call_recording_enabled: false`.
 * @returns the parsed ElevenLabs JSON response; throws on non-2xx.
 */
/** Shape of the ElevenLabs outbound-call response we rely on. */
export interface ElevenLabsCallResult {
  conversation_id?: string;
  callSid?: string;
  call_sid?: string;
  success?: boolean;
  [key: string]: unknown;
}

export async function launchElevenLabsCall(input: {
  agentId: string;
  to: string;
  dynamicVariables: Record<string, string>;
}): Promise<ElevenLabsCallResult> {
  assertAllowedNumber(input.to);

  const response = await fetch(
    "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": elevenLabsApiKey(),
      },
      body: JSON.stringify({
        agent_id: input.agentId,
        agent_phone_number_id: elevenLabsPhoneNumberId(),
        to_number: input.to,
        call_recording_enabled: false,
        conversation_initiation_client_data: {
          dynamic_variables: input.dynamicVariables,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs call failed: ${response.status}`);
  }
  return await response.json() as ElevenLabsCallResult;
}
