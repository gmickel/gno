/**
 * Client helpers for /api/sessions/*. Unlike the generic apiFetch, failures
 * keep the stable `details.sessionsCode` so the page can branch on it
 * (e.g. show the archive setup state for SESSIONS_NOT_CONFIGURED).
 */

export type {
  SessionDiscoveryCandidate,
  SessionHarness,
  SessionImportReceipt,
  SessionsDiscovery,
  SessionSourceStatus,
  SessionsStatus,
  SessionUnitReceipt,
} from "../../../../sessions/types";

export interface SessionsApiResult<T> {
  data: T | null;
  error: string | null;
  sessionsCode: string | null;
  status: number;
}

interface ErrorEnvelope {
  error?: {
    message?: string;
    details?: { sessionsCode?: string };
  };
}

export async function sessionsApi<T>(
  endpoint: string,
  init?: RequestInit
): Promise<SessionsApiResult<T>> {
  try {
    const res = await fetch(endpoint, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const isJson = (res.headers.get("content-type") ?? "").includes(
      "application/json"
    );
    const json: unknown = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const envelope = (json ?? {}) as ErrorEnvelope;
      return {
        data: null,
        error: envelope.error?.message ?? `Request failed: ${res.status}`,
        sessionsCode: envelope.error?.details?.sessionsCode ?? null,
        status: res.status,
      };
    }
    if (json === null) {
      return {
        data: null,
        error: `Non-JSON response: ${res.status}`,
        sessionsCode: null,
        status: res.status,
      };
    }
    return { data: json as T, error: null, sessionsCode: null, status: 200 };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Network error",
      sessionsCode: null,
      status: 0,
    };
  }
}
