import { describe, expect, test } from "bun:test";

import {
  browserClipPayloadSchema,
  BROWSER_CLIP_MAX_BYTES,
  prepareBrowserClip,
  renderBrowserClipReader,
} from "../../src/core/browser-clip";
import { BROWSER_CLIP_HTTP_URL_PATTERN } from "../../src/core/browser-clip-provenance";
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

    const changedTitle = selectionPayload();
    changedTitle.title = "Different title";
    const changedAuthor = selectionPayload();
    changedAuthor.author = "Grace";
    expect(
      prepareBrowserClip(changedTitle, { now: FIXED_NOW }).preview.digest
    ).not.toBe(first.preview.digest);
    expect(
      prepareBrowserClip(changedAuthor, { now: FIXED_NOW }).preview.digest
    ).not.toBe(first.preview.digest);
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

  test("Reader text escapes existing backslashes and Markdown punctuation once", () => {
    const markdown = renderBrowserClipReader([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: String.raw`Path C:\docs\*draft*`,
          },
        ],
      },
    ]);

    expect(markdown).toBe(String.raw`Path C:\\docs\\\*draft\*` + "\n");
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
      "<!-- hidden -->",
      "![pixel](https://example.com/p.gif)",
      "![pixel][tracker]\n\n[tracker]: https://example.com/p.gif",
      "[click](javascript:alert(1))",
      "[data](data:text/html,x)",
      "[click][target]\n\n[target]: javascript:alert(1)",
    ]) {
      const payload = selectionPayload();
      payload.selection.editedMarkdown = editedMarkdown;
      expect(() => prepareBrowserClip(payload, { now: FIXED_NOW })).toThrow();
    }
  });

  test("edited Markdown preserves safe server-rendered blockquotes", () => {
    const payload = selectionPayload();
    payload.selection.editedMarkdown = "> Quoted source\n>\n> Follow-up";

    expect(
      prepareBrowserClip(payload, { now: FIXED_NOW }).preview.body
    ).toContain("> Quoted source\n>\n> Follow-up");
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

  test("runtime and Draft-07 share one closed browser URL grammar", async () => {
    const schema = await loadSchema("browser-clip");
    const schemaPattern = (
      schema as {
        definitions: { httpUrl: { pattern: string } };
      }
    ).definitions.httpUrl.pattern;
    expect(schemaPattern).toBe(BROWSER_CLIP_HTTP_URL_PATTERN);

    const accepted = [
      "HTTPS://example.com/article",
      "http://localhost:3000/path?x=1#section",
      "https://xn--bcher-kva.example/a%20b",
      "https://127.0.0.1:65535/a?currency=%E2%82%AC",
    ];
    const rejected = [
      "http://",
      "https://?x",
      "https://#fragment",
      "https://user:pass@example.com/private",
      "https://bücher.example/article",
      "https://example.com/%ZZ",
      "https://example.com:65536/path",
      "https://example.com:080/path",
      "https://[::1]/path",
      "https://[::1/path",
    ];

    for (const sourceUrl of accepted) {
      const payload = { ...selectionPayload(), sourceUrl };
      expect(browserClipPayloadSchema.safeParse(payload).success).toBeTrue();
      expect(assertValid(payload, schema)).toBeTrue();
    }
    for (const sourceUrl of rejected) {
      const payload = { ...selectionPayload(), sourceUrl };
      expect(browserClipPayloadSchema.safeParse(payload).success).toBeFalse();
      expect(assertInvalid(payload, schema)).toBeTrue();
    }
  });

  test("rejects disallowed C0 and C1 controls while preserving tabs and line endings", async () => {
    const schema = await loadSchema("browser-clip");
    for (const control of ["\u0000", "\u001f", "\u0085"]) {
      const payload = selectionPayload();
      payload.selection.exactText = `before${control}after`;
      expect(browserClipPayloadSchema.safeParse(payload).success).toBeFalse();
      expect(assertInvalid(payload, schema)).toBeTrue();
    }

    const allowed = selectionPayload();
    allowed.selection.exactText = "one\ttwo\r\nthree";
    expect(browserClipPayloadSchema.safeParse(allowed).success).toBeTrue();
    expect(assertValid(allowed, schema)).toBeTrue();
  });

  test("control rejection covers every free-form payload category", async () => {
    const schema = await loadSchema("browser-clip");
    const control = "\u0085";
    const readerText = readerPayload();
    readerText.reader.blocks = [
      {
        type: "paragraph",
        content: [{ type: "text", text: `bad${control}` }],
      },
    ] as never;
    const readerLink = readerPayload();
    readerLink.reader.blocks = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            text: `bad${control}`,
            href: "https://example.com",
          },
        ],
      },
    ] as never;
    const readerCode = readerPayload();
    readerCode.reader.blocks = [
      { type: "code", language: "ts", text: `bad${control}` },
    ] as never;
    const destination = selectionPayload();
    destination.destination.relPath = `clips/bad${control}.md`;
    const edited = selectionPayload();
    edited.selection.editedMarkdown = `bad${control}`;

    const candidates = [
      { ...selectionPayload(), title: `bad${control}` },
      { ...selectionPayload(), author: `bad${control}` },
      { ...selectionPayload(), site: `bad${control}` },
      {
        ...selectionPayload(),
        browser: { ...selectionPayload().browser, name: `bad${control}` },
      },
      {
        ...selectionPayload(),
        extraction: {
          ...selectionPayload().extraction,
          extractorVersion: `bad${control}`,
        },
      },
      { ...selectionPayload(), tags: [`bad${control}`] },
      { ...selectionPayload(), note: `bad${control}` },
      destination,
      edited,
      readerText,
      readerLink,
      readerCode,
    ];

    for (const candidate of candidates) {
      expect(browserClipPayloadSchema.safeParse(candidate).success).toBeFalse();
      expect(assertInvalid(candidate, schema)).toBeTrue();
    }
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

  test("edited bodies never open an existing clip with the same extraction", () => {
    const originalPayload = selectionPayload();
    originalPayload.selection.editedMarkdown = "Original edit";
    const original = prepareBrowserClip(originalPayload, { now: FIXED_NOW });
    const changedPayload = selectionPayload();
    changedPayload.selection.editedMarkdown = "Changed edit";
    const changed = prepareBrowserClip(changedPayload, { now: FIXED_NOW });
    const relPath = "clips/article.md";

    expect(changed.provenance.extractionHash).toBe(
      original.provenance.extractionHash
    );
    expect(changed.provenance.finalBodyHash).not.toBe(
      original.provenance.finalBodyHash
    );
    expect(changed.provenance.clipIdentity).not.toBe(
      original.provenance.clipIdentity
    );
    const conflict = planCapture({
      input: changed.captureInput,
      existingRelPaths: [relPath],
      existingProvenanceByRelPath: new Map([
        [relPath, original.provenance.clipIdentity],
      ]),
      now: FIXED_NOW,
    });
    expect(conflict.openedExisting).toBeFalse();
    expect(conflict.provenanceConflict).toBeTrue();

    changedPayload.destination.collisionPolicy = "create_with_suffix";
    const suffixed = prepareBrowserClip(changedPayload, { now: FIXED_NOW });
    const suffixPlan = planCapture({
      input: suffixed.captureInput,
      existingRelPaths: [relPath],
      now: FIXED_NOW,
    });
    expect(suffixPlan.openedExisting).toBeFalse();
    expect(suffixPlan.createdWithSuffix).toBeTrue();
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
