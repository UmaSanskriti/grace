// =====================================================================
// Grace — phone-number cryptography (spec §10 "PII", INV-12 support)
//
// NOTE ON SIGNATURES: CONTRACTS.md lists `encryptPhone`/`hashPhone` as
// synchronous (`: string`). Web Crypto (crypto.subtle) is async-only and we
// use no external crypto libraries, so both functions are implemented as
// `async` returning `Promise<string>`. Callers must `await` them. This is the
// documented deviation from the frozen contract.
//
// Uses Web Crypto (crypto.subtle) only — no external crypto libraries.
// =====================================================================

import { decodeBase64, encodeBase64 } from "std/encoding/base64.ts";
import { encodeHex } from "std/encoding/hex.ts";
import { phoneEncryptionKey } from "./env.ts";

/** AES-GCM recommended IV length in bytes. */
const IV_BYTES = 12;

/** Import PHONE_ENCRYPTION_KEY (32-byte base64) as an AES-GCM CryptoKey. */
async function importAesKey(): Promise<CryptoKey> {
  // Wrap in a fresh Uint8Array to guarantee an ArrayBuffer (not ArrayBufferLike)
  // backing, which the DOM `BufferSource` type on importKey requires.
  const raw = new Uint8Array(decodeBase64(phoneEncryptionKey()));
  if (raw.byteLength !== 32) {
    throw new Error(
      `PHONE_ENCRYPTION_KEY must decode to 32 bytes (AES-256), got ${raw.byteLength}`,
    );
  }
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a phone number for storage at rest (§10 "PII", encrypted phone values).
 * A fresh random IV is prepended to the ciphertext (which includes the GCM tag).
 * @param e164 phone number in E.164 form.
 * @returns base64 of `iv (12 bytes) || ciphertext+tag`.
 */
export async function encryptPhone(e164: string): Promise<string> {
  const key = await importAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(e164),
  );
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.byteLength);
  return encodeBase64(combined);
}

/**
 * Decrypt a value produced by {@link encryptPhone}.
 * @param payload base64 of `iv || ciphertext+tag`.
 * @returns the original E.164 phone number.
 */
export async function decryptPhone(payload: string): Promise<string> {
  const key = await importAesKey();
  const combined = decodeBase64(payload);
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

/**
 * Deterministic SHA-256 hash of a phone number for lookup/matching
 * (e.g. ConsentRecord.phone_hash, §4.1). Not reversible.
 * @param e164 phone number in E.164 form.
 * @returns lowercase hex SHA-256 digest.
 */
export async function hashPhone(e164: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e164));
  return encodeHex(new Uint8Array(digest));
}
