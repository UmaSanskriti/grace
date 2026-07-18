// =====================================================================
// Grace — CORS helpers for browser-invoked Edge Functions (spec §6.3, §10)
// Web app (web/) calls a subset of functions directly from the browser.
// =====================================================================

/** Standard CORS headers for browser-invoked functions. */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

/**
 * Handle a CORS preflight request.
 * @returns a 204 Response with CORS headers for `OPTIONS`, else null.
 */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return null;
}
