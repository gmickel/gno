import { describe, expect, test } from "bun:test";

import type { Collection } from "../../src/config/types";

import {
  scanNetworkBoundarySource,
  scanShippedNetworkBoundaries,
} from "../../scripts/network-boundary-scan";
import { createDefaultConfig } from "../../src/config/defaults";
import { EgressDeniedError } from "../../src/core/egress-enforcement";
import { NETWORK_BOUNDARY_INVENTORY } from "../../src/core/network-boundary-inventory";
import { requestHttpInference } from "../../src/llm/http-inference";
import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import {
  enforceHttpMcpEgress,
  httpMcpEgressDeniedResponse,
  MCP_HTTP_EGRESS_TOOLS,
} from "../../src/mcp/http-egress";
import { enforceSyncCommandEgress } from "../../src/mcp/sync-egress";

const collection = (
  name: string,
  egressPolicy: Collection["egressPolicy"]
): Collection => ({
  name,
  path: `/${name}`,
  pattern: "**/*",
  include: [],
  exclude: [],
  egressPolicy,
});

describe("network boundary enforcement inventory", () => {
  test("matches every shipped structural network callsite exactly", async () => {
    const actual = (await scanShippedNetworkBoundaries()).map(({ key }) => key);
    const expected = NETWORK_BOUNDARY_INVENTORY.filter(
      ({ primitive }) => primitive !== "logical"
    )
      .map(({ key }) => key)
      .sort();
    expect(actual).toEqual(expected);
  });

  test("detects qualified, bracketed, imported, and aliased evasions", () => {
    const callsites = scanNetworkBoundarySource(
      "src/evasion.tsx",
      `
        import { spawn as launch } from "node:child_process";
        import * as childProcess from "node:child_process";
        const request = globalThis["fetch"];
        const { serve: start } = Bun;
        const Socket = globalThis.WebSocket;
        const run = launch;
        request("/api");
        start({ fetch: () => new Response() });
        new Socket("ws://localhost");
        new EventSource("/events");
        run("helper");
        Bun["connect"]({});
        childProcess["execFile"]("helper");
        Bun["dns"]["lookup"]("internal");
      `
    );
    expect(callsites.map(({ primitive }) => primitive)).toEqual([
      "fetch",
      "bun_serve",
      "web_socket",
      "event_source",
      "child_process",
      "bun_connect",
      "child_process",
      "bun_dns_lookup",
    ]);
  });

  test("assigns a distinct key to a new call in an already registered file", () => {
    expect(
      scanNetworkBoundarySource(
        "src/existing.ts",
        `fetch("/one"); globalThis.fetch("/two");`
      ).map(({ key }) => key)
    ).toEqual(["src/existing.ts::fetch#1", "src/existing.ts::fetch#2"]);
  });

  test("ties browser client transports to an explicit server boundary", () => {
    const clients = NETWORK_BOUNDARY_INVENTORY.filter(
      ({ enforcement }) => enforcement === "client_transport"
    );
    expect(clients.length).toBeGreaterThan(0);
    expect(
      clients.every(
        (entry) => "serverBoundary" in entry && Boolean(entry.serverBoundary)
      )
    ).toBe(true);
  });

  test("requires every registered MCP tool to have an egress content class", async () => {
    const source = await Bun.file("src/mcp/tools/index.ts").text();
    const names = [...new Set(source.match(/"gno_[a-z0-9_]+"/gu) ?? [])].map(
      (name) => name.slice(1, -1)
    );
    expect(names.sort()).toEqual(Object.keys(MCP_HTTP_EGRESS_TOOLS).sort());
  });

  test("documents disabled remote/private paths explicitly", () => {
    const disabled = NETWORK_BOUNDARY_INVENTORY.filter(
      ({ enforcement }) => enforcement === "disabled"
    );
    expect(disabled.map(({ id }) => id).sort()).toEqual([
      "private-agent-access",
      "remote-publish-upload",
    ]);
    expect(disabled.every(({ action }) => action === null)).toBe(true);
  });
});

describe("network boundary policy enforcement", () => {
  test("intersects MCP peer zone authentication and collection policy per request", () => {
    const payload = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "gno_get",
        arguments: { ref: "gno://notes/private.md" },
      },
    };
    const policies = ["local_only", "lan", "remote"] as const;
    const zones = ["loopback", "lan", "remote"] as const;
    for (const policy of policies) {
      for (const destinationZone of zones) {
        for (const authenticated of [false, true]) {
          const expected =
            destinationZone === "loopback" ||
            (authenticated &&
              (policy === "remote" ||
                (policy === "lan" && destinationZone === "lan")));
          const invoke = () =>
            enforceHttpMcpEgress(payload, [collection("notes", policy)], {
              authenticated,
              destinationZone,
              operationAuthorized: true,
            });
          if (expected) expect(invoke).not.toThrow();
          else expect(invoke).toThrow(EgressDeniedError);
        }
      }
    }
  });

  test("gates resource list and read using the current request zone", () => {
    const collections = [collection("notes", "lan")];
    expect(() =>
      enforceHttpMcpEgress(
        {
          method: "resources/read",
          params: { uri: "gno://notes/private.md" },
        },
        collections,
        {
          authenticated: true,
          destinationZone: "lan",
          operationAuthorized: true,
        }
      )
    ).not.toThrow();
    expect(() =>
      enforceHttpMcpEgress({ method: "resources/list" }, collections, {
        authenticated: true,
        destinationZone: "remote",
        operationAuthorized: true,
      })
    ).toThrow(EgressDeniedError);
  });

  test("scopes remote audits to the requested collection array", () => {
    const collections = [
      collection("public", "remote"),
      collection("private", "local_only"),
    ];
    const request = (requested: string[]) => ({
      method: "tools/call",
      params: {
        name: "gno_audit",
        arguments: { collections: requested },
      },
    });
    const context = {
      authenticated: true,
      destinationZone: "remote" as const,
      operationAuthorized: true,
    };

    expect(() =>
      enforceHttpMcpEgress(request([" Public "]), collections, context)
    ).not.toThrow();
    expect(() =>
      enforceHttpMcpEgress(request(["private"]), collections, context)
    ).toThrow(EgressDeniedError);
  });

  test("attributes a batch denial to the exact denied member", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "gno://notes/private.md" },
      },
    ];
    let denied: EgressDeniedError | undefined;
    try {
      enforceHttpMcpEgress(batch, [collection("notes", "local_only")], {
        authenticated: true,
        destinationZone: "remote",
        operationAuthorized: true,
      });
    } catch (error) {
      if (error instanceof EgressDeniedError) denied = error;
    }
    expect(denied).toBeDefined();
    if (!denied) throw new Error("Expected egress denial");
    const response = httpMcpEgressDeniedResponse(denied, batch);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { data: { code: "EGRESS_DENIED" } },
      id: 2,
    });
    expect(JSON.stringify(body)).not.toContain("private.md");
  });

  test("denies unscoped remote inference before DNS or request bytes", async () => {
    let resolverCalls = 0;
    let fetchCalls = 0;
    let denied: unknown;
    try {
      await requestHttpInference(
        "https://provider.example/v1/chat/completions",
        { method: "POST", body: "secret-body" },
        {
          collections: [],
          collectionNames: [],
          env: {},
          resolver: {
            lookup: async () => {
              resolverCalls += 1;
              return ["93.184.216.34"];
            },
          },
          fetchFn: async () => {
            fetchCalls += 1;
            return new Response("{}");
          },
        }
      );
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(EgressDeniedError);
    expect(resolverCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("supports policy-matched LAN inference through a DNS-pinned hostname", async () => {
    let resolverCalls = 0;
    let requestUrl = "";
    const response = await requestHttpInference(
      "http://model.internal:8080/v1/embeddings",
      { method: "POST", body: "bounded-input" },
      {
        collections: [collection("notes", "lan")],
        collectionNames: ["notes"],
        env: {},
        resolver: {
          lookup: async () => {
            resolverCalls += 1;
            return ["192.168.1.20"];
          },
        },
        fetchFn: async (input) => {
          requestUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          return new Response('{"ok":true}');
        },
      }
    );
    expect(response.ok).toBe(true);
    expect(resolverCalls).toBe(3);
    expect(requestUrl).toStartWith("http://192.168.1.20:8080/");
  });

  test("denies mixed, public, and special-use DNS answers before inference fetch", async () => {
    for (const addresses of [
      ["192.168.1.20", "93.184.216.34"],
      ["93.184.216.34"],
      ["169.254.169.254"],
    ]) {
      let resolverCalls = 0;
      let fetchCalls = 0;
      let denied: unknown;
      try {
        await requestHttpInference(
          "http://model.internal:8080/v1/embeddings",
          { method: "POST", body: "private-content" },
          {
            collections: [collection("notes", "lan")],
            collectionNames: ["notes"],
            env: {},
            resolver: {
              lookup: async () => {
                resolverCalls += 1;
                return addresses;
              },
            },
            fetchFn: async () => {
              fetchCalls += 1;
              return new Response("{}");
            },
          }
        );
      } catch (error) {
        denied = error;
      }
      expect(denied).toBeInstanceOf(EgressDeniedError);
      expect(resolverCalls).toBe(1);
      expect(fetchCalls).toBe(0);
    }
  });

  test("pins remote inference and refuses cross-origin credential/body forwarding", async () => {
    let fetchCalls = 0;
    const options = {
      collections: [collection("notes", "remote")],
      collectionNames: ["notes"],
      env: {},
      resolver: {
        lookup: async () => ["93.184.216.34"],
      },
      fetchFn: async () => {
        fetchCalls += 1;
        return new Response(null, {
          status: 307,
          headers: { location: "https://other.example/steal" },
        });
      },
    };
    let denied: unknown;
    try {
      await requestHttpInference(
        "https://provider.example/v1/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer hidden" },
          body: "private-content",
        },
        options
      );
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(EgressDeniedError);
    expect(fetchCalls).toBe(1);
  });

  test("uses only explicit participating collections for mixed-policy inference", async () => {
    const collections = [
      collection("approved", "remote"),
      collection("private", "local_only"),
    ];
    let allowedFetches = 0;
    const allowed = await requestHttpInference(
      "https://provider.example/v1/embeddings",
      { method: "POST", body: "approved-content" },
      {
        collections,
        collectionNames: ["approved"],
        env: {},
        resolver: { lookup: async () => ["93.184.216.34"] },
        fetchFn: async () => {
          allowedFetches += 1;
          return new Response("{}");
        },
      }
    );
    expect(allowed.ok).toBe(true);
    expect(allowedFetches).toBe(1);

    let deniedFetches = 0;
    let denied: unknown;
    try {
      await requestHttpInference(
        "https://provider.example/v1/embeddings",
        { method: "POST", body: "mixed-content" },
        {
          collections,
          collectionNames: ["approved", "private"],
          env: {},
          resolver: { lookup: async () => ["93.184.216.34"] },
          fetchFn: async () => {
            deniedFetches += 1;
            return new Response("{}");
          },
        }
      );
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(EgressDeniedError);
    expect(deniedFetches).toBe(0);
  });

  test("requires the adapter caller to choose selected or corpus-wide scope", async () => {
    const collections = [
      collection("approved", "remote"),
      collection("private", "local_only"),
    ];
    const adapter = new LlmAdapter({
      ...createDefaultConfig(),
      collections,
    });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ data: [{ embedding: [0.1, 0.2] }] });
    }) as unknown as typeof fetch;
    try {
      const selected = await adapter.createEmbeddingPort(
        "https://93.184.216.34/v1/embeddings#test",
        {
          egressCollections: ["approved"],
          policy: { offline: true, allowDownload: false },
        }
      );
      expect(selected.ok).toBe(true);
      expect(fetchCalls).toBe(1);
      if (selected.ok) await selected.value.dispose();

      const corpusWide = await adapter.createEmbeddingPort(
        "https://93.184.216.34/v1/embeddings#test",
        {
          egressCollections: "all",
          policy: { offline: true, allowDownload: false },
        }
      );
      expect(corpusWide).toMatchObject({
        ok: false,
        error: { code: "EGRESS_DENIED" },
      });
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      await adapter.dispose();
    }
  });

  test("fails closed on DNS rebinding before inference bytes are sent", async () => {
    let resolverCalls = 0;
    let fetchCalls = 0;
    let denied: unknown;
    try {
      await requestHttpInference(
        "https://provider.example/v1/embeddings",
        { method: "POST", body: "private-content" },
        {
          collections: [collection("notes", "remote")],
          collectionNames: ["notes"],
          env: {},
          resolver: {
            lookup: async () => {
              resolverCalls += 1;
              return resolverCalls < 3 ? ["93.184.216.34"] : ["93.184.216.35"];
            },
          },
          fetchFn: async () => {
            fetchCalls += 1;
            return new Response("{}");
          },
        }
      );
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(EgressDeniedError);
    expect(resolverCalls).toBe(3);
    expect(fetchCalls).toBe(0);
  });

  test("requires policy in addition to MCP write authorization for sync commands", () => {
    const ctx = {
      collections: [collection("notes", "local_only")],
      enableWrite: true,
    };
    expect(() =>
      enforceSyncCommandEgress(ctx as never, {
        collectionNames: ["notes"],
        gitPull: true,
      })
    ).toThrow(EgressDeniedError);
  });
});
