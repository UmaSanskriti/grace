// =====================================================================
// Grace — JSON Response helpers for Edge Functions (spec §6.3)
// Every response carries CORS headers so browser-invoked functions work.
// =====================================================================

import { corsHeaders } from "./cors.ts";

/**
 * Build a JSON success Response.
 * @param data serializable payload.
 * @param status HTTP status (default 200).
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Build a JSON error Response of shape `{ error: message }`.
 * @param message human-readable error string.
 * @param status HTTP status code.
 */
export function error(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}
