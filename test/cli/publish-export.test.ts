import { describe, expect, it } from "bun:test";

import {
  buildDefaultPublishExportPath,
  formatPublishExport,
} from "../../src/cli/commands/publish";
import {
  buildExportedMetadata,
  derivePublishArtifactFilename,
  deriveExportedSlug,
  derivePublishSlug,
  deriveExportedSummary,
  deriveExportedTitle,
  MAX_PUBLISH_SLUG_LENGTH,
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

    expect(
      deriveExportedSlug({
        relPath: "日本語/!!!.md",
        title: "!!!",
      })
    ).toBe("untitled");

    const longSlug = derivePublishSlug(["a".repeat(120)]);
    expect(longSlug.length).toBe(MAX_PUBLISH_SLUG_LENGTH);
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
        {
          audience: "clients",
          password: "secret",
          tags: ["ignore-me"],
          title: "Atlas",
          topics: ["launch", "ops"],
          token: "should-not-export",
        },
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
      topics: ["launch", "ops"],
    });
  });

  it("builds default output paths in Downloads when --out is omitted", () => {
    const artifact = {
      version: 1 as const,
      source: "atlas",
      exportedAt: "2026-04-10T13:45:00.000Z",
      spaces: [
        {
          routeSlug: "atlas",
          sourceType: "collection" as const,
          title: "Atlas",
          summary: "Atlas summary",
          visibility: "public" as const,
          notes: [],
        },
      ],
    };

    expect(derivePublishArtifactFilename(artifact)).toBe("atlas.json");
    expect(buildDefaultPublishExportPath(artifact)).toContain(
      "/Downloads/atlas-20260410.json"
    );
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
