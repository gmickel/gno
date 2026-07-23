import { beforeAll, describe, expect, test } from "bun:test";

import type { Collection } from "../../src/config/types";
import type { DocumentRow, StorePort, TagRow } from "../../src/store/types";

import {
  buildEncryptedPublishArtifact,
  buildPublicPublishManifest,
  buildPublishArtifact,
  type PublishArtifactNote,
} from "../../src/publish/artifact";
import {
  MAX_ENCRYPTED_KEY_MATERIAL_BASE64_LENGTH,
  MAX_ENCRYPTED_SECRET_TOKEN_LENGTH,
} from "../../src/publish/artifact-validation";
import { exportPublishArtifact } from "../../src/publish/export-service";
import { buildExportedMetadata } from "../../src/publish/metadata";
import { ok } from "../../src/store/types";
import {
  assertInvalid,
  assertValid,
  loadSchema,
} from "../spec/schemas/validator";

const PUBLISHED_MARKDOWN =
  "# Atlas\n\nThe public decision owner is Mina.\nReview is due Friday.";

const NOTE: PublishArtifactNote = {
  markdown: PUBLISHED_MARKDOWN,
  metadata: {
    audience: "public",
    topics: ["decisions", "operations"],
  },
  slug: "atlas",
  summary: "Public decision record.",
  title: "Atlas",
};

const buildDocument = (
  overrides: Partial<DocumentRow> & Pick<DocumentRow, "id" | "relPath">
): DocumentRow => ({
  active: true,
  collection: "atlas",
  converterId: "markdown",
  converterVersion: "1",
  createdAt: "2026-07-23T10:00:00.000Z",
  docid: `#${overrides.id.toString().padStart(8, "0")}`,
  ingestVersion: 1,
  languageHint: "en",
  lastErrorAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  mirrorHash: overrides.id.toString().repeat(64).slice(0, 64),
  sourceExt: ".md",
  sourceHash: (overrides.id + 2).toString().repeat(64).slice(0, 64),
  sourceMime: "text/markdown",
  sourceMtime: "2026-07-23T10:00:00.000Z",
  sourceSize: 100,
  title: null,
  updatedAt: "2026-07-23T10:00:00.000Z",
  uri: `gno://atlas/${overrides.relPath}`,
  ...overrides,
});

const compileTimePublicOnlyGuard = (): void => {
  buildPublicPublishManifest({
    exportedAt: "2026-07-23T10:00:00.000Z",
    notes: [NOTE],
    routeSlug: "atlas",
    sourceType: "note",
    summary: NOTE.summary,
    title: NOTE.title,
    // @ts-expect-error Public manifests cannot be activated for invite-only spaces.
    visibility: "invite-only",
  });
};
void compileTimePublicOnlyGuard;

describe("publish artifact contract", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("publish-artifact");
  });

  test("builds deterministic public evidence from the published Markdown projection", () => {
    const secondNote: PublishArtifactNote = {
      markdown: "# Zeta\n\nPublished appendix.",
      slug: "zeta",
      summary: "Appendix.",
      title: "Zeta",
    };
    const first = buildPublishArtifact({
      homeNoteSlug: "atlas",
      notes: [secondNote, NOTE],
      routeSlug: "decision-room",
      sourceType: "collection",
      summary: "Published decisions.",
      title: "Decision room",
      visibility: "public",
    });
    const second = buildPublishArtifact({
      homeNoteSlug: "atlas",
      notes: [NOTE, secondNote],
      routeSlug: "decision-room",
      sourceType: "collection",
      summary: "Published decisions.",
      title: "Decision room",
      visibility: "public",
    });

    const space = first.spaces[0];
    expect(space?.visibility).toBe("public");
    if (!space || space.visibility !== "public") {
      throw new Error("Expected a public artifact space");
    }

    expect(space.manifest.schemaVersion).toBe("1.0");
    expect(space.manifest.visibility).toBe("public");
    expect(space.manifest.capabilities).toEqual({
      capsuleEvidence: true,
      exactLineCitations: true,
      llmsTxt: true,
      markdownDocuments: true,
    });
    expect(space.manifest.documents.map((document) => document.slug)).toEqual([
      "atlas",
      "zeta",
    ]);

    const document = space.manifest.documents[0];
    expect(document?.markdownPath).toBe("./atlas.md");
    expect(document?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(document?.byteLength).toBe(
      new TextEncoder().encode(PUBLISHED_MARKDOWN).byteLength
    );
    expect(document?.lineCount).toBe(PUBLISHED_MARKDOWN.split("\n").length);
    expect(document?.evidence).toMatchObject({
      docid: `#${document?.contentHash.slice(0, 8)}`,
      endLine: PUBLISHED_MARKDOWN.split("\n").length,
      locator: `./atlas.md#L1-L${PUBLISHED_MARKDOWN.split("\n").length}`,
      mirrorHash: document?.contentHash,
      passageHash: document?.contentHash,
      sourceHash: document?.contentHash,
      startLine: 1,
      uri: "gno://public/decision-room/atlas.md",
    });
    expect(document?.evidence.evidenceId).toMatch(/^[a-f0-9]{64}$/);
    expect(space.manifest.projectionRevision).toBe(
      second.spaces[0]?.visibility === "public"
        ? second.spaces[0].manifest.projectionRevision
        : ""
    );
    expect(assertValid(first, schema)).toBe(true);
  });

  test("excludes unpublished content and local source paths from artifact bytes and revision inputs", async () => {
    const published = buildDocument({
      id: 1,
      relPath: "public/atlas.md",
      title: "Atlas",
    });
    const draft = buildDocument({
      id: 2,
      relPath: "private/draft.md",
      title: "Private draft",
    });
    const content = new Map([
      [
        published.mirrorHash ?? "",
        `---\ntitle: Atlas\ncanonical: /Users/gordon/private-client-vault/atlas.md\npassword: frontmatter-secret\n---\n\n${PUBLISHED_MARKDOWN}\n\n[[_internal/private-plan.md]]`,
      ],
      [
        draft.mirrorHash ?? "",
        "---\npublish: false\n---\n\nPRIVATE_DRAFT_SENTINEL",
      ],
    ]);
    const tags = new Map<number, TagRow[]>();
    const store = {
      getContentBatch: async () => ok(content),
      getTagsBatch: async () => ok(tags),
      listDocuments: async () => ok([published, draft]),
    } as unknown as StorePort;
    const collections: Collection[] = [
      {
        exclude: [],
        include: [],
        name: "atlas",
        path: "/Users/gordon/private-client-vault",
        pattern: "**/*",
      },
    ];

    const { artifact } = await exportPublishArtifact({
      collections,
      options: { routeSlug: "public-atlas", visibility: "public" },
      store,
      target: "atlas",
    });
    const serialized = JSON.stringify(artifact);

    expect(artifact.source).toBe("public-atlas");
    expect(serialized).not.toContain("/Users/gordon");
    expect(serialized).not.toContain("private/draft.md");
    expect(serialized).not.toContain("PRIVATE_DRAFT_SENTINEL");
    expect(serialized).not.toContain("frontmatter-secret");
    expect(serialized).not.toContain("sourceRelPath");
    expect(serialized).not.toContain("_internal/private-plan.md");
    expect(assertValid(artifact, schema)).toBe(true);
  });

  test("forbids agent manifests and capability flags on restricted or encrypted artifacts", () => {
    const restricted = buildPublishArtifact({
      notes: [NOTE],
      routeSlug: "atlas",
      sourceType: "note",
      summary: NOTE.summary,
      title: NOTE.title,
      visibility: "invite-only",
    });
    const encrypted = buildEncryptedPublishArtifact({
      encryptedPayload: {
        ciphertext: "Y2lwaGVydGV4dA==",
        iterations: 210_000,
        iv: "aXY=",
        salt: "c2FsdA==",
      },
      routeSlug: "atlas",
      secretToken: "opaque-token",
      sourceType: "note",
    });
    const restrictedBytes = JSON.stringify(restricted);
    const encryptedBytes = JSON.stringify(encrypted);

    for (const bytes of [restrictedBytes, encryptedBytes]) {
      expect(bytes).not.toContain('"manifest"');
      expect(bytes).not.toContain('"capabilities"');
      expect(bytes).not.toContain("llmsTxt");
      expect(bytes).not.toContain("privateAgent");
      expect(bytes).not.toContain("inviteAgent");
    }
    expect(assertValid(restricted, schema)).toBe(true);
    expect(assertValid(encrypted, schema)).toBe(true);

    const publicArtifact = buildPublishArtifact({
      notes: [NOTE],
      routeSlug: "atlas",
      sourceType: "note",
      summary: NOTE.summary,
      title: NOTE.title,
      visibility: "public",
    });
    const publicManifest =
      publicArtifact.spaces[0]?.visibility === "public"
        ? publicArtifact.spaces[0].manifest
        : null;
    expect(publicManifest).not.toBeNull();
    expect(
      assertInvalid(
        {
          ...restricted,
          spaces: [{ ...restricted.spaces[0], manifest: publicManifest }],
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...encrypted,
          spaces: [{ ...encrypted.spaces[0], manifest: publicManifest }],
        },
        schema
      )
    ).toBe(true);
  });

  test("fails closed when V1 builder inputs cannot satisfy the schema", () => {
    const validInput = {
      notes: [NOTE],
      routeSlug: "atlas",
      sourceType: "note" as const,
      summary: NOTE.summary,
      title: NOTE.title,
      visibility: "public" as const,
    };

    expect(() => buildPublishArtifact({ ...validInput, notes: [] })).toThrow(
      /at least one note/iu
    );
    expect(() =>
      buildPublishArtifact({ ...validInput, routeSlug: "Atlas/private" })
    ).toThrow(/valid publish slug/iu);
    expect(() => buildPublishArtifact({ ...validInput, title: "   " })).toThrow(
      /must not be blank/iu
    );
    expect(() =>
      buildPublishArtifact({
        ...validInput,
        notes: [{ ...NOTE, slug: "bad_slug" }],
      })
    ).toThrow(/valid publish slug/iu);
    expect(() =>
      buildPublishArtifact({ ...validInput, notes: [NOTE, { ...NOTE }] })
    ).toThrow(/duplicate note slug/iu);
    expect(() =>
      buildPublishArtifact({ ...validInput, homeNoteSlug: "missing" })
    ).toThrow(/not present in notes/iu);
    expect(() =>
      buildPublishArtifact({
        ...validInput,
        visibility: "encrypted" as never,
      })
    ).toThrow(/visibility must be/iu);
    expect(() =>
      buildPublicPublishManifest({
        exportedAt: "2026-07-23T10:00:00.000Z",
        ...validInput,
        notes: [],
      })
    ).toThrow(/at least one note/iu);

    const projected = buildPublishArtifact({
      ...validInput,
      notes: [
        {
          ...NOTE,
          ignored: "not part of the contract",
          metadata: { topics: ["decisions"] },
        } as PublishArtifactNote,
      ],
    });
    expect(projected.spaces[0]?.notes[0]).not.toHaveProperty("ignored");
    expect(assertValid(projected, schema)).toBe(true);
  });

  test("fails closed and projects only schema-valid encrypted V2 fields", () => {
    const validInput = {
      encryptedPayload: {
        ciphertext: "Y2lwaGVydGV4dA==",
        iterations: 210_000,
        iv: "aXY=",
        salt: "c2FsdA==",
      },
      routeSlug: "atlas",
      secretToken: "opaque-token",
      sourceType: "note" as const,
    };
    const artifact = buildEncryptedPublishArtifact({
      ...validInput,
      encryptedPayload: {
        ...validInput.encryptedPayload,
        ignored: "not part of the contract",
      },
      exportedAt: "not-caller-controlled",
      ignored: "not part of the contract",
      visibility: "public",
    } as Parameters<typeof buildEncryptedPublishArtifact>[0]);

    expect(artifact.spaces[0]).not.toHaveProperty("ignored");
    expect(artifact.spaces[0]?.encryptedPayload).not.toHaveProperty("ignored");
    expect(artifact.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(artifact.spaces[0]?.visibility).toBe("encrypted");
    expect(assertValid(artifact, schema)).toBe(true);

    for (const field of ["ciphertext", "iv", "salt"] as const) {
      expect(() =>
        buildEncryptedPublishArtifact({
          ...validInput,
          encryptedPayload: {
            ...validInput.encryptedPayload,
            [field]: "",
          },
        })
      ).toThrow(/must not be blank/iu);
    }
    expect(() =>
      buildEncryptedPublishArtifact({
        ...validInput,
        encryptedPayload: {
          ...validInput.encryptedPayload,
          ciphertext: "not-base64",
        },
      })
    ).toThrow(/valid base64/iu);
    expect(() =>
      buildEncryptedPublishArtifact({
        ...validInput,
        encryptedPayload: {
          ...validInput.encryptedPayload,
          iv: "A".repeat(MAX_ENCRYPTED_KEY_MATERIAL_BASE64_LENGTH + 4),
        },
      })
    ).toThrow(/must not exceed/iu);
    for (const iterations of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        buildEncryptedPublishArtifact({
          ...validInput,
          encryptedPayload: {
            ...validInput.encryptedPayload,
            iterations,
          },
        })
      ).toThrow(/positive safe integer/iu);
    }
    expect(() =>
      buildEncryptedPublishArtifact({
        ...validInput,
        routeSlug: "Atlas/private",
      })
    ).toThrow(/valid publish slug/iu);
    expect(() =>
      buildEncryptedPublishArtifact({
        ...validInput,
        sourceType: "workspace" as never,
      })
    ).toThrow(/sourceType must be/iu);
    for (const secretToken of [
      "",
      "   ",
      "x".repeat(MAX_ENCRYPTED_SECRET_TOKEN_LENGTH + 1),
    ]) {
      expect(() =>
        buildEncryptedPublishArtifact({ ...validInput, secretToken })
      ).toThrow(/secretToken/iu);
    }
  });

  test("filters embedded local references and non-public metadata URLs", () => {
    const doc = {
      author: "Gordon Mickel",
      categories: null,
      contentType: "markdown",
      frontmatterDate: null,
      languageHint: "en",
    };
    const projected = buildExportedMetadata(
      doc,
      {
        audience: "Source: /Users/gordon/private/atlas.md",
        canonical: "https://example.com/public/atlas",
        icon: "📚",
        series: "file:///home/gordon/private.md",
        status: "Copied from C:\\Users\\gordon\\private.md",
        subtitle: "See /usr/local/private.md",
        theme: "Public reader docs live in /docs/public",
        topic: [
          "See gno://secret/private.md",
          "Mirror at \\\\server\\share\\private.md",
        ],
      },
      []
    );

    expect(projected).toEqual({
      author: "Gordon Mickel",
      canonical: "https://example.com/public/atlas",
      contentType: "markdown",
      icon: "📚",
      language: "en",
      theme: "Public reader docs live in /docs/public",
    });

    const nonPublicUrls = [
      "http://localhost/private",
      "http://service.internal/private",
      "http://127.0.0.1/private",
      "http://10.0.0.4/private",
      "http://169.254.169.254/private",
      "http://172.16.0.4/private",
      "http://192.168.1.4/private",
      "http://[::1]/private",
      "http://[fc00::1]/private",
      "https://user:password@example.com/private",
    ];
    for (const canonical of nonPublicUrls) {
      expect(buildExportedMetadata(doc, { canonical }, [])).not.toHaveProperty(
        "canonical"
      );
    }
  });
});
