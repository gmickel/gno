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
          duration: 327,
        },
      },
      {}
    );

    expect(output).toContain("Embedded 2,597 chunks in 5m 27s");
    expect(output).toContain("31 chunks failed to embed.");
    expect(output).not.toContain("0.3s");
  });
});
