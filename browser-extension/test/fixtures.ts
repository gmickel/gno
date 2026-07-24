import type {
  BrowserClipPayload,
  BrowserClipPreview,
  CaptureReceipt,
  ExtractionResult,
  StoredGrant,
} from "../src/types";

export const grant: StoredGrant = {
  grantId: "123e4567-e89b-42d3-a456-426614174000",
  grantToken: "a".repeat(64),
  expiresAt: "2026-08-24T08:00:00.000Z",
};

export const extraction: ExtractionResult = {
  sourceUrl: "https://example.com/article?b=2&a=1#section",
  canonicalUrl: "https://example.com/article",
  title: "Example",
  author: "Ada",
  site: "Example",
  publishedAt: "2026-07-23",
  observedAt: "2026-07-24T08:00:00.000Z",
  browser: { name: "Chromium", version: null, platform: "macOS" },
  warnings: ["canonical_url_differs"],
  selectionText: "Exact café selection",
  readerBlocks: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Visible article" }],
    },
  ],
};

export const payload: BrowserClipPayload = {
  schemaVersion: "1.0",
  sourceUrl: extraction.sourceUrl,
  canonicalUrl: extraction.canonicalUrl,
  title: extraction.title,
  author: extraction.author,
  site: extraction.site,
  publishedAt: extraction.publishedAt,
  observedAt: extraction.observedAt,
  browser: extraction.browser,
  extraction: {
    visibility: "user_visible",
    authenticated: false,
    extractorVersion: "gno-browser-clipper/1.0",
    warnings: ["canonical_url_differs"],
  },
  destination: {
    collection: "notes",
    relPath: "clips/example.md",
    folderPath: null,
    collisionPolicy: "open_existing",
  },
  tags: ["browser"],
  note: null,
  mode: "selection",
  selection: {
    exactText: "Exact café selection",
    editedMarkdown: null,
  },
};

export const provenance = {
  schemaVersion: "1.0",
  mode: "selection",
  sourceUrl: "https://example.com/article?a=1&b=2",
  canonicalUrl: "https://example.com/article",
  title: "Example",
  author: "Ada",
  site: "Example",
  publishedAt: "2026-07-23",
  observedAt: "2026-07-24T08:00:00.000Z",
  capturedAt: "2026-07-24T08:01:00.000Z",
  extractionHash: "1".repeat(64),
  finalBodyHash: "2".repeat(64),
  clipIdentity: "3".repeat(64),
  previewDigest: "4".repeat(64),
  exactSelection: "Exact café selection",
  extractionWarnings: ["canonical_url_differs"],
  browser: { name: "Chromium", version: null, platform: "macOS" },
};

export const source = {
  kind: "web",
  title: "Example",
  url: "https://example.com/article?a=1&b=2",
  author: "Ada",
  observedAt: "2026-07-24T08:00:00.000Z",
  capturedAt: "2026-07-24T08:01:00.000Z",
  canonicalUrl: "https://example.com/article",
  site: "Example",
  publishedAt: "2026-07-23",
  browserClip: provenance,
};

export const previewResponse = {
  schemaVersion: "1.0",
  preview: {
    body: "# Example\n\nExact café selection",
    digest: "4".repeat(64),
    source,
    destination: payload.destination,
    tags: payload.tags,
  },
  provenance,
  plan: {
    collection: "notes",
    relPath: "clips/example.md",
    outcome: "created",
    provenanceConflict: false,
  },
} satisfies BrowserClipPreview & { schemaVersion: "1.0" };

export const receiptResponse = {
  schemaVersion: "1.0",
  uri: "gno://notes/clips/example.md",
  collection: "notes",
  relPath: "clips/example.md",
  absPath: "/tmp/notes/clips/example.md",
  created: true,
  openedExisting: false,
  createdWithSuffix: false,
  overwritten: false,
  contentHash: "2".repeat(64),
  source,
  tags: ["browser"],
  sync: { status: "completed" },
  embed: { status: "not_requested" },
  collisionPolicyResult: "created",
} satisfies CaptureReceipt & { schemaVersion: "1.0" };

export const jsonResponse = (
  body: unknown,
  status = 200,
  headers?: HeadersInit
): Response =>
  Response.json(body, {
    status,
    headers,
  });
