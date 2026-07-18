// =====================================================================
// Grace contract test — webhook replay / idempotency (spec §11.1 row 10)
//
// Pass condition: "Duplicate event returns 200 without duplicate rows."
// Security guardrail §10: "Unique key for every MessageSid, CallSid,
// conversation ID, and webhook type."
//
// This models the `ensureIdempotent(key): Promise<boolean>` contract from
// CONTRACTS.md against a small in-memory stub (false if already seen), and
// a minimal webhook handler that inserts a row only on first sight.
//
// PURE / OFFLINE: no network, no backend.
// =====================================================================

import { assert, assertEquals } from "std/assert/mod.ts";

// ---------------------------------------------------------------------
// In-memory idempotency store mirroring ensureIdempotent().
// Real impl: a UNIQUE (key) row in Postgres; INSERT ... ON CONFLICT.
// Returns TRUE the first time a key is seen, FALSE on every replay.
// ---------------------------------------------------------------------
function makeIdempotencyStub() {
  const seen = new Set<string>();
  return {
    ensureIdempotent(key: string): Promise<boolean> {
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
    size: () => seen.size,
  };
}

// ---------------------------------------------------------------------
// Minimal webhook handler under test.
// Idempotency key = `${webhookType}:${externalId}` (§10 idempotency rule).
// On a duplicate it MUST NOT insert a second row and MUST still return 200.
// ---------------------------------------------------------------------
interface WebhookEvent {
  type: "post_call_transcription" | "call_initiation_failure" | "twilio_status";
  externalId: string; // conversation_id, CallSid, or MessageSid
  payload: Record<string, unknown>;
}

async function handleWebhook(
  event: WebhookEvent,
  idem: ReturnType<typeof makeIdempotencyStub>,
  rows: Array<{ key: string; payload: Record<string, unknown> }>,
): Promise<{ status: number; inserted: boolean }> {
  const key = `${event.type}:${event.externalId}`;
  const first = await idem.ensureIdempotent(key);
  if (!first) {
    // Replay: acknowledge with 200, do NOT write a duplicate row.
    return { status: 200, inserted: false };
  }
  rows.push({ key, payload: event.payload });
  return { status: 200, inserted: true };
}

// =====================================================================
// Tests
// =====================================================================

Deno.test("webhook replay: duplicate event returns 200 and inserts no duplicate row", async () => {
  const idem = makeIdempotencyStub();
  const rows: Array<{ key: string; payload: Record<string, unknown> }> = [];
  const event: WebhookEvent = {
    type: "post_call_transcription",
    externalId: "conv_abc",
    payload: { transcript_ready: true },
  };

  const first = await handleWebhook(event, idem, rows);
  assertEquals(first.status, 200);
  assert(first.inserted, "first delivery must insert a row");

  // Exact same event delivered again (carrier / provider retry).
  const replay = await handleWebhook(event, idem, rows);
  assertEquals(replay.status, 200, "replay must still return 200");
  assertEquals(replay.inserted, false, "replay must not insert a second row");

  assertEquals(rows.length, 1, "exactly one row exists after the replay");
});

Deno.test("webhook replay: same external id but DIFFERENT type is a distinct key", async () => {
  const idem = makeIdempotencyStub();
  const rows: Array<{ key: string; payload: Record<string, unknown> }> = [];
  // Same underlying call id can legitimately produce two webhook TYPES.
  const transcription: WebhookEvent = { type: "post_call_transcription", externalId: "call_1", payload: {} };
  const failure: WebhookEvent = { type: "call_initiation_failure", externalId: "call_1", payload: {} };

  const a = await handleWebhook(transcription, idem, rows);
  const b = await handleWebhook(failure, idem, rows);
  assert(a.inserted && b.inserted, "distinct webhook types keep distinct idempotency keys");
  assertEquals(rows.length, 2);
});

Deno.test("webhook replay: three MessageSid retries collapse to one row", async () => {
  const idem = makeIdempotencyStub();
  const rows: Array<{ key: string; payload: Record<string, unknown> }> = [];
  const sms: WebhookEvent = { type: "twilio_status", externalId: "SM1234", payload: { status: "delivered" } };

  const results = [];
  for (let i = 0; i < 3; i++) results.push(await handleWebhook(sms, idem, rows));

  assert(results.every((r) => r.status === 200), "every retry acknowledges 200");
  assertEquals(results.filter((r) => r.inserted).length, 1, "only the first retry writes");
  assertEquals(rows.length, 1);
  assertEquals(idem.size(), 1);
});
