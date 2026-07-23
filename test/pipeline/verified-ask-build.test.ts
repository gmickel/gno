import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config";
import type { GenerationPort } from "../../src/llm/types";

import { verifyContextCapsuleRuntime } from "../../src/app/context-runtime";
import { buildVerifiedAsk } from "../../src/app/verified-ask";
import { createDefaultConfig } from "../../src/config";
import { sha256Text } from "../../src/core/context-capsule-validation";
import { compileContextEvidence } from "../../src/core/context-evidence";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const schemaAwarePort = (): GenerationPort => ({
  modelUri: "file:/verified-ask.gguf",
  structuredOutput: "json_schema",
  generate: async (_prompt, params) => {
    if (!params?.jsonSchema) {
      return { ok: true, value: "Mina owns the launch decision [1]." };
    }
    const schema = params.jsonSchema as {
      properties: {
        judgments: {
          items: {
            properties: {
              claimId: { enum: string[] };
              evidenceIds: { items: { enum: string[] } };
            };
          };
        };
      };
    };
    const properties = schema.properties.judgments.items.properties;
    return {
      ok: true,
      value: JSON.stringify({
        judgments: [
          {
            claimId: properties.claimId.enum[0],
            verdict: "supported",
            confidence: 1,
            evidenceIds: [properties.evidenceIds.items.enum[0]],
            rationaleCode: "semantic_entailment",
          },
        ],
        unresolvedClaimIds: [],
      }),
    };
  },
  dispose: async () => {},
});

describe("verified Ask application boundary", () => {
  test("preserves retrieval controls and fails closed on index mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-verified-ask-"));
    const store = new SqliteAdapter();
    try {
      expect(
        (await store.open(join(root, "index-default.sqlite"), "unicode61")).ok
      ).toBe(true);
      const config: Config = {
        ...createDefaultConfig(),
        collections: [
          {
            name: "notes",
            path: root,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ],
      };
      expect((await store.syncCollections(config.collections)).ok).toBe(true);
      const content = "# Owner\nMina owns the launch decision.";
      const mirrorHash = sha256Text(content);
      await Bun.write(join(root, "decision.md"), content);
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "decision.md",
            sourceHash: sha256Text(content),
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: content.length,
            sourceMtime: "2026-07-22T10:00:00.000Z",
            mirrorHash,
            title: "Launch decision",
            languageHint: "en",
          })
        ).ok
      ).toBe(true);
      expect((await store.upsertContent(mirrorHash, content)).ok).toBe(true);
      expect(
        (
          await store.upsertChunks(mirrorHash, [
            {
              seq: 0,
              pos: 0,
              text: content,
              startLine: 1,
              endLine: 2,
              language: "en",
            },
          ])
        ).ok
      ).toBe(true);
      expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
      const lexical = await store.searchFts("Mina", {
        collection: "notes",
      });
      expect(lexical.ok && lexical.value.length).toBeGreaterThan(0);
      const hybrid = await searchHybrid(
        {
          store,
          config,
          vectorIndex: null,
          embedPort: null,
          expandPort: null,
          rerankPort: null,
        },
        "Mina",
        {
          collection: "notes",
          lang: "en",
          exclude: ["hiring"],
          minScore: 0,
          graph: false,
          noRerank: true,
          limit: 4,
          candidateLimit: 9,
        }
      );
      expect(hybrid.ok && hybrid.value.results.length).toBeGreaterThan(0);
      expect(hybrid.ok && hybrid.value.results[0]?.uri).toBe(
        "gno://notes/decision.md"
      );
      if (!hybrid.ok) throw new Error(hybrid.error.message);
      const evidencePlan = await compileContextEvidence(
        {
          goal: "Mina",
          query: "Mina",
          indexName: "default",
          collections: ["notes"],
          lang: "en",
          exclude: ["hiring"],
          minScore: 0,
          graph: false,
          noRerank: true,
          limit: 4,
          candidateLimit: 9,
          temporalNow: new Date("2026-07-23T12:00:00.000Z"),
          limits: {
            requestedTokens: 100_000,
            requestedBytes: 100_000,
            safetyMarginTokens: 0,
            safetyMarginBytes: 0,
          },
        },
        {
          store,
          retrieve: async () => hybrid.value,
          projectCanonical: (draft) => ({
            value: draft,
            usedBytes: 1,
            usedTokens: 1,
          }),
        }
      );
      expect(evidencePlan.selected).toHaveLength(1);

      const result = await buildVerifiedAsk(
        "Mina",
        {
          verify: true,
          collection: "notes",
          lang: "en",
          intent: "decision ownership",
          exclude: ["hiring"],
          minScore: 0,
          graph: true,
          noGraph: true,
          noRerank: true,
          limit: 4,
          candidateLimit: 9,
          contextBudgetTokens: 100_000,
          contextBudgetBytes: 100_000,
        },
        {
          store,
          config,
          indexName: "default",
          genPort: schemaAwarePort(),
        }
      );

      expect(result.verification?.capsule.retrieval.request).toMatchObject({
        lang: "en",
        intent: "decision ownership",
        exclude: ["hiring"],
        minScore: 0,
        limit: 4,
        candidateLimit: 9,
        graphRequested: false,
        rerankRequested: false,
      });
      expect(
        result.verification?.capsule.retrieval.capabilityStates
      ).toMatchObject({
        reranking: { outcome: "not_requested" },
        graphExpansion: { outcome: "not_requested" },
      });
      expect(result.verification?.capsule.scope.indexName).toBe("default");
      expect(result.verification?.capsule.evidence[0]).toMatchObject({
        retrievalSources: ["bm25"],
        graphExpanded: false,
      });
      expect(
        verifyContextCapsuleRuntime(result.verification?.capsule, {
          store,
          config,
          indexName: "other",
        })
      ).rejects.toThrow("does not match runtime index");
    } finally {
      await store.close();
      await safeRm(root);
    }
  });
});
