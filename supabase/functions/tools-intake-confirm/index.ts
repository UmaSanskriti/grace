// =====================================================================
// Grace — Intake tool: freeze the CaseSpec (version + hash)
// Endpoint: POST /tools/intake/confirm  (spec §6.3, tool `confirm_case_spec`)
// Owner: task 8. Called once after the caller affirms the read-back summary.
//
// Invariants enforced here:
//   INV-03 (groundwork)  freezes ONE immutable version + input_hash that every
//          initial ProviderCallTask must later share.
//   INV-04  mention_budget is re-asserted false on freeze unless already authorized.
//   Explicit-confirmation gate: refuses to freeze without `affirmed === true`.
// =====================================================================

import { supabaseAdmin } from "../_shared/supabase.ts";
import { json, error } from "../_shared/respond.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { CaseSpec } from "../_shared/types.ts";
import vertical from "../../../config/vertical.json" with { type: "json" };

/** Recursively sort object keys so equal specs hash identically (INV-03). */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the disclosure allowlist: the plain facts a provider may hear.
 * Derived ONLY from confirmed spec, minus any facts_disallowed / never-collect.
 * This is the raw material for each ProviderCallTask.facts_allowed (§5.2, §5.4).
 */
function buildDisclosureAllowlist(spec: Record<string, any>): string[] {
  const facts: string[] = [];
  const zip = spec.location?.pickup_zip;
  const loc = spec.custody?.current_location_type;
  if (loc && zip) facts.push(`${loc} pickup near ZIP ${zip}`);
  else if (zip) facts.push(`pickup near ZIP ${zip}`);
  if (spec.disposition) facts.push(String(spec.disposition).replaceAll("_", " "));
  for (const m of (spec.must_haves as string[]) ?? []) facts.push(m);
  for (const [k, val] of Object.entries(spec.service_preferences ?? {})) {
    facts.push(`${k}: ${String(val)}`);
  }
  // Strip anything that overlaps the disallowed / never-collect lists.
  const banned = [
    ...vertical.facts_disallowed_defaults,
    ...vertical.data_minimization_never_collect,
    ...((spec.facts_disallowed as string[]) ?? []),
  ].map((t) => t.toLowerCase());
  return facts.filter((f) => {
    const lf = f.toLowerCase();
    return !banned.some((b) => lf.includes(b) || lf.includes(b.replaceAll("_", " ")));
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return error("Method not allowed", 405);

  let body: {
    case_id?: string;
    case_version?: number;
    affirmed?: boolean;
    summary_read?: string;
  };
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const caseId = body.case_id;
  if (!caseId) return error("case_id is required", 400);

  // Explicit-confirmation gate: no freeze without an affirmative YES.
  if (body.affirmed !== true) {
    return error("Cannot confirm: caller has not affirmed the read-back (affirmed=true required)", 409);
  }

  const admin = supabaseAdmin();

  const { data: caseRow, error: caseErr } = await admin
    .from("cases")
    .select("case_id, current_version")
    .eq("case_id", caseId)
    .maybeSingle();
  if (caseErr) return error(`DB error loading case: ${caseErr.message}`, 500);
  if (!caseRow) return error("case not found", 404);

  // Load the working draft (unconfirmed).
  const { data: draftRow, error: draftErr } = await admin
    .from("case_versions")
    .select("version, case_spec_json, confirmed_at")
    .eq("case_id", caseId)
    .is("confirmed_at", null)
    .order("version", { ascending: false })
    .maybeSingle();
  if (draftErr) return error(`DB error loading draft: ${draftErr.message}`, 500);
  if (!draftRow) return error("no draft CaseSpec to confirm", 409);

  const spec = { ...(draftRow.case_spec_json as Record<string, any>) };
  const confirmedAt = new Date().toISOString();
  const newVersion = (caseRow.current_version ?? 0) + 1;

  // Stamp the frozen fields onto the spec BEFORE hashing so the hash is complete.
  spec.version = newVersion;
  spec.confirmed_at = confirmedAt;
  const disclosureAllowlist = buildDisclosureAllowlist(spec);
  spec.disclosure_allowlist = disclosureAllowlist; // consumed by ProviderCallTask builder

  // INV-03: single canonical hash that all initial tasks must reference.
  const inputHash = await sha256Hex(JSON.stringify(canonicalize(spec)));

  // Freeze the row: set version + confirmed_at + input_hash. Immutable hereafter.
  const { error: upErr } = await admin
    .from("case_versions")
    .update({
      version: newVersion,
      case_spec_json: spec,
      confirmed_at: confirmedAt,
      input_hash: inputHash,
    })
    .eq("case_id", caseId)
    .eq("version", draftRow.version);
  if (upErr) return error(`DB error freezing version: ${upErr.message}`, 500);

  // Advance the case: current_version pointer + CASE_CONFIRMED state.
  const { error: caseUpErr } = await admin
    .from("cases")
    .update({ current_version: newVersion, status: "CASE_CONFIRMED" })
    .eq("case_id", caseId);
  if (caseUpErr) return error(`DB error updating case: ${caseUpErr.message}`, 500);

  await admin.from("events").insert({
    case_id: caseId,
    type: "case_confirmed",
    actor: "intake_agent",
    payload_json: {
      version: newVersion,
      input_hash: inputHash,
      disclosure_allowlist: disclosureAllowlist,
      summary_read: body.summary_read ?? null,
    },
    idempotency_key: `confirm:${caseId}:${newVersion}`,
  });

  return json({
    confirmed: true,
    version: newVersion,
    spec_hash: inputHash,
    confirmed_at: confirmedAt,
    case_spec: spec as unknown as CaseSpec,
  });
});
