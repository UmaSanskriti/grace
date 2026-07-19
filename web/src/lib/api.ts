// Typed fetch client for the Grace Edge Function endpoints (spec §6.3).
// All external vendor APIs (Twilio/ElevenLabs/OpenAI/Tavily) are server-side
// only; this client talks solely to the Grace Edge Functions using the anon
// key (§10 — never a service key in browser code).

import type {
  CaseContextResponse,
  CaseReportResponse,
  EnrollRequest,
  EnrollResponse,
} from "../types";

const BASE_URL: string =
  (import.meta.env.VITE_APP_BASE_URL as string | undefined)?.replace(
    /\/+$/,
    ""
  ) ?? "";

const ANON_KEY: string =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function isApiConfigured(): boolean {
  return BASE_URL.length > 0;
}

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!BASE_URL) {
    throw new ApiError(
      0,
      "VITE_APP_BASE_URL is not set. Copy .env.example to .env and point it at your Grace Edge Functions."
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  // Supabase Edge Functions gate on the anon key.
  if (ANON_KEY) {
    headers["apikey"] = ANON_KEY;
    headers["Authorization"] = `Bearer ${ANON_KEY}`;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  } catch (err) {
    throw new ApiError(
      0,
      `Network error contacting ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    let message = `Request to ${path} failed (${res.status})`;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      message = String((parsed as { error: unknown }).error);
    }
    throw new ApiError(res.status, message, parsed);
  }

  return parsed as T;
}

export const api = {
  // NOTE: Supabase serves each Edge Function at /functions/v1/<function-name>,
  // so VITE_APP_BASE_URL ends in /functions/v1 and paths are the hyphenated
  // function names (not the spec's clean /demo/enroll paths).

  /** POST demo-enroll — create case, validate allowlist, store consent. */
  enroll(body: EnrollRequest): Promise<EnrollResponse> {
    return request<EnrollResponse>("/demo-enroll", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** GET cases-context — compact context + CaseSpec + ledger markdown. */
  getContext(caseId: string): Promise<CaseContextResponse> {
    return request<CaseContextResponse>(
      `/cases-context?case_id=${encodeURIComponent(caseId)}`
    );
  },

  /** GET cases-report — ranked report JSON + Markdown. */
  getReport(caseId: string): Promise<CaseReportResponse> {
    return request<CaseReportResponse>(
      `/cases-report?case_id=${encodeURIComponent(caseId)}`
    );
  },
};
