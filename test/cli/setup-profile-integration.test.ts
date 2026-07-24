import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directory and fixture creation APIs with
// no Bun structural equivalent.
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
// node:os has no Bun temporary-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { ProjectProfileApplyCommandOutcome } from "../../src/cli/commands/profile-apply";

import { getIndexDbPath } from "../../src/app/constants";
import { setupWithActivation } from "../../src/cli/commands/setup-activation";
import { runCli } from "../../src/cli/run";
import { createDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const createdRoots: string[] = [];
const originalDirs = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};
const originalWrites = {
  stdout: process.stdout.write.bind(process.stdout),
  stderr: process.stderr.write.bind(process.stderr),
};

async function createHarness(label: string) {
  const root = await mkdtemp(join(tmpdir(), `gno-setup-profile-${label}-`));
  createdRoots.push(root);
  const project = join(root, "project");
  const docs = join(project, "docs");
  const nested = join(docs, "nested");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, ".gno"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(docs, "notes.md"),
    "# Notes\n\nThe Atlas profile setup proof."
  );
  await writeFile(
    join(nested, "nested.md"),
    "# Nested\n\nThe nested fallback setup proof."
  );
  process.env.GNO_CONFIG_DIR = join(root, "runtime", "config");
  process.env.GNO_DATA_DIR = join(root, "runtime", "data");
  process.env.GNO_CACHE_DIR = join(root, "runtime", "cache");
  return { root, project, docs, nested };
}

async function cli(...args: string[]) {
  let stdout = "";
  let stderr = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalWrites.stdout;
    process.stderr.write = originalWrites.stderr;
  }
}

async function seedRecoveryState(root: string) {
  const config = createDefaultConfig();
  expect((await saveConfig(config)).ok).toBe(true);
  await mkdir(join(root, "runtime", "data"), { recursive: true });

  const store = new SqliteAdapter();
  expect((await store.open(getIndexDbPath(), config.ftsTokenizer)).ok).toBe(
    true
  );
  expect(
    (
      await store.syncCollections([
        {
          name: "recovery",
          path: join(root, "recovery"),
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ])
    ).ok
  ).toBe(true);
  expect(
    (
      await store.syncContexts([
        {
          scopeType: "collection",
          scopeKey: "recovery:",
          text: "Recovery context",
        },
      ])
    ).ok
  ).toBe(true);
  expect(
    (
      await store.upsertDocument({
        collection: "recovery",
        relPath: "evidence.md",
        sourceHash: "a".repeat(64),
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 24,
        sourceMtime: "2026-07-24T00:00:00.000Z",
        title: "Recovery evidence",
        mirrorHash: "b".repeat(64),
        converterId: "native/markdown",
        converterVersion: "1.0.0",
        contentTypeSource: "default",
      })
    ).ok
  ).toBe(true);
  await store.close();
  return config;
}

async function readRecoverySnapshot(
  config: ReturnType<typeof createDefaultConfig>
) {
  const store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), config.ftsTokenizer);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const collections = await store.getCollections();
    const contexts = await store.getContexts();
    const documents = await store.listDocuments("recovery");
    if (!(collections.ok && contexts.ok && documents.ok)) {
      throw new Error("Failed to read recovery-state snapshot");
    }
    return {
      collections: collections.value,
      contexts: contexts.value,
      documents: documents.value,
    };
  } finally {
    await store.close();
  }
}

const validProfileYaml = [
  'schemaVersion: "1.0"',
  "collection:",
  "  name: profiled",
  "  root: docs",
  '  include: ["**/*.md"]',
  "contexts:",
  "  - text: Profile context.",
  "contentTypes: {}",
  "",
].join("\n");

function successfulApplyOutcome(
  collectionName: string,
  options: {
    resultStatus?: "applied" | "unchanged";
    receiptStatus?: "applied" | "unchanged";
  } = {}
): ProjectProfileApplyCommandOutcome {
  const resultStatus = options.resultStatus ?? "applied";
  return {
    exitCode: 0,
    result: {
      schemaVersion: "1.0",
      command: "apply",
      status: resultStatus,
      applied: resultStatus === "applied",
      discovery: {
        status: "found",
        source: "cwd",
        boundary: "repository",
        profile: ".gno/index.yml",
        ambiguous: false,
        shadowedProfiles: 0,
      },
      receipt: {
        schemaVersion: "1.0",
        command: "apply",
        status: options.receiptStatus ?? resultStatus,
        profile: { fingerprint: "a".repeat(64) },
        diff: { status: "in_sync", changes: [], staleMappings: [] },
        resources: [
          {
            kind: "collection",
            id: collectionName,
            disposition: "reused",
            pendingIndexing: false,
          },
        ],
        pendingIndexing: [],
        diagnostics: [],
      },
      diagnostics: [],
    },
  };
}

afterEach(async () => {
  for (const [name, value] of Object.entries(originalDirs)) {
    const key = `GNO_${name.toUpperCase()}_DIR`;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of createdRoots.splice(0)) await safeRm(root);
});

describe("setup project-profile integration", () => {
  test("applies a valid ancestor profile before indexing its declared root", async () => {
    const { project, docs, nested } = await createHarness("apply");
    const canonicalDocs = await realpath(docs);
    await writeFile(
      join(project, ".gno", "index.yml"),
      [
        'schemaVersion: "1.0"',
        "collection:",
        "  name: profiled",
        "  root: docs",
        '  include: ["**/*.md"]',
        "contexts:",
        "  - text: Prefer profile evidence.",
        "contentTypes:",
        "  people:",
        "    prefixes: [people]",
        "    preset: person",
        "affinityDefaults: { enabled: true, contribution: 0.01 }",
        "",
      ].join("\n")
    );

    const result = await cli(
      "setup",
      nested,
      "--apply-profile",
      "--no-semantic",
      "--json"
    );

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      schemaVersion: "1.0",
      status: "completed",
      profile: {
        check: { command: "check", status: "valid" },
        apply: {
          command: "apply",
          status: "applied",
        },
      },
      setup: {
        status: "completed",
        lexical: {
          receipt: {
            input: { folder: canonicalDocs },
            collection: { name: "profiled", path: canonicalDocs },
          },
        },
      },
      connectors: [],
    });
    expect(parsed.profile.apply.receipt.resources).toContainEqual(
      expect.objectContaining({
        kind: "project_affinity",
        disposition: "skipped",
      })
    );
    assertValid(parsed, await loadSchema("setup-profile-result"));
    const config = await loadConfig();
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.collections[0]?.path).toBe(canonicalDocs);
    expect(config.value.contexts).toContainEqual({
      scopeType: "collection",
      scopeKey: "profiled:",
      text: "Prefer profile evidence.",
    });
    expect(config.value.contentTypes?.[0]?.id).toBe("people");
    expect(config.value.projectAffinity?.contribution).toBe(0.03);
    expect(await readdir(join(project, ".gno"))).toEqual(["index.yml"]);
  });

  test("preserves DB-only recovery state through profile apply and full setup", async () => {
    const { root, project, nested } = await createHarness("recovery");
    await writeFile(join(project, ".gno", "index.yml"), validProfileYaml);
    const initialConfig = await seedRecoveryState(root);

    const result = await cli(
      "setup",
      nested,
      "--apply-profile",
      "--no-semantic",
      "--json"
    );
    expect(result.code).toBe(0);

    const verified = new SqliteAdapter();
    expect(
      (await verified.open(getIndexDbPath(), initialConfig.ftsTokenizer)).ok
    ).toBe(true);
    const collections = await verified.getCollections();
    expect(
      collections.ok && collections.value.map((item) => item.name).sort()
    ).toEqual(["profiled", "recovery"]);
    const contexts = await verified.getContexts();
    expect(contexts.ok && contexts.value).toContainEqual(
      expect.objectContaining({
        scopeKey: "recovery:",
        text: "Recovery context",
      })
    );
    const documents = await verified.listDocuments("recovery");
    expect(documents.ok && documents.value).toHaveLength(1);
    await verified.close();
  });

  for (const failure of [
    { status: "invalid" as const, exitCode: 1 as const },
    { status: "failed" as const, exitCode: 2 as const },
  ]) {
    test(`fails closed before setup when profile apply returns ${failure.status}`, async () => {
      const { root, project, nested } = await createHarness(
        `apply-${failure.status}`
      );
      await writeFile(join(project, ".gno", "index.yml"), validProfileYaml);
      const config = await seedRecoveryState(root);
      const configPath = join(process.env.GNO_CONFIG_DIR!, "index.yml");
      const configBefore = await Bun.file(configPath).text();
      const storeBefore = await readRecoverySnapshot(config);

      const outcome = await setupWithActivation({
        folder: nested,
        applyProfile: true,
        semantic: false,
        json: true,
        applyProfileAdvisory: async () => ({
          exitCode: failure.exitCode,
          result: {
            schemaVersion: "1.0",
            command: "apply",
            status: failure.status,
            applied: false,
            discovery: {
              status: "found",
              source: "cwd",
              boundary: "repository",
              profile: ".gno/index.yml",
              ambiguous: false,
              shadowedProfiles: 0,
            },
            receipt: null,
            diagnostics: [
              {
                code: "PROFILE_APPLY_TEST_FAILURE",
                severity: "error",
                path: "runtime",
                message: "Injected profile apply failure.",
                remediation: "Repair the injected failure.",
              },
            ],
          },
        }),
      });

      expect(outcome).toMatchObject({
        exitCode: failure.exitCode,
        result: {
          status: "failed",
          profile: {
            check: { status: "valid" },
            apply: { status: failure.status },
          },
          setup: {
            status: "failed",
            lexical: { error: { code: "profile_apply_failed" } },
          },
          connectors: [],
        },
      });
      assertValid(outcome.result, await loadSchema("setup-profile-result"));
      expect(await Bun.file(configPath).text()).toBe(configBefore);
      expect(await readRecoverySnapshot(config)).toEqual(storeBefore);
    });
  }

  test("fails closed before setup when profile apply throws", async () => {
    const { root, project, nested } = await createHarness("apply-throws");
    await writeFile(join(project, ".gno", "index.yml"), validProfileYaml);
    const config = await seedRecoveryState(root);
    const configPath = join(process.env.GNO_CONFIG_DIR!, "index.yml");
    const configBefore = await Bun.file(configPath).text();
    const storeBefore = await readRecoverySnapshot(config);

    const outcome = await setupWithActivation({
      folder: nested,
      applyProfile: true,
      semantic: false,
      json: true,
      applyProfileAdvisory: async () => {
        throw new Error("Injected profile apply transport failure");
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 2,
      result: {
        status: "failed",
        profile: {
          check: { status: "valid" },
          apply: null,
        },
        setup: {
          status: "failed",
          lexical: { error: { code: "profile_apply_failed" } },
        },
        connectors: [],
      },
    });
    assertValid(outcome.result, await loadSchema("setup-profile-result"));
    expect(await Bun.file(configPath).text()).toBe(configBefore);
    expect(await readRecoverySnapshot(config)).toEqual(storeBefore);
  });

  test("fails closed before apply or setup when explicit profile inspection throws", async () => {
    const { root, nested } = await createHarness("inspection-throws");
    const config = await seedRecoveryState(root);
    const configPath = join(process.env.GNO_CONFIG_DIR!, "index.yml");
    const configBefore = await Bun.file(configPath).text();
    const storeBefore = await readRecoverySnapshot(config);
    let applyCalled = false;

    const outcome = await setupWithActivation({
      folder: nested,
      applyProfile: true,
      semantic: false,
      json: true,
      inspectProfileAdvisory: async () => {
        throw new Error("Injected profile inspection failure");
      },
      applyProfileAdvisory: async () => {
        applyCalled = true;
        return successfulApplyOutcome("profiled");
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 2,
      result: {
        status: "failed",
        lexical: { error: { code: "profile_inspection_failed" } },
      },
    });
    assertValid(outcome.result, await loadSchema("setup-command-result"));
    expect(applyCalled).toBe(false);
    expect(await Bun.file(configPath).text()).toBe(configBefore);
    expect(await readRecoverySnapshot(config)).toEqual(storeBefore);
  });

  for (const malformed of [
    {
      label: "mismatched receipt status",
      outcome: successfulApplyOutcome("profiled", {
        resultStatus: "applied",
        receiptStatus: "unchanged",
      }),
      retainApply: false,
    },
    {
      label: "empty collection resource ID",
      outcome: successfulApplyOutcome(""),
      retainApply: false,
    },
    {
      label: "collection absent from persisted config",
      outcome: successfulApplyOutcome("missing"),
      retainApply: true,
    },
  ]) {
    test(`fails closed before setup for ${malformed.label}`, async () => {
      const { root, project, nested } = await createHarness(
        `malformed-${malformed.outcome.result.receipt?.resources[0]?.id || "empty"}`
      );
      await writeFile(join(project, ".gno", "index.yml"), validProfileYaml);
      const config = await seedRecoveryState(root);
      const configPath = join(process.env.GNO_CONFIG_DIR!, "index.yml");
      const configBefore = await Bun.file(configPath).text();
      const storeBefore = await readRecoverySnapshot(config);

      const outcome = await setupWithActivation({
        folder: nested,
        applyProfile: true,
        semantic: false,
        json: true,
        applyProfileAdvisory: async () => malformed.outcome,
      });

      expect(outcome).toMatchObject({
        exitCode: 2,
        result: {
          status: "failed",
          profile: {
            apply: malformed.retainApply ? malformed.outcome.result : null,
          },
          setup: {
            status: "failed",
            lexical: { error: { code: "profile_apply_failed" } },
          },
        },
      });
      assertValid(outcome.result, await loadSchema("setup-profile-result"));
      expect(await Bun.file(configPath).text()).toBe(configBefore);
      expect(await readRecoverySnapshot(config)).toEqual(storeBefore);
    });
  }

  test("keeps invalid and absent profiles usable with truthful action status", async () => {
    const invalid = await createHarness("invalid");
    await writeFile(
      join(invalid.project, ".gno", "index.yml"),
      'schemaVersion: "2.0"\ncollection: { name: invalid, root: docs }\n'
    );
    const invalidResult = await cli(
      "setup",
      invalid.nested,
      "--apply-profile",
      "--no-semantic",
      "--json"
    );
    expect(invalidResult.code).toBe(0);
    const invalidParsed = JSON.parse(invalidResult.stdout);
    expect(invalidParsed).toMatchObject({
      status: "completed_with_actions",
      profile: {
        check: { status: "invalid" },
        apply: null,
      },
      setup: { status: "completed" },
    });
    assertValid(invalidParsed, await loadSchema("setup-profile-result"));

    const absent = await createHarness("absent");
    const absentResult = await cli(
      "setup",
      absent.nested,
      "--apply-profile",
      "--no-semantic",
      "--json"
    );
    expect(absentResult.code).toBe(0);
    const absentParsed = JSON.parse(absentResult.stdout);
    expect(absentParsed).toMatchObject({
      status: "completed_with_actions",
      profile: {
        check: { status: "not_found" },
        apply: null,
      },
      setup: { status: "completed" },
    });
    assertValid(absentParsed, await loadSchema("setup-profile-result"));
  });

  test("rejects explicit setup overrides when applying a valid profile", async () => {
    const { project, nested } = await createHarness("option-conflict");
    await writeFile(
      join(project, ".gno", "index.yml"),
      [
        'schemaVersion: "1.0"',
        "collection:",
        "  name: profiled",
        "  root: docs",
        '  include: ["**/*.md"]',
        "contexts: []",
        "contentTypes: {}",
        "affinityDefaults: { enabled: true, contribution: 0.01 }",
        "",
      ].join("\n")
    );

    for (const override of [
      ["--name", "override"],
      ["--exclude", "private"],
    ]) {
      const result = await cli(
        "setup",
        nested,
        "--apply-profile",
        ...override,
        "--no-semantic",
        "--json"
      );
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        status: "failed",
        profile: {
          check: { status: "valid" },
          apply: null,
        },
        setup: {
          status: "failed",
          lexical: {
            error: { code: "profile_option_conflict" },
          },
        },
      });
      assertValid(parsed, await loadSchema("setup-profile-result"));
    }
    expect(await loadConfig()).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
});
