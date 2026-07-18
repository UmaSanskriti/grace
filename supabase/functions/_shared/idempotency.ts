// =====================================================================
// Grace — webhook/event idempotency (spec §6.7, §10 "Idempotency")
// A unique key (MessageSid / CallSid / conversation_id + event type) is
// recorded exactly once, so replayed vendor webhooks are safe no-ops.
//
// Assumes an `events` table (owned by the DB task, §6.2) with a UNIQUE
// `idempotency_key` column. A duplicate insert surfaces Postgres unique-
// violation code 23505, which we treat as "already seen".
// =====================================================================

import { supabaseAdmin } from "./supabase.ts";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Record an idempotency key, returning whether this is the first sighting
 * (spec §6.7, §10 "Idempotency").
 * @param key stable key, e.g. `${eventType}:${MessageSid}`.
 * @returns true if newly inserted (safe to process); false if already seen.
 */
export async function ensureIdempotent(key: string): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from("events")
    .insert({ idempotency_key: key });

  if (!error) return true;
  if (error.code === UNIQUE_VIOLATION) return false;
  throw new Error(`ensureIdempotent failed for key "${key}": ${error.message}`);
}
