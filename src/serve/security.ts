/**
 * CSRF protection and security utilities for the API server.
 *
 * @module src/serve/security
 */

/**
 * Validate Origin header for CSRF protection.
 * Same-origin requests (no Origin header) are allowed.
 * Cross-origin requests must originate from localhost.
 */
export function validateOrigin(req: Request, port: number): boolean {
  const origin = req.headers.get('Origin');
  // Same-origin requests (browser fetch, curl) have no Origin header
  if (!origin) {
    return true;
  }

  const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return allowed.includes(origin);
}

/**
 * Validate API token for non-browser clients (e.g., Raycast).
 * Token is optional - if GNO_API_TOKEN env var is set, it enables token auth.
 * Requests with valid token bypass Origin check.
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
 * GET/HEAD are always allowed. POST/PUT/DELETE require valid Origin or token.
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
 */
export function forbiddenResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'Forbidden', code: 'CSRF_VIOLATION' }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
