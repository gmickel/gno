import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory and fixture creation APIs with
// no Bun structural equivalent.
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
// node:os has no Bun temporary-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { ConfigSchema } from "../../src/config";
import { loadConfigFromPath } from "../../src/config/loader";
import { applyProjectProfile } from "../../src/core/project-profile-apply";
import { safeRm } from "../helpers/cleanup";

const createdRoots: string[] = [];

const profileYaml = (separator: "/" | "\\"): string => {
  const guidance = ["guidance", "AGENTS.md"].join(separator);
  const prefix = ["people", "team"].join(separator);
  const include = ["**", "*.md"].join(separator);
  return [
    'schemaVersion: "1.0"',
    "collection:",
    "  name: portable",
    "  root: docs",
    `  include: ["${include.replaceAll("\\", "\\\\")}"]`,
    "  exclude: [node_modules]",
    "  languageHint: en",
    "contexts:",
    `  - file: "${guidance.replaceAll("\\", "\\\\")}"`,
    "  - text: Prefer exact evidence.",
    "contentTypes:",
    "  people:",
    `    prefixes: ["${prefix.replaceAll("\\", "\\\\")}"]`,
    "    preset: person",
    "affinityDefaults: { enabled: true, contribution: 0.02 }",
    "recommendedCapabilities: [workspace.read]",
    "",
  ].join("\n");
};

function storeStub(): SqliteAdapter {
  return {
    syncCollections: async () => ({ ok: true, value: undefined }),
    syncContexts: async () => ({ ok: true, value: undefined }),
    upsertCollections: async () => ({ ok: true, value: undefined }),
    upsertContexts: async () => ({ ok: true, value: undefined }),
  } as unknown as SqliteAdapter;
}

async function machineFixture(
  root: string,
  machinePath: string[],
  separator: "/" | "\\"
) {
  const machineRoot = join(root, ...machinePath);
  const project = join(machineRoot, "work", "portable-repo");
  const configPath = join(machineRoot, "runtime", "config", "index.yml");
  const dataDir = join(machineRoot, "runtime", "data");
  await mkdir(join(project, ".gno"), { recursive: true });
  await mkdir(join(project, "docs"), { recursive: true });
  await mkdir(join(project, "guidance"), { recursive: true });
  await Bun.write(join(project, "docs", "note.md"), "# Portable\n");
  await Bun.write(
    join(project, "guidance", "AGENTS.md"),
    "Prefer primary sources.\n"
  );
  const yaml = profileYaml(separator);
  await Bun.write(join(project, ".gno", "index.yml"), yaml);

  const applied = await applyProjectProfile({
    profileYaml: yaml,
    profileRoot: project,
    configPath,
    dataDir,
    store: storeStub(),
  });
  expect(applied.ok).toBe(true);
  const loaded = await loadConfigFromPath(configPath);
  expect(loaded.ok).toBe(true);
  if (!(applied.ok && loaded.ok)) throw new Error("portable apply failed");
  return { applied, config: loaded.value, dataDir, project };
}

function portableConfig(config: Config): unknown {
  return {
    ...config,
    collections: config.collections.map((collection) => ({
      ...collection,
      path: "$PROJECT_ROOT/docs",
    })),
    projectProfileBindings: config.projectProfileBindings?.map((binding) => ({
      ...binding,
      path: "$PROJECT_ROOT/.gno/index.yml",
    })),
  };
}

afterEach(async () => {
  for (const root of createdRoots.splice(0)) await safeRm(root);
});

describe("project profile clean-machine portability", () => {
  test("validates local binding provenance without timestamps", () => {
    const base = {
      ...ConfigSchema.parse({
        version: "1.0",
        collections: [],
        contexts: [],
        contentTypes: [],
      }),
      projectProfileBindings: [
        {
          path: join(tmpdir(), "project", ".gno", "index.yml"),
          fingerprint: "a".repeat(64),
          collection: "notes",
        },
      ],
    };
    expect(ConfigSchema.safeParse(base).success).toBe(true);
    expect(
      ConfigSchema.safeParse({
        ...base,
        projectProfileBindings: [
          { ...base.projectProfileBindings[0], path: ".gno/index.yml" },
        ],
      }).success
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({
        ...base,
        projectProfileBindings: [
          { ...base.projectProfileBindings[0], fingerprint: "not-a-sha256" },
        ],
      }).success
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({
        ...base,
        projectProfileBindings: [
          base.projectProfileBindings[0],
          base.projectProfileBindings[0],
        ],
      }).success
    ).toBe(false);
  });

  test("reproduces identical semantics under POSIX and Windows-shaped roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-profile-portability-"));
    createdRoots.push(root);
    const [posix, windows] = await Promise.all([
      machineFixture(root, ["home", "alice"], "/"),
      machineFixture(root, ["drive-c", "Users", "Bob"], "\\"),
    ]);

    expect(portableConfig(posix.config)).toEqual(
      portableConfig(windows.config)
    );
    expect(posix.applied.receipt.profile.fingerprint).toBe(
      windows.applied.receipt.profile.fingerprint
    );
    expect(posix.applied.receipt).toEqual(windows.applied.receipt);

    for (const fixture of [posix, windows]) {
      expect(fixture.config.projectProfileBindings).toEqual([
        {
          path: await realpath(join(fixture.project, ".gno", "index.yml")),
          fingerprint: fixture.applied.receipt.profile.fingerprint,
          collection: "portable",
        },
      ]);
      const publicReceipt = JSON.stringify(fixture.applied.receipt);
      expect(publicReceipt).not.toContain(fixture.project);
      expect(publicReceipt).not.toContain(".gno/index.yml");
      const trackedFiles = [
        ...(await Array.fromAsync(
          new Bun.Glob("**/*").scan({
            cwd: fixture.project,
            dot: true,
            onlyFiles: true,
          })
        )),
      ].sort();
      expect(trackedFiles).toEqual([
        ".gno/index.yml",
        "docs/note.md",
        "guidance/AGENTS.md",
      ]);
      expect(
        trackedFiles.some((path) =>
          /(?:\.db|\.sqlite|\.gguf|\.lock|secret|token|cache)/i.test(path)
        )
      ).toBe(false);
      expect(fixture.applied.receiptPath.startsWith(fixture.dataDir)).toBe(
        true
      );
      expect(
        await Bun.file(
          join(fixture.dataDir, "project-profiles", "apply-receipt.json")
        ).exists()
      ).toBe(true);
    }
  });
});
