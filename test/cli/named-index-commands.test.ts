/**
 * Regression tests for issue #369: CLI commands honoring global --index when
 * the default index holds other collections, plus the index-aware mismatch
 * error message.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises — directory creation has no Bun-native equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os — no Bun temporary-directory helper.
import { tmpdir } from "node:os";
// node:path — no Bun path utilities.
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";

import { getIndexDbPath } from "../../src/app/constants";
import { runCli } from "../../src/cli/run";
import { createDefaultConfig, saveConfigToPath } from "../../src/config";
import { getActivePreset } from "../../src/llm/registry";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import { embedStoredSimilarityVectors } from "../helpers/stored-similarity-fixture";

const savedEnv = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

let root = "";
let reproConfigPath = "";
let defaultConfigPath = "";

function makeCollection(name: string): Collection {
  return {
    name,
    path: join(root, "docs", name),
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
}

function makeConfig(...names: string[]): Config {
  const config = createDefaultConfig();
  config.collections = names.map(makeCollection);
  return config;
}

async function execCli(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origError = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...values: unknown[]) => out.push(`${values.join(" ")}\n`);
  console.error = (...values: unknown[]) => err.push(`${values.join(" ")}\n`);
  let code = 0;
  try {
    code = await runCli(["node", "gno", ...args]);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-named-index-"));
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");

  await mkdir(join(root, "docs", "other"), { recursive: true });
  await mkdir(join(root, "docs", "repro"), { recursive: true });
  await Bun.write(
    join(root, "docs", "other", "other.md"),
    "# Other\n\nUnrelated default-index note.\n"
  );
  await Bun.write(
    join(root, "docs", "repro", "a.md"),
    "# Source\n\nLinks to [[b]] and [target](b.md).\n"
  );
  await Bun.write(
    join(root, "docs", "repro", "b.md"),
    "# Target\n\nTarget note body.\n"
  );

  defaultConfigPath = join(root, "config", "index.yml");
  reproConfigPath = join(root, "repro.yml");
  await saveConfigToPath(makeConfig("other"), defaultConfigPath);
  await saveConfigToPath(makeConfig("repro"), reproConfigPath);

  const defaultIdx = await execCli(["index", "--no-embed"]);
  if (defaultIdx.code !== 0) {
    throw new Error(`default index setup failed: ${defaultIdx.stderr}`);
  }
  const reproIdx = await execCli([
    "--config",
    reproConfigPath,
    "--index",
    "repro-links",
    "index",
    "--no-embed",
  ]);
  if (reproIdx.code !== 0) {
    throw new Error(`repro-links index setup failed: ${reproIdx.stderr}`);
  }
});

afterEach(async () => {
  for (const [key, value] of [
    ["GNO_CONFIG_DIR", savedEnv.config],
    ["GNO_DATA_DIR", savedEnv.data],
    ["GNO_CACHE_DIR", savedEnv.cache],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await safeRm(root);
});

describe("CLI commands honor --index with a populated default index (#369)", () => {
  test("links list honors --index before and after subcommand", async () => {
    const before = await execCli([
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "links",
      "list",
      "gno://repro/a.md",
      "--json",
    ]);
    expect(before.code).toBe(0);
    const parsedBefore = JSON.parse(before.stdout) as {
      links: Array<{ resolvedUri?: string }>;
      meta: { uri: string; totalLinks: number };
    };
    expect(parsedBefore.meta.uri).toBe("gno://repro/a.md");
    expect(parsedBefore.meta.totalLinks).toBe(2);
    expect(
      parsedBefore.links.every((l) => l.resolvedUri === "gno://repro/b.md")
    ).toBe(true);

    const after = await execCli([
      "links",
      "list",
      "gno://repro/a.md",
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "--json",
    ]);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout).meta.uri).toBe("gno://repro/a.md");
  });

  test("backlinks honors --index", async () => {
    const res = await execCli([
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "backlinks",
      "gno://repro/b.md",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      backlinks: Array<{ sourceUri: string }>;
      meta: { uri: string; totalBacklinks: number };
    };
    expect(parsed.meta.uri).toBe("gno://repro/b.md");
    expect(parsed.meta.totalBacklinks).toBeGreaterThanOrEqual(1);
    expect(parsed.backlinks[0]?.sourceUri).toBe("gno://repro/a.md");
  });

  test("similar honors --index", async () => {
    const store = new SqliteAdapter();
    const opened = await store.open(
      getIndexDbPath("repro-links"),
      createDefaultConfig().ftsTokenizer
    );
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const embedModel = getActivePreset(makeConfig("repro")).embed;
      await embedStoredSimilarityVectors(store.getRawDb(), embedModel, {
        "a.md": [1, 0, 0],
        "b.md": [0.9, 0.1, 0],
      });
    } finally {
      await store.close();
    }

    const res = await execCli([
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "similar",
      "gno://repro/a.md",
      "--threshold",
      "0.5",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      similar: Array<{ uri: string }>;
      meta: { uri: string };
    };
    expect(parsed.meta.uri).toBe("gno://repro/a.md");
    expect(parsed.similar.map((item) => item.uri)).toEqual([
      "gno://repro/b.md",
    ]);
  });

  test("publish export honors --index", async () => {
    const res = await execCli([
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "publish",
      "export",
      "gno://repro/a.md",
      "--preview",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      artifact: { spaces: Array<{ notes: Array<{ title: string }> }> };
    };
    expect(parsed.artifact.spaces[0]?.notes[0]?.title).toBe("Source");
  });

  test("collection policy set honors --index", async () => {
    const res = await execCli([
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "collection",
      "policy",
      "set",
      "repro",
      "local_only",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      current: { collection: string; effectivePolicy: string };
    };
    expect(parsed.current.collection).toBe("repro");
    expect(parsed.current.effectivePolicy).toBe("local_only");
  });

  test("egress-audit honors --index", async () => {
    const statusRes = await execCli([
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "egress-audit",
      "status",
    ]);
    expect(statusRes.code).toBe(0);

    const listRes = await execCli([
      "--config",
      reproConfigPath,
      "--index",
      "repro-links",
      "egress-audit",
      "list",
    ]);
    expect(listRes.code).toBe(0);
  });

  test("init honors --index when creating a named index database", async () => {
    const customConfig = join(root, "custom-init.yml");
    const res = await execCli([
      "--config",
      customConfig,
      "--index",
      "custom-init",
      "init",
    ]);
    expect(res.code).toBe(0);
    const expectedDb = getIndexDbPath("custom-init");
    expect(res.stdout).toContain(expectedDb);
    expect(await Bun.file(expectedDb).exists()).toBe(true);
  });
});

describe("stale collections mismatch error names index and puts cleanup last (#369)", () => {
  test("default index mismatch names default, suggests --index before cleanup, and names cleanup target", async () => {
    const res = await execCli([
      "--config",
      reproConfigPath,
      "search",
      "Target",
    ]);
    expect(res.code).not.toBe(0);
    const msg = res.stderr;
    expect(msg).toContain(
      'Index "default" holds collections the config does not list: other (1 document).'
    );
    expect(msg).toContain("--index <name>");
    expect(msg).toContain('"gno cleanup"');
    expect(msg).toContain('delete their data from index "default"');
    expect(msg.indexOf("--index <name>")).toBeLessThan(
      msg.indexOf("gno cleanup")
    );
  });

  test("named index mismatch names that index and includes --index in cleanup hint", async () => {
    const res = await execCli([
      "--config",
      defaultConfigPath,
      "--index",
      "repro-links",
      "search",
      "Other",
    ]);
    expect(res.code).not.toBe(0);
    const msg = res.stderr;
    expect(msg).toContain(
      'Index "repro-links" holds collections the config does not list: repro (2 documents).'
    );
    expect(msg).toContain("--index <name>");
    expect(msg).toContain('"gno --index repro-links cleanup"');
    expect(msg).toContain('delete their data from index "repro-links"');
    expect(msg.indexOf("--index <name>")).toBeLessThan(
      msg.indexOf("gno --index repro-links cleanup")
    );
  });
});
