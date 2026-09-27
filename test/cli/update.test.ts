import { describe, expect, test } from "bun:test";

import { formatUpdate } from "../../src/cli/commands/update";

describe("formatUpdate", () => {
  test("surfaces a zero-failure partial warning in terminal and JSON", () => {
    const result = {
      success: true as const,
      result: {
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
                relPath: "partial.jsonl",
                status: "added" as const,
                recordImport: {
                  adapterId: "adapter/jsonl",
                  adapterVersion: "1.0.0",
                  adapterFingerprint: "a".repeat(64),
                  snapshotState: "partial" as const,
                  authoritative: false,
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
                      outcome: "added" as const,
                      recordKey: "b".repeat(64),
                      sourceLocator: "line:1",
                      sourceHash: "c".repeat(64),
                      adapterFingerprint: "a".repeat(64),
                      attachments: [],
                    },
                  ],
                  itemsTruncated: 0,
                  warnings: [
                    {
                      code: "PARTIAL_SNAPSHOT" as const,
                      message:
                        "Adapter reported a partial snapshot; unseen records were preserved.",
                      retryable: true,
                    },
                  ],
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
    };

    expect(formatUpdate(result, {})).toContain(
      "partial.jsonl: 1 record warning (partial snapshot)"
    );
    const json = formatUpdate(result, { json: true });
    expect(JSON.parse(json).collections[0].files[0].recordImport).toMatchObject(
      {
        warnings: [{ code: "PARTIAL_SNAPSHOT" }],
        items: [{ outcome: "added", sourceLocator: "line:1" }],
      }
    );
    expect(json).toBe(formatUpdate(result, { json: true }));
  });

  test("names a file stopped at its conversion budget without --verbose (fn-198)", () => {
    const collection = {
      collection: "wb",
      filesProcessed: 2,
      filesAdded: 1,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesErrored: 2,
      filesSkipped: 0,
      filesMarkedInactive: 0,
      durationMs: 1,
      errors: [
        {
          relPath: "reports/pivot.xlsx",
          code: "TIMEOUT",
          message: "Conversion timed out after 60000ms",
        },
        { relPath: "broken.pdf", code: "CORRUPT", message: "Invalid PDF" },
      ],
    };
    const result = {
      success: true as const,
      result: {
        collections: [collection],
        totalDurationMs: 1,
        totalFilesProcessed: 2,
        totalFilesAdded: 1,
        totalFilesUpdated: 0,
        totalFilesErrored: 2,
        totalFilesSkipped: 0,
      },
    };

    const output = formatUpdate(result, {});

    expect(output).toContain(
      "[TIMEOUT] reports/pivot.xlsx: Conversion timed out after 60000ms"
    );
    expect(output).not.toContain("broken.pdf");
  });
});
