/**
 * Hermetic tests for publish attachment rewrite, bundling, and egress summary.
 */
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdir/symlink — structural ops; no Bun equivalent
import { mkdir, symlink } from "node:fs/promises";
// node:path join — no Bun path utils
import { join } from "node:path";

import {
  encodeBytesToBase64,
  sha256BytesHex,
} from "../../src/publish/artifact-asset-codec";
import {
  MAX_PUBLISH_UPLOAD_BYTES,
  measureArtifactUploadBytes,
  validatePublishAssetContract,
} from "../../src/publish/artifact-assets";
import {
  buildAttachmentBasenameIndex,
  buildDeterministicAssets,
  rewriteAttachmentsInMarkdown,
  summarizeAssetEgress,
} from "../../src/publish/attachment-resolver";
import {
  AVIF_1X1,
  cleanupAttachmentRoots,
  GIF_1X1,
  JPEG_1X1,
  makeRoot,
  PNG_1X1,
  WEBP_1X1,
  writeBytes,
} from "./helpers/attachment-fixtures";

afterEach(async () => {
  await cleanupAttachmentRoots();
});

describe("rewriteAttachmentsInMarkdown", () => {
  test("bundles Obsidian + Markdown forms with Unicode/spaces/aliases/titles", async () => {
    const root = await makeRoot();
    await writeBytes(join(root, "dot.png"), PNG_1X1);
    await writeBytes(join(root, "Pasted image 1.png"), PNG_1X1);
    await mkdir(join(root, "notes"), { recursive: true });
    await writeBytes(join(root, "notes", "rel.png"), JPEG_1X1);
    await writeBytes(join(root, "café (1).png"), GIF_1X1);
    await mkdir(join(root, "notes", "dir", "(parens)"), { recursive: true });
    await writeBytes(
      join(root, "notes", "dir", "(parens)", "nested.png"),
      WEBP_1X1
    );
    await writeBytes(join(root, "notes", "spaced name.png"), AVIF_1X1);

    const index = await buildAttachmentBasenameIndex(root);
    const markdown = [
      "---",
      "title: Demo",
      "---",
      "",
      "![[dot.png]]",
      "![[Pasted image 1.png|hero]]",
      "![[dot.png|120]]",
      "![[café (1).png#frag|alias]]",
      "![rel](./rel.png)",
      "![spaces](<spaced name.png>)",
      "![nested](dir/(parens)/nested.png)",
      '![titled](rel.png "caption")',
      "![enc](rel%20missing.png)",
      "![ext](https://cdn.example/a.png)",
      "![proto](//cdn.example/b.png)",
      "```",
      "![[dot.png]]",
      "```",
      "`![[dot.png]]`",
    ].join("\n");

    const result = await rewriteAttachmentsInMarkdown(markdown, {
      basenameIndex: index,
      collectionRoot: root,
      noteSlug: "demo",
      sourceRelPath: "notes/demo.md",
    });

    expect(result.markdown).toContain("gno-asset:");
    expect(result.markdown).toContain("![hero](gno-asset:");
    expect(result.markdown).toContain("![alias](gno-asset:");
    expect(result.markdown).toContain("![spaces](gno-asset:");
    expect(result.markdown).toContain("![nested](gno-asset:");
    expect(result.markdown).toContain("![titled](gno-asset:");
    expect(result.markdown).toContain("![ext](https://cdn.example/a.png)");
    expect(result.markdown).toContain("![proto](//cdn.example/b.png)");
    expect(result.markdown).toContain("```\n![[dot.png]]\n```");
    expect(result.markdown).toContain("`![[dot.png]]`");
    expect(result.externalCount).toBe(2);
    expect(result.payloads.size).toBeGreaterThanOrEqual(2);

    const assets = buildDeterministicAssets(result.payloads);
    const ids = assets.map((asset) => asset.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("keeps non-asset Markdown bytes byte-identical when no local assets rewrite", async () => {
    const root = await makeRoot();
    const index = await buildAttachmentBasenameIndex(root);
    const markdown =
      "# Title\n\nParagraph with ![ext](https://cdn.example/x.png) link.\n\n```\n![x](local.png)\n```\n";
    const result = await rewriteAttachmentsInMarkdown(markdown, {
      basenameIndex: index,
      collectionRoot: root,
      noteSlug: "n",
      sourceRelPath: "n.md",
    });
    expect(result.markdown).toBe(markdown);
    expect(result.payloads.size).toBe(0);
    expect(result.externalCount).toBe(1);
  });

  test("never fetches external images and leaves them untouched", async () => {
    const root = await makeRoot();
    const index = await buildAttachmentBasenameIndex(root);
    const result = await rewriteAttachmentsInMarkdown(
      "![x](https://evil.example/track.png)\n![y](http://evil.example/a.jpg)",
      {
        basenameIndex: index,
        collectionRoot: root,
        noteSlug: "n",
        sourceRelPath: "n.md",
      }
    );
    expect(result.payloads.size).toBe(0);
    expect(result.externalCount).toBe(2);
    expect(result.markdown).toContain("https://evil.example/track.png");
  });

  test("rejects authored gno-asset sentinels instead of trusting producer input", async () => {
    const root = await makeRoot();
    const index = await buildAttachmentBasenameIndex(root);
    const source =
      "![forged](gno-asset:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)";
    const result = await rewriteAttachmentsInMarkdown(source, {
      basenameIndex: index,
      collectionRoot: root,
      noteSlug: "n",
      sourceRelPath: "n.md",
    });

    expect(result.markdown).toBe("");
    expect(result.payloads.size).toBe(0);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "ASSET_CORRUPT",
        sourceRef:
          "gno-asset:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ]);
  });

  test("reports missing and ambiguous basenames without bundling", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    await writeBytes(join(root, "a", "twin.png"), PNG_1X1);
    await writeBytes(join(root, "b", "twin.png"), PNG_1X1);
    const index = await buildAttachmentBasenameIndex(root);
    const result = await rewriteAttachmentsInMarkdown(
      "![[missing.png]]\n![[twin.png]]",
      {
        basenameIndex: index,
        collectionRoot: root,
        noteSlug: "n",
        sourceRelPath: "n.md",
      }
    );
    expect(result.payloads.size).toBe(0);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "ASSET_AMBIGUOUS",
      "ASSET_MISSING",
    ]);
    expect(result.markdown.includes("![[")).toBe(false);
  });

  test("hard-fails traversal before reading bytes", async () => {
    const root = await makeRoot();
    const index = await buildAttachmentBasenameIndex(root);
    try {
      await rewriteAttachmentsInMarkdown("![x](../../etc/passwd.png)", {
        basenameIndex: index,
        collectionRoot: root,
        noteSlug: "n",
        sourceRelPath: "notes/n.md",
      });
      expect.unreachable("expected ASSET_TRAVERSAL");
    } catch (error) {
      expect(String(error)).toMatch(/ASSET_TRAVERSAL/);
    }
  });

  test("hard-fails symlink escape before reading bytes", async () => {
    const root = await makeRoot();
    const outside = join(root, "..", `outside-${Date.now()}.png`);
    await writeBytes(outside, PNG_1X1);
    await symlink(outside, join(root, "link.png"));
    const index = await buildAttachmentBasenameIndex(root);
    try {
      await rewriteAttachmentsInMarkdown("![x](link.png)", {
        basenameIndex: index,
        collectionRoot: root,
        noteSlug: "n",
        sourceRelPath: "n.md",
      });
      expect.unreachable("expected ASSET_TRAVERSAL");
    } catch (error) {
      expect(String(error)).toMatch(/ASSET_TRAVERSAL/);
    }
  });

  test("rejects MIME spoof, data URLs, SVG, and non-raster basenames", async () => {
    const root = await makeRoot();
    await writeBytes(
      join(root, "fake.png"),
      new TextEncoder().encode("not-an-image")
    );
    await writeBytes(
      join(root, "vector.svg"),
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    );
    await writeBytes(
      join(root, "report.pdf"),
      new TextEncoder().encode("%PDF-1.7")
    );
    const index = await buildAttachmentBasenameIndex(root);
    const result = await rewriteAttachmentsInMarkdown(
      "![[fake.png]]\n![[vector.svg]]\n![[report.pdf]]\n![d](data:image/png;base64,AAAA)",
      {
        basenameIndex: index,
        collectionRoot: root,
        noteSlug: "n",
        sourceRelPath: "n.md",
      }
    );
    const codes = result.diagnostics.map((d) => d.code).sort();
    expect(codes).toContain("ASSET_MIME_SPOOF");
    expect(codes).toContain("ASSET_UNSUPPORTED_FORMAT");
    expect(
      codes.filter((code) => code === "ASSET_UNSUPPORTED_FORMAT")
    ).toHaveLength(3);
    expect(result.payloads.size).toBe(0);
  });

  test("deduplicates identical bytes while retaining every ownership mapping", async () => {
    const root = await makeRoot();
    await writeBytes(join(root, "a.png"), PNG_1X1);
    await writeBytes(join(root, "copy.png"), PNG_1X1);
    const index = await buildAttachmentBasenameIndex(root);
    const first = await rewriteAttachmentsInMarkdown("![[a.png]]", {
      basenameIndex: index,
      collectionRoot: root,
      noteSlug: "one",
      sourceRelPath: "one.md",
    });
    const second = await rewriteAttachmentsInMarkdown("![[copy.png]]", {
      basenameIndex: index,
      collectionRoot: root,
      noteSlug: "two",
      sourceRelPath: "two.md",
    });
    const payloads = new Map(first.payloads);
    for (const [id, payload] of second.payloads) {
      const existing = payloads.get(id);
      if (existing) existing.references.push(...payload.references);
      else payloads.set(id, payload);
    }
    const assets = buildDeterministicAssets(payloads);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.references.map((r) => r.noteSlug).sort()).toEqual([
      "one",
      "two",
    ]);
    expect(assets[0]?.id).toBe(sha256BytesHex(PNG_1X1));
    expect(assets[0]?.data).toBe(encodeBytesToBase64(PNG_1X1));
  });

  test("summary reports exact final bytes and rejects envelope oversize", async () => {
    const root = await makeRoot();
    await writeBytes(join(root, "a.png"), PNG_1X1);
    const index = await buildAttachmentBasenameIndex(root);
    const rewritten = await rewriteAttachmentsInMarkdown("![[a.png]]", {
      basenameIndex: index,
      collectionRoot: root,
      noteSlug: "atlas",
      sourceRelPath: "atlas.md",
    });
    const assets = buildDeterministicAssets(rewritten.payloads);
    const artifact = {
      version: 1 as const,
      source: "atlas",
      exportedAt: "2026-08-03T00:00:00.000Z",
      spaces: [
        {
          notes: [
            {
              markdown: rewritten.markdown,
              slug: "atlas",
              summary: "s",
              title: "Atlas",
              metadata: {},
            },
          ],
          routeSlug: "atlas",
          sourceType: "note" as const,
          summary: "s",
          title: "Atlas",
          visibility: "secret-link" as const,
        },
      ],
      assets,
      requiredCapabilities: ["bundled-raster-assets@1" as const],
    };
    const summary = summarizeAssetEgress({
      artifact,
      diagnostics: rewritten.diagnostics,
      externalCount: rewritten.externalCount,
      preDedupRawBytes: rewritten.preDedupRawBytes,
    });
    expect(summary.finalUploadBytes).toBe(measureArtifactUploadBytes(artifact));
    expect(summary.assetCount).toBe(1);
    expect(validatePublishAssetContract(artifact).ok).toBe(true);

    expect(() =>
      summarizeAssetEgress({
        artifact: { pad: "x".repeat(MAX_PUBLISH_UPLOAD_BYTES) },
        diagnostics: [],
        externalCount: 0,
        preDedupRawBytes: 0,
      })
    ).toThrow(/ENVELOPE_OVERSIZE/);
  });
});
