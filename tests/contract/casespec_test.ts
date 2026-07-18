// =====================================================================
// Grace contract test — CaseSpec strict-JSON validity (spec §11.1 row 1)
//
// Pass condition (§11.1): "100% valid strict JSON; unknowns explicit;
// version increments only on confirmed edit." Also encodes INV-04
// (mention_budget defaults false and can never be inferred).
//
// PURE / OFFLINE: no network, no backend. Runs under `deno test`.
// Types are imported from the frozen contract; the tiny validator/
// reducer helpers below are local test stubs that mirror the documented
// server behavior (§4.4, §4.5) so the invariants are checked in isolation.
// =====================================================================

import {
  assert,
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "std/assert/mod.ts";
import type {
  CasePatch,
  CaseSpec,
  CaseSpecPermissions,
} from "../../supabase/functions/_shared/types.ts";

// ---------------------------------------------------------------------
// Canonical confirmed CaseSpec (spec §4.4 example, with a real case_id).
// ---------------------------------------------------------------------
function canonicalSpec(): CaseSpec {
  return {
    case_id: "case_0001",
    version: 4,
    mode: "at_need",
    jurisdiction: { country: "US", state: "CA" },
    location: { pickup_zip: "94304", search_radius_miles: 25 },
    custody: { current_location_type: "hospital", transfer_deadline_at: null },
    authority: { confirmed_for_demo: true, role: "adult_child" },
    disposition: "cremation_with_service",
    must_haves: ["private family goodbye", "Spanish-language support"],
    service_preferences: { viewing: "private", ceremony: "memorial_later", return_of_ashes: true },
    cost_posture: "balanced",
    budget_user_stated: null,
    benefits_to_check: [],
    permissions: {
      research: true,
      call: true,
      mention_budget: false,
      use_verified_quote: true,
      negotiate_within_policy: true,
      transcribe_if_all_parties_consent: true,
    },
    facts_disallowed: ["cause_of_death", "social_security_number", "payment_data"],
    unknowns: [],
    confirmed_at: "2026-07-18T17:00:00Z",
  };
}

const REQUIRED_PERMISSION_KEYS: (keyof CaseSpecPermissions)[] = [
  "research",
  "call",
  "mention_budget",
  "use_verified_quote",
  "negotiate_within_policy",
  "transcribe_if_all_parties_consent",
];

// ---------------------------------------------------------------------
// Local validator stub — mirrors the strict-JSON schema contract (§4.4).
// A real implementation validates with json_schema strict mode; here we
// assert the shape a strict validator would enforce.
// ---------------------------------------------------------------------
function isValidCaseSpec(spec: CaseSpec): { ok: boolean; reason?: string } {
  if (typeof spec.case_id !== "string" || spec.case_id.length === 0) {
    return { ok: false, reason: "case_id missing" };
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    return { ok: false, reason: "version must be a non-negative integer" };
  }
  if (spec.mode !== "at_need" && spec.mode !== "pre_need") {
    return { ok: false, reason: "mode not in enum" };
  }
  if (!["lowest_comparable_total", "balanced", "prioritize_fit"].includes(spec.cost_posture)) {
    return { ok: false, reason: "cost_posture not in enum" };
  }
  if (!Array.isArray(spec.unknowns)) {
    return { ok: false, reason: "unknowns must be an explicit array" };
  }
  for (const k of REQUIRED_PERMISSION_KEYS) {
    if (typeof spec.permissions[k] !== "boolean") {
      return { ok: false, reason: `permission ${k} must be boolean` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// Local reducer stub — the ONLY sanctioned way to bump a version is a
// confirmed edit (§4.5: "confirmation creates an immutable CaseSpec
// version"). Draft patches never touch version until confirmed.
// ---------------------------------------------------------------------
function applyDraftPatch(spec: CaseSpec, patch: CasePatch): CaseSpec {
  // Draft edits mutate content but NOT version/confirmed_at.
  return { ...spec, ...patch, version: spec.version, confirmed_at: null };
}

function confirmEdit(spec: CaseSpec, patch: CasePatch, at: string): CaseSpec {
  const drafted = applyDraftPatch(spec, patch);
  return { ...drafted, version: spec.version + 1, confirmed_at: at };
}

// =====================================================================
// Tests
// =====================================================================

Deno.test("CaseSpec: canonical example is valid strict JSON and round-trips", () => {
  const spec = canonicalSpec();
  const result = isValidCaseSpec(spec);
  assert(result.ok, `expected valid, got: ${result.reason}`);
  // Strict JSON: must serialize and parse back byte-for-byte structurally.
  const round = JSON.parse(JSON.stringify(spec)) as CaseSpec;
  assertEquals(round, spec);
  assert(isValidCaseSpec(round).ok);
});

Deno.test("CaseSpec: unknowns are explicit (always an array, never omitted)", () => {
  const spec = canonicalSpec();
  assert(Array.isArray(spec.unknowns));
  // An unresolved field is represented explicitly, not by absence.
  const withUnknown: CaseSpec = { ...spec, disposition: null, unknowns: ["disposition"] };
  assert(isValidCaseSpec(withUnknown).ok);
  assert(withUnknown.unknowns.includes("disposition"));
});

Deno.test("CaseSpec: an invalid enum value is rejected by the strict validator", () => {
  const spec = canonicalSpec();
  // deno-lint-ignore no-explicit-any
  const bad = { ...spec, cost_posture: "cheapest_possible" as any };
  assertFalse(isValidCaseSpec(bad).ok);
});

Deno.test("CaseSpec: version increments ONLY on a confirmed edit", () => {
  const spec = canonicalSpec();
  const before = spec.version;

  // Draft patch during intake -> content may change, version does NOT.
  const drafted = applyDraftPatch(spec, { disposition: "cremation_direct" });
  assertStrictEquals(drafted.version, before);
  assertStrictEquals(drafted.confirmed_at, null);

  // Explicit confirmation (YES gate) -> version increments by exactly one.
  const confirmed = confirmEdit(spec, { disposition: "cremation_direct" }, "2026-07-18T18:00:00Z");
  assertStrictEquals(confirmed.version, before + 1);
  assert(confirmed.confirmed_at !== null);
});

Deno.test("INV-04: mention_budget defaults false", () => {
  const spec = canonicalSpec();
  assertStrictEquals(spec.permissions.mention_budget, false);
});

Deno.test("INV-04: mention_budget can NEVER be inferred from a volunteered budget", () => {
  const spec = canonicalSpec();
  // Consumer volunteers a range during intake. Per §4.3 budget rule this
  // stays private: applying the patch must leave mention_budget false and
  // must NOT let the patch flip it true implicitly.
  const patched = applyDraftPatch(spec, {
    budget_user_stated: "around 4000",
  } as CasePatch);
  assertStrictEquals(patched.budget_user_stated, "around 4000");
  assertStrictEquals(
    patched.permissions.mention_budget,
    false,
    "a volunteered budget must never flip mention_budget true",
  );
});

Deno.test("INV-04: mention_budget can only become true via explicit permission grant", () => {
  const spec = canonicalSpec();
  // The ONLY legitimate path: the consumer explicitly authorizes disclosure.
  const explicit = applyDraftPatch(spec, {
    permissions: { ...spec.permissions, mention_budget: true },
  });
  assertStrictEquals(explicit.permissions.mention_budget, true);
});
