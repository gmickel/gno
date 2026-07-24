import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directory and fixture creation APIs with
// no Bun structural equivalent.
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
// node:os has no Bun temporary-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import { getIndexDbPath } from "../../src/app/constants";
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
    await writeFile(
      join(project, ".gno", "index.yml"),
      [
        'schemaVersion: "1.0"',
        "collection:",
        "  name: profiled",
        "  root: docs",
        '  include: ["**/*.md"]',
        "contexts:",
        "  - text: Profile context.",
        "contentTypes: {}",
        "",
      ].join("\n")
    );
    const initialConfig = createDefaultConfig();
    expect((await saveConfig(initialConfig)).ok).toBe(true);
    await mkdir(join(root, "runtime", "data"), { recursive: true });

    const seeded = new SqliteAdapter();
    expect(
      (await seeded.open(getIndexDbPath(), initialConfig.ftsTokenizer)).ok
    ).toBe(true);
    expect(
      (
        await seeded.syncCollections([
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
        await seeded.syncContexts([
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
        await seeded.upsertDocument({
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
    await seeded.close();

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
