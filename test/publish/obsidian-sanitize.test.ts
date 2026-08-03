import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdir — structural op; no Bun equivalent
import { mkdir } from "node:fs/promises";
// node:path join — no Bun path utils
import { join } from "node:path";

import { buildAttachmentBasenameIndex } from "../../src/publish/attachment-resolver";
import { sanitizePublishMarkdown } from "../../src/publish/obsidian-sanitize";
import {
  cleanupAttachmentRoots,
  makeRoot,
  PNG_1X1,
  writeBytes,
} from "./helpers/attachment-fixtures";

afterEach(async () => {
  await cleanupAttachmentRoots();
});

describe("sanitizePublishMarkdown private attachment boundary", () => {
  test("strips private Markdown and Obsidian images before reading or bundling", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "_internal"), { recursive: true });
    await writeBytes(join(root, "_internal", "secret.png"), PNG_1X1);
    const result = await sanitizePublishMarkdown(
      [
        "![](_internal/secret.png)",
        "![[_internal/secret.png]]",
        "![[_internal/secret.png|secret]]",
        "![encoded](%5Finternal%2Fsecret.png)",
      ].join("\n"),
      {
        basenameIndex: await buildAttachmentBasenameIndex(root),
        collectionRoot: root,
        noteSlug: "private-boundary",
        sourceRelPath: "note.md",
      }
    );

    expect(result.markdown).not.toContain("_internal");
    expect(result.markdown).not.toContain("gno-asset:");
    expect(result.payloads.size).toBe(0);
    expect(result.preDedupRawBytes).toBe(0);
    expect(result.warnings).toHaveLength(4);
    expect(
      result.warnings.every(
        (warning) => warning.kind === "internal-reference-stripped"
      )
    ).toBeTrue();
  });

  test("does not broaden the private boundary to remote URLs or excluded code", async () => {
    const root = await makeRoot();
    const source = [
      "![remote](https://cdn.example/_internal/public.png)",
      "`![](example.png)`",
      "```md",
      "![](example.png)",
      "```",
    ].join("\n");
    const result = await sanitizePublishMarkdown(source, {
      basenameIndex: await buildAttachmentBasenameIndex(root),
      collectionRoot: root,
      noteSlug: "private-boundary",
      sourceRelPath: "note.md",
    });

    expect(result.markdown).toBe(source);
    expect(result.externalCount).toBe(1);
    expect(result.payloads.size).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});
