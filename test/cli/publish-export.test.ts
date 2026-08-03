import { describe, expect, it } from "bun:test";
// node:fs/promises — temporary directory lifecycle has no Bun-native equivalent.
import { mkdtemp, rm } from "node:fs/promises";
// node:os — no Bun temporary-directory helper.
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import {
  buildDefaultPublishExportPath,
  formatPublishExport,
  writePublishArtifactFile,
} from "../../src/cli/commands/publish";
import { resolveDownloadsDir } from "../../src/core/user-dirs";
import {
  buildEncryptedPublishArtifact,
  buildExportedMetadata,
  buildPublishArtifact,
  derivePublishArtifactFilename,
  deriveExportedSlug,
  derivePublishSlug,
  deriveExportedSummary,
  deriveExportedTitle,
  MAX_PUBLISH_SLUG_LENGTH,
  measureArtifactUploadBytes,
  serializePublishArtifact,
} from "../../src/publish/artifact";
import { buildEncryptedArtifactPayload } from "../../src/publish/encrypted-export";

const PUBLISH_NOTE = {
  markdown: "# Atlas\n\nPublished notes.",
  slug: "atlas",
  summary: "Atlas summary",
  title: "Atlas",
};

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
          contentType: "markdown",
          frontmatterDate: "2026-04-10",
          languageHint: "en",
        },
        {
          audience: "clients",
          canonical: "https://example.com/atlas",
          coverImage: "/Users/gordon/private/cover.png",
          password: "secret",
          tags: ["ignore-me"],
          title: "Atlas",
          topics: ["launch", "ops"],
          token: "should-not-export",
        },
        [{ source: "frontmatter", tag: "atlas" }]
      )
    ).toEqual({
      audience: "clients",
      author: "Gordon Mickel",
      canonical: "https://example.com/atlas",
      categories: ["research"],
      contentType: "markdown",
      date: "2026-04-10",
      language: "en",
      tags: ["atlas"],
      topics: ["launch", "ops"],
    });
  });

  it("prefers USERPROFILE for Windows downloads paths", async () => {
    const path = await resolveDownloadsDir({
      env: {
        HOME: "/msys/home/gordon",
        USERPROFILE: "C:\\Users\\gordon",
      },
      homeDir: "/msys/home/gordon",
      platform: "win32",
    });

    expect(path).toBe(win32.join("C:\\Users\\gordon", "Downloads"));
  });

  it("honors XDG_DOWNLOAD_DIR on Linux", async () => {
    const path = await resolveDownloadsDir({
      env: {
        HOME: "/home/gordon",
        XDG_DOWNLOAD_DIR: "$HOME/Inbox",
      },
      homeDir: "/home/gordon",
      platform: "linux",
    });

    expect(path).toBe("/home/gordon/Inbox");
  });

  it("reads localized Linux downloads dirs from user-dirs.dirs", async () => {
    const path = await resolveDownloadsDir({
      env: {
        HOME: "/home/gordon",
      },
      homeDir: "/home/gordon",
      platform: "linux",
      readTextFile: async () =>
        'XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n',
    });

    expect(path).toBe("/home/gordon/Téléchargements");
  });

  it("falls back to home Downloads when no platform override exists", async () => {
    const path = await resolveDownloadsDir({
      env: {
        HOME: "/Users/gordon",
      },
      homeDir: "/Users/gordon",
      platform: "darwin",
    });

    expect(path).toBe("/Users/gordon/Downloads");
  });

  it("builds default output paths in the resolved downloads dir when --out is omitted", async () => {
    const artifact = buildPublishArtifact({
      notes: [PUBLISH_NOTE],
      routeSlug: "atlas",
      sourceType: "collection",
      summary: "Atlas summary",
      title: "Atlas",
      visibility: "public",
    });
    artifact.exportedAt = "2026-04-10T13:45:00.000Z";

    expect(derivePublishArtifactFilename(artifact)).toBe("atlas.json");
    expect(await buildDefaultPublishExportPath(artifact)).toEndWith(
      join("Downloads", "atlas-20260410.json")
    );
  });

  it("writes the exact canonical bytes reported by finalUploadBytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-publish-write-"));
    try {
      const artifact = buildPublishArtifact({
        notes: [{ ...PUBLISH_NOTE, markdown: "# Atlas\n\nGrüezi 👋" }],
        routeSlug: "atlas",
        sourceType: "collection",
        summary: "Atlas summary",
        title: "Atlas",
        visibility: "public",
      });
      const outPath = join(root, "nested", "atlas.json");

      await writePublishArtifactFile(outPath, artifact);

      const written = await Bun.file(outPath).text();
      expect(written).toBe(serializePublishArtifact(artifact));
      expect(new TextEncoder().encode(written).byteLength).toBe(
        measureArtifactUploadBytes(artifact)
      );
      expect(written).toContain('\n  "exportedAt"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formats successful export output with the next step", () => {
    const artifact = buildPublishArtifact({
      notes: [PUBLISH_NOTE],
      routeSlug: "atlas",
      sourceType: "collection",
      summary: "Atlas summary",
      title: "Atlas",
      visibility: "public",
    });
    const formatted = formatPublishExport(
      {
        success: true,
        data: {
          artifact,
          assetSummary: {
            assetCount: 0,
            dedupSavedBytes: 0,
            diagnostics: [],
            encodedBytes: 0,
            externalCount: 0,
            finalUploadBytes: 128,
            rawBytes: 0,
            referenceCount: 0,
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
    expect(formatted).toContain("Asset summary:");
    expect(formatted).toContain("finalBytes=128");
  });

  it("prints stable asset diagnostics in human output", () => {
    const artifact = buildPublishArtifact({
      notes: [PUBLISH_NOTE],
      routeSlug: "atlas",
      sourceType: "collection",
      summary: "Atlas summary",
      title: "Atlas",
      visibility: "public",
    });
    const formatted = formatPublishExport(
      {
        success: true,
        data: {
          artifact,
          assetSummary: {
            assetCount: 0,
            dedupSavedBytes: 0,
            diagnostics: [
              {
                code: "ASSET_MISSING",
                message: "Attachment not found",
                noteSlug: "atlas",
                sourceRef: "missing.png",
              },
            ],
            encodedBytes: 0,
            externalCount: 0,
            finalUploadBytes: 128,
            rawBytes: 0,
            referenceCount: 0,
          },
          outPath: "/tmp/atlas.json",
          uploadUrl: "https://gno.sh/studio",
          warnings: [],
          warningsDisplay: [],
        },
      },
      { json: false }
    );

    expect(formatted).toContain(
      "[ASSET_MISSING] atlas: missing.png — Attachment not found"
    );
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
