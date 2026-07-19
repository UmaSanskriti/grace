// Typed fetch client for the Grace backend (the FastAPI app under `app/`).
// All external vendor APIs (Twilio/ElevenLabs/OpenAI/Tavily) are server-side
// only — no vendor credential ever belongs in browser code. The backend has no
// auth gate, so this client sends no auth headers.

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
      "VITE_APP_BASE_URL is not set. Copy .env.example to .env and point it at the Grace backend."
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

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
  // NOTE (issue #12): VITE_APP_BASE_URL now points straight at the FastAPI
  // backend's root — there is no /functions/v1 prefix any more.
  //
  // The three calls below are NOT yet implemented by that backend: it serves
  // /agent-activity, /call-transcript, /demo-call, /cases/{id} and
  // /cases/{id}/report, and nothing answers these hyphenated paths. They are
  // left verbatim rather than remapped onto guessed equivalents — /cases/{id}
  // returns the raw case dump, not CaseContextResponse, and /cases/{id}/report
  // returns text/markdown, not CaseReportResponse. Enroll has no counterpart at
  // all. Reconciling these routes is follow-up work, tracked separately.

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
