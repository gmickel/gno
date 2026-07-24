import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directories, directory metadata, and
// symlinks; Bun has no equivalent structural filesystem APIs.
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
// node:os has no Bun temporary-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { dirname, join } from "node:path";

import type { Config } from "../../src/config/types";

import {
  formatProjectProfileResult,
  runProjectProfileCommand,
} from "../../src/cli/commands/profile";
import { runCli } from "../../src/cli/run";
import { createDefaultConfig } from "../../src/config";
import {
  discoverProjectProfile,
  PROJECT_PROFILE_RELATIVE_PATH,
} from "../../src/core/project-profile-discovery";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const tempRoots: string[] = [];
const originalDirs = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};
const originalWrites = {
  stdout: process.stdout.write.bind(process.stdout),
  stderr: process.stderr.write.bind(process.stderr),
};

const PROFILE = `
schemaVersion: "1.0"
collection:
  name: notes
  root: .
  include: ["**/*.md"]
  exclude: [node_modules]
contexts:
  - text: Prefer primary sources.
affinityDefaults:
  enabled: true
  contribution: 0.03
recommendedCapabilities: [workspace.read]
`;

const makeRoot = async (label: string): Promise<string> => {
  const created = await mkdtemp(join(tmpdir(), `gno-profile-cli-${label}-`));
  const root = await realpath(created);
  tempRoots.push(root);
  return root;
};

const writeProfile = async (root: string, yaml = PROFILE): Promise<string> => {
  const path = join(root, PROJECT_PROFILE_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, yaml);
  return path;
};

const writeConfig = async (path: string, config: Config): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, Bun.YAML.stringify(config));
};

const captureCli = async (
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
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
    return {
      code: await runCli(["bun", "gno", ...args]),
      stdout,
      stderr,
    };
  } finally {
    process.stdout.write = originalWrites.stdout;
    process.stderr.write = originalWrites.stderr;
  }
};

afterEach(async () => {
  process.stdout.write = originalWrites.stdout;
  process.stderr.write = originalWrites.stderr;
  for (const [name, value] of Object.entries(originalDirs)) {
    const key = `GNO_${name.toUpperCase()}_DIR`;
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("project profile discovery", () => {
  test("finds the nearest monorepo profile and reports the shadowed root without merging", async () => {
    const root = await makeRoot("nested");
    await mkdir(join(root, ".git"));
    await writeProfile(root);
    const nestedRoot = join(root, "packages", "app");
    const cwd = join(nestedRoot, "src");
    await mkdir(cwd, { recursive: true });
    const nestedProfile = await writeProfile(
      nestedRoot,
      PROFILE.replace("name: notes", "name: app-notes")
    );

    const result = await discoverProjectProfile({
      channel: "local",
      cwd,
    });

    expect(result).toMatchObject({
      summary: {
        status: "found",
        source: "cwd",
        boundary: "repository",
        ambiguous: true,
        shadowedProfiles: 1,
      },
      profilePath: nestedProfile,
      profileRoot: nestedRoot,
      diagnostics: [{ code: "SHADOWED_PROFILE", severity: "warning" }],
    });
  });

  test("an explicit root wins exactly and never falls back to nested or ancestor profiles", async () => {
    const root = await makeRoot("override");
    await mkdir(join(root, ".git"));
    const rootProfile = await writeProfile(root);
    const nested = join(root, "packages", "app");
    await writeProfile(nested);

    const selected = await discoverProjectProfile({
      channel: "local",
      rootOverride: root,
    });
    expect(selected).toMatchObject({
      summary: {
        status: "found",
        source: "override",
        boundary: "explicit",
        ambiguous: false,
      },
      profilePath: rootProfile,
    });

    const exactFile = await discoverProjectProfile({
      channel: "local",
      rootOverride: rootProfile,
    });
    expect(exactFile).toMatchObject({
      summary: {
        status: "found",
        source: "override",
        boundary: "explicit",
      },
      profilePath: rootProfile,
    });

    const absent = await discoverProjectProfile({
      channel: "local",
      rootOverride: join(nested, "child"),
    });
    expect(absent.summary.status).toBe("error");
  });

  test("treats a worktree .git file as the repository boundary", async () => {
    const root = await makeRoot("worktree");
    await Bun.write(
      join(root, ".git"),
      "gitdir: /redacted/main/.git/worktrees/app\n"
    );
    const profilePath = await writeProfile(root);
    const cwd = join(root, "src", "nested");
    await mkdir(cwd, { recursive: true });

    const result = await discoverProjectProfile({
      channel: "local",
      cwd,
    });
    expect(result.summary.boundary).toBe("repository");
    expect(result.profilePath).toBe(profilePath);
  });

  test("a nested repository boundary prevents parent profile inheritance", async () => {
    const root = await makeRoot("nested-repository");
    await mkdir(join(root, ".git"));
    await writeProfile(root);
    const nested = join(root, "vendor", "child");
    await mkdir(nested, { recursive: true });
    await Bun.write(join(nested, ".git"), "gitdir: /redacted/child\n");

    const result = await discoverProjectProfile({
      channel: "local",
      cwd: nested,
    });
    expect(result.summary).toMatchObject({
      status: "not_found",
      boundary: "repository",
    });
  });

  test("stops before a filesystem-device boundary", async () => {
    const root = await makeRoot("device");
    await writeProfile(root);
    const nested = join(root, "mount", "child");
    await mkdir(nested, { recursive: true });
    const nestedDevice = (await stat(nested)).dev;
    const boundaryParent = dirname(nested);

    const result = await discoverProjectProfile(
      { channel: "local", cwd: nested },
      {
        lstat,
        realpath,
        stat: async (path) => {
          const metadata = await stat(path);
          if (path === boundaryParent) {
            return {
              dev: nestedDevice + 1,
              isDirectory: () => metadata.isDirectory(),
              isFile: () => metadata.isFile(),
            };
          }
          return metadata;
        },
      }
    );
    expect(result.summary).toMatchObject({
      status: "not_found",
      boundary: "filesystem",
    });
  });

  test("rejects a profile symlink that escapes the trusted root", async () => {
    const root = await makeRoot("symlink-root");
    const outside = await makeRoot("symlink-outside");
    const outsideProfile = await writeProfile(outside);
    await mkdir(join(root, ".gno"), { recursive: true });
    await symlink(outsideProfile, join(root, PROJECT_PROFILE_RELATIVE_PATH));

    const result = await discoverProjectProfile({
      channel: "local",
      rootOverride: root,
    });
    expect(result).toMatchObject({
      summary: { status: "error" },
      diagnostics: [{ code: "PROFILE_SYMLINK_ESCAPE" }],
    });
  });

  test("remote discovery returns before every filesystem dependency", async () => {
    let probes = 0;
    const probe = async (): Promise<never> => {
      probes += 1;
      throw new Error("unexpected filesystem probe");
    };
    const result = await discoverProjectProfile(
      { channel: "remote", cwd: "/private", rootOverride: "/private" },
      { lstat: probe, realpath: probe, stat: probe }
    );
    expect(probes).toBe(0);
    expect(result.summary).toMatchObject({
      status: "disabled",
      source: "remote",
      boundary: "remote",
    });
  });
});

describe("project profile check/show/diff", () => {
  test("emits deterministic schema-valid path-redacted JSON without mutating local state", async () => {
    const root = await makeRoot("commands");
    const profilePath = await writeProfile(root);
    const configPath = join(root, "local-config", "index.yml");
    const profileBefore = await Bun.file(profilePath).text();
    const [check, show, diff] = await Promise.all([
      runProjectProfileCommand({
        command: "check",
        path: root,
        configPath,
      }),
      runProjectProfileCommand({
        command: "show",
        path: root,
        configPath,
      }),
      runProjectProfileCommand({
        command: "diff",
        path: root,
        configPath,
      }),
    ]);
    const schema = await loadSchema("project-profile-command");

    for (const outcome of [check, show, diff]) {
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result.valid).toBe(true);
      assertValid(outcome.result, schema);
      const json = formatProjectProfileResult(outcome.result, { json: true });
      expect(json).not.toContain(root);
      expect(json).not.toContain(configPath);
      expect(json).not.toContain("hf:");
      expect(json).not.toContain(".gguf");
    }
    expect(check.result.profile?.desiredState).toBeNull();
    expect(show.result.profile?.desiredState).not.toBeNull();
    expect(check.result.diff).toBeNull();
    expect(show.result.diff).toBeNull();
    expect(diff.result.diff?.status).toBe("changes_required");
    expect(await Bun.file(profilePath).text()).toBe(profileBefore);
    expect(await Bun.file(configPath).exists()).toBe(false);

    const repeated = await runProjectProfileCommand({
      command: "diff",
      path: root,
      configPath,
    });
    expect(formatProjectProfileResult(repeated.result, { json: true })).toBe(
      formatProjectProfileResult(diff.result, { json: true })
    );
  });

  test.each([
    ["../private", "traversal"],
    ["/tmp/private", "POSIX absolute"],
    ["C:\\private", "Windows absolute"],
    ["\\\\server\\share", "UNC"],
  ])("rejects %s (%s) through the shared compiler", async (profileRoot) => {
    const root = await makeRoot(`unsafe-${profileRoot.length}`);
    await writeProfile(
      root,
      `schemaVersion: "1.0"\ncollection: { name: notes, root: "${profileRoot.replaceAll("\\", "\\\\")}" }\n`
    );
    const outcome = await runProjectProfileCommand({
      command: "check",
      path: root,
      configPath: join(root, "missing.yml"),
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.status).toBe("invalid");
    expect(
      outcome.result.diagnostics.some(
        (issue) => issue.code === "CONFIG_NOT_FOUND"
      )
    ).toBe(true);
    expect(
      outcome.result.diagnostics.some((issue) => issue.code === "UNSAFE_PATH")
    ).toBe(true);
  });

  test("reports exact offline preset availability without downloading or exposing URIs", async () => {
    const root = await makeRoot("offline");
    await writeProfile(
      root,
      PROFILE.replace(
        "collection:\n  name: notes",
        "collection:\n  name: notes\n  modelPreset: slim-tuned"
      )
    );
    const checked: string[] = [];
    const outcome = await runProjectProfileCommand({
      command: "check",
      path: root,
      offline: true,
      configPath: join(root, "missing.yml"),
      isModelAvailableOffline: async (_uri, modelType) => {
        checked.push(modelType);
        return modelType === "embed";
      },
    });

    expect(checked).toEqual(["embed", "rerank", "expand", "gen"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MODEL_PRESET_UNAVAILABLE_OFFLINE",
        path: "collection.modelPreset",
      })
    );
    const serialized = JSON.stringify(outcome.result);
    expect(serialized).not.toContain("hf:");
    expect(serialized).not.toContain(".gguf");
  });

  test("reports unsupported schema and preset aliases with actionable diagnostics", async () => {
    const root = await makeRoot("unsupported");
    await writeProfile(
      root,
      'schemaVersion: "2.0"\ncollection: { name: notes }\n'
    );
    const version = await runProjectProfileCommand({
      command: "check",
      path: root,
      configPath: join(root, "missing.yml"),
    });
    expect(version.result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_SCHEMA_MAJOR",
        remediation: expect.stringContaining("Migrate"),
      })
    );

    await writeProfile(
      root,
      'schemaVersion: "1.0"\ncollection: { name: notes, modelPreset: absent }\n'
    );
    const model = await runProjectProfileCommand({
      command: "check",
      path: root,
      configPath: join(root, "missing.yml"),
    });
    expect(model.result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MODEL_PRESET_NOT_FOUND",
        remediation: expect.stringContaining("alias"),
      })
    );
  });

  test("diff exposes stale repair/removal choices without applying either", async () => {
    const root = await makeRoot("stale");
    await writeProfile(root);
    const otherRoot = await makeRoot("old-root");
    const configPath = join(root, "config", "index.yml");
    const config = createDefaultConfig();
    config.collections = [
      {
        name: "notes",
        path: otherRoot,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      {
        name: "legacy-notes",
        path: root,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    await writeConfig(configPath, config);
    const configBefore = await Bun.file(configPath).text();

    const outcome = await runProjectProfileCommand({
      command: "diff",
      path: root,
      configPath,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.diff).toMatchObject({
      status: "changes_required",
      staleMappings: [
        {
          collection: "legacy-notes",
          reason: "name_changed",
          choices: ["repair", "remove_explicitly"],
        },
        {
          collection: "notes",
          reason: "root_changed",
          choices: ["repair", "remove_explicitly"],
        },
      ],
    });
    expect(
      outcome.result.diff?.changes.some(
        (change) =>
          change.action === "repair" && change.field === "collection.root"
      )
    ).toBe(true);
    expect(await Bun.file(configPath).text()).toBe(configBefore);
  });

  test("the CLI keeps JSON stdout clean and returns the structured receipt", async () => {
    const root = await makeRoot("cli");
    await writeProfile(root);
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");

    const output = await captureCli(["profile", "check", root, "--json"]);

    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    const parsed = JSON.parse(output.stdout);
    expect(parsed).toMatchObject({
      schemaVersion: "1.0",
      command: "check",
      status: "valid",
      discovery: {
        source: "override",
        profile: ".gno/index.yml",
      },
    });
    assertValid(parsed, await loadSchema("project-profile-command"));
  });
});
