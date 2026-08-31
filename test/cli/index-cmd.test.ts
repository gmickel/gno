import { describe, expect, test } from "bun:test";

import { formatIndex } from "../../src/cli/commands/index-cmd";

describe("formatIndex", () => {
  test("formats embed duration in seconds without dividing twice", () => {
    const output = formatIndex(
      {
        success: true,
        syncResult: {
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
        },
        embedSkipped: false,
        embedResult: {
          embedded: 2597,
          errors: 31,
          contentionErrors: 0,
          duration: 327,
        },
      },
      {}
    );

    expect(output).toContain("Embedded 2,597 chunks in 5m 27s");
    expect(output).toContain("31 chunks failed to embed.");
    expect(output).not.toContain("0.3s");
  });

  test("preserves record receipts in deterministic JSON output", () => {
    const output = formatIndex(
      {
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
      },
      { json: true }
    );

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
        JSON.parse(
          JSON.stringify({
            success: true,
            syncResult: JSON.parse(output).syncResult,
            embedSkipped: true,
          })
        ),
        { json: true }
      )
    );
  });
});
