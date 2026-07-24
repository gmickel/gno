/** Stable closed failures for the browser-clipper transport boundary. */

const SECURITY_ERRORS = {
  CLIPPER_ABORTED: { message: "Clipper request aborted", status: 503 },
  CLIPPER_BODY_TOO_LARGE: {
    message: "Clipper request body too large",
    status: 413,
  },
  CLIPPER_BUSY: { message: "Clipper request queue is full", status: 429 },
  CLIPPER_FORBIDDEN: { message: "Forbidden", status: 403 },
  CLIPPER_INVALID_JSON: { message: "Invalid JSON body", status: 400 },
  CLIPPER_RATE_LIMITED: { message: "Too many clipper requests", status: 429 },
} as const;

export function clipperSecurityErrorResponse(
  code: keyof typeof SECURITY_ERRORS
): Response {
  const detail = SECURITY_ERRORS[code];
  return Response.json(
    { error: { code, message: detail.message } },
    { status: detail.status }
  );
}
