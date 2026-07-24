import { describe, expect, test } from "bun:test";

import {
  browserClipPayloadSchema,
  BROWSER_CLIP_MAX_BYTES,
  prepareBrowserClip,
  renderBrowserClipReader,
} from "../../src/core/browser-clip";
import {
  extractCaptureSourceFromFrontmatter,
  planCapture,
} from "../../src/core/capture";
import { sha256Text } from "../../src/core/context-capsule-validation";
import {
  assertInvalid,
  assertValid,
  loadSchema,
} from "../spec/schemas/validator";

const FIXED_NOW = new Date("2026-07-24T08:00:00.000Z");

const selectionPayload = () => ({
  schemaVersion: "1.0",
  mode: "selection",
  sourceUrl: "https://Example.com/article?z=2&a=1#selection",
  canonicalUrl: "https://example.com/article?a=1&z=2#canonical",
  title: "Café research",
  author: "Ada",
  site: "Example",
  publishedAt: "2026-07-23",
  observedAt: "2026-07-24T09:00:00+01:00",
  browser: {
    name: "Chromium",
    version: "140",
    platform: "macOS",
  },
  extraction: {
    visibility: "user_visible",
    authenticated: false,
    extractorVersion: "1.0.0",
    warnings: [],
  },
  destination: {
    collection: "notes",
    relPath: "clips/article.md",
    folderPath: null,
    collisionPolicy: "open_existing",
  },
  tags: ["research", "web"],
  note: null,
  selection: {
    exactText: "Cafe\u0301\r\n<script>alert(1)</script>",
    editedMarkdown: null as string | null,
  },
});

const readerPayload = () => {
  const payload = {
    ...selectionPayload(),
    mode: "reader",
    reader: {
      editedMarkdown: null,
      blocks: [
        {
          type: "heading",
          level: 2,
          content: [{ type: "text", text: "Reader title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Read <script> as visible text and " },
            {
              type: "link",
              text: "follow",
              href: "https://example.com/path?b=2&a=1#part",
            },
          ],
        },
        {
          type: "list",
          ordered: false,
          items: [
            [{ type: "text", text: "one" }],
            [{ type: "text", text: "two" }],
          ],
        },
        {
          type: "quote",
          content: [{ type: "text", text: "quoted" }],
        },
        {
          type: "code",
          language: "ts",
          text: "const fence = ```;",
        },
        { type: "horizontal_rule" },
      ],
    },
  };
  delete (payload as { selection?: unknown }).selection;
  return payload;
};

describe("browser clip contract", () => {
  test("selection preserves exact Unicode bytes while canonicalizing final Markdown", () => {
    const prepared = prepareBrowserClip(selectionPayload(), { now: FIXED_NOW });

    expect(prepared.provenance.exactSelection).toBe(
      "Cafe\u0301\r\n<script>alert(1)</script>"
    );
    expect(prepared.provenance.extractionHash).toBe(
      sha256Text("Cafe\u0301\r\n<script>alert(1)</script>")
    );
    expect(prepared.preview.body).toBe(
      "Café\n&lt;script&gt;alert(1)&lt;/script&gt;\n"
    );
    expect(prepared.provenance.finalBodyHash).toBe(
      sha256Text(prepared.preview.body.trim())
    );
    expect(prepared.provenance.finalBodyHash).not.toBe(
      prepared.provenance.extractionHash
    );
    expect(prepared.provenance.extractionWarnings).toEqual([
      "line_endings_normalized",
      "unicode_normalized",
    ]);
    expect(prepared.provenance.sourceUrl).toBe(
      "https://example.com/article?a=1&z=2"
    );
    expect(prepared.provenance.canonicalUrl).toBe(
      "https://example.com/article?a=1&z=2"
    );
    expect(prepared.provenance.publishedAt).toBe("2026-07-23");
    expect(prepared.provenance.observedAt).toBe("2026-07-24T08:00:00.000Z");
    expect(prepared.provenance.capturedAt).toBe(FIXED_NOW.toISOString());
  });

  test("unchanged input produces stable identity and preview digest", () => {
    const first = prepareBrowserClip(selectionPayload(), { now: FIXED_NOW });
    const second = prepareBrowserClip(selectionPayload(), { now: FIXED_NOW });
    const later = prepareBrowserClip(selectionPayload(), {
      now: new Date("2026-07-24T09:00:00.000Z"),
    });

    expect(first.provenance.clipIdentity).toBe(second.provenance.clipIdentity);
    expect(first.preview.digest).toBe(second.preview.digest);
    expect(first.preview.digest).toBe(later.preview.digest);
    expect(first.provenance.capturedAt).not.toBe(later.provenance.capturedAt);
  });

  test("Reader AST preserves structure and escapes visible markup", () => {
    const payload = readerPayload();
    const parsed = browserClipPayloadSchema.parse(payload);
    if (parsed.mode !== "reader") throw new Error("Expected reader payload");
    const markdown = renderBrowserClipReader(parsed.reader.blocks);

    expect(markdown).toContain("## Reader title");
    expect(markdown).toContain(
      "Read &lt;script&gt; as visible text and [follow](https://example.com/path?a=1&b=2)"
    );
    expect(markdown).toContain("- one\n- two");
    expect(markdown).toContain("> quoted");
    expect(markdown).toContain("````ts\nconst fence = ```;\n````");
    expect(markdown).not.toContain("<script>");
  });

  test("closed Reader schema rejects HTML, embeds, images, attributes, and dangerous URLs", () => {
    const payload = readerPayload();
    const invalidBlocks = [
      { type: "html", html: "<script>alert(1)</script>" },
      { type: "image", src: "https://example.com/tracker.gif" },
      { type: "iframe", src: "https://example.com/embed" },
      {
        type: "paragraph",
        content: [{ type: "text", text: "hidden", hidden: true }],
      },
      {
        type: "paragraph",
        content: [{ type: "link", text: "bad", href: "javascript:alert(1)" }],
      },
      {
        type: "paragraph",
        content: [{ type: "link", text: "bad", href: "data:text/html,x" }],
      },
    ];
    for (const block of invalidBlocks) {
      const candidate = structuredClone(payload);
      candidate.reader.blocks = [block] as never;
      expect(browserClipPayloadSchema.safeParse(candidate).success).toBeFalse();
    }
    expect(
      browserClipPayloadSchema.safeParse({
        ...payload,
        rawHtml: "<form><input></form>",
      }).success
    ).toBeFalse();
  });

  test("edited Markdown rejects raw HTML, images, and dangerous links", () => {
    for (const editedMarkdown of [
      "<script>alert(1)</script>",
      "![pixel](https://example.com/p.gif)",
      "[click](javascript:alert(1))",
      "[data](data:text/html,x)",
    ]) {
      const payload = selectionPayload();
      payload.selection.editedMarkdown = editedMarkdown;
      expect(() => prepareBrowserClip(payload, { now: FIXED_NOW })).toThrow();
    }
  });

  test("rejects credentials, non-HTTP schemes, ambiguous destinations, and huge payloads", () => {
    const badUrls = [
      "file:///tmp/a",
      "https://user:pass@example.com/private",
      "blob:https://example.com/id",
    ];
    for (const sourceUrl of badUrls) {
      expect(
        browserClipPayloadSchema.safeParse({
          ...selectionPayload(),
          sourceUrl,
        }).success
      ).toBeFalse();
    }
    expect(
      browserClipPayloadSchema.safeParse({
        ...selectionPayload(),
        destination: {
          ...selectionPayload().destination,
          folderPath: "clips",
        },
      }).success
    ).toBeFalse();
    const huge = selectionPayload();
    huge.selection.exactText = "x".repeat(BROWSER_CLIP_MAX_BYTES);
    expect(browserClipPayloadSchema.safeParse(huge).success).toBeFalse();
  });

  test("Draft-07 payload schema matches runtime structural contract", async () => {
    const schema = await loadSchema("browser-clip");
    expect(assertValid(selectionPayload(), schema)).toBeTrue();
    const reader = readerPayload();
    delete (reader as { selection?: unknown }).selection;
    expect(assertValid(reader, schema)).toBeTrue();
    expect(
      assertInvalid({ ...selectionPayload(), rawHtml: "<script />" }, schema)
    ).toBeTrue();
    expect(
      assertInvalid(
        {
          ...reader,
          reader: {
            ...reader.reader,
            blocks: [{ type: "image", src: "https://example.com/a.png" }],
          },
        },
        schema
      )
    ).toBeTrue();
  });

  test("capture frontmatter round-trips browser provenance", () => {
    const prepared = prepareBrowserClip(selectionPayload(), { now: FIXED_NOW });
    const plan = planCapture({
      input: prepared.captureInput,
      existingRelPaths: [],
      now: FIXED_NOW,
    });
    const source = extractCaptureSourceFromFrontmatter(plan.content);

    expect(source.browserClip?.clipIdentity).toBe(
      prepared.provenance.clipIdentity
    );
    expect(source.browserClip?.exactSelection).toBe(
      prepared.provenance.exactSelection
    );
    expect(plan.contentHash).toBe(prepared.provenance.finalBodyHash);
  });

  test("shared capture rejects open or incoherent browser provenance", () => {
    const prepared = prepareBrowserClip(selectionPayload(), { now: FIXED_NOW });
    const malformed = structuredClone(prepared.captureInput);
    malformed.source = {
      ...malformed.source,
      browserClip: {
        ...prepared.provenance,
        exactSelection: null,
        unexpected: true,
      } as never,
    };

    expect(() =>
      planCapture({
        input: malformed,
        existingRelPaths: [],
        now: FIXED_NOW,
      })
    ).toThrow();
  });

  test("open_existing requires matching stored browser provenance", () => {
    const prepared = prepareBrowserClip(selectionPayload(), { now: FIXED_NOW });
    const relPath = "clips/article.md";
    const matching = planCapture({
      input: prepared.captureInput,
      existingRelPaths: [relPath],
      existingProvenanceByRelPath: new Map([
        [relPath, prepared.provenance.clipIdentity],
      ]),
      now: FIXED_NOW,
    });
    expect(matching.openedExisting).toBeTrue();
    expect(matching.provenanceConflict).toBeFalse();

    for (const existingProvenanceByRelPath of [
      undefined,
      new Map([[relPath, "f".repeat(64)]]),
    ]) {
      const conflict = planCapture({
        input: prepared.captureInput,
        existingRelPaths: [relPath],
        existingProvenanceByRelPath,
        now: FIXED_NOW,
      });
      expect(conflict.openedExisting).toBeFalse();
      expect(conflict.provenanceConflict).toBeTrue();
      expect(conflict.collisionPolicyResult).toBe("conflict");
    }
  });

  test("create_with_suffix creates a distinct clip without provenance matching", () => {
    const payload = selectionPayload();
    payload.destination.collisionPolicy = "create_with_suffix";
    const prepared = prepareBrowserClip(payload, { now: FIXED_NOW });
    const plan = planCapture({
      input: prepared.captureInput,
      existingRelPaths: ["clips/article.md"],
      now: FIXED_NOW,
    });

    expect(plan.relPath).toBe("clips/article-2.md");
    expect(plan.openedExisting).toBeFalse();
    expect(plan.provenanceConflict).toBeFalse();
    expect(plan.createdWithSuffix).toBeTrue();
    expect(plan.collisionPolicyResult).toBe("created_with_suffix");
  });
});
