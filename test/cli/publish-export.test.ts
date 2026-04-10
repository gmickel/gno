import { describe, expect, it } from "bun:test";

import { formatPublishExport } from "../../src/cli/commands/publish";
import {
  buildExportedMetadata,
  deriveExportedSlug,
  deriveExportedSummary,
  deriveExportedTitle,
} from "../../src/publish/artifact";

describe("publish export helpers", () => {
  it("derives stable titles and slugs from document rows", () => {
    expect(
      deriveExportedTitle({
        relPath: "notes/merkle-paths.md",
        title: "Merkle Paths For Portable Knowledge Bundles",
      })
    ).toBe("Merkle Paths For Portable Knowledge Bundles");

    expect(
      deriveExportedSlug({
        relPath: "notes/merkle-paths.md",
        title: "Merkle Paths For Portable Knowledge Bundles",
      })
    ).toBe("merkle-paths-for-portable-knowledge-bundles");

    expect(
      deriveExportedSlug({
        relPath: "notes/README.md",
        title: null,
      })
    ).toBe("readme");
  });

  it("prefers frontmatter summary and builds filtered metadata", () => {
    const markdown = `---\ntitle: Atlas\ndescription: Frontmatter summary\n---\n\n# Atlas\n\nBody text.`;

    expect(
      deriveExportedSummary(markdown, { description: "Frontmatter summary" })
    ).toBe("Frontmatter summary");

    expect(
      buildExportedMetadata(
        {
          author: "Gordon Mickel",
          categories: ["research"],
          collection: "atlas",
          contentType: "markdown",
          frontmatterDate: "2026-04-10",
          languageHint: "en",
          relPath: "notes/atlas.md",
        },
        { audience: "clients", title: "Atlas" },
        [{ source: "frontmatter", tag: "atlas" }]
      )
    ).toEqual({
      author: "Gordon Mickel",
      categories: ["research"],
      collection: "atlas",
      contentType: "markdown",
      date: "2026-04-10",
      language: "en",
      sourceRelPath: "notes/atlas.md",
      tags: ["atlas"],
      audience: "clients",
    });
  });

  it("formats successful export output with the next step", () => {
    const formatted = formatPublishExport(
      {
        success: true,
        data: {
          artifact: {
            version: 1,
            source: "atlas",
            exportedAt: "2026-04-10T00:00:00.000Z",
            spaces: [
              {
                routeSlug: "atlas",
                sourceType: "collection",
                title: "Atlas",
                summary: "Atlas summary",
                visibility: "public",
                notes: [],
              },
            ],
          },
          outPath: "/tmp/atlas.json",
          uploadUrl: "https://gno.sh/studio",
        },
      },
      { json: false }
    );

    expect(formatted).toContain("Exported collection to /tmp/atlas.json");
    expect(formatted).toContain("open https://gno.sh/studio");
  });
});
