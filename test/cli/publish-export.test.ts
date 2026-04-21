import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  buildDefaultPublishExportPath,
  formatPublishExport,
} from "../../src/cli/commands/publish";
import {
  buildEncryptedPublishArtifact,
  buildExportedMetadata,
  derivePublishArtifactFilename,
  deriveExportedSlug,
  derivePublishSlug,
  deriveExportedSummary,
  deriveExportedTitle,
  MAX_PUBLISH_SLUG_LENGTH,
} from "../../src/publish/artifact";
import { buildEncryptedArtifactPayload } from "../../src/publish/encrypted-export";

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
    expect(buildDefaultPublishExportPath(artifact)).toEndWith(
      join("Downloads", "atlas-20260410.json")
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
          warnings: [],
          warningsDisplay: [],
        },
      },
      { json: false }
    );

    expect(formatted).toContain("Exported collection to /tmp/atlas.json");
    expect(formatted).toContain("open https://gno.sh/studio");
  });

  it("builds encrypted export artifacts without plaintext note content", async () => {
    const markdown = "# Spicy Fajita Pasta\n\nSecret family recipe notes.";
    const encrypted = await buildEncryptedArtifactPayload({
      exportedAt: "2026-04-16T12:00:00.000Z",
      notes: [
        {
          markdown,
          metadata: {
            tags: ["recipes"],
          },
          slug: "spicy-fajita-pasta",
          summary: "Creamy fajita pasta.",
          title: "Spicy Fajita Pasta",
        },
      ],
      passphrase: "correct horse battery staple",
      routeSlug: "spicy-fajita-pasta",
      sourceType: "note",
      summary: "Creamy fajita pasta.",
      title: "Spicy Fajita Pasta",
    });

    const artifact = buildEncryptedPublishArtifact({
      encryptedPayload: encrypted.encryptedPayload,
      routeSlug: "spicy-fajita-pasta",
      secretToken: encrypted.secretToken,
      source: "gno://recipes/spicy-fajita-pasta.md",
      sourceType: "note",
    });

    const serialized = JSON.stringify(artifact);

    expect(artifact.version).toBe(2);
    expect(artifact.spaces[0]?.visibility).toBe("encrypted");
    expect(serialized).not.toContain(markdown);
    expect(serialized).not.toContain("Secret family recipe notes.");
    expect(serialized).not.toContain("Spicy Fajita Pasta");
    expect(serialized).not.toContain("Creamy fajita pasta.");
  });
});
