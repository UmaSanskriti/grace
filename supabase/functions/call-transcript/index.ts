// =====================================================================
// Grace — GET /call-transcript?conversation_id=...
// Server-side proxy that fetches an ElevenLabs conversation's status +
// transcript (the xi-api-key must never reach the browser). Used by the Live
// Agent Loop tab to show each call's transcript after the agent finishes.
// Returns a clean, already-escaped-on-render shape.
// =====================================================================

import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { elevenLabsApiKey } from "../_shared/env.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return error("Method not allowed", 405);

  const cid = new URL(req.url).searchParams.get("conversation_id");
  if (!cid) return error("conversation_id is required", 400);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(cid)}`,
    { headers: { "xi-api-key": elevenLabsApiKey() } },
  );

  // Conversation may not be queryable for a moment right after launch.
  if (res.status === 404) return json({ status: "pending", transcript: [], duration_secs: null });
  if (!res.ok) return error(`ElevenLabs conversation fetch failed: ${res.status}`, 502);

  const d = await res.json() as {
    status?: string;
    transcript?: { role?: string; message?: string | null; time_in_call_secs?: number }[];
    metadata?: { call_duration_secs?: number };
  };

  const transcript = (d.transcript ?? [])
    .filter((t) => (t.message ?? "").trim().length > 0)
    .map((t) => ({
      role: t.role === "user" ? "caller" : "grace", // "user" = the human on the line
      message: t.message ?? "",
      secs: t.time_in_call_secs ?? null,
    }));

  return json({
    status: d.status ?? "unknown", // 'processing' | 'done' | 'in-progress' | 'failed'
    transcript,
    duration_secs: d.metadata?.call_duration_secs ?? null,
  });
});
