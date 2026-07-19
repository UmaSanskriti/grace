// =====================================================================
// Grace — Intake tool: validate & persist a CaseSpec patch
// Endpoint: POST /tools/intake/case-patch  (spec §6.3, tool `patch_case_spec`)
// Owner: task 8. Called by the Grace Intake Agent at a confirmed checkpoint.
//
// Invariants enforced here:
//   INV-04  mention_budget defaults false and is NEVER inferred — it cannot flip
//           to true through a patch unless an explicit authorization flag is set.
//   INV-08 (data-min) rejects disallowed / never-collect facts before persisting.
//   Increment nothing: the working draft version does not advance until confirm.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { CasePatch, CaseSpec } from "../_shared/types.ts";
// Config is the source of truth for jurisdiction defaults + disallowed facts.
import vertical from "../_shared/config/vertical.json" with { type: "json" };

/** Deterministic default draft spec for a brand-new case (all permissions false). */
function baseSpec(caseId: string, version: number): Record<string, unknown> {
  return {
    case_id: caseId,
    version,
    mode: "at_need",
    jurisdiction: {
      country: vertical.jurisdiction.country,
      state: vertical.jurisdiction.state,
    },
    location: { pickup_zip: null, search_radius_miles: 25 },
    custody: { current_location_type: null, transfer_deadline_at: null },
    authority: { confirmed_for_demo: false, role: null },
    disposition: null,
    must_haves: [],
    service_preferences: {},
    cost_posture: "balanced",
    budget_user_stated: null,
    benefits_to_check: [],
    // INV-04: mention_budget starts false and only an explicit authorization flips it.
    permissions: {
      research: false,
      call: false,
      mention_budget: false,
      use_verified_quote: false,
      negotiate_within_policy: false,
      transcribe_if_all_parties_consent: false,
    },
    facts_disallowed: [...vertical.facts_disallowed_defaults],
    unknowns: [],
    confirmed_at: null,
  };
}

/** Shallow+one-level-deep merge of a CasePatch onto the working draft. */
function mergePatch(
  draft: Record<string, unknown>,
  patch: CasePatch,
): Record<string, unknown> {
  const nested = new Set([
    "jurisdiction",
    "location",
    "custody",
    "authority",
    "service_preferences",
    "permissions",
  ]);
  const out: Record<string, unknown> = { ...draft };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (nested.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = { ...(draft[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Fields still needed before this spec can be confirmed and called out on. */
function unresolvedFields(spec: Record<string, any>): string[] {
  const u: string[] = [];
  if (!spec.disposition) u.push("disposition");
  if (!spec.authority?.confirmed_for_demo) u.push("authority");
  if (!spec.location?.pickup_zip) u.push("location.pickup_zip");
  if (spec.custody?.current_location_type == null) u.push("custody.current_location_type");
  if (!spec.permissions?.call) u.push("permissions.call");
  if (!spec.permissions?.transcribe_if_all_parties_consent) u.push("permissions.transcription");
  if (!Array.isArray(spec.must_haves) || spec.must_haves.length === 0) u.push("must_haves");
  for (const k of (spec.unknowns as string[]) ?? []) u.push(k);
  return [...new Set(u)];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  let body: {
    case_id?: string;
    case_version?: number;
    patch?: CasePatch;
    authorize_mention_budget?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const caseId = body.case_id;
  const patch = (body.patch ?? {}) as CasePatch;
  if (!caseId) return error("case_id is required", 400);

  // ---- INV-08 / data-minimization: reject disallowed & never-collect facts. ----
  // Provider/consumer speech is data, never a reason to store prohibited PII.
  const banned = [
    ...vertical.data_minimization_never_collect,
    ...vertical.facts_disallowed_defaults,
  ];
  const hay = JSON.stringify(patch).toLowerCase();
  for (const term of banned) {
    const t = term.toLowerCase();
    if (hay.includes(t) || hay.includes(t.replaceAll("_", " "))) {
      return error(`Disallowed fact rejected (data minimization): ${term}`, 422);
    }
  }

  // ---- INV-04: mention_budget can NEVER be inferred or flipped by a patch ----
  // unless an explicit authorization flag accompanies the request.
  const wantsBudgetMention = (patch as any)?.permissions?.mention_budget === true;
  if (wantsBudgetMention && body.authorize_mention_budget !== true) {
    return error(
      "INV-04: mention_budget cannot be set true without explicit authorization",
      403,
    );
  }

  const admin = supabaseAdmin();

  // Look up the case + its current confirmed version pointer.
  const { data: caseRow, error: caseErr } = await admin
    .from("cases")
    .select("case_id, current_version, status")
    .eq("case_id", caseId)
    .maybeSingle();
  if (caseErr) return error(`DB error loading case: ${caseErr.message}`, 500);
  if (!caseRow) return error("case not found", 404);

  // The working draft is the single case_versions row with confirmed_at IS NULL.
  // Its version is the *prospective* next version; it does not advance on patch.
  const draftVersion = (caseRow.current_version ?? 0) + 1;
  const { data: draftRow } = await admin
    .from("case_versions")
    .select("version, case_spec_json")
    .eq("case_id", caseId)
    .is("confirmed_at", null)
    .order("version", { ascending: false })
    .maybeSingle();

  const currentDraft: Record<string, unknown> =
    (draftRow?.case_spec_json as Record<string, unknown>) ?? baseSpec(caseId, draftVersion);

  // Merge, then re-assert INV-04 defensively: unauthorized budget stays false.
  const merged = mergePatch(currentDraft, patch);
  const perms = merged.permissions as Record<string, unknown>;
  if (body.authorize_mention_budget !== true) {
    perms.mention_budget = false; // never inferred
  }
  merged.version = draftRow?.version ?? draftVersion;
  merged.confirmed_at = null;

  // Persist the draft (no version bump). Upsert the single unconfirmed row.
  const { error: upErr } = await admin
    .from("case_versions")
    .upsert(
      {
        case_id: caseId,
        version: merged.version,
        case_spec_json: merged,
        confirmed_at: null,
        input_hash: null,
      },
      { onConflict: "case_id,version" },
    );
  if (upErr) return error(`DB error saving draft: ${upErr.message}`, 500);

  // Move the case into CASE_DRAFT (idempotent).
  await admin.from("cases").update({ status: "CASE_DRAFT" }).eq("case_id", caseId);

  // Audit trail (metadata only).
  await admin.from("events").insert({
    case_id: caseId,
    type: "case_patch_applied",
    actor: "intake_agent",
    payload_json: { version: merged.version, keys: Object.keys(patch) },
    idempotency_key: `patch:${caseId}:${crypto.randomUUID()}`,
  });

  return json({
    version: merged.version,
    case_spec_draft: merged as unknown as CaseSpec,
    unresolved_fields: unresolvedFields(merged),
  });
});
