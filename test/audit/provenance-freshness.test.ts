import { describe, expect, test } from "bun:test";

import type { DocumentRow } from "../../src/store/types";

import {
  evaluateFreshnessAudit,
  type AuditFreshnessDocument,
} from "../../src/core/audit-freshness";
import {
  evaluateProvenanceAudit,
  type AuditProvenanceDocument,
} from "../../src/core/audit-provenance";
import { groupAuditPhysicalSources } from "../../src/core/audit-workspace";

test("groups shared logical-record containers into one physical observation", () => {
  const documents = Array.from(
    { length: 10_000 },
    (_, index) =>
      ({
        collection: "notes",
        relPath: `.gno/records/export.jsonl/${index}.md`,
        recordKey: `record-${index}`,
        recordSourcePath: "exports/export.jsonl",
        sourceExt: ".jsonl",
      }) as DocumentRow
  );
  expect(groupAuditPhysicalSources(documents)).toEqual([
    {
      key: '["notes","exports/export.jsonl"]',
      collection: "notes",
      relPath: "exports/export.jsonl",
      markdownSource: false,
    },
  ]);
});

const provenanceDocument = (
  overrides: Partial<AuditProvenanceDocument> = {}
): AuditProvenanceDocument => ({
  uri: "gno://notes/capture.md",
  relPath: "capture.md",
  captureSourceDeclared: true,
  captureSource: {
    kind: "web",
    capturedAt: "2026-08-03T12:00:00.000Z",
    url: "https://example.com/source",
  },
  record: {},
  ...overrides,
});

const freshnessDocument = (
  overrides: Partial<AuditFreshnessDocument> = {}
): AuditFreshnessDocument => ({
  uri: "gno://notes/current.md",
  relPath: "current.md",
  contentType: "meeting",
  indexedSourceHash: "hash-current",
  indexedSourceMtime: "2026-08-01T12:00:00.000Z",
  indexedAt: "2026-08-01T12:00:01.000Z",
  lastErrorCode: null,
  source: {
    state: "readable",
    hash: "hash-current",
    mtime: "2026-08-01T12:00:00.000Z",
  },
  ...overrides,
});

describe("provenance completeness audit", () => {
  test("checks only explicitly declared capture and logical-record contracts", () => {
    const ordinary = provenanceDocument({
      uri: "gno://notes/ordinary.md",
      captureSourceDeclared: false,
      captureSource: undefined,
      record: { converterId: "markdown", converterVersion: "1" },
    });
    const incompleteCapture = provenanceDocument({
      captureSource: { url: "not-a-url" },
    });
    const incompleteRecord = provenanceDocument({
      uri: "gno://notes/record.md",
      captureSourceDeclared: false,
      captureSource: undefined,
      record: { recordKey: "mail:123" },
    });
    const rules = evaluateProvenanceAudit([
      ordinary,
      incompleteCapture,
      incompleteRecord,
    ]);
    const capture = rules.find(
      ({ ruleId }) => ruleId === "provenance.capture-source"
    );
    const record = rules.find(
      ({ ruleId }) => ruleId === "provenance.logical-record"
    );
    expect(capture?.findings?.map(({ location }) => location)).toEqual([
      "source.capturedAt",
      "source.kind",
      "source.url",
    ]);
    expect(record?.findings?.map(({ location }) => location)).toEqual([
      "converterId",
      "converterVersion",
      "recordAdapterFingerprint",
      "recordSourceLocator",
    ]);
    expect(
      capture?.findings?.some(({ subject }) => subject === ordinary.uri)
    ).toBe(false);
    expect(
      record?.findings?.some(({ subject }) => subject === ordinary.uri)
    ).toBe(false);
  });

  test("skips undeclared contracts instead of inventing prose requirements", () => {
    const rules = evaluateProvenanceAudit([
      provenanceDocument({
        captureSourceDeclared: false,
        captureSource: undefined,
      }),
    ]);
    expect(rules.every(({ status }) => status === "skip")).toBe(true);
    expect(rules.flatMap(({ findings }) => findings ?? [])).toEqual([]);
  });

  test("marks capture provenance unavailable when source evidence is unreadable", () => {
    const rules = evaluateProvenanceAudit([
      provenanceDocument({
        sourceState: "missing",
        captureSourceDeclared: false,
        captureSource: undefined,
      }),
    ]);
    expect(
      rules.find(({ ruleId }) => ruleId === "provenance.capture-source")
    ).toMatchObject({
      status: "unavailable",
      skipReason: "source_unavailable",
    });
    expect(
      rules.find(({ ruleId }) => ruleId === "provenance.logical-record")?.status
    ).toBe("skip");
  });

  test("does not invent capture availability gaps for non-Markdown sources", () => {
    const rules = evaluateProvenanceAudit([
      provenanceDocument({
        sourceState: "missing",
        captureSourceSupported: false,
        captureSourceDeclared: false,
        captureSource: undefined,
      }),
    ]);
    expect(
      rules.find(({ ruleId }) => ruleId === "provenance.capture-source")
    ).toMatchObject({
      status: "skip",
      skipReason: "contract_not_declared",
    });
  });

  test("caps payloads while retaining exact finding counts", () => {
    const documents = Array.from({ length: 1200 }, (_, index) =>
      provenanceDocument({
        uri: `gno://notes/${index}.md`,
        relPath: `${index}.md`,
        captureSource: {},
      })
    );
    const capture = evaluateProvenanceAudit(documents).find(
      ({ ruleId }) => ruleId === "provenance.capture-source"
    );
    expect(capture?.findings).toHaveLength(1000);
    expect(capture?.findingCount).toBe(2400);
    expect(capture?.examinedCount).toBe(1200);
    const reversedCapture = evaluateProvenanceAudit(
      [...documents].reverse()
    ).find(({ ruleId }) => ruleId === "provenance.capture-source");
    expect(reversedCapture?.findings).toEqual(capture?.findings);
  });
});

describe("freshness and index consistency audit", () => {
  test("canonically caps findings independent of snapshot traversal order", () => {
    const documents = Array.from({ length: 1001 }, (_, index) =>
      freshnessDocument({
        uri: `gno://notes/${String(index).padStart(4, "0")}.md`,
        relPath: `${String(index).padStart(4, "0")}.md`,
        source: { state: "missing", hash: null, mtime: null },
      })
    );
    const evaluate = (input: AuditFreshnessDocument[]) =>
      evaluateFreshnessAudit(input, {
        now: new Date("2026-08-03T12:00:00.000Z"),
      }).find(({ ruleId }) => ruleId === "freshness.source-readable");
    const forward = evaluate(documents);
    const reversed = evaluate([...documents].reverse());
    expect(forward?.findingCount).toBe(1001);
    expect(forward?.findings).toHaveLength(1000);
    expect(reversed?.findings).toEqual(forward?.findings);
  });

  test("distinguishes unreadable, drifted, and stale indexed revisions", () => {
    const missing = freshnessDocument({
      uri: "gno://notes/missing.md",
      source: { state: "missing", hash: null, mtime: null },
    });
    const drifted = freshnessDocument({
      uri: "gno://notes/drifted.md",
      source: {
        state: "readable",
        hash: "hash-new",
        mtime: "2026-08-03T12:00:00.000Z",
      },
    });
    const errored = freshnessDocument({
      uri: "gno://notes/errored.md",
      indexedAt: null,
      lastErrorCode: "CONVERSION_FAILED",
    });
    const rules = evaluateFreshnessAudit([missing, drifted, errored], {
      now: new Date("2026-08-03T12:00:00.000Z"),
    });
    expect(
      rules.find(({ ruleId }) => ruleId === "freshness.source-readable")?.status
    ).toBe("unavailable");
    expect(
      rules.find(({ ruleId }) => ruleId === "freshness.source-index-drift")
        ?.findings
    ).toHaveLength(1);
    expect(
      rules.find(({ ruleId }) => ruleId === "freshness.index-revision")
        ?.findings
    ).toHaveLength(1);
  });

  test("reports age only under explicit policy and never as factual falsity", () => {
    const old = freshnessDocument({
      indexedSourceMtime: "2025-01-01T00:00:00.000Z",
    });
    const withoutPolicy = evaluateFreshnessAudit([old], {
      now: new Date("2026-08-03T12:00:00.000Z"),
    }).find(({ ruleId }) => ruleId === "freshness.configured-age-signal");
    expect(withoutPolicy?.status).toBe("skip");
    const withPolicy = evaluateFreshnessAudit([old], {
      now: new Date("2026-08-03T12:00:00.000Z"),
      agePolicy: { maxAgeDays: 90, contentTypes: ["meeting"] },
    }).find(({ ruleId }) => ruleId === "freshness.configured-age-signal");
    expect(withPolicy?.status).toBe("fail");
    expect(withPolicy?.findings?.[0]?.severity).toBe("info");
    const serialized = JSON.stringify(withPolicy);
    expect(serialized).not.toContain("incorrect");
    expect(serialized).toContain(
      "age is not evidence that the content is false"
    );
  });

  test("changed-during-read and truncated scans are inconclusive", () => {
    const rules = evaluateFreshnessAudit(
      [
        freshnessDocument({
          source: {
            state: "readable",
            hash: "hash-current",
            mtime: "2026-08-01T12:00:00.000Z",
            changedDuringRead: true,
          },
        }),
      ],
      {
        now: new Date("2026-08-03T12:00:00.000Z"),
        truncated: true,
      }
    );
    expect(rules.every(({ status }) => status === "inconclusive")).toBe(true);
    expect(
      rules.every(
        ({ skipReason }) => skipReason === "source_changed_during_read"
      )
    ).toBe(true);
  });
});
