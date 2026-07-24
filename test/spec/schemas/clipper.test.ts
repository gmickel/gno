import { beforeAll, describe, expect, test } from "bun:test";

import { prepareBrowserClip } from "../../../src/core/browser-clip";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const schemas = new Map<string, object>();

beforeAll(async () => {
  for (const name of [
    "clipper-pair-start",
    "clipper-pair-status",
    "clipper-pair-approval",
    "clipper-revoke",
    "clipper-csrf",
    "clipper-error",
    "browser-clip-preview",
  ]) {
    schemas.set(name, await loadSchema(name));
  }
});

const schema = (name: string): object => {
  const loaded = schemas.get(name);
  if (!loaded) throw new Error(`Missing test schema: ${name}`);
  return loaded;
};

const prepared = prepareBrowserClip(
  {
    schemaVersion: "1.0",
    mode: "selection",
    sourceUrl: "https://example.com/article",
    canonicalUrl: null,
    title: "Article",
    author: null,
    site: null,
    publishedAt: null,
    observedAt: "2026-07-24T10:00:00.000Z",
    browser: { name: "Chromium", version: null, platform: null },
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
    tags: ["web"],
    note: null,
    selection: { exactText: "Visible body", editedMarkdown: null },
  },
  { now: new Date("2026-07-24T10:01:00.000Z") }
);

const fixtures = {
  "clipper-pair-start": {
    schemaVersion: "1.0",
    pairId: "a".repeat(64),
    pairingCode: "12345678",
    expiresAt: "2026-07-24T10:05:00.000Z",
    origin: `chrome-extension://${"a".repeat(32)}`,
    approvalPath: "/api/clipper/pair/approve",
  },
  "clipper-pair-status": {
    schemaVersion: "1.0",
    status: "approved",
    grantId: "123e4567-e89b-42d3-a456-426614174000",
    grantToken: "b".repeat(64),
    expiresAt: "2026-08-23T10:00:00.000Z",
  },
  "clipper-pair-approval": {
    schemaVersion: "1.0",
    status: "approved",
    origin: `chrome-extension://${"a".repeat(32)}`,
    expiresAt: "2026-08-23T10:00:00.000Z",
  },
  "clipper-revoke": {
    schemaVersion: "1.0",
    grantId: "123e4567-e89b-42d3-a456-426614174000",
    status: "revoked",
    revokedAt: "2026-07-24T10:02:00.000Z",
  },
  "clipper-csrf": {
    schemaVersion: "1.0",
    csrfToken: "c".repeat(64),
  },
  "clipper-error": {
    error: {
      code: "CLIPPER_UNAUTHORIZED",
      message: "Unauthorized",
    },
  },
  "browser-clip-preview": {
    schemaVersion: "1.0",
    preview: prepared.preview,
    provenance: prepared.provenance,
    plan: {
      collection: "notes",
      relPath: "clips/article.md",
      outcome: "created",
      provenanceConflict: false,
    },
  },
} as const;

describe("browser clipper response schemas", () => {
  test("accepts every closed successful response", () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      expect(assertValid(fixture, schema(name))).toBe(true);
    }
  });

  test("rejects extension fields on every response root", () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      expect(
        assertInvalid({ ...fixture, leakedToken: "secret" }, schema(name))
      ).toBe(true);
    }
  });

  test("keeps one-time delivery and revocation states coherent", () => {
    expect(
      assertInvalid(
        {
          schemaVersion: "1.0",
          status: "pending",
          grantToken: "b".repeat(64),
          expiresAt: "2026-07-24T10:05:00.000Z",
        },
        schema("clipper-pair-status")
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...fixtures["clipper-revoke"],
          status: "already_revoked",
        },
        schema("clipper-revoke")
      )
    ).toBe(true);
  });

  test("closes preview planning and error details", () => {
    const preview = fixtures["browser-clip-preview"];
    expect(
      assertInvalid(
        {
          ...preview,
          preview: { ...preview.preview, rawHtml: "<article>" },
        },
        schema("browser-clip-preview")
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...preview,
          plan: { ...preview.plan, absPath: "/private/note.md" },
        },
        schema("browser-clip-preview")
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          error: {
            ...fixtures["clipper-error"].error,
            details: { token: "secret" },
          },
        },
        schema("clipper-error")
      )
    ).toBe(true);
  });
});
