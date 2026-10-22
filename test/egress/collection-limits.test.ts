import { describe, expect, test } from "bun:test";

import type { Collection } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/context";

import {
  EgressDeniedError,
  enforceCollectionEgress,
} from "../../src/core/egress-enforcement";
import { resolveEgressLineage } from "../../src/core/egress-provenance";
import {
  enforceHttpMcpEgress,
  httpMcpEgressDeniedResponse,
} from "../../src/mcp/http-egress";
import { enforceSyncCommandEgress } from "../../src/mcp/sync-egress";

const collections = (count: number): Collection[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `c${index}`,
    path: `/c${index}`,
    pattern: "**/*",
    include: [],
    exclude: [],
    egressPolicy: "remote",
  }));

const context = {
  authenticated: true,
  destinationZone: "remote" as const,
  operationAuthorized: true,
};

const search = (args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "gno_search", arguments: { query: "x", ...args } },
});

/** The denial a call gets, or null when it is allowed; anything else fails. */
const denial = (run: () => unknown): EgressDeniedError | null => {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EgressDeniedError) return error;
    throw error;
  }
};

describe("egress collection limits", () => {
  test("HTTP MCP judges a scoped call on its scope at every configuration size", () => {
    for (const size of [64, 65, 128, 129, 300]) {
      const configured = collections(size);
      expect(
        denial(() =>
          enforceHttpMcpEgress(
            search({ collection: "c3" }),
            configured,
            context
          )
        )
      ).toBeNull();
      expect(
        denial(() =>
          enforceHttpMcpEgress(
            search({ collections: ["c1", "c2"] }),
            configured,
            context
          )
        )
      ).toBeNull();
    }
  });

  test("HTTP MCP denies an unscoped call over the bound with COLLECTION_LIMIT_EXCEEDED", () => {
    expect(
      denial(() => enforceHttpMcpEgress(search({}), collections(64), context))
    ).toBeNull();
    for (const size of [65, 128, 129, 300]) {
      const denied = denial(() =>
        enforceHttpMcpEgress(search({}), collections(size), context)
      );
      expect(denied?.decision.reason).toBe("COLLECTION_LIMIT_EXCEEDED");
    }
  });

  test("HTTP MCP denies a scoped call naming more than 64 collections at any size", () => {
    for (const size of [65, 128, 129, 300]) {
      const named = collections(size)
        .slice(0, 65)
        .map(({ name }) => name);
      const denied = denial(() =>
        enforceHttpMcpEgress(
          search({ collections: named }),
          collections(size),
          context
        )
      );
      expect(denied?.decision.reason).toBe("COLLECTION_LIMIT_EXCEEDED");
    }
  });

  test("the over-bound HTTP MCP denial is a redacted 403", async () => {
    const payload = search({});
    const denied = denial(() =>
      enforceHttpMcpEgress(payload, collections(129), context)
    );
    if (!denied) throw new Error("Expected an egress denial");
    const response = httpMcpEgressDeniedResponse(denied, payload);
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).toContain("COLLECTION_LIMIT_EXCEEDED");
    expect(text).not.toContain('"c1');
    expect(JSON.parse(text)).toMatchObject({
      error: { data: { code: "EGRESS_DENIED" } },
      id: 1,
    });
  });

  test("daemon status and other unscoped boundaries deny instead of failing", () => {
    for (const size of [129, 300]) {
      const denied = denial(() =>
        enforceCollectionEgress({
          collections: collections(size),
          action: "serve",
          destinationZone: "remote",
          caller: { authenticated: true, operationAuthorized: true },
          contentClass: "metadata",
        })
      );
      expect(denied?.decision.reason).toBe("COLLECTION_LIMIT_EXCEEDED");
    }
  });

  test("sync tools evaluate a named collection and deny an unscoped pull over the bound", () => {
    const ctx = {
      collections: collections(129),
      enableWrite: true,
    } as unknown as ToolContext;
    expect(
      denial(() =>
        enforceSyncCommandEgress(ctx, {
          collectionNames: ["c7"],
          gitPull: true,
        })
      )
    ).toBeNull();
    const denied = denial(() =>
      enforceSyncCommandEgress(ctx, { gitPull: true })
    );
    expect(denied?.decision.reason).toBe("COLLECTION_LIMIT_EXCEEDED");
  });

  test("lineage resolves a named scope out of a large configuration", () => {
    const inputs = collections(300).map(({ name }) => ({
      collection: name,
      policy: "remote" as const,
      source: "explicit" as const,
    }));
    const lineage = resolveEgressLineage(inputs, ["c200", "c5"]);
    expect(lineage.sources.map(({ collection }) => collection)).toEqual([
      "c200",
      "c5",
    ]);
  });
});
