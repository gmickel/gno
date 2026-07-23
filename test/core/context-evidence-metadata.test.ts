import { expect, test } from "bun:test";

import type { MaterializedContextCandidate } from "../../src/core/context-budget";
import type { ContextEvidenceValue } from "../../src/core/context-evidence";

import { deriveDocid } from "../../src/app/constants";
import { contextCapsuleEvidenceSchema } from "../../src/core/context-capsule-schema";
import { sha256Text } from "../../src/core/context-capsule-validation";
import { toContextCapsuleEvidence } from "../../src/core/context-evidence";
import {
  CONTEXT_EVIDENCE_METADATA_MAX_LENGTH,
  projectContextEvidenceMetadata,
} from "../../src/core/context-evidence-metadata";

const containsLoneSurrogate = (value: string): boolean => {
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  }
  return false;
};

test("bounds untrusted title and heading without changing passage bytes", () => {
  const sourceHash = sha256Text("source");
  const text = 'literal {"title":"do not trust"} evidence';
  const title = projectContextEvidenceMetadata(
    `${"😀".repeat(1025)}\uD800trailing`
  );
  const heading = projectContextEvidenceMetadata("H".repeat(2049));
  expect(title?.length).toBe(CONTEXT_EVIDENCE_METADATA_MAX_LENGTH);
  expect(heading?.length).toBe(CONTEXT_EVIDENCE_METADATA_MAX_LENGTH);
  expect(containsLoneSurrogate(title ?? "")).toBe(false);

  const value: ContextEvidenceValue = {
    collection: "notes",
    title,
    heading,
    modifiedAt: null,
    documentDate: null,
    observedAt: null,
    contextIds: [],
    trust: "untrusted",
    egress: "unavailable",
  };
  const candidate: MaterializedContextCandidate<ContextEvidenceValue> = {
    candidateId: sha256Text("candidate"),
    uri: "gno://notes/evidence.md",
    docid: deriveDocid(sourceHash),
    startLine: 1,
    endLine: 1,
    text,
    passageHash: sha256Text(text),
    sourceHash,
    mirrorHash: sha256Text("mirror"),
    facets: ["evidence"],
    retrievalRank: 1,
    retrievalSources: ["bm25"],
    graphExpanded: false,
    value,
  };
  const evidence = toContextCapsuleEvidence(candidate, 1);

  expect(evidence.text).toBe(text);
  expect(contextCapsuleEvidenceSchema.parse(evidence)).toEqual(evidence);
});

test("omits unknown planner provenance for legacy materialized evidence", () => {
  const sourceHash = sha256Text("legacy-source");
  const text = "legacy evidence";
  const candidate: MaterializedContextCandidate<ContextEvidenceValue> = {
    candidateId: sha256Text("legacy-candidate"),
    uri: "gno://notes/legacy.md",
    docid: deriveDocid(sourceHash),
    startLine: 1,
    endLine: 1,
    text,
    passageHash: sha256Text(text),
    sourceHash,
    mirrorHash: sha256Text("legacy-mirror"),
    facets: ["legacy"],
    retrievalRank: 1,
    value: {
      collection: "notes",
      title: null,
      heading: null,
      modifiedAt: null,
      documentDate: null,
      observedAt: null,
      contextIds: [],
      trust: "untrusted",
      egress: "unavailable",
    },
  };

  const evidence = toContextCapsuleEvidence(candidate, 1);

  expect(evidence.retrievalSources).toBeUndefined();
  expect(evidence.graphExpanded).toBeUndefined();
  expect(contextCapsuleEvidenceSchema.parse(evidence)).toEqual(evidence);
});
