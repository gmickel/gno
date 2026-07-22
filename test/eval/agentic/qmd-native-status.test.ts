import { describe, expect, test } from "bun:test";
// node:path: runtime directory parsing and PATH delimiter have no Bun equivalent.
import { delimiter, dirname } from "node:path";

import type { CorpusSnapshot } from "../../../evals/agentic/types";

import {
  AgenticHarnessError,
  type AdapterPreparation,
} from "../../../evals/agentic/adapter";
import {
  createQmdAdapterFactory,
  QMD_ADAPTER_ID,
} from "../../../evals/agentic/adapters/qmd";
import { canonicalFingerprint } from "../../../evals/agentic/canonical";
import {
  buildQmdEnvironment,
  validateQmdPreparedStatus,
} from "../../../evals/agentic/lifecycle/qmd-native";
import { loadQmdLock } from "../../../evals/agentic/qmd-lock";
import { runQmdCommand } from "../../../evals/agentic/qmd-preflight";

const snapshot: CorpusSnapshot = {
  fixtureVersion: "fixture",
  fingerprint: "fixture-fingerprint",
  files: [
    {
      taskId: "t0a1b2c3",
      collection: "c001",
      relPath: "one.md",
      sourcePath: "fixture/c001/one.md",
      sourceHash: "one-hash",
      content: "One\n",
    },
    {
      taskId: "t1b2c3d4",
      collection: "c002",
      relPath: "two.md",
      sourcePath: "fixture/c002/two.md",
      sourceHash: "two-hash",
      content: "Two\n",
    },
  ],
};

const readyStatus = {
  totalDocuments: 2,
  needsEmbedding: 0,
  hasVectorIndex: true,
  collections: [
    { name: "c001", documents: 1 },
    { name: "c002", documents: 1 },
  ],
};

describe("qmd prepared status validation", () => {
  test("accepts exact snapshot coverage with current embeddings", () => {
    expect(() =>
      validateQmdPreparedStatus(readyStatus, snapshot)
    ).not.toThrow();
  });

  test.each([
    {
      ...readyStatus,
      totalDocuments: 1,
      needsEmbedding: 1,
      hasVectorIndex: false,
      collections: [],
    },
    {
      ...readyStatus,
      collections: [
        { name: "c001", documents: 1 },
        { name: "c001", documents: 1 },
      ],
    },
  ])("rejects partial, stale, duplicate, or missing coverage", (status) => {
    try {
      validateQmdPreparedStatus(status, snapshot);
      throw new Error("expected index status failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgenticHarnessError);
      expect((error as AgenticHarnessError).code).toBe(
        "qmd_index_preflight_failed"
      );
    }
  });
});

test("qmd isolated environment drops inherited knobs and pins Bun lookup", async () => {
  const lock = await loadQmdLock();
  const env = buildQmdEnvironment(
    {
      configDir: "/isolated/config",
      xdgConfigHome: "/isolated/xdg-config",
      xdgCacheHome: "/isolated/xdg-cache",
      dbPath: "/isolated/index.sqlite",
    },
    {
      lock,
      lockFileSha256: "0".repeat(64),
      lockFingerprint: "lock",
      repoPath: "/qmd",
      entrypointPath: "/qmd/bin/qmd",
      modelCachePath: "/models",
      modelPaths: {
        embed: "/models/embed",
        rerank: "/models/rerank",
        generate: "/models/generate",
      },
      repositoryFingerprint: "repo",
    },
    {
      PATH: "/untrusted/bin",
      HOME: "/home/test",
      QMD_FORCE_CPU: "1",
      QMD_EMBED_CONTEXT_SIZE: "42",
      QMD_WRAPPER_CAPTURE: "/tmp/capture",
      qmd_case_insensitive_poison: "windows-parent",
    }
  );
  expect(env.HOME).toBe("/home/test");
  expect(env.QMD_FORCE_CPU).toBeUndefined();
  expect(env.QMD_EMBED_CONTEXT_SIZE).toBeUndefined();
  expect(env.QMD_WRAPPER_CAPTURE).toBeUndefined();
  expect(env.qmd_case_insensitive_poison).toBeUndefined();
  expect(env.PATH?.split(delimiter)[0]).toBe(dirname(process.execPath));
  expect(env.QMD_SOURCE_MODE).toBe("1");

  const inheritedPoison = process.env.QMD_FORCE_CPU;
  process.env.QMD_FORCE_CPU = "reintroduced-by-parent";
  try {
    const child = await runQmdCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({home:process.env.HOME,poison:process.env.QMD_FORCE_CPU,embed:process.env.QMD_EMBED_MODEL}))",
      ],
      cwd: process.cwd(),
      env,
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      home: "/home/test",
      embed: lock.models.embed.uri,
    });
  } finally {
    if (inheritedPoison === undefined) delete process.env.QMD_FORCE_CPU;
    else process.env.QMD_FORCE_CPU = inheritedPoison;
  }
});

test("qmd adapter rejects invalid attached preparation as a harness error", async () => {
  const adapter = createQmdAdapterFactory()();
  const invalid = {
    adapterId: QMD_ADAPTER_ID,
    corpusFingerprint: snapshot.fingerprint,
    indexFingerprint: canonicalFingerprint({ invalid: true }),
    preparation: { valueMs: 0, unavailableReason: null },
    observations: {},
    tempPaths: [],
    handle: {},
  } satisfies AdapterPreparation;
  try {
    await adapter.prepare({
      snapshot,
      prepared: invalid,
      signal: new AbortController().signal,
    });
    throw new Error("expected invalid preparation");
  } catch (error) {
    expect(error).toBeInstanceOf(AgenticHarnessError);
    expect((error as AgenticHarnessError).code).toBe("qmd_preparation_invalid");
  }
});
