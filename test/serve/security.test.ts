/**
 * Tests for CSRF protection and security utilities.
 */

import { describe, expect, test } from 'bun:test';
import {
  forbiddenResponse,
  isRequestAllowed,
  validateOrigin,
  validateToken,
} from '../../src/serve/security';

describe('validateOrigin', () => {
  const port = 3000;

  test('allows requests without Origin header (same-origin/curl)', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
    });
    expect(validateOrigin(req, port)).toBe(true);
  });

  test('allows localhost origin', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(validateOrigin(req, port)).toBe(true);
  });

  test('allows 127.0.0.1 origin', () => {
    const req = new Request('http://127.0.0.1:3000/api/test', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    expect(validateOrigin(req, port)).toBe(true);
  });

  test('rejects cross-origin requests', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      headers: { Origin: 'http://evil.com' },
    });
    expect(validateOrigin(req, port)).toBe(false);
  });

  test('rejects origin with wrong port', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      headers: { Origin: 'http://localhost:4000' },
    });
    expect(validateOrigin(req, port)).toBe(false);
  });

  test('rejects cross-origin for port 0 (ephemeral)', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    // Port 0 means ephemeral - we can't know actual port, so reject cross-origin
    expect(validateOrigin(req, 0)).toBe(false);
  });

  test('allows no-origin for port 0', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
    });
    // No Origin header is always allowed (same-origin/curl)
    expect(validateOrigin(req, 0)).toBe(true);
  });
});

describe('validateToken', () => {
  const originalEnv = process.env.GNO_API_TOKEN;

  test('returns false when token env not set', () => {
    process.env.GNO_API_TOKEN = '';
    const req = new Request('http://localhost:3000/api/test', {
      headers: { 'X-GNO-Token': 'some-token' },
    });
    expect(validateToken(req)).toBe(false);
    process.env.GNO_API_TOKEN = originalEnv;
  });

  test('returns false when token header missing', () => {
    process.env.GNO_API_TOKEN = 'secret-token';
    const req = new Request('http://localhost:3000/api/test');
    expect(validateToken(req)).toBe(false);
    process.env.GNO_API_TOKEN = originalEnv;
  });

  test('returns false when token mismatch', () => {
    process.env.GNO_API_TOKEN = 'secret-token';
    const req = new Request('http://localhost:3000/api/test', {
      headers: { 'X-GNO-Token': 'wrong-token' },
    });
    expect(validateToken(req)).toBe(false);
    process.env.GNO_API_TOKEN = originalEnv;
  });

  test('returns true when token matches', () => {
    process.env.GNO_API_TOKEN = 'secret-token';
    const req = new Request('http://localhost:3000/api/test', {
      headers: { 'X-GNO-Token': 'secret-token' },
    });
    expect(validateToken(req)).toBe(true);
    process.env.GNO_API_TOKEN = originalEnv;
  });
});

describe('isRequestAllowed', () => {
  const port = 3000;

  test('allows GET requests without checking CSRF', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'GET',
      headers: { Origin: 'http://evil.com' },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test('allows HEAD requests without checking CSRF', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'HEAD',
      headers: { Origin: 'http://evil.com' },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test('allows OPTIONS requests without checking CSRF', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.com' },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test('blocks POST from evil origin', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      headers: { Origin: 'http://evil.com' },
    });
    expect(isRequestAllowed(req, port)).toBe(false);
  });

  test('allows POST from localhost', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test('allows POST without Origin (curl/same-origin)', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'POST',
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test('blocks DELETE from evil origin', () => {
    const req = new Request('http://localhost:3000/api/test', {
      method: 'DELETE',
      headers: { Origin: 'http://evil.com' },
    });
    expect(isRequestAllowed(req, port)).toBe(false);
  });
});

describe('forbiddenResponse', () => {
  test('returns 403 status', () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
  });

  test('returns JSON error body with standard envelope', async () => {
    const response = forbiddenResponse();
    const body = await response.json();
    // Uses same error envelope as other API errors
    expect(body).toEqual({
      error: { code: 'CSRF_VIOLATION', message: 'Forbidden' },
    });
  });

  test('sets Content-Type header', () => {
    const response = forbiddenResponse();
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });
});
