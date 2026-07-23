import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises, node:os, and node:path provide temporary directory structure.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getIndexDbPath } from "../../src/app/constants";
import { traceReplay } from "../../src/cli/commands/replay";
import { traceExport } from "../../src/cli/commands/trace";
import { createProgram } from "../../src/cli/program";
import {
  createDefaultConfig,
  ensureDirectories,
  saveConfig,
} from "../../src/config";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const HASH = "a".repeat(64);
const originalDirs = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

describe("trace CLI contract", () => {
  let root = "";

  afterEach(async () => {
    process.env.GNO_CONFIG_DIR = originalDirs.config;
    process.env.GNO_DATA_DIR = originalDirs.data;
    process.env.GNO_CACHE_DIR = originalDirs.cache;
    if (root) await safeRm(root);
  });

  test("registers the complete local management command group", () => {
    const program = createProgram();
    const trace = program.commands.find(
      (command) => command.name() === "trace"
    );
    expect(trace).toBeDefined();
    expect(trace!.commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "label",
      "export",
      "replay",
      "delete",
      "purge",
    ]);
    expect(
      trace!.commands
        .find((command) => command.name() === "purge")
        ?.helpInformation()
    ).toContain("Delete every local retrieval trace receipt");
  });

  test("renders a schema-valid missing-manifest replay without mutation", async () => {
    root = await mkdtemp(join(tmpdir(), "gno-trace-replay-cli-"));
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    await ensureDirectories();
    const configPath = join(root, "config", "index.yml");
    expect((await saveConfig(createDefaultConfig(), configPath)).ok).toBeTrue();
    const output = await traceReplay(
      "missing-export",
      { id: "cli-bm25", type: "bm25" },
      { configPath, format: "json" }
    );
    const receipt = JSON.parse(output);
    expect(
      assertValid(receipt, await loadSchema("retrieval-trace-replay"))
    ).toBeTrue();
    expect(receipt).toMatchObject({
      verdict: "unreplayable",
      reason: "manifest_missing",
      applied: false,
    });
  });

  test("emits a schema-valid export receipt and keeps output files artifact-only", async () => {
    root = await mkdtemp(join(tmpdir(), "gno-trace-cli-"));
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    await ensureDirectories();
    const configPath = join(root, "config", "index.yml");
    const config = createDefaultConfig();
    expect((await saveConfig(config, configPath)).ok).toBeTrue();

    const store = new SqliteAdapter();
    expect(
      (await store.open(getIndexDbPath(), config.ftsTokenizer)).ok
    ).toBeTrue();
    expect(
      (
        await store.createRetrievalTrace({
          traceId: "cli-trace",
          schemaVersion: "1.0",
          redactionMode: "metadata",
          replayCapable: false,
          queryText: null,
          queryDigest: null,
          queryShape: { characters: 4, terms: 1 },
          goalText: null,
          goalDigest: null,
          goalShape: { characters: 0, terms: 0 },
          filters: { shape: {} },
          fingerprints: {
            pipeline: HASH,
            model: HASH,
            config: HASH,
            index: HASH,
          },
          status: "open",
          createdAtMs: 100,
          updatedAtMs: 100,
          expiresAtMs: 10_000,
        })
      ).ok
    ).toBeTrue();
    expect(
      (await store.finalizeRetrievalTrace("cli-trace", "completed", 101)).ok
    ).toBeTrue();
    await store.close();

    const output = await traceExport(["cli-trace"], {
      configPath,
      format: "json",
    });
    const receipt = JSON.parse(output);
    assertValid(receipt, await loadSchema("retrieval-trace-export"));
    expect(receipt.manifest.traceIds).toEqual(["cli-trace"]);

    const outputPath = join(root, "export.json");
    expect(
      await traceExport(["cli-trace"], {
        configPath,
        format: "json",
        output: outputPath,
      })
    ).toBe("");
    expect(await Bun.file(outputPath).json()).toEqual(receipt.artifact);
  });
});
