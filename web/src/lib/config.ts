// Typed access to the copied config JSON (§ CONTRACTS.md — copied into
// web/src/config, not imported across runtimes).
import personasJson from "../config/personas.json";
import verticalJson from "../config/vertical.json";
import disclosureJson from "../config/disclosure.json";

export interface PersonaConcession {
  type: string;
  category?: string;
  description: string;
  price_delta: number;
  requires_verified_leverage?: boolean;
  revised_total?: number;
  post_condition?: string;
}

export interface Persona {
  provider_id: string;
  persona_id: string;
  label: string;
  motivation: string;
  capacity: string;
  behavior: string;
  hard_constraint: string;
  prices: Record<string, number>;
  initial_total?: number;
  initial_total_is_package_range?: boolean;
  headline_quote?: number;
  headline_note?: string;
  resolved_total: number;
  resolved_note?: string;
  allowed_concession: PersonaConcession;
  distinct_outcome: string;
  prohibited_disclosures?: string[];
}

export interface PersonasConfig {
  $schema_version: string;
  note: string;
  synthetic_case_summary: string;
  price_categories: string[];
  personas: Persona[];
  roleplayer_console: {
    banner: string;
    buttons: string[];
    never_calls_grace: boolean;
  };
}

export const personas = personasJson as unknown as PersonasConfig;
export const vertical = verticalJson as unknown as {
  jurisdiction: { country: string; state: string };
  facts_disallowed_defaults: string[];
  data_minimization_never_collect: string[];
  ranking: { weights: Record<string, number>; rules: string[] };
  negotiation_policy: {
    policy_id: string;
    allowed: string[];
    not_allowed: string[];
  };
  consumer_rights_signals: string[];
  red_flags: string[];
};
export const disclosure = disclosureJson as unknown as {
  $schema_version: string;
  disclosure_version: string;
  consent_fields: Record<string, unknown>;
  messages: {
    first_sms: string;
    confirmation_gate: string;
    consumer_updates: Record<string, string>;
    [k: string]: unknown;
  };
  sms_keywords: string[];
};

export function personaById(personaId: string): Persona | undefined {
  const key = personaId.trim().toUpperCase();
  return personas.personas.find(
    (p) => p.persona_id.toUpperCase() === key
  );
}

/** Human-friendly label for a price/quote category key. */
export function categoryLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
