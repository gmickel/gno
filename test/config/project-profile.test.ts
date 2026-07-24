import Ajv from "ajv";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory and symlink APIs without Bun equivalents.
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import projectProfileJsonSchema from "../../spec/project-profile.schema.json";
import { createDefaultConfig } from "../../src/config/defaults";
import {
  PROJECT_PROFILE_FINGERPRINT_DOMAIN,
  ProjectProfileSchema,
} from "../../src/config/project-profile";
import {
  canonicalProjectProfileJson,
  compileProjectProfileYaml,
  PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES,
  projectProfileIncludePattern,
} from "../../src/core/project-profile";
import { FileWalker } from "../../src/ingestion/walker";
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
  people:
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

  test.each([
    [
      "duplicate include",
      { collection: { name: "notes", include: ["**/*.md", "**/*.md"] } },
    ],
    [
      "duplicate exclude",
      { collection: { name: "notes", exclude: ["dist", "dist"] } },
    ],
    [
      "duplicate context",
      {
        collection: { name: "notes" },
        contexts: [{ text: "same" }, { text: "same" }],
      },
    ],
    [
      "uppercase runtime directory",
      { collection: { name: "notes", root: ".GNO/state" } },
    ],
    [
      "uppercase runtime model",
      { collection: { name: "notes", include: ["models/EMBED.GGUF"] } },
    ],
    [
      "brace traversal",
      { collection: { name: "notes", include: ["docs/{safe,../private}/**"] } },
    ],
    [
      "POSIX absolute brace alternative",
      { collection: { name: "notes", include: ["docs/{safe,/etc}/**"] } },
    ],
    [
      "nested Windows absolute brace alternative",
      {
        collection: {
          name: "notes",
          include: ["docs/{safe,{nested,C:\\private}}/**"],
        },
      },
    ],
    [
      "Windows reserved name",
      { collection: { name: "notes", root: "docs/CON" } },
    ],
    [
      "Windows reserved extension",
      { collection: { name: "notes", root: "docs/aux.txt" } },
    ],
    [
      "Windows invalid colon",
      { collection: { name: "notes", root: "docs/a:b" } },
    ],
    [
      "Windows trailing dot",
      { collection: { name: "notes", root: "docs/name." } },
    ],
    [
      "Windows trailing space",
      { collection: { name: "notes", root: "docs/name " } },
    ],
    [
      "Windows reserved name in brace alternative",
      { collection: { name: "notes", include: ["docs/{safe,CON}/**"] } },
    ],
    [
      "Windows reserved extension in brace alternative",
      { collection: { name: "notes", include: ["docs/{safe,aux.txt}/**"] } },
    ],
    [
      "Windows trailing dot in brace alternative",
      { collection: { name: "notes", include: ["docs/{safe,name.}/**"] } },
    ],
    [
      "Windows trailing space in brace alternative",
      { collection: { name: "notes", include: ["docs/{safe,name }/**"] } },
    ],
    [
      "composed brace traversal",
      { collection: { name: "notes", include: ["docs/.{.,safe}/**"] } },
    ],
    [
      "composed trailing dot",
      { collection: { name: "notes", include: ["docs/name{.,x}"] } },
    ],
    [
      "composed Windows reserved name",
      { collection: { name: "notes", include: ["docs/C{ON,AT}/**"] } },
    ],
    [
      "composed Windows reserved extension",
      { collection: { name: "notes", include: ["docs/a{ux,bc}.txt"] } },
    ],
    [
      "split composed Windows reserved name",
      { collection: { name: "notes", include: ["docs/{C,A}ON/**"] } },
    ],
    [
      "suffix-composed Windows reserved name",
      { collection: { name: "notes", include: ["docs/C{O,AT}N/**"] } },
    ],
    [
      "split composed Windows reserved extension",
      { collection: { name: "notes", include: ["docs/{a,b}ux.txt"] } },
    ],
    [
      "secret context path",
      {
        collection: { name: "notes" },
        contexts: [{ file: "config/.env.local" }],
      },
    ],
  ])("keeps Zod and Draft-07 parity for %s", (_label, partial) => {
    const candidate = { schemaVersion: "1.0", ...partial };
    expect(ProjectProfileSchema.safeParse(candidate).success).toBe(false);
    expect(validateJsonSchema(candidate)).toBe(false);
  });

  test("keys content-type rules by their structurally unique IDs", () => {
    const candidate = {
      schemaVersion: "1.0",
      collection: { name: "notes" },
      contentTypes: {
        people: { prefixes: ["people"], preset: "person" },
        meetings: { prefixes: ["team"], preset: "meeting" },
      },
    };
    expect(ProjectProfileSchema.safeParse(candidate).success).toBe(true);
    expect(validateJsonSchema(candidate)).toBe(true);

    const legacyArray = {
      ...candidate,
      contentTypes: [{ id: "people", prefixes: ["people"], preset: "person" }],
    };
    expect(ProjectProfileSchema.safeParse(legacyArray).success).toBe(false);
    expect(validateJsonSchema(legacyArray)).toBe(false);

    const invalidId = {
      ...candidate,
      contentTypes: {
        "People Notes": { prefixes: ["people"], preset: "person" },
      },
    };
    expect(ProjectProfileSchema.safeParse(invalidId).success).toBe(false);
    expect(validateJsonSchema(invalidId)).toBe(false);

    const tooManyRules = {
      ...candidate,
      contentTypes: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `type-${index}`,
          { prefixes: [`type-${index}`], preset: "project-note" },
        ])
      ),
    };
    expect(ProjectProfileSchema.safeParse(tooManyRules).success).toBe(false);
    expect(validateJsonSchema(tooManyRules)).toBe(false);
  });

  test("keeps bounded searchBoost validation in Zod and Draft-07 parity", () => {
    for (const searchBoost of [0.5, 1, 2]) {
      const candidate = {
        schemaVersion: "1.0",
        collection: { name: "notes" },
        contentTypes: {
          people: { prefixes: ["people"], preset: "person", searchBoost },
        },
      };
      expect(ProjectProfileSchema.safeParse(candidate).success).toBe(true);
      expect(validateJsonSchema(candidate)).toBe(true);
    }

    for (const searchBoost of [0.49, 2.01]) {
      const candidate = {
        schemaVersion: "1.0",
        collection: { name: "notes" },
        contentTypes: {
          people: { prefixes: ["people"], preset: "person", searchBoost },
        },
      };
      expect(ProjectProfileSchema.safeParse(candidate).success).toBe(false);
      expect(validateJsonSchema(candidate)).toBe(false);
    }
  });

  test("accepts multiple brace-free include entries with exact schema parity", () => {
    const candidate = {
      schemaVersion: "1.0",
      collection: {
        name: "notes",
        include: ["docs/**/*.md", "src/**/*.ts", "src/**/*.tsx"],
      },
    };
    expect(ProjectProfileSchema.safeParse(candidate).success).toBe(true);
    expect(validateJsonSchema(candidate)).toBe(true);
  });

  test("scans canonical include unions while preserving literal and bracket-class commas", async () => {
    const pattern = projectProfileIncludePattern([
      "docs/a,b.md",
      "src/**/*.ts",
      "src/**/*.tsx",
      "chars/[a,b].md",
    ]);
    expect(pattern).toBe(
      "{docs/a\\,b.md,src/**/*.ts,src/**/*.tsx,chars/[a,b].md}"
    );
    const root = await makeRoot("include-union");
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "chars"), { recursive: true });
    await Bun.write(join(root, "docs", "a,b.md"), "included");
    await Bun.write(join(root, "docs", "a.md"), "excluded");
    await Bun.write(join(root, "src", "app.ts"), "included");
    await Bun.write(join(root, "src", "app.tsx"), "included");
    await Bun.write(join(root, "chars", "a.md"), "included");
    await Bun.write(join(root, "chars", "b.md"), "included");
    const scanned = await new FileWalker().walk({
      root,
      pattern,
      include: [".md", ".ts", ".tsx"],
      exclude: [],
      maxBytes: 1024,
    });
    expect(scanned.entries.map((entry) => entry.relPath)).toEqual([
      "chars/a.md",
      "chars/b.md",
      "docs/a,b.md",
      "src/app.ts",
      "src/app.tsx",
    ]);
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
    expect(first.value.desiredState.contentTypes).toContainEqual({
      id: "people",
      prefixes: ["people"],
      preset: "person",
      graphHints: ["mentions", "works_at"],
      searchBoost: 1,
    });
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

  test("rejects secret, non-regular, and oversized context files before reading", async () => {
    const root = await makeRoot("context-safety");
    await mkdir(join(root, "guidance"), { recursive: true });
    await Bun.write(
      join(root, "large.txt"),
      "x".repeat(PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES + 1)
    );

    const cases = [
      {
        file: ".env",
        code: "UNSAFE_PATH",
      },
      {
        file: "guidance",
        code: "CONTEXT_FILE_NOT_REGULAR",
      },
      {
        file: "large.txt",
        code: "CONTEXT_FILE_TOO_LARGE",
      },
    ] as const;
    for (const item of cases) {
      const result = await compile(
        `schemaVersion: "1.0"\ncollection: { name: notes }\ncontexts:\n  - file: "${item.file}"\n`,
        root
      );
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: item.code,
            path: "contexts[0].file",
          }),
        ],
      });
    }
  });

  test.each([
    [".env", "guidance.txt"],
    ["credentials.json", "account.txt"],
    ["id_ed25519", "key-guidance.txt"],
  ])(
    "rejects a safe-looking context symlink resolving to secret target %s",
    async (secretName, linkName) => {
      const root = await makeRoot(`secret-symlink-${linkName}`);
      await Bun.write(join(root, secretName), "private\n");
      await symlink(secretName, join(root, linkName));

      const result = await compile(
        `schemaVersion: "1.0"\ncollection: { name: notes }\ncontexts:\n  - file: "${linkName}"\n`,
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
    }
  );

  test("accepts a regular UTF-8 context at the exact byte limit", async () => {
    const root = await makeRoot("context-limit");
    await Bun.write(
      join(root, "limit.txt"),
      "x".repeat(PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES)
    );
    const result = await compile(
      'schemaVersion: "1.0"\ncollection: { name: notes }\ncontexts:\n  - file: limit.txt\n',
      root
    );
    expect(result.ok).toBe(true);
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

  test("rejects file-backed models stored inside the profile root", async () => {
    const root = await makeRoot("model-overlap");
    const modelPath = join(root, "models", "embed.gguf");
    await mkdir(join(root, "models"), { recursive: true });
    await Bun.write(modelPath, "GGUF");
    const config = createDefaultConfig();
    config.models = {
      activePreset: "local",
      presets: [
        {
          id: "local",
          name: "Local",
          embed: `file:${modelPath}`,
          rerank: "hf:owner/rerank/rerank.gguf",
          expand: "hf:owner/expand/expand.gguf",
          gen: "hf:owner/gen/gen.gguf",
        },
      ],
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      expandContextSize: 2_048,
      warmModelTtl: 300_000,
    };

    const result = await compileProjectProfileYaml(
      'schemaVersion: "1.0"\ncollection: { name: notes, modelPreset: local }\n',
      { profileRoot: root, config }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "MODEL_PATH_OVERLAP",
          path: "collection.modelPreset",
        }),
      ],
    });
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
