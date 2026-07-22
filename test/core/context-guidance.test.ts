import { expect, test } from "bun:test";

import type { SearchResult } from "../../src/pipeline/types";
import type { ContextRow } from "../../src/store/types";

import {
  contextGuidanceResultIdentity,
  resolveContextGuidance,
} from "../../src/core/context-guidance";

const result = (collection: string): SearchResult => ({
  docid: "#deadbeef",
  score: 1,
  uri: `gno://${collection}/team/decision.md`,
  snippet: "decision",
  source: {
    relPath: "team/decision.md",
    mime: "text/markdown",
    ext: ".md",
    sourceHash: "a".repeat(64),
  },
  conversion: { mirrorHash: "b".repeat(64) },
});

test("configured contexts bind by canonical URI even when docids collide", () => {
  const alpha = result("alpha");
  const beta = result("beta");
  const contexts: ContextRow[] = [
    {
      scopeType: "prefix",
      scopeKey: "gno://alpha/team/",
      text: "Alpha-only guidance",
      syncedAt: "2026-07-22T10:00:00.000Z",
    },
    {
      scopeType: "prefix",
      scopeKey: "gno://beta/team/",
      text: "Beta-only guidance",
      syncedAt: "2026-07-22T10:00:00.000Z",
    },
  ];

  const guidance = resolveContextGuidance(contexts, [beta, alpha], "default");
  const contextsById = new Map(
    guidance.contexts.map((context) => [context.contextId, context])
  );
  const alphaIds = guidance.idsByResultIdentity.get(
    contextGuidanceResultIdentity(alpha)
  );
  const betaIds = guidance.idsByResultIdentity.get(
    contextGuidanceResultIdentity(beta)
  );

  expect(alphaIds).toHaveLength(1);
  expect(betaIds).toHaveLength(1);
  expect(alphaIds?.[0]).not.toBe(betaIds?.[0]);
  expect(contextsById.get(alphaIds?.[0] ?? "")?.text).toBe(
    "Alpha-only guidance"
  );
  expect(contextsById.get(betaIds?.[0] ?? "")?.text).toBe("Beta-only guidance");
});
