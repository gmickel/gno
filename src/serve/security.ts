/**
 * CSRF protection and security utilities for the API server.
 *
 * Security model:
 * - This is a loopback-only server (127.0.0.1)
 * - CSRF protection uses Origin header validation
 * - Requests WITHOUT Origin header are allowed (same-origin browser requests, curl)
 * - Setting GNO_API_TOKEN enables token auth as an alternative to Origin validation
 *   but does NOT require it for non-browser clients (they just omit Origin)
 *
 * @module src/serve/security
 */

/**
 * Validate Origin header for CSRF protection.
 * Same-origin requests (no Origin header) are allowed - this includes:
 * - Same-origin browser fetch/XHR (browser omits Origin for same-origin)
 * - curl and other non-browser clients (no Origin header by default)
 * Cross-origin browser requests must originate from localhost/127.0.0.1.
 */
export function validateOrigin(req: Request, port: number): boolean {
  const origin = req.headers.get('Origin');
  // Same-origin requests (browser fetch, curl) have no Origin header
  if (!origin) {
    return true;
  }

  // For port 0 (ephemeral), we can't validate specific port - only allow if
  // the port in the request matches the expected allowed origins pattern
  const allowed =
    port === 0
      ? [] // Can't know actual port, reject cross-origin for ephemeral
      : [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  return allowed.includes(origin);
}

/**
 * Validate API token for non-browser clients (e.g., Raycast).
 * Token auth is optional - only enabled if GNO_API_TOKEN env var is set.
 * When enabled, requests with valid token bypass Origin validation.
 * When disabled (no env var), this always returns false.
 */
export function validateToken(req: Request): boolean {
  const expectedToken = process.env.GNO_API_TOKEN;
  // Token auth disabled if env var not set
  if (!expectedToken) {
    return false;
  }

  const token = req.headers.get('X-GNO-Token');
  return token === expectedToken;
}

/**
 * Check if request is allowed (CSRF protection).
 * GET/HEAD/OPTIONS are always allowed (safe methods).
 * POST/PUT/DELETE require either:
 * - Valid Origin header (localhost/127.0.0.1 on same port), OR
 * - No Origin header (same-origin browser or non-browser client), OR
 * - Valid X-GNO-Token header (if GNO_API_TOKEN env is set)
 */
export function isRequestAllowed(req: Request, port: number): boolean {
  const method = req.method.toUpperCase();

  // Safe methods - no CSRF protection needed
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  // Unsafe methods - require valid Origin or token
  return validateToken(req) || validateOrigin(req, port);
}

/**
 * Create 403 Forbidden response for CSRF violations.
 * Uses same error envelope as other API errors for consistency.
 */
export function forbiddenResponse(): Response {
  return Response.json(
    { error: { code: 'CSRF_VIOLATION', message: 'Forbidden' } },
    { status: 403 }
  );
}
