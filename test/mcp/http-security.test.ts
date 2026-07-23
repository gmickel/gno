import { afterEach, describe, expect, mock, test } from "bun:test";
// node:fs/promises provides POSIX mode mutation and temp-directory cleanup for tests.
import { chmod, mkdtemp, rm } from "node:fs/promises";
// node:os tmpdir and node:path join have no Bun equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpMcpSecurity,
  resolveHttpGatewayConfig,
} from "../../src/mcp/http-security";

const MCP_URL = "http://127.0.0.1:3000/mcp";
const testDirs: string[] = [];

function peerServer(address = "127.0.0.1") {
  return {
    requestIP: () => ({ address, port: 50_000 }),
    timeout: () => undefined,
  };
}

function request(
  init: RequestInit = {},
  headers: Record<string, string> = {}
): Request {
  return new Request(MCP_URL, {
    ...init,
    headers: {
      host: "127.0.0.1:3000",
      ...headers,
    },
  });
}

async function tokenFixture(token = "a".repeat(64)): Promise<{
  dir: string;
  path: string;
  token: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "gno-http-security-"));
  testDirs.push(dir);
  const path = join(dir, "token");
  await Bun.write(path, `${token}\n`);
  await chmod(path, 0o600);
  return { dir, path, token };
}

afterEach(async () => {
  await Promise.all(
    testDirs.splice(0).map((dir) => rm(dir, { recursive: true }))
  );
});

describe("HTTP MCP startup policy", () => {
  test("defaults to literal IPv4 loopback and exact local allowlists", () => {
    const config = resolveHttpGatewayConfig(undefined);
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedHosts).toEqual(["127.0.0.1:3000", "localhost:3000"]);
    expect(config.allowedOrigins).toEqual([
      "http://127.0.0.1:3000",
      "http://localhost:3000",
    ]);
    expect(config.enableWrite).toBe(false);
  });

  test("fails closed for non-loopback or wildcard binding without every control", async () => {
    for (const host of ["0.0.0.0", "192.0.2.10", "::"]) {
      const security = new HttpMcpSecurity(resolveHttpGatewayConfig({ host }));
      expect(security.initialize()).rejects.toThrow(
        "requires tokenFile plus exact allowedHosts and allowedOrigins"
      );
    }
  });

  test("rejects wildcard Host or Origin allowlist entries", async () => {
    const fixture = await tokenFixture();
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        host: "0.0.0.0",
        tokenFile: fixture.path,
        allowedHosts: ["*.example.test"],
        allowedOrigins: ["https://client.example.test"],
      })
    );
    expect(security.initialize()).rejects.toThrow("exact Host values");
  });

  test("creates an explicitly configured token file with restrictive permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-http-token-create-"));
    testDirs.push(dir);
    const path = join(dir, "token");
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        host: "0.0.0.0",
        tokenFile: path,
        allowedHosts: ["gateway.example.test:3000"],
        allowedOrigins: ["https://client.example.test"],
      })
    );
    await security.initialize();
    const token = (await Bun.file(path).text()).trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32") {
      const { mode } = await import("node:fs/promises").then(({ lstat }) =>
        lstat(path)
      );
      expect(mode & 0o077).toBe(0);
    }
  });

  test("rejects a token file readable by group or other users", async () => {
    if (process.platform === "win32") return;
    const fixture = await tokenFixture();
    await chmod(fixture.path, 0o644);
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        host: "0.0.0.0",
        tokenFile: fixture.path,
        allowedHosts: ["gateway.example.test:3000"],
        allowedOrigins: ["https://client.example.test"],
      })
    );
    expect(security.initialize()).rejects.toThrow("0600 or stricter");
  });
});

describe("HTTP MCP request boundary", () => {
  test("uses Bun requestIP and rejects a chunked body through a live route", async () => {
    let security: HttpMcpSecurity | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: {
        "/mcp": async (incoming, bunServer) => {
          const result = await security?.authorize(incoming, bunServer);
          if (!result) return new Response("not ready", { status: 503 });
          return result.ok ? new Response("ok") : result.response;
        },
      },
    });
    try {
      security = new HttpMcpSecurity(
        resolveHttpGatewayConfig(
          { limits: { maxBodyBytes: 8 } },
          { port: server.port }
        )
      );
      await security.initialize();

      const allowed = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        headers: { host: `127.0.0.1:${server.port}` },
      });
      expect(allowed.status).toBe(200);

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"long":"'));
          controller.enqueue(new TextEncoder().encode('payload"}'));
          controller.close();
        },
      });
      const oversized = await fetch(
        new Request(`http://127.0.0.1:${server.port}/mcp`, {
          method: "POST",
          headers: {
            host: `127.0.0.1:${server.port}`,
            "content-type": "application/json",
          },
          body,
        })
      );
      expect(oversized.status).toBe(413);
    } finally {
      await server.stop(true);
    }
  });

  test("uses the actual peer and ignores spoofed forwarding headers", async () => {
    const security = new HttpMcpSecurity(resolveHttpGatewayConfig(undefined));
    await security.initialize();
    const spoofed = request(
      {},
      {
        forwarded: "for=127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
      }
    );
    const result = await security.authorize(spoofed, peerServer("203.0.113.9"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  test("enforces exact Host and Origin on every method", async () => {
    const security = new HttpMcpSecurity(resolveHttpGatewayConfig(undefined));
    await security.initialize();
    for (const method of ["GET", "POST", "DELETE", "PUT"]) {
      const badHost = await security.authorize(
        request({ method }, { host: "attacker.example" }),
        peerServer()
      );
      expect(badHost.ok).toBe(false);
      if (!badHost.ok) expect(badHost.response.status).toBe(403);

      const badOrigin = await security.authorize(
        request({ method }, { origin: "https://attacker.example" }),
        peerServer()
      );
      expect(badOrigin.ok).toBe(false);
      if (!badOrigin.ok) expect(badOrigin.response.status).toBe(403);
    }
  });

  test("requires a valid bearer token off loopback without echoing credentials", async () => {
    const fixture = await tokenFixture();
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        host: "0.0.0.0",
        tokenFile: fixture.path,
        allowedHosts: ["gateway.example.test:3000"],
        allowedOrigins: ["https://client.example.test"],
      })
    );
    await security.initialize();

    const missing = await security.authorize(
      request({}, { host: "gateway.example.test:3000" }),
      peerServer("192.0.2.20")
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(401);
      expect(await missing.response.text()).not.toContain(fixture.token);
    }

    const allowed = await security.authorize(
      request(
        {},
        {
          authorization: `Bearer ${fixture.token}`,
          host: "gateway.example.test:3000",
          "x-forwarded-for": "203.0.113.7",
        }
      ),
      peerServer("192.0.2.20")
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.value.request.headers.has("authorization")).toBe(false);
      expect(allowed.value.request.headers.has("x-forwarded-for")).toBe(false);
    }
  });

  test("rejects declared and chunked oversized bodies before dispatch", async () => {
    const config = resolveHttpGatewayConfig({
      limits: { maxBodyBytes: 8 },
    });
    const security = new HttpMcpSecurity(config);
    await security.initialize();

    const declared = await security.authorize(
      request(
        { method: "POST", body: "{}" },
        { "content-length": "9", "content-type": "application/json" }
      ),
      peerServer()
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
    const chunked = await security.authorize(
      request(
        { method: "POST", body: stream },
        { "content-type": "application/json" }
      ),
      peerServer()
    );
    expect(chunked.ok).toBe(false);
    if (!chunked.ok) expect(chunked.response.status).toBe(413);
  });

  test("bounds request rate per actual peer", async () => {
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({ limits: { maxRequestsPerMinute: 1 } })
    );
    await security.initialize();
    expect((await security.authorize(request(), peerServer())).ok).toBe(true);
    const limited = await security.authorize(request(), peerServer());
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.response.status).toBe(429);
  });

  test("rotation and revocation trigger session invalidation", async () => {
    const fixture = await tokenFixture();
    const invalidate = mock(async () => undefined);
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        host: "0.0.0.0",
        tokenFile: fixture.path,
        allowedHosts: ["gateway.example.test:3000"],
        allowedOrigins: ["https://client.example.test"],
      }),
      { onCredentialsChanged: invalidate }
    );
    await security.initialize();

    const nextToken = "b".repeat(64);
    await Bun.write(fixture.path, `${nextToken}\n`);
    await chmod(fixture.path, 0o600);
    const rotated = await security.authorize(
      request(
        {},
        {
          authorization: `Bearer ${nextToken}`,
          host: "gateway.example.test:3000",
        }
      ),
      peerServer("192.0.2.20")
    );
    expect(rotated.ok).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);

    await rm(fixture.path);
    const revoked = await security.authorize(
      request(
        {},
        {
          authorization: `Bearer ${nextToken}`,
          host: "gateway.example.test:3000",
        }
      ),
      peerServer("192.0.2.20")
    );
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.response.status).toBe(503);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
