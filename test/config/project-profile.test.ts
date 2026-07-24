import Ajv from "ajv";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory and symlink APIs without Bun equivalents.
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import projectProfileJsonSchema from "../../spec/project-profile.schema.json";
import {
  PROJECT_PROFILE_FINGERPRINT_DOMAIN,
  ProjectProfileSchema,
} from "../../src/config/project-profile";
import {
  canonicalProjectProfileJson,
  compileProjectProfileYaml,
} from "../../src/core/project-profile";
import { safeRm } from "../helpers/cleanup";

const tempRoots: string[] = [];
const validateJsonSchema = new Ajv({
  strict: true,
  allErrors: true,
}).compile(projectProfileJsonSchema);

const PROFILE = `
schemaVersion: "1.0"
collection:
  name: project-notes
  root: .
  include:
    - "**/*.md"
  exclude:
    - node_modules
  languageHint: en
  modelPreset: slim-tuned
contexts:
  - file: AGENTS.md
  - text: Prefer primary sources.
contentTypes:
  - id: people
    prefixes: [people]
    preset: person
    graphHints: [works_at, mentions]
affinityDefaults:
  enabled: true
  contribution: 0.03
recommendedCapabilities: [workspace.read, search]
`;

const makeRoot = async (label: string, context = "Project guidance\n") => {
  const root = await mkdtemp(join(tmpdir(), `gno-profile-${label}-`));
  tempRoots.push(root);
  await Bun.write(join(root, "AGENTS.md"), context);
  return root;
};

const compile = (yaml: string, profileRoot: string) =>
  compileProjectProfileYaml(yaml, {
    profileRoot,
    isModelAvailableOffline: async () => true,
  });

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("project profile schema", () => {
  test("is strict recursively and the Draft-07 contract matches", () => {
    const parsed = Bun.YAML.parse(PROFILE);
    expect(ProjectProfileSchema.safeParse(parsed).success).toBe(true);

    expect(validateJsonSchema(parsed)).toBe(true);

    const forbidden = {
      ...(parsed as Record<string, unknown>),
      hooks: { afterApply: "curl example.invalid" },
    };
    expect(ProjectProfileSchema.safeParse(forbidden).success).toBe(false);
    expect(validateJsonSchema(forbidden)).toBe(false);

    const nestedSecret = structuredClone(parsed) as {
      collection: Record<string, unknown>;
    };
    nestedSecret.collection.apiKey = "secret";
    expect(ProjectProfileSchema.safeParse(nestedSecret).success).toBe(false);
    expect(validateJsonSchema(nestedSecret)).toBe(false);
    expect(projectProfileJsonSchema.$schema).toBe(
      "http://json-schema.org/draft-07/schema#"
    );
  });

  test.each([
    ["/tmp/notes", "POSIX absolute"],
    ["\\rooted", "Windows rooted"],
    ["C:\\notes", "Windows absolute"],
    ["\\\\server\\share", "UNC"],
    ["C:notes", "drive-relative"],
    ["notes/../private", "traversal"],
    ["${PROJECT_ROOT}/notes", "environment expansion"],
    [".gno/index.sqlite", "runtime database"],
    ["models/embed.gguf", "runtime model"],
  ])("rejects %s (%s)", (root) => {
    const result = ProjectProfileSchema.safeParse({
      schemaVersion: "1.0",
      collection: { name: "notes", root },
    });
    expect(result.success).toBe(false);
    expect(
      validateJsonSchema({
        schemaVersion: "1.0",
        collection: { name: "notes", root },
      })
    ).toBe(false);
  });

  test("rejects NUL paths, raw model URIs, hooks, and runtime path fields", () => {
    for (const collection of [
      { name: "notes", root: "docs\0private" },
      { name: "notes", include: ["**/*.sqlite"] },
      { name: "notes", modelPreset: "hf:owner/model/file.gguf" },
      { name: "notes", updateCmd: "make index" },
      { name: "notes", databasePath: ".gno/index.sqlite" },
    ]) {
      expect(
        ProjectProfileSchema.safeParse({
          schemaVersion: "1.0",
          collection,
        }).success
      ).toBe(false);
    }
  });
});

describe("project profile compiler", () => {
  test("keeps desired state and fingerprint machine-neutral", async () => {
    const firstRoot = await makeRoot("first");
    const secondRoot = await makeRoot("second");
    const [first, second] = await Promise.all([
      compile(PROFILE, firstRoot),
      compile(PROFILE, secondRoot),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;

    expect(first.value.desiredState).toEqual(second.value.desiredState);
    expect(first.value.canonicalJson).toBe(second.value.canonicalJson);
    expect(first.value.fingerprint).toBe(second.value.fingerprint);
    expect(first.value.resolvedPaths.profileRoot).not.toBe(
      second.value.resolvedPaths.profileRoot
    );
    expect(first.value.resolvedPaths.contextFiles[0]?.absolutePath).not.toBe(
      second.value.resolvedPaths.contextFiles[0]?.absolutePath
    );
    expect(first.value.desiredState.collection.exclude).toContain(".gno");
    expect(first.value.desiredState.contexts).toContainEqual(
      expect.objectContaining({
        scopeType: "collection",
        scopeKey: "project-notes:",
        source: expect.objectContaining({
          kind: "file",
          path: "AGENTS.md",
        }),
      })
    );
  });

  test("uses the versioned domain and exact context file bytes", async () => {
    const firstRoot = await makeRoot("bytes-a", "same visible text\n");
    const secondRoot = await makeRoot("bytes-b", "same visible text\r\n");
    const first = await compile(PROFILE, firstRoot);
    const second = await compile(PROFILE, secondRoot);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;

    expect(first.value.fingerprint).not.toBe(second.value.fingerprint);
    const expected = new Bun.CryptoHasher("sha256")
      .update(
        `${PROJECT_PROFILE_FINGERPRINT_DOMAIN}${canonicalProjectProfileJson(
          first.value.desiredState
        )}`
      )
      .digest("hex");
    expect(first.value.fingerprint).toBe(expected);
  });

  test("rejects collection and context symlink escapes", async () => {
    const root = await makeRoot("symlink-root");
    const outside = await makeRoot("symlink-outside", "private\n");
    await symlink(outside, join(root, "outside"));

    const collectionEscape = await compile(
      `
schemaVersion: "1.0"
collection: { name: notes, root: outside }
`,
      root
    );
    expect(collectionEscape).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "SYMLINK_ESCAPE",
          path: "collection.root",
        }),
      ],
    });

    const contextEscape = await compile(
      `
schemaVersion: "1.0"
collection: { name: notes }
contexts:
  - file: outside/AGENTS.md
`,
      root
    );
    expect(contextEscape).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "SYMLINK_ESCAPE",
          path: "contexts[0].file",
        }),
      ],
    });
  });

  test.each([
    [
      `schemaVersion: "2.0"\ncollection: { name: notes }\n`,
      "UNSUPPORTED_SCHEMA_MAJOR",
    ],
    [
      `schemaVersion: "1.1"\ncollection: { name: notes }\n`,
      "UNSUPPORTED_SCHEMA_MINOR",
    ],
    [`collection: { name: notes }\n`, "MIGRATION_REQUIRED"],
  ])("returns an explicit migration diagnostic", async (yaml, code) => {
    const root = await makeRoot(`version-${code}`);
    const result = await compile(yaml, root);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code, path: "schemaVersion" })],
    });
  });

  test("reports exact alias lookup and offline cache misses without model URIs", async () => {
    const root = await makeRoot("models");
    const unknown = await compile(
      `
schemaVersion: "1.0"
collection: { name: notes, modelPreset: missing }
`,
      root
    );
    expect(unknown).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "MODEL_PRESET_NOT_FOUND" }),
      ],
    });

    const checkedTypes: string[] = [];
    const unavailable = await compileProjectProfileYaml(PROFILE, {
      profileRoot: root,
      isModelAvailableOffline: async (_uri, modelType) => {
        checkedTypes.push(modelType);
        return modelType === "embed";
      },
    });
    expect(checkedTypes).toEqual(["embed", "rerank", "expand", "gen"]);
    expect(unavailable).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "MODEL_PRESET_UNAVAILABLE_OFFLINE",
          path: "collection.modelPreset",
        }),
      ],
    });
    if (unavailable.ok) return;
    const serialized = JSON.stringify(unavailable.diagnostics);
    expect(serialized).not.toContain("hf:");
    expect(serialized).not.toContain(".gguf");
    expect(serialized).toBe(
      JSON.stringify(
        unavailable.diagnostics
          .slice()
          .sort((a, b) => a.path.localeCompare(b.path))
      )
    );
  });

  test("does not resolve environment expansion before validation", async () => {
    const root = await makeRoot("environment");
    const result = await compile(
      `
schemaVersion: "1.0"
collection: { name: notes }
contexts:
  - file: "\${HOME}/AGENTS.md"
`,
      root
    );
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "UNSAFE_PATH",
          path: "contexts[0].file",
        }),
      ],
    });
  });

  test("resolves a real collection subdirectory separately from logical state", async () => {
    const root = await makeRoot("subdir");
    await mkdir(join(root, "docs"));
    const result = await compile(
      `
schemaVersion: "1.0"
collection:
  name: notes
  root: docs
`,
      root
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.desiredState.collection.root).toBe("docs");
    expect(result.value.resolvedPaths.collectionRoot).toBe(
      join(await realpath(root), "docs")
    );
    expect(result.value.canonicalJson).not.toContain(root);
  });
});
