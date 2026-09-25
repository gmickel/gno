/**
 * Client helpers for /api/sessions/*: failures keep the stable
 * `details.sessionsCode` so the page can branch on it (e.g. show the archive
 * setup state for SESSIONS_NOT_CONFIGURED).
 */

import { apiFetch } from "../../hooks/use-api";

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
}

/** apiFetch plus the stable `details.sessionsCode` of a failed request. */
export async function sessionsApi<T>(
  endpoint: string,
  init?: RequestInit
): Promise<SessionsApiResult<T>> {
  const result = await apiFetch<T>(endpoint, init);
  const code = result.details?.sessionsCode;
  return {
    data: result.data,
    error: result.error,
    sessionsCode: typeof code === "string" ? code : null,
  };
}
