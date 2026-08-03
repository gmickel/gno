/**
 * SDK section-target create/resolve tests using the shared semantic matrix.
 */

import {
  createDefaultConfig,
  createGnoClient,
  GnoSdkError,
  type GnoClient,
  type SectionTargetResolveResult,
} from "@gmickel/gno";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no atomic temporary-directory creation API.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import createResultSchema from "../../spec/output-schemas/section-target-create-result.schema.json";
import resolveResultSchema from "../../spec/output-schemas/section-target-resolve-result.schema.json";
import targetSchema from "../../spec/output-schemas/section-target.schema.json";
import {
  CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
  SECTION_TARGET_BOUNDS,
} from "../../src/core/sections";
import { safeRm } from "../helpers/cleanup";
import {
  SECTION_FIXTURE_CONTENT,
  SECTION_SEMANTIC_CASES,
  captureFixtureTarget,
  wrongDocumentTarget,
} from "../helpers/section-target-fixtures";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(targetSchema);
const validateCreate = ajv.compile(createResultSchema);
const validateResolve = ajv.compile(resolveResultSchema);

describe("SDK section targets", () => {
  let testDir: string;
  let client: GnoClient;
  let notesDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-sdk-section-targets-"));
    notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });

    const config = createDefaultConfig();
    config.collections = [
      {
        name: "notes",
        path: notesDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ];

    client = await createGnoClient({
      config,
      dbPath: join(testDir, "index.sqlite"),
    });
  });

  afterAll(async () => {
    await client.close();
    await safeRm(testDir);
  });

  async function writeAndIndex(
    relPath: string,
    content: string
  ): Promise<string> {
    const abs = join(notesDir, relPath);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
    await client.index({ noEmbed: true });
    return `gno://notes/${relPath}`;
  }

  test("getSections remains backward compatible", async () => {
    const uri = await writeAndIndex("compat.md", SECTION_FIXTURE_CONTENT);
    const sections = await client.getSections(uri);
    expect(sections.map((section) => section.anchor)).toEqual([
      "guide",
      "setup",
      "usage",
    ]);
    expect(sections[0]).toMatchObject({
      anchor: "guide",
      level: 1,
      title: "Guide",
    });
  });

  for (const fixture of SECTION_SEMANTIC_CASES) {
    test(`create+resolve ${fixture.id}`, async () => {
      const captureUri = await writeAndIndex(
        `${fixture.id}-capture.md`,
        fixture.captureContent
      );
      const created = await client.createSectionTarget(
        captureUri,
        fixture.selector
      );
      expect(validateCreate(created)).toBe(true);
      expect(created.uri).toBe(captureUri);
      expect(created.target.document.uri).toBe(captureUri);

      const resolveUri = await writeAndIndex(
        `${fixture.id}-resolve.md`,
        fixture.resolveContent
      );
      const target = {
        ...created.target,
        document: { uri: resolveUri },
      };
      const resolved: SectionTargetResolveResult =
        await client.resolveSectionTarget(resolveUri, target);
      expect(validateResolve(resolved)).toBe(true);
      expect(resolved.status).toBe(fixture.expectedStatus);
      expect(resolved.uri).toBe(resolveUri);
      if (fixture.navigable) {
        expect(resolved.citation?.uri).toBe(resolveUri);
        expect(resolved.citation?.anchor).toBeTruthy();
      } else {
        expect(resolved.citation).toBeUndefined();
      }
    });
  }

  test("rejects invalid selectors and malformed targets", async () => {
    const uri = await writeAndIndex("validate.md", SECTION_FIXTURE_CONTENT);

    try {
      await client.createSectionTarget(uri, {
        anchor: "setup",
        line: 3,
      } as never);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GnoSdkError);
    }

    try {
      await client.createSectionTarget(uri, {} as never);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION" });
    }

    try {
      await client.resolveSectionTarget(uri, {
        schemaVersion: "1",
      } as never);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION" });
    }
  });

  test("wrong-document target resolves as missing without citation", async () => {
    const uri = await writeAndIndex("wrong-doc.md", SECTION_FIXTURE_CONTENT);
    const wrong = await wrongDocumentTarget(SECTION_FIXTURE_CONTENT);
    const resolved = await client.resolveSectionTarget(uri, wrong);
    expect(validateResolve(resolved)).toBe(true);
    expect(resolved.status).toBe("missing");
    expect(resolved.diagnostics.reason).toBe("document_uri_mismatch");
    expect(resolved.citation).toBeUndefined();
    expect(resolved.uri).toBe(uri);
  });

  test("rejects create/resolve when stored canonical URI exceeds transport bounds", async () => {
    const uri = await writeAndIndex(
      "oversized-canonical.md",
      SECTION_FIXTURE_CONTENT
    );
    const oversizedUri = `gno://notes/${"u".repeat(SECTION_TARGET_BOUNDS.uriMaxChars)}`;
    expect(oversizedUri.length).toBeGreaterThan(
      SECTION_TARGET_BOUNDS.uriMaxChars
    );

    const store = (
      client as unknown as {
        store: {
          getDocumentByUri: (requested: string) => Promise<{
            ok: boolean;
            value?: { uri: string } | null;
            error?: unknown;
          }>;
        };
      }
    ).store;
    const originalGetByUri = store.getDocumentByUri.bind(store);
    store.getDocumentByUri = async (requested: string) => {
      const result = await originalGetByUri(requested);
      if (!result.ok || !result.value) return result;
      return {
        ...result,
        value: { ...result.value, uri: oversizedUri },
      };
    };

    try {
      try {
        await client.createSectionTarget(uri, { anchor: "setup" });
        throw new Error("expected create validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GnoSdkError);
        expect(error).toMatchObject({
          code: "VALIDATION",
          message: CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
        });
      }

      const target = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
        anchor: "setup",
      });
      try {
        await client.resolveSectionTarget(uri, target);
        throw new Error("expected resolve validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GnoSdkError);
        expect(error).toMatchObject({
          code: "VALIDATION",
          message: CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
        });
      }
    } finally {
      store.getDocumentByUri = originalGetByUri;
    }
  });
});
