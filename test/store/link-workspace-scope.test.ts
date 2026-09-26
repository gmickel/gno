/**
 * Resolving an edge never widens retrieval scope (R5, R6, A1, A2, A4).
 *
 * Fixture: ai (local_only) and work (remote) share one vault.
 *   ai:Agents/Planner.md --[[Roadmap]]--> work:Roadmap.md
 *   work:Roadmap.md --[[Planner]]--> ai:Agents/Planner.md
 *   work:Roadmap.md --[[Private]]--> ai:Private.md
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { Collection } from "../../src/config/types";
import type { ContextRetrievalRequest } from "../../src/core/context-compiler";

import { planContextEvidence } from "../../src/core/context-compiler";
import {
  EgressDeniedError,
  planCollectionEgress,
} from "../../src/core/egress-enforcement";
import { analyzeKnowledgeImpact } from "../../src/core/knowledge-impact";
import { enforceHttpMcpEgress } from "../../src/mcp/http-egress";
import { expandGraphCandidates } from "../../src/pipeline/graph-retrieval";
import {
  openLinkWorkspaceFixture,
  type LinkWorkspaceFixture,
} from "../fixtures/link-workspace/fixture";

let fixture: LinkWorkspaceFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const ROADMAP = "gno://work/Roadmap.md";
const PLANNER = "gno://ai/Agents/Planner.md";
const PRIVATE = "gno://ai/Private.md";

const docids = (f: LinkWorkspaceFixture): Map<string, string> =>
  new Map(
    f.store
      .getRawDb()
      .query<{ docid: string; uri: string }, []>(
        "SELECT docid, uri FROM documents WHERE active = 1"
      )
      .all()
      .map((row) => [row.docid, row.uri])
  );

const neighbourUris = async (
  f: LinkWorkspaceFixture,
  seed: string,
  scope: { collection?: string; collections?: string[] }
): Promise<string[]> => {
  const result = await f.store.getGraphNeighborsForSeeds({
    seedDocumentIds: [f.docId(seed)],
    ...scope,
  });
  if (!result.ok) throw new Error(result.error.message);
  const uris = docids(f);
  return [
    ...new Set(
      result.value.links.flatMap((link) => [
        uris.get(link.source) ?? link.source,
        uris.get(link.target) ?? link.target,
      ])
    ),
  ]
    .filter((uri) => uri !== seed)
    .sort();
};

describe("graph neighbours honour the requested collection scope (R5, A2, A4)", () => {
  test("singleton, plural and unscoped allowlists", async () => {
    fixture = await openLinkWorkspaceFixture();
    expect(await neighbourUris(fixture, ROADMAP, {})).toEqual([
      PLANNER,
      PRIVATE,
    ]);
    expect(
      await neighbourUris(fixture, ROADMAP, { collection: "work" })
    ).toEqual([]);
    expect(
      await neighbourUris(fixture, ROADMAP, { collections: ["ai", "work"] })
    ).toEqual([PLANNER, PRIVATE]);
    expect(
      await neighbourUris(fixture, ROADMAP, { collections: ["work", "plain"] })
    ).toEqual([]);
    expect(await neighbourUris(fixture, ROADMAP, { collections: [] })).toEqual(
      []
    );
  });

  test("a scoped call never re-resolves to an in-scope title match (A3)", async () => {
    fixture = await openLinkWorkspaceFixture();
    // [[Roadmap]] from Planner resolves to work:Roadmap.md; scoped to ai the
    // edge is dropped rather than redirected to ai:Titled.md.
    expect(
      await neighbourUris(fixture, PLANNER, { collection: "ai" })
    ).toContain("gno://ai/Agents/_index.md");
    expect(
      await neighbourUris(fixture, PLANNER, { collection: "ai" })
    ).not.toContain("gno://ai/Titled.md");
  });

  test("query-time expansion hydrates only in-scope neighbours", async () => {
    fixture = await openLinkWorkspaceFixture();
    const db = fixture.store.getRawDb();
    const seed = db
      .query<{ id: number; mirror_hash: string }, [string]>(
        "SELECT id, mirror_hash FROM documents WHERE uri = ?"
      )
      .get(ROADMAP)!;
    const candidates = [
      {
        documentId: seed.id,
        mirrorHash: seed.mirror_hash,
        seq: 0,
        bm25Rank: 1,
        vecRank: null,
        fusionScore: 1,
        sources: ["bm25" as const],
      },
    ];
    const hashes = (collection?: string, collections?: string[]) =>
      expandGraphCandidates(fixture!.store, candidates, {
        collection,
        collections,
      }).then((result) =>
        result.candidates
          .map(
            ({ mirrorHash }) =>
              db
                .query<{ uri: string }, [string]>(
                  "SELECT uri FROM documents WHERE mirror_hash = ?"
                )
                .get(mirrorHash)?.uri
          )
          .sort()
      );
    expect(await hashes("work")).toEqual([]);
    expect(await hashes("work", ["work", "plain"])).toEqual([]);
    expect(await hashes("work", ["ai", "work"])).toEqual([PLANNER, PRIVATE]);
  });

  test("capsule planning partitions search per collection but shares one graph allowlist", async () => {
    const requests: ContextRetrievalRequest[] = [];
    await planContextEvidence(
      {
        goal: "Where is the roadmap?",
        query: "roadmap",
        indexName: "default",
        collections: ["work", "ai"],
        temporalNow: "2026-09-26T12:00:00.000Z",
        observedAt: null,
        contextSnapshot: [],
        limits: {
          requestedBytes: 20_000,
          requestedTokens: 20_000,
          safetyMarginBytes: 100,
          safetyMarginTokens: 100,
        },
      },
      {
        retrieve: async (request) => {
          requests.push(request);
          return {
            results: [],
            meta: { query: request.query, mode: "bm25_only", totalResults: 0 },
          };
        },
        materializeCandidates: async () => [],
        projectCanonical: () => null,
      }
    ).catch(() => null);
    expect(requests.map((request) => request.collection)).toEqual([
      "ai",
      "work",
    ]);
    for (const request of requests) {
      expect(request.graphCollections).toEqual(["ai", "work"]);
    }
  });
});

describe("backlinks, graph export and impact honour scope (R6, A2)", () => {
  test("backlinks list cross-collection sources only when in scope", async () => {
    fixture = await openLinkWorkspaceFixture();
    const id = fixture.docId(ROADMAP);
    const all = await fixture.store.getBacklinksForDoc(id);
    const scoped = await fixture.store.getBacklinksForDoc(id, {
      collection: "work",
    });
    if (!all.ok || !scoped.ok) throw new Error("backlinks failed");
    expect(
      all.value.map((row) => [row.sourceDocUri, row.sourceCollection])
    ).toContainEqual([PLANNER, "ai"]);
    expect(scoped.value).toEqual([]);
  });

  test("graph export drops edges whose resolved endpoint is out of scope", async () => {
    fixture = await openLinkWorkspaceFixture();
    const scoped = await fixture.store.getGraph({ collection: "work" });
    const all = await fixture.store.getGraph({});
    if (!scoped.ok || !all.ok) throw new Error("graph failed");
    expect(scoped.value.nodes.every((node) => node.collection === "work")).toBe(
      true
    );
    const nodeCollection = new Map(
      all.value.nodes.map((node) => [node.id, node.collection])
    );
    expect(
      all.value.links.some(
        (link) =>
          nodeCollection.get(link.source) === "ai" &&
          nodeCollection.get(link.target) === "work"
      )
    ).toBe(true);
  });

  test("impact never bridges through a forbidden collection", async () => {
    fixture = await openLinkWorkspaceFixture();
    // Inbound to ai:Private: work:Roadmap (depth 1), ai:Planner (depth 2 via
    // work:Roadmap). Scoped to ai, work is a forbidden bridge.
    const unscoped = await analyzeKnowledgeImpact(fixture.store, PRIVATE);
    const scoped = await analyzeKnowledgeImpact(fixture.store, PRIVATE, {
      collections: ["ai"],
    });
    if (!unscoped.success || !scoped.success) throw new Error("impact failed");
    expect(unscoped.data.impacted.map((item) => item.document.uri)).toEqual([
      ROADMAP,
      PLANNER,
    ]);
    expect(scoped.data.impacted).toEqual([]);
    expect(JSON.stringify(scoped.data)).not.toContain("gno://work/");
    expect(
      await analyzeKnowledgeImpact(fixture.store, PRIVATE, {
        collections: ["work"],
      })
    ).toMatchObject({ success: false, isValidation: true });
    expect(
      await analyzeKnowledgeImpact(fixture.store, PRIVATE, {
        collections: ["nope"],
      })
    ).toMatchObject({
      success: false,
      error: "Collection not found: nope",
      isValidation: true,
    });
  });
});

describe("egress boundary is unchanged and applies to graph results (A1)", () => {
  const collections = (f: LinkWorkspaceFixture): Collection[] => f.collections;
  const remoteCaller = {
    authenticated: true,
    destinationZone: "remote" as const,
    operationAuthorized: true,
  };
  const impactCall = (args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "gno_impact", arguments: args },
  });

  test("remote graph tools without a scope are denied by default", async () => {
    fixture = await openLinkWorkspaceFixture();
    // The ref is in the remote collection, but links resolve into the
    // local_only one: the unscoped result spans every collection.
    expect(() =>
      enforceHttpMcpEgress(
        impactCall({ ref: ROADMAP }),
        collections(fixture!),
        remoteCaller
      )
    ).toThrow(EgressDeniedError);
    expect(() =>
      enforceHttpMcpEgress(
        impactCall({ ref: ROADMAP, collections: ["work"] }),
        collections(fixture!),
        remoteCaller
      )
    ).not.toThrow();
  });

  test.each([
    ["gno_backlinks", ""],
    ["gno_backlinks", "   "],
    ["gno_graph_neighbors", ""],
    ["gno_impact", ""],
    ["gno_search", ""],
    ["gno_query", "  "],
  ])(
    "a remote %s call with a blank collection is treated as unscoped (%j)",
    async (name, collection) => {
      fixture = await openLinkWorkspaceFixture();
      // Handlers treat a blank collection as omitted, so the result spans
      // every collection, including local_only ones.
      expect(() =>
        enforceHttpMcpEgress(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name,
              arguments:
                name.startsWith("gno_graph") ||
                name === "gno_backlinks" ||
                name === "gno_impact"
                  ? { ref: ROADMAP, collection }
                  : { query: "roadmap", collection },
            },
          },
          collections(fixture!),
          remoteCaller
        )
      ).toThrow(EgressDeniedError);
    }
  );

  test.each([
    ["gno_backlinks", { ref: PRIVATE, collection: "work" }],
    ["gno_impact", { ref: PRIVATE, collections: ["work"] }],
    ["gno_graph_neighbors", { ref: PRIVATE, collection: "work" }],
    ["gno_graph_path", { from: PRIVATE, to: ROADMAP, collection: "work" }],
    ["gno_backlinks", { ref: "#abc123", collection: "work" }],
    ["gno_similar", { ref: ROADMAP, crossCollection: true }],
  ])(
    "a remote %s call scoped to an allowed collection cannot reach a local_only ref",
    async (name, args) => {
      fixture = await openLinkWorkspaceFixture();
      expect(() =>
        enforceHttpMcpEgress(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          },
          collections(fixture!),
          remoteCaller
        )
      ).toThrow(EgressDeniedError);
    }
  );

  test("an unscoped remote transfer is denied; explicit partial output omits local_only and discloses it", async () => {
    fixture = await openLinkWorkspaceFixture();
    const input = {
      collections: collections(fixture),
      action: "remote_inference" as const,
      destinationZone: "remote" as const,
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "snippet" as const,
    };
    expect(() => planCollectionEgress(input)).toThrow(EgressDeniedError);
    const plan = planCollectionEgress({
      ...input,
      partialResults: "explicit",
    });
    expect(plan.allowedCollections).toEqual(["work"]);
    expect(plan.disclosure).toMatchObject({
      code: "EGRESS_PARTIAL_RESULT",
      omittedCollections: expect.arrayContaining(["ai"]),
    });
    // The allowed set becomes the graph allowlist: no local_only neighbour.
    expect(
      await neighbourUris(fixture, ROADMAP, {
        collections: plan.allowedCollections,
      })
    ).toEqual([]);
  });
});
