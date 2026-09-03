import { beforeAll, describe, expect, test } from "bun:test";

import type { IndexResult } from "../../src/cli/commands/index-cmd";

import { formatIndex } from "../../src/cli/commands/index-cmd";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const SYNC_RESULT = {
  collections: [
    {
      collection: "notes",
      filesProcessed: 10,
      filesAdded: 10,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesErrored: 0,
      filesSkipped: 0,
      filesMarkedInactive: 0,
      durationMs: 1234,
      errors: [],
    },
  ],
  totalDurationMs: 1234,
  totalFilesProcessed: 10,
  totalFilesAdded: 10,
  totalFilesUpdated: 0,
  totalFilesErrored: 0,
  totalFilesSkipped: 0,
};

const LEXICAL = {
  state: "completed" as const,
  filesProcessed: 10,
  filesAdded: 10,
  filesUpdated: 0,
  filesErrored: 0,
  filesSkipped: 0,
  durationMs: 1234,
};

const COMPLETED: IndexResult = {
  success: true,
  syncResult: SYNC_RESULT,
  embedSkipped: false,
  embedResult: {
    embedded: 2597,
    errors: 31,
    contentionErrors: 0,
    duration: 327,
  },
  stages: {
    lexical: LEXICAL,
    embed: {
      state: "completed",
      embedded: 2597,
      errors: 31,
      contentionErrors: 0,
      durationMs: 327_000,
    },
  },
  resumedFrom: null,
};

const EMBED_FAILED: IndexResult = {
  success: false,
  error: "Embed stage failed: connection refused",
  syncResult: SYNC_RESULT,
  embedSkipped: false,
  stages: {
    lexical: LEXICAL,
    embed: {
      state: "failed",
      embedded: 0,
      errors: 0,
      contentionErrors: 0,
      durationMs: 0,
      error: "connection refused",
    },
  },
  resumedFrom: {
    stage: "embed",
    state: "interrupted",
    startedAt: "2026-09-03T06:00:02.000Z",
    pid: 4242,
  },
};

describe("formatIndex", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("index-receipt");
  });

  test("formats embed duration in seconds without dividing twice", () => {
    const output = formatIndex(COMPLETED, {});

    expect(output).toContain("Indexing complete.");
    expect(output).toContain("Embedded 2,597 chunks in 5m 27s");
    expect(output).toContain("31 chunks failed to embed.");
    expect(output).not.toContain("0.3s");
  });

  test("JSON receipt carries per-stage states and validates against index-receipt@1.0", () => {
    const parsed = JSON.parse(formatIndex(COMPLETED, { json: true }));
    expect(assertValid(parsed, schema)).toBe(true);
    expect(parsed).toMatchObject({
      success: true,
      stages: {
        lexical: { state: "completed" },
        embed: { state: "completed" },
      },
      resumedFrom: null,
      embedSkipped: false,
    });
  });

  test("a failed embed stage yields a partial receipt with the resume marker", () => {
    const json = JSON.parse(formatIndex(EMBED_FAILED, { json: true }));
    expect(assertValid(json, schema)).toBe(true);
    expect(json).toMatchObject({
      success: false,
      error: "Embed stage failed: connection refused",
      stages: {
        lexical: { state: "completed", filesAdded: 10 },
        embed: { state: "failed", error: "connection refused" },
      },
      resumedFrom: { stage: "embed", state: "interrupted", pid: 4242 },
    });
    expect(json.syncResult.totalFilesAdded).toBe(10);

    const human = formatIndex(EMBED_FAILED, {});
    expect(human).toContain("Indexing failed.");
    expect(human).toContain("Embed stage failed: connection refused");
    expect(human).toContain("Lexical index is intact");
  });

  test("a failure before any stage prints only the error", () => {
    expect(
      formatIndex({ success: false, error: "GNO not initialized" }, {})
    ).toBe("Error: GNO not initialized");
  });

  test("preserves record receipts in deterministic JSON output", () => {
    const result: IndexResult = {
      success: true,
      syncResult: {
        collections: [
          {
            collection: "exports",
            filesProcessed: 1,
            filesAdded: 1,
            filesUpdated: 0,
            filesUnchanged: 0,
            filesErrored: 0,
            filesSkipped: 0,
            filesMarkedInactive: 0,
            durationMs: 1,
            errors: [],
            files: [
              {
                relPath: "records.jsonl",
                status: "added",
                recordImport: {
                  adapterId: "adapter/jsonl",
                  adapterVersion: "1.0.0",
                  adapterFingerprint: "a".repeat(64),
                  snapshotState: "complete",
                  authoritative: true,
                  stoppedByCap: false,
                  sourceBytesRead: 10,
                  records: {
                    accepted: 1,
                    added: 1,
                    updated: 0,
                    reactivated: 0,
                    unchanged: 0,
                    deactivated: 0,
                    preserved: 0,
                    failed: 0,
                  },
                  items: [
                    {
                      outcome: "added",
                      recordKey: "b".repeat(64),
                      sourceLocator: "line:1",
                      sourceHash: "c".repeat(64),
                      adapterFingerprint: "a".repeat(64),
                      attachments: [],
                    },
                  ],
                  itemsTruncated: 0,
                  warnings: [],
                  failures: [],
                },
              },
            ],
          },
        ],
        totalDurationMs: 1,
        totalFilesProcessed: 1,
        totalFilesAdded: 1,
        totalFilesUpdated: 0,
        totalFilesErrored: 0,
        totalFilesSkipped: 0,
      },
      embedSkipped: true,
      stages: {
        lexical: {
          ...LEXICAL,
          filesProcessed: 1,
          filesAdded: 1,
          durationMs: 1,
        },
        embed: {
          state: "skipped",
          embedded: 0,
          errors: 0,
          contentionErrors: 0,
          durationMs: 0,
          reason: "--no-embed",
        },
      },
      resumedFrom: null,
    };
    const output = formatIndex(result, { json: true });

    expect(JSON.parse(output).syncResult.collections[0].files[0]).toMatchObject(
      {
        recordImport: {
          items: [{ outcome: "added", sourceLocator: "line:1" }],
          itemsTruncated: 0,
        },
      }
    );
    expect(output).toBe(
      formatIndex(
        { ...result, syncResult: JSON.parse(output).syncResult },
        { json: true }
      )
    );
  });
});
