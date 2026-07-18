// =====================================================================
// Grace — Supabase admin client (spec §10 Secrets/RLS)
// Uses the service-role key: bypasses RLS, so this is SERVER-SIDE ONLY.
// Never import this module into web/ client code.
// =====================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseServiceRoleKey, supabaseUrl } from "./env.ts";

/**
 * Build a service-role Supabase client for privileged Edge Function work (§10 RLS).
 * Auth persistence is disabled — Edge Functions are stateless per request.
 * @returns a configured {@link SupabaseClient}.
 */
export function supabaseAdmin(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
