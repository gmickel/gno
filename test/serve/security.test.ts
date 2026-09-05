/**
 * Tests for CSRF protection and security utilities.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { DocumentRow } from "../../src/store/types";

import { handleDocAsset } from "../../src/serve/routes/api";
import {
  forbiddenResponse,
  isRequestAllowed,
  validateOrigin,
  validateToken,
} from "../../src/serve/security";
import { getCspHeader, withSecurityHeaders } from "../../src/serve/server";
import { safeRm } from "../helpers/cleanup";

describe("validateOrigin", () => {
  const port = 3000;

  test("allows requests without Origin header (same-origin/curl)", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
    });
    expect(validateOrigin(req, port)).toBe(true);
  });

  test("allows localhost origin", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(validateOrigin(req, port)).toBe(true);
  });

  test("allows 127.0.0.1 origin", () => {
    const req = new Request("http://127.0.0.1:3000/api/test", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:3000" },
    });
    expect(validateOrigin(req, port)).toBe(true);
  });

  test("rejects cross-origin requests", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { Origin: "http://evil.com" },
    });
    expect(validateOrigin(req, port)).toBe(false);
  });

  test("rejects origin with wrong port", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { Origin: "http://localhost:4000" },
    });
    expect(validateOrigin(req, port)).toBe(false);
  });

  test("rejects cross-origin for port 0 (ephemeral)", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });
    // Port 0 means ephemeral - we can't know actual port, so reject cross-origin
    expect(validateOrigin(req, 0)).toBe(false);
  });

  test("allows no-origin for port 0", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
    });
    // No Origin header is always allowed (same-origin/curl)
    expect(validateOrigin(req, 0)).toBe(true);
  });
});

describe("validateToken", () => {
  const originalEnv = process.env.GNO_API_TOKEN;

  test("returns false when token env not set", () => {
    process.env.GNO_API_TOKEN = "";
    const req = new Request("http://localhost:3000/api/test", {
      headers: { "X-GNO-Token": "some-token" },
    });
    expect(validateToken(req)).toBe(false);
    if (originalEnv === undefined) {
      delete process.env.GNO_API_TOKEN;
    } else {
      process.env.GNO_API_TOKEN = originalEnv;
    }
  });

  test("returns false when token header missing", () => {
    process.env.GNO_API_TOKEN = "secret-token";
    const req = new Request("http://localhost:3000/api/test");
    expect(validateToken(req)).toBe(false);
    if (originalEnv === undefined) {
      delete process.env.GNO_API_TOKEN;
    } else {
      process.env.GNO_API_TOKEN = originalEnv;
    }
  });

  test("returns false when token mismatch", () => {
    process.env.GNO_API_TOKEN = "secret-token";
    const req = new Request("http://localhost:3000/api/test", {
      headers: { "X-GNO-Token": "wrong-token" },
    });
    expect(validateToken(req)).toBe(false);
    if (originalEnv === undefined) {
      delete process.env.GNO_API_TOKEN;
    } else {
      process.env.GNO_API_TOKEN = originalEnv;
    }
  });

  test("returns true when token matches", () => {
    process.env.GNO_API_TOKEN = "secret-token";
    const req = new Request("http://localhost:3000/api/test", {
      headers: { "X-GNO-Token": "secret-token" },
    });
    expect(validateToken(req)).toBe(true);
    if (originalEnv === undefined) {
      delete process.env.GNO_API_TOKEN;
    } else {
      process.env.GNO_API_TOKEN = originalEnv;
    }
  });
});

describe("isRequestAllowed", () => {
  const port = 3000;

  test("allows GET requests without checking CSRF", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "GET",
      headers: { Origin: "http://evil.com" },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test("allows HEAD requests without checking CSRF", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "HEAD",
      headers: { Origin: "http://evil.com" },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test("allows OPTIONS requests without checking CSRF", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "OPTIONS",
      headers: { Origin: "http://evil.com" },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test("blocks POST from evil origin", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { Origin: "http://evil.com" },
    });
    expect(isRequestAllowed(req, port)).toBe(false);
  });

  test("allows POST from localhost", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test("allows POST without Origin (curl/same-origin)", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "POST",
    });
    expect(isRequestAllowed(req, port)).toBe(true);
  });

  test("blocks DELETE from evil origin", () => {
    const req = new Request("http://localhost:3000/api/test", {
      method: "DELETE",
      headers: { Origin: "http://evil.com" },
    });
    expect(isRequestAllowed(req, port)).toBe(false);
  });
});

describe("forbiddenResponse", () => {
  test("returns 403 status", () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
  });

  test("returns JSON error body with standard envelope", async () => {
    const response = forbiddenResponse();
    const body = await response.json();
    // Uses same error envelope as other API errors
    expect(body).toEqual({
      error: { code: "CSRF_VIOLATION", message: "Forbidden" },
    });
  });

  test("sets Content-Type header", () => {
    const response = forbiddenResponse();
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("CSP and framing headers (fn-112)", () => {
  test("CSP includes worker-src 'self', frame-ancestors none, object-src none; no unsafe-eval", () => {
    for (const isDev of [true, false]) {
      const csp = getCspHeader(isDev);
      expect(csp).toContain("worker-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain("unsafe-eval");
    }
  });

  test("withSecurityHeaders sets X-Frame-Options DENY and CSP", () => {
    const res = withSecurityHeaders(new Response("ok"), false);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  describe("doc-asset responses keep framing + CSP envelope", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "gno-sec-asset-"));
    });

    afterEach(async () => {
      await safeRm(tmpDir);
    });

    test("doc-asset through withSecurityHeaders retains DENY + frame-ancestors", async () => {
      const notesDir = join(tmpDir, "notes");
      await mkdir(notesDir, { recursive: true });
      await writeFile(join(notesDir, "doc.md"), "# note");
      await writeFile(join(notesDir, "a.pdf"), "%PDF-1.4 fake");

      const doc: DocumentRow = {
        id: 1,
        collection: "reading",
        relPath: "notes/doc.md",
        sourceHash: "hash",
        sourceMime: "application/pdf",
        sourceExt: ".pdf",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        docid: "#doc",
        uri: "gno://reading/notes/doc.md",
        title: "doc",
        mirrorHash: "mirror",
        converterId: null,
        converterVersion: null,
        languageHint: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        active: true,
        ingestVersion: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const config: Config = {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [
          {
            name: "reading",
            path: tmpDir,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ],
        contexts: [],
      };

      const store = {
        getDocumentByUri(uri: string) {
          return Promise.resolve({
            ok: true as const,
            value: uri === doc.uri ? doc : null,
          });
        },
      };

      const raw = await handleDocAsset(
        store as never,
        config,
        new URL(
          `http://localhost/api/doc-asset?uri=${encodeURIComponent(doc.uri)}&path=a.pdf`
        )
      );
      const wrapped = withSecurityHeaders(raw, false);
      expect(wrapped.headers.get("X-Frame-Options")).toBe("DENY");
      const csp = wrapped.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("worker-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain("unsafe-eval");
    });
  });
});
