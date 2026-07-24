import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directory fixture APIs without Bun equivalents.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os has no Bun temporary-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import { loadConfigFromPath } from "../../src/config";
import { safeRm } from "../helpers/cleanup";

const roots: string[] = [];

interface CliProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runIsolatedCli(
  env: Record<string, string>,
  args: string[]
): Promise<CliProcessResult> {
  const child = Bun.spawn([Bun.which("bun")!, "src/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await safeRm(root);
});

describe("CLI config writer routing", () => {
  test("keeps raw config saves behind the canonical mutation primitive", async () => {
    const allowed = new Set([
      "src/config/saver.ts",
      "src/core/config-mutation.ts",
    ]);
    const directWriters: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.ts").scan(".")) {
      const source = await Bun.file(path).text();
      if (/\bsaveConfig(?:ToPath)?\s*\(/.test(source) && !allowed.has(path)) {
        directWriters.push(path);
      }
    }
    expect(directWriters).toEqual([]);
  });

  test("honors --config and preserves concurrent profile and collection writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-config-writers-"));
    roots.push(root);
    const env = {
      GNO_CONFIG_DIR: join(root, "default-config"),
      GNO_DATA_DIR: join(root, "data"),
      GNO_CACHE_DIR: join(root, "cache"),
    };
    const configPath = join(root, "selected", "index.yml");
    const globalArgs = ["--config", configPath];

    const initialized = await runIsolatedCli(env, [...globalArgs, "init"]);
    expect(initialized.exitCode).toBe(0);
    expect(await Bun.file(configPath).exists()).toBe(true);
    expect(await Bun.file(join(env.GNO_CONFIG_DIR, "index.yml")).exists()).toBe(
      false
    );

    const context = await runIsolatedCli(env, [
      ...globalArgs,
      "context",
      "add",
      "/",
      "Selected custom config",
    ]);
    expect(context.exitCode).toBe(0);

    const project = join(root, "project");
    const docs = join(project, "docs");
    const recovery = join(root, "recovery");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(project, ".gno"), { recursive: true });
    await mkdir(docs, { recursive: true });
    await mkdir(recovery, { recursive: true });
    await Bun.write(join(docs, "proof.md"), "# Profile proof\n");
    await Bun.write(
      join(project, ".gno", "index.yml"),
      [
        'schemaVersion: "1.0"',
        "collection: { name: profiled, root: docs }",
        "contexts:",
        "  - text: Profile context.",
        "contentTypes: {}",
        "",
      ].join("\n")
    );

    const [profile, collection] = await Promise.all([
      runIsolatedCli(env, [
        ...globalArgs,
        "profile",
        "apply",
        project,
        "--json",
      ]),
      runIsolatedCli(env, [
        ...globalArgs,
        "collection",
        "add",
        recovery,
        "--name",
        "recovery",
      ]),
    ]);
    expect(profile.exitCode).toBe(0);
    expect(collection.exitCode).toBe(0);

    const loaded = await loadConfigFromPath(configPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.collections.map((item) => item.name).sort()).toEqual([
      "profiled",
      "recovery",
    ]);
    expect(loaded.value.contexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Selected custom config" }),
        expect.objectContaining({ text: "Profile context." }),
      ])
    );
  });

  test("models use never overwrites a malformed selected config", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-config-models-"));
    roots.push(root);
    const env = {
      GNO_CONFIG_DIR: join(root, "default-config"),
      GNO_DATA_DIR: join(root, "data"),
      GNO_CACHE_DIR: join(root, "cache"),
    };
    const configPath = join(root, "selected", "index.yml");
    await mkdir(join(root, "selected"), { recursive: true });
    const malformed = "version: ['not-valid'\n";
    await Bun.write(configPath, malformed);

    const result = await runIsolatedCli(env, [
      "--config",
      configPath,
      "models",
      "use",
      "auto",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(configPath).text()).toBe(malformed);
  });
});
