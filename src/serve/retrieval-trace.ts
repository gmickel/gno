/** REST-only retrieval trace transport metadata. */

import type { RetrievalTraceSession } from "../core/retrieval-trace-session";

export const RETRIEVAL_TRACE_HEADER = "X-GNO-Trace-ID";

export const requestRetrievalTraceId = (
  request: Request
): string | undefined => {
  const value = request.headers.get(RETRIEVAL_TRACE_HEADER)?.trim();
  return value || undefined;
};

/** Preserve status/body bytes while adding transport-only trace identity. */
export const withRetrievalTraceHeader = (
  response: Response,
  session: RetrievalTraceSession | null | undefined
): Response => {
  const traceId = session?.metadata()?.traceId;
  if (!traceId) return response;
  const headers = new Headers(response.headers);
  headers.set(RETRIEVAL_TRACE_HEADER, traceId);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
