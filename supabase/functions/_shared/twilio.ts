// =====================================================================
// Grace — Twilio webhook integrity + TwiML helpers (spec §6.7, §10 Webhook auth)
// Validates X-Twilio-Signature before any Messaging/Voice callback is processed.
// Uses Web Crypto (crypto.subtle) only — no external crypto libraries.
// =====================================================================

import { encodeBase64 } from "std/encoding/base64.ts";
import { twilioAuthToken } from "./env.ts";

/** Constant-time string comparison to avoid signature timing leaks (§10). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify Twilio's X-Twilio-Signature (spec §6.7, §10 "Webhook auth").
 *
 * Algorithm (Twilio spec): take the full request URL, append each POSTed
 * form param as key+value (no separator) in ascending key order, HMAC-SHA1
 * with TWILIO_AUTH_TOKEN, base64-encode, and compare to the header.
 *
 * The request is cloned so the caller can still read the original body.
 * @returns true only if the signature is present and valid.
 */
export async function verifyTwilioSignature(req: Request): Promise<boolean> {
  const header = req.headers.get("X-Twilio-Signature");
  if (!header) return false;

  // Build the signed string: URL followed by sorted param key+value pairs.
  let signed = req.url;
  const contentType = req.headers.get("content-type") ?? "";
  if (req.method === "POST" && contentType.includes("application/x-www-form-urlencoded")) {
    const form = await req.clone().formData();
    const keys: string[] = [];
    for (const key of form.keys()) keys.push(key);
    keys.sort();
    for (const key of keys) {
      signed += key + String(form.get(key) ?? "");
    }
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(twilioAuthToken()),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = encodeBase64(new Uint8Array(mac));
  return timingSafeEqual(expected, header);
}

/** Escape the five XML predefined entities so transcript/body text is TwiML-safe. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a valid TwiML `<Response><Message>` reply for Twilio Messaging (§8.4).
 * @param body message text (XML-escaped before embedding).
 * @returns a Response with `text/xml` content type.
 */
export function twimlMessage(body: string): Response {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(body)}</Message></Response>`;
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}
