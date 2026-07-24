import { describe, expect, test } from "bun:test";

import type { HttpMcpPeerServer } from "../../src/mcp/http-security";

import {
  ClipperRequestGate,
  ClipperSecurityBoundary,
  isClipperLoopbackAddress,
  parseClipperExtensionOrigin,
  readClipperBoundedJson,
  withClipperCors,
} from "../../src/serve/clipper-security";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const HOST = "127.0.0.1:3210";
const SAME_ORIGIN = `http://${HOST}`;

function peerServer(address = "127.0.0.1"): HttpMcpPeerServer {
  return {
    requestIP: () => ({ address, port: 50_000 }),
    timeout: () => undefined,
  };
}

function request(
  method: string,
  origin: string | null,
  options: { body?: BodyInit; headers?: HeadersInit; host?: string } = {}
): Request {
  const headers = new Headers(options.headers);
  headers.set("host", options.host ?? HOST);
  if (origin) headers.set("origin", origin);
  return new Request(`${SAME_ORIGIN}/api/clipper`, {
    method,
    headers,
    body: options.body,
  });
}

function boundary(
  limits: {
    maxBodyBytes?: number;
    maxConcurrentRequests?: number;
    maxQueuedRequests?: number;
    maxRequestsPerMinute?: number;
  } = {},
  now?: () => number
): ClipperSecurityBoundary {
  return new ClipperSecurityBoundary(
    {
      allowedHosts: [HOST, "localhost:3210"],
      sameOrigins: [SAME_ORIGIN, "http://localhost:3210"],
      limits,
    },
    { now }
  );
}

describe("clipper loopback boundary", () => {
  test("rejects wildcard and non-loopback boundary configuration", () => {
    for (const config of [
      { allowedHosts: ["*.example"], sameOrigins: [SAME_ORIGIN] },
      {
        allowedHosts: ["attacker.example:3210"],
        sameOrigins: [SAME_ORIGIN],
      },
      {
        allowedHosts: [HOST],
        sameOrigins: ["http://attacker.example:3210"],
      },
    ]) {
      expect(() => new ClipperSecurityBoundary(config)).toThrow();
    }
  });

  test("recognizes IPv4, IPv6, and mapped loopback without trusting forwarding headers", async () => {
    for (const address of [
      "127.0.0.1",
      "127.99.2.3",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isClipperLoopbackAddress(address)).toBe(true);
    }
    for (const address of [
      "126.255.255.255",
      "128.0.0.1",
      "192.0.2.1",
      "::2",
    ]) {
      expect(isClipperLoopbackAddress(address)).toBe(false);
    }

    const security = boundary();
    const spoofed = request("GET", EXTENSION_ORIGIN, {
      headers: {
        forwarded: "for=127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
      },
    });
    const denied = await security.admit(spoofed, peerServer("203.0.113.8"), {
      origin: { kind: "extension" },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
  });

  test("requires exact Host and a required origin for every admission mode", async () => {
    const security = boundary();
    for (const [candidate, policy] of [
      [
        request("GET", EXTENSION_ORIGIN, { host: "attacker.example" }),
        { origin: { kind: "extension" } },
      ],
      [
        request("POST", null, { body: "{}" }),
        { origin: { kind: "same-origin" }, readJson: true },
      ],
      [
        request("POST", "https://evil.example", { body: "{}" }),
        { origin: { kind: "same-origin" }, readJson: true },
      ],
    ] as const) {
      const result = await security.admit(candidate, peerServer(), policy);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }

    const allowed = await security.admit(
      request("POST", SAME_ORIGIN, { body: "{}" }),
      peerServer(),
      { origin: { kind: "same-origin" }, readJson: true }
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.value.body).toEqual({});
      allowed.value.release();
    }
  });

  test("allows an originless same-origin safe GET only when explicitly enabled", async () => {
    const security = boundary();
    const browserGet = request("GET", null, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    const allowed = await security.admit(browserGet, peerServer(), {
      origin: { allowOriginlessSafeGet: true, kind: "same-origin" },
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.value.origin).toBe(SAME_ORIGIN);
      allowed.value.release();
    }

    for (const candidate of [
      request("GET", null, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      request("POST", null, {
        body: "{}",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      request("GET", null, {
        headers: { "sec-fetch-site": "same-origin" },
        host: "attacker.example",
      }),
    ]) {
      const denied = await security.admit(candidate, peerServer(), {
        origin: { allowOriginlessSafeGet: true, kind: "same-origin" },
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.response.status).toBe(403);
    }
  });

  test("accepts only an exact Chromium extension origin and enforces origin binding", async () => {
    expect(parseClipperExtensionOrigin(EXTENSION_ORIGIN)).toEqual({
      extensionId: EXTENSION_ID,
      origin: EXTENSION_ORIGIN,
    });
    for (const malformed of [
      "chrome-extension://abcdefghijklmnop",
      `${EXTENSION_ORIGIN}/path`,
      `${EXTENSION_ORIGIN}?query=yes`,
      "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
      "moz-extension://abcdefghijklmnopabcdefghijklmnop",
    ]) {
      expect(parseClipperExtensionOrigin(malformed)).toBeNull();
    }

    const security = boundary();
    const allowed = await security.admit(
      request("GET", EXTENSION_ORIGIN),
      peerServer(),
      { origin: { kind: "extension", expectedOrigin: EXTENSION_ORIGIN } }
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.value.extensionId).toBe(EXTENSION_ID);
      allowed.value.release();
    }

    const otherOrigin = `chrome-extension://${"p".repeat(32)}`;
    const denied = await security.admit(
      request("GET", otherOrigin),
      peerServer(),
      { origin: { kind: "extension", expectedOrigin: EXTENSION_ORIGIN } }
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
  });
});

describe("clipper CORS and Private Network Access", () => {
  test("answers exact extension preflights with bounded CORS and PNA policy", () => {
    const security = boundary();
    const preflight = request("OPTIONS", EXTENSION_ORIGIN, {
      headers: {
        "access-control-request-headers":
          "content-type, authorization, idempotency-key",
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    });
    const response = security.handlePreflight(preflight, peerServer(), {
      origin: { kind: "extension", expectedOrigin: EXTENSION_ORIGIN },
      methods: ["POST"],
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      EXTENSION_ORIGIN
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, authorization, idempotency-key"
    );
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true"
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("vary")).toContain("Origin");
  });

  test("rejects hostile, absent, malformed, or over-broad preflights", () => {
    const security = boundary();
    const cases = [
      request("OPTIONS", null, {
        headers: { "access-control-request-method": "POST" },
      }),
      request("OPTIONS", "https://evil.example", {
        headers: { "access-control-request-method": "POST" },
      }),
      request("OPTIONS", EXTENSION_ORIGIN, {
        headers: { "access-control-request-method": "DELETE" },
      }),
      request("OPTIONS", EXTENSION_ORIGIN, {
        headers: {
          "access-control-request-headers": "x-admin",
          "access-control-request-method": "POST",
        },
      }),
      request("OPTIONS", EXTENSION_ORIGIN, {
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-private-network": "false",
        },
      }),
    ];
    for (const candidate of cases) {
      const response = security.handlePreflight(candidate, peerServer(), {
        origin: { kind: "extension", expectedOrigin: EXTENSION_ORIGIN },
        methods: ["POST"],
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("adds an exact CORS origin to an authorized response", async () => {
    const response = withClipperCors(
      Response.json({ paired: true }),
      EXTENSION_ORIGIN
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(
      EXTENSION_ORIGIN
    );
    expect(response.headers.get("vary")).toContain("Origin");
    expect(await response.json()).toEqual({ paired: true });
  });
});

describe("clipper body, rate, and concurrency bounds", () => {
  test("rejects declared, streamed, malformed, and invalid-UTF8 JSON bodies", async () => {
    const declared = await readClipperBoundedJson(
      request("POST", EXTENSION_ORIGIN, {
        body: "{}",
        headers: { "content-length": "9" },
      }),
      8
    );
    expect(declared.ok).toBe(false);
    if (!declared.ok) expect(declared.response.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"long":"'));
        controller.enqueue(new TextEncoder().encode('payload"}'));
        controller.close();
      },
    });
    const streamed = await readClipperBoundedJson(
      request("POST", EXTENSION_ORIGIN, { body: stream }),
      8
    );
    expect(streamed.ok).toBe(false);
    if (!streamed.ok) expect(streamed.response.status).toBe(413);

    for (const body of ["{", new Uint8Array([0xff])]) {
      const malformed = await readClipperBoundedJson(
        request("POST", EXTENSION_ORIGIN, { body }),
        8
      );
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.response.status).toBe(400);
    }
  });

  test("rate-limits by actual peer and resets at the fixed window", async () => {
    let now = 1_000;
    const security = boundary({ maxRequestsPerMinute: 1 }, () => now);
    const first = await security.admit(
      request("GET", EXTENSION_ORIGIN),
      peerServer(),
      { origin: { kind: "extension" } }
    );
    expect(first.ok).toBe(true);
    if (first.ok) first.value.release();

    const limited = await security.admit(
      request("GET", EXTENSION_ORIGIN),
      peerServer(),
      { origin: { kind: "extension" } }
    );
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.response.status).toBe(429);
      expect(limited.response.headers.get("access-control-allow-origin")).toBe(
        EXTENSION_ORIGIN
      );
    }

    now += 60_000;
    const reset = await security.admit(
      request("GET", EXTENSION_ORIGIN),
      peerServer(),
      { origin: { kind: "extension" } }
    );
    expect(reset.ok).toBe(true);
    if (reset.ok) reset.value.release();
  });

  test("keeps admitted extension body failures CORS-readable", async () => {
    const security = boundary({ maxBodyBytes: 4 });
    const admitted = await security.admit(
      request("POST", EXTENSION_ORIGIN, {
        body: '{"too":"large"}',
      }),
      peerServer(),
      { origin: { kind: "extension" }, readJson: true }
    );
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) {
      expect(admitted.response.status).toBe(413);
      expect(admitted.response.headers.get("access-control-allow-origin")).toBe(
        EXTENSION_ORIGIN
      );
    }
  });

  test("bounds active and queued work, then releases capacity exactly once", async () => {
    const gate = new ClipperRequestGate(1, 1);
    const releaseFirst = await gate.acquire();
    const queued = gate.acquire();
    await Promise.resolve();
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(1);
    expect(gate.acquire()).rejects.toThrow("queue is full");

    releaseFirst();
    releaseFirst();
    const releaseQueued = await queued;
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(0);
    releaseQueued();
    expect(gate.active).toBe(0);
  });

  test("removes aborted queued work without consuming capacity", async () => {
    const gate = new ClipperRequestGate(1, 1);
    const release = await gate.acquire();
    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(queued).rejects.toThrow("aborted");
    await queued.catch(() => undefined);
    expect(gate.queued).toBe(0);
    release();
    expect(gate.active).toBe(0);
  });
});
