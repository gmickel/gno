import { describe, expect, test } from "bun:test";

import type { Collection } from "../../src/config/types";
import type { EgressLineageInput } from "../../src/core/egress-provenance";
import type { SearchResult } from "../../src/pipeline/types";
import type { StorePort } from "../../src/store/types";

import {
  EgressDeniedError,
  planCollectionEgress,
} from "../../src/core/egress-enforcement";
import { EGRESS_MAX_COLLECTIONS } from "../../src/core/egress-limits";
import {
  createEgressLineage,
  EgressProvenanceError,
  resolveEgressLineage,
} from "../../src/core/egress-provenance";
import { attachSearchResultEgressLineage } from "../../src/pipeline/egress-lineage";

const sources = [
  { collection: "remote", policy: "remote", source: "explicit" },
  { collection: "local", policy: "local_only", source: "legacy_default" },
  { collection: "lan", policy: "lan", source: "explicit" },
] as const;

const makeCollection = (
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

const expectInvalidLineage = (run: () => unknown): void => {
  try {
    run();
    throw new Error("Expected invalid egress lineage");
  } catch (error) {
    expect(error).toBeInstanceOf(EgressProvenanceError);
    expect((error as EgressProvenanceError).code).toBe(
      "INVALID_EGRESS_LINEAGE"
    );
  }
};

const planRemotePublish = (collections: readonly Collection[]) =>
  planCollectionEgress({
    collections,
    collectionNames: ["a"],
    action: "publish",
    destinationZone: "remote",
    caller: { authenticated: true, operationAuthorized: true },
    contentClass: "capsule",
  });

describe("derived egress policy lineage", () => {
  test("sorts immutable membership and preserves the most restrictive policy", () => {
    const lineage = createEgressLineage(sources);

    expect(lineage.effectivePolicy).toBe("local_only");
    expect(lineage.sources.map(({ collection }) => collection)).toEqual([
      "lan",
      "local",
      "remote",
    ]);
    expect(lineage.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(lineage)).toBe(true);
    expect(Object.isFrozen(lineage.sources)).toBe(true);
    expect(createEgressLineage([...sources].reverse())).toEqual(lineage);
  });

  test("fails closed for empty and unknown requested scopes", () => {
    for (const requested of [[], ["missing"], [""], [" "]] as const) {
      expect(() => resolveEgressLineage(sources, requested)).toThrow(
        EgressProvenanceError
      );
    }
  });

  test("rejects conflicting policy identities", () => {
    expect(() =>
      createEgressLineage([sources[0], { ...sources[0], policy: "local_only" }])
    ).toThrow("Conflicting policy lineage");
    expect(() => createEgressLineage([sources[0], sources[0]])).toThrow(
      "Duplicate policy lineage"
    );
    expect(() =>
      createEgressLineage([
        { collection: "remote", policy: "remote", source: "config_default" },
      ])
    ).toThrow("invalid collection or policy");
  });

  test("validates duplicate raw lineage before selecting requested scope", () => {
    const local: EgressLineageInput = {
      collection: "a",
      policy: "local_only",
      source: "explicit",
    };
    const remote: EgressLineageInput = {
      collection: "a",
      policy: "remote",
      source: "explicit",
    };
    for (const inputs of [
      [remote, remote],
      [local, remote],
      [remote, local],
    ]) {
      expectInvalidLineage(() => resolveEgressLineage(inputs, ["a"]));
    }
  });

  test("fails closed for hostile, sparse, and oversized resolver inputs", () => {
    const hostileGetter: EgressLineageInput = {
      get collection(): string {
        throw new Error("hostile collection getter");
      },
      policy: "remote",
      source: "explicit",
    };
    const sparse = Array<EgressLineageInput>(1);
    const oversized = Array.from(
      { length: EGRESS_MAX_COLLECTIONS + 1 },
      (_, index) => ({
        collection: `c${index}`,
        policy: "remote" as const,
        source: "explicit" as const,
      })
    );
    const revoked = Proxy.revocable<EgressLineageInput[]>([sources[0]], {});
    revoked.revoke();

    for (const inputs of [[hostileGetter], sparse, oversized, revoked.proxy]) {
      expectInvalidLineage(() => resolveEgressLineage(inputs, ["remote"]));
    }
  });

  test("planner rejects duplicate keys before selecting an allowed policy", () => {
    const local = makeCollection("a", "local_only");
    const remote = makeCollection("a", "remote");
    for (const collections of [
      [remote, remote],
      [local, remote],
      [remote, local],
    ]) {
      expectInvalidLineage(() => planRemotePublish(collections));
    }
  });

  test("planner normalizes hostile, sparse, and oversized inputs to provenance errors", () => {
    const hostileGetter = {
      ...makeCollection("a", "remote"),
      get name(): string {
        throw new Error("hostile collection getter");
      },
    };
    const sparse = Array<Collection>(1);
    const oversized = Array.from(
      { length: EGRESS_MAX_COLLECTIONS + 1 },
      (_, index) => makeCollection(`c${index}`, "remote")
    );
    const revoked = Proxy.revocable<Collection[]>(
      [makeCollection("a", "remote")],
      {}
    );
    revoked.revoke();

    for (const collections of [
      [hostileGetter],
      sparse,
      oversized,
      revoked.proxy,
    ]) {
      expectInvalidLineage(() => planRemotePublish(collections));
    }
  });

  test("denies mixed transfer by default and discloses explicit partial output", () => {
    const collections: Collection[] = [
      {
        name: "remote",
        path: "/remote",
        pattern: "**/*",
        include: [],
        exclude: [],
        egressPolicy: "remote",
      },
      {
        name: "local",
        path: "/local",
        pattern: "**/*",
        include: [],
        exclude: [],
        egressPolicy: "local_only",
      },
    ];
    const input = {
      collections,
      action: "publish" as const,
      destinationZone: "remote" as const,
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "capsule" as const,
    };
    expect(() => planCollectionEgress(input)).toThrow(EgressDeniedError);
    expect(
      planCollectionEgress({ ...input, partialResults: "explicit" })
    ).toEqual({
      mode: "partial",
      sourceLineage: createEgressLineage([
        { collection: "local", policy: "local_only", source: "explicit" },
        { collection: "remote", policy: "remote", source: "explicit" },
      ]),
      allowedCollections: ["remote"],
      omittedCollections: [
        { collection: "local", reason: "POLICY_LOCAL_ONLY" },
      ],
      disclosure: {
        code: "EGRESS_PARTIAL_RESULT",
        omittedCount: 1,
        omittedCollections: ["local"],
      },
    });
  });

  test("fails search attachment for an unknown mirror owner", async () => {
    const result: SearchResult = {
      docid: "#abcdef",
      score: 1,
      uri: "gno://remote/shared.md",
      snippet: "shared",
      source: {
        relPath: "shared.md",
        mime: "text/markdown",
        ext: ".md",
        sourceHash: "a".repeat(64),
      },
      conversion: { mirrorHash: "b".repeat(64) },
    };
    const attached = await attachSearchResultEgressLineage(
      {} as Pick<StorePort, "getCollections" | "getDocumentsByMirrorHashes">,
      [result],
      {
        ownershipHashes: ["b".repeat(64)],
        ownershipDocuments: [
          { collection: "unknown", mirrorHash: "b".repeat(64) },
        ],
        collections: [
          {
            name: "remote",
            path: "/remote",
            pattern: "**/*",
            include: [],
            exclude: [],
            updateCmd: null,
            languageHint: null,
            egressPolicy: "remote",
            egressPolicySource: "explicit",
            syncedAt: "",
          },
        ],
      }
    );
    expect(attached.ok).toBe(false);
    expect(result.egressLineage).toBeUndefined();
  });
});
