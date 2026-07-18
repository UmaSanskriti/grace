// =====================================================================
// Grace contract test — SMS routing + STOP revocation (spec §4.2, §11.1)
//
// Covers:
//   - The EXACT first SMS matches config/disclosure.json (spec §4.2).
//   - TEXT / CALL / HELP / STOP routing (§4.2 table).
//   - INV-10: STOP revokes and blocks all later outbound.
//
// Reads the real config so the user-facing/legal strings are asserted
// against the single source of truth (not a copy).
//
// PURE / OFFLINE: no network, no backend. Requires --allow-read for the
// JSON import (Deno grants read for local module imports automatically).
// =====================================================================

import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import type { CaseStatus, ContactStatus } from "../../supabase/functions/_shared/types.ts";
import disclosure from "../../config/disclosure.json" with { type: "json" };

// The exact first SMS from spec §4.2 ("Exact first SMS").
const EXACT_FIRST_SMS =
  "Grace here, the AI funeral-arrangements advocate for this demo. Would you rather continue by text or receive a call? Reply TEXT or CALL. Messages and calls may be transcribed and processed by our service providers. Reply STOP to stop.";

// ---------------------------------------------------------------------
// Router stub mirroring the §4.2 routing table + INV-10 revocation gate.
// ---------------------------------------------------------------------
interface SessionState {
  contact_status: ContactStatus;
  preferred_channel: "text" | "voice" | "unknown";
  reask_count: number;
}

interface RouteResult {
  reply: string | null; // outbound SMS, or null if none sent
  action: string; // system action label
  next_state: CaseStatus | null;
}

function newSession(): SessionState {
  return { contact_status: "active", preferred_channel: "unknown", reask_count: 0 };
}

/** Returns null reply if outbound is blocked by revocation (INV-10). */
function guardOutbound(state: SessionState, reply: string): string | null {
  return state.contact_status === "revoked" ? null : reply;
}

function route(state: SessionState, body: string): RouteResult {
  const keyword = body.trim().toUpperCase();
  const m = disclosure.messages;

  // STOP is honored even when revoked (single confirmation), and it is the
  // only keyword allowed to produce an outbound message once revoked.
  if (keyword === "STOP") {
    const alreadyRevoked = state.contact_status === "revoked";
    state.contact_status = "revoked";
    return {
      reply: alreadyRevoked ? null : m.stop_confirmation,
      action: "revoke_and_confirm_once",
      next_state: null,
    };
  }

  // Every other outbound is blocked once revoked (INV-10).
  if (state.contact_status === "revoked") {
    return { reply: null, action: "blocked_revoked", next_state: null };
  }

  switch (keyword) {
    case "TEXT":
      state.preferred_channel = "text";
      return { reply: guardOutbound(state, "first_intake_question"), action: "set_channel_text_send_intake", next_state: "TEXT_INTAKE" };
    case "CALL":
      state.preferred_channel = "voice";
      return { reply: guardOutbound(state, m.calling_now_ack), action: "ack_and_launch_intake_agent", next_state: "INTAKE_AGENT_ACTIVE" };
    case "HELP":
      return { reply: guardOutbound(state, m.help), action: "explain_demo_and_stop", next_state: null };
    default: {
      // Unknown reply: re-ask channel once, then default to text.
      state.reask_count += 1;
      if (state.reask_count === 1) {
        return { reply: guardOutbound(state, m.reask_channel), action: "reask_channel_once", next_state: null };
      }
      state.preferred_channel = "text";
      return { reply: guardOutbound(state, "first_intake_question"), action: "default_to_text", next_state: "TEXT_INTAKE" };
    }
  }
}

// =====================================================================
// Tests
// =====================================================================

Deno.test("first SMS: config value matches the spec §4.2 exact string byte-for-byte", () => {
  assertEquals(disclosure.messages.first_sms, EXACT_FIRST_SMS);
});

Deno.test("first SMS: discloses AI identity, transcription/processing, and STOP", () => {
  const sms = disclosure.messages.first_sms;
  assertStringIncludes(sms, "AI funeral-arrangements advocate");
  assertStringIncludes(sms, "Reply TEXT or CALL");
  assertStringIncludes(sms, "transcribed and processed by our service providers");
  assertStringIncludes(sms, "Reply STOP to stop");
});

Deno.test("routing: TEXT sets channel=text and moves to TEXT_INTAKE", () => {
  const s = newSession();
  const r = route(s, "text");
  assertEquals(s.preferred_channel, "text");
  assertEquals(r.next_state, "TEXT_INTAKE");
});

Deno.test("routing: CALL sends 'Calling now.' and launches the intake agent", () => {
  const s = newSession();
  const r = route(s, "CALL");
  assertEquals(r.reply, disclosure.messages.calling_now_ack);
  assertEquals(r.reply, "Calling now.");
  assertEquals(s.preferred_channel, "voice");
  assertEquals(r.next_state, "INTAKE_AGENT_ACTIVE");
});

Deno.test("routing: HELP returns the demo/data-handling explanation", () => {
  const s = newSession();
  const r = route(s, "help");
  assertEquals(r.reply, disclosure.messages.help);
  assertStringIncludes(r.reply!, "STOP to stop");
});

Deno.test("routing: unknown reply re-asks channel once, then defaults to text", () => {
  const s = newSession();
  const first = route(s, "maybe?");
  assertEquals(first.reply, disclosure.messages.reask_channel);
  assertEquals(first.action, "reask_channel_once");
  const second = route(s, "still unsure");
  assertEquals(second.action, "default_to_text");
  assertEquals(s.preferred_channel, "text");
});

Deno.test("INV-10: STOP revokes, sends exactly one confirmation, then blocks all later outbound", () => {
  const s = newSession();

  const stop = route(s, "STOP");
  assertEquals(s.contact_status, "revoked");
  assertEquals(stop.reply, disclosure.messages.stop_confirmation);

  // A later CALL / TEXT / HELP must produce NO outbound message.
  assertEquals(route(s, "CALL").reply, null);
  assertEquals(route(s, "TEXT").reply, null);
  assertEquals(route(s, "HELP").reply, null);

  // A second STOP does not re-send a confirmation (one confirmation only).
  assertEquals(route(s, "STOP").reply, null);
});

Deno.test("INV-10: STOP confirmation string matches config exactly", () => {
  assertEquals(
    disclosure.messages.stop_confirmation,
    "You're unsubscribed. Grace will not contact you again. Reply HELP for info.",
  );
});
