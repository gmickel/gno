import { describe, expect, test } from "bun:test";

import type { Collection, Config } from "../../src/config/types";

import { CollectionEgressPolicyService } from "../../src/core/collection-egress-policy-service";
import {
  collectionEgressStates,
  EgressDeniedError,
} from "../../src/core/egress-enforcement";
import { EGRESS_MAX_COLLECTIONS } from "../../src/core/egress-limits";
import { evaluateEgressPolicy } from "../../src/core/egress-policy";
import {
  EgressProvenanceError,
  resolveEgressLineage,
} from "../../src/core/egress-provenance";
import { enforceHttpMcpEgress } from "../../src/mcp/http-egress";

// One collection per access boundary: deployments routinely configure
// several hundred, and an unscoped request is checked against all of them.
const LARGE = 500;

const name = (index: number): string => `c${String(index).padStart(4, "0")}`;

const collections = (
  count: number,
  policyOf: (index: number) => Collection["egressPolicy"] = () => undefined
): Collection[] =>
  Array.from({ length: count }, (_, index) => ({
    name: name(index),
    path: `/corpus/${name(index)}`,
    pattern: "**/*.md",
    include: [],
    exclude: [],
    egressPolicy: policyOf(index),
  }));

const search = (args: Record<string, unknown> = { query: "quarterly" }) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "gno_search", arguments: args },
});

const loopback = {
  authenticated: true,
  destinationZone: "loopback",
  operationAuthorized: true,
} as const;

const deniedReason = (invoke: () => void): string | undefined => {
  try {
    invoke();
  } catch (error) {
    if (error instanceof EgressDeniedError) return error.decision.reason;
    throw error;
  }
  return undefined;
};

describe("collection egress limits", () => {
  test("one shared bound sized for hundreds of collections", () => {
    expect(EGRESS_MAX_COLLECTIONS).toBeGreaterThanOrEqual(LARGE);
  });

  test("decides over hundreds of collections and refuses one past the bound", () => {
    const states = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        collection: name(index),
        policy: "remote" as const,
        source: "explicit" as const,
      }));
    const request = {
      action: "serve",
      destination: { zone: "remote" },
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "snippet",
    } as const;

    const large = evaluateEgressPolicy({
      ...request,
      collections: states(LARGE),
    });
    expect(large.allowed).toBeTrue();
    expect(large.audit.collectionCount).toBe(LARGE);

    const atLimit = evaluateEgressPolicy({
      ...request,
      collections: states(EGRESS_MAX_COLLECTIONS),
    });
    expect(atLimit.allowed).toBeTrue();

    const over = evaluateEgressPolicy({
      ...request,
      collections: states(EGRESS_MAX_COLLECTIONS + 1),
    });
    expect(over).toMatchObject({
      allowed: false,
      reason: "COLLECTION_LIMIT_EXCEEDED",
      audit: { collectionCount: EGRESS_MAX_COLLECTIONS + 1, collections: [] },
    });
  });

  test("resolves a configured scope of hundreds of collections", () => {
    const configured = collections(LARGE);
    expect(collectionEgressStates(configured)).toHaveLength(LARGE);
    expect(
      collectionEgressStates(configured, [name(0), name(LARGE - 1)])
    ).toHaveLength(2);
    expect(() =>
      collectionEgressStates(collections(EGRESS_MAX_COLLECTIONS + 1))
    ).toThrow(EgressProvenanceError);

    const lineage = resolveEgressLineage(
      configured.map((collection) => ({
        collection: collection.name,
        policy: "local_only",
        source: "config_default",
      }))
    );
    expect(lineage.sources).toHaveLength(LARGE);
    expect(lineage.effectivePolicy).toBe("local_only");
  });

  test("HTTP MCP serves an unscoped call over hundreds of collections", () => {
    const configured = collections(LARGE);
    expect(
      deniedReason(() => enforceHttpMcpEgress(search(), configured, loopback))
    ).toBeUndefined();
    expect(
      deniedReason(() =>
        enforceHttpMcpEgress(
          search({ query: "quarterly", collection: name(LARGE - 1) }),
          configured,
          loopback
        )
      )
    ).toBeUndefined();
  });

  test("a large scope still fails closed on its most restrictive collection", () => {
    // Every collection remote except one local_only one at the end.
    const configured = collections(LARGE, (index) =>
      index === LARGE - 1 ? "local_only" : "remote"
    );
    const remote = { ...loopback, destinationZone: "remote" } as const;
    expect(
      deniedReason(() => enforceHttpMcpEgress(search(), configured, remote))
    ).toBe("POLICY_LOCAL_ONLY");
    expect(
      deniedReason(() =>
        enforceHttpMcpEgress(
          search({ query: "quarterly", collection: name(0) }),
          configured,
          remote
        )
      )
    ).toBeUndefined();
  });

  test("HTTP MCP refuses an oversized configuration as a policy denial", () => {
    const configured = collections(EGRESS_MAX_COLLECTIONS + 1);
    for (const payload of [
      search(),
      search({ query: "quarterly", collection: name(0) }),
      { jsonrpc: "2.0", id: 8, method: "resources/list" },
    ]) {
      expect(
        deniedReason(() => enforceHttpMcpEgress(payload, configured, loopback))
      ).toBe("COLLECTION_LIMIT_EXCEEDED");
    }
  });

  test("gno_egress_check accepts hundreds of collections, explicit or omitted", () => {
    const config = {
      collections: collections(LARGE, () => "remote"),
      contexts: [],
    } as unknown as Config;
    const service = new CollectionEgressPolicyService({
      getConfig: () => config,
      mutateConfig: async () => ({ ok: false, error: "read-only" }) as never,
      onPolicyChanged: () => {
        throw new Error("unexpected policy change");
      },
    });
    const request = {
      action: "serve",
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "snippet",
      destinationZone: "remote",
    };
    for (const scope of [
      {},
      { collections: Array.from({ length: LARGE }, (_, index) => name(index)) },
    ]) {
      const result = service.check({ ...request, ...scope });
      expect(result.ok).toBeTrue();
      if (!result.ok) throw new Error(result.error);
      expect(result.value.allowedCollections).toHaveLength(LARGE);
    }
    expect(
      service.check({
        ...request,
        collections: Array.from(
          { length: EGRESS_MAX_COLLECTIONS + 1 },
          (_, index) => name(index)
        ),
      })
    ).toMatchObject({ ok: false, code: "VALIDATION" });
  });
});
