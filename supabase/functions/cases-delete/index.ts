// =====================================================================
// Grace — purge a demo case
// Endpoint: DELETE /cases/{id}  (spec §6.3, §10.2)
// Owner: task 8.
//
// Invariants enforced here:
//   INV-12  purge demo data at/before purge_at, INCLUDING vendor conversation IDs.
//           DB rows cascade; private storage objects removed; ElevenLabs
//           conversations best-effort deleted at the vendor.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { elevenLabsApiKey } from "../_shared/env.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";

const PRIVATE_BUCKET = "grace-private";

function extractCaseId(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("cases");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  return url.searchParams.get("case_id") ?? url.searchParams.get("id");
}

/** Best-effort deletion of a conversation at ElevenLabs (INV-12 vendor purge). */
async function deleteElevenLabsConversation(conversationId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
      { method: "DELETE", headers: { "xi-api-key": elevenLabsApiKey() } },
    );
    return res.ok;
  } catch (e) {
    console.error("ElevenLabs conversation delete failed (non-fatal):", e);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "DELETE") return error("Method not allowed", 405);

  const url = new URL(req.url);
  const caseId = extractCaseId(url);
  if (!caseId) return error("case_id is required", 400);

  const admin = supabaseAdmin();

  const { data: caseRow } = await admin
    .from("cases")
    .select("case_id")
    .eq("case_id", caseId)
    .maybeSingle();
  if (!caseRow) return json({ deleted: true, note: "already absent" });

  // Collect vendor conversation IDs BEFORE deleting rows (INV-12).
  const { data: sessions } = await admin
    .from("call_sessions")
    .select("elevenlabs_conversation_id")
    .eq("case_id", caseId);
  const conversationIds = (sessions ?? [])
    .map((s: any) => s.elevenlabs_conversation_id)
    .filter((c: unknown): c is string => typeof c === "string" && c.length > 0);

  const vendorResults: Record<string, boolean> = {};
  for (const cid of conversationIds) {
    vendorResults[cid] = await deleteElevenLabsConversation(cid);
  }

  // Remove private storage projections + raw payloads (best-effort).
  try {
    const toRemove: string[] = [
      `cases/${caseId}/evidence.md`,
      `cases/${caseId}/context.md`,
    ];
    for (const cid of conversationIds) {
      const { data: listed } = await admin.storage.from(PRIVATE_BUCKET).list(`raw/${cid}`);
      for (const obj of listed ?? []) toRemove.push(`raw/${cid}/${obj.name}`);
    }
    if (toRemove.length > 0) await admin.storage.from(PRIVATE_BUCKET).remove(toRemove);
  } catch (e) {
    console.error("storage purge failed (non-fatal):", e);
  }

  // Delete the case. Child tables cascade via DB FKs (task 2 migrations).
  const { error: delErr } = await admin.from("cases").delete().eq("case_id", caseId);
  if (delErr) return error(`DB error deleting case: ${delErr.message}`, 500);

  // Defensive explicit deletes in case a FK cascade is not configured.
  await Promise.allSettled([
    admin.from("events").delete().eq("case_id", caseId),
    admin.from("quotes").delete().eq("case_id", caseId),
    admin.from("case_versions").delete().eq("case_id", caseId),
    admin.from("call_sessions").delete().eq("case_id", caseId),
    admin.from("messages").delete().eq("case_id", caseId),
    admin.from("reports").delete().eq("case_id", caseId),
    admin.from("provider_call_tasks").delete().eq("case_id", caseId),
  ]);

  return json({
    deleted: true,
    case_id: caseId,
    vendor_conversations_deleted: vendorResults,
  });
});
