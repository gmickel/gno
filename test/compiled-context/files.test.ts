// Bun async rejection assertions return promises despite their void matcher typings.
/* oxlint-disable typescript-eslint/await-thenable */
import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink or chmod primitives.
import { mkdtemp, realpath, symlink } from "node:fs/promises";
// Bun has no platform temp-directory or path helpers.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompiledContextRuntimeDeps } from "../../src/app/compiled-context";

import {
  compileContextFile,
  checkContextFile,
  refreshContextFile,
} from "../../src/app/compiled-context-files";
import { buildContextCapsule } from "../../src/app/context-runtime";
import { sha256Text } from "../../src/core/context-capsule-validation";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

let root: string;
let store: SqliteAdapter;
let deps: CompiledContextRuntimeDeps;
let capsulePath: string;
let outputPath: string;
const request = {
  goal: "launch owner",
  collections: ["notes"],
  budgetTokens: 100_000,
  budgetBytes: 100_000,
  depthPolicy: "fast" as const,
};
async function seed(text: string): Promise<void> {
  const hash = sha256Text(text);
  expect(
    (
      await store.upsertDocument({
        collection: "notes",
        relPath: "source.md",
        sourceHash: hash,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: text.length,
        sourceMtime: "2026-09-23T10:00:00.000Z",
        mirrorHash: hash,
        title: "Launch owner",
      })
    ).ok
  ).toBe(true);
  expect((await store.upsertContent(hash, text)).ok).toBe(true);
  expect(
    (
      await store.upsertChunks(hash, [
        { seq: 0, pos: 0, text, startLine: 1, endLine: 1 },
      ])
    ).ok
  ).toBe(true);
  expect((await store.rebuildFtsForHash(hash)).ok).toBe(true);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "gno-compiled-files-")));
  store = new SqliteAdapter();
  expect((await store.open(join(root, "default.sqlite"), "unicode61")).ok).toBe(
    true
  );
  const config: CompiledContextRuntimeDeps["config"] = {
    version: "1.0" as const,
    ftsTokenizer: "unicode61",
    contexts: [],
    collections: [
      {
        name: "notes",
        path: root,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
  };
  expect((await store.syncCollections(config.collections)).ok).toBe(true);
  deps = { store, config, indexName: "default" };
  await seed("The launch owner is Mina.");
  capsulePath = join(root, "input.json");
  outputPath = join(root, "project.gno-context.md");
  await Bun.write(
    capsulePath,
    JSON.stringify(await buildContextCapsule(request, deps))
  );
});
afterEach(async () => {
  await store.close();
  await safeRm(root);
});
const compile = () =>
  compileContextFile({ capsulePath, outputPath, budgetTokens: 20_000 }, deps);

test("compile writes private companions, verifies, and refuses overwrites", async () => {
  const written = await compile();
  expect(written.status).toBe("written");
  assertValid(written, await loadSchema("compiled-context-file"));
  expect((await checkContextFile({ outputPath }, deps)).status).toBe("current");
  await expect(compile()).rejects.toThrow("already exists");
  const bytes = await Bun.file(outputPath).text();
  const noOp = await refreshContextFile(
    {
      outputPath,
      capsuleOutputPath: join(root, "fresh.gno-context.capsule.json"),
    },
    deps,
    () => {
      throw new Error("No rebuild expected");
    }
  );
  expect(noOp.status).toBe("unchanged");
  expect(await Bun.file(outputPath).text()).toBe(bytes);
});
test("manual edits conflict and stay intact", async () => {
  await compile();
  await Bun.write(outputPath, "My manual edit");
  expect((await checkContextFile({ outputPath }, deps)).status).toBe(
    "conflict"
  );
  await expect(
    refreshContextFile(
      {
        outputPath,
        capsuleOutputPath: join(root, "fresh.gno-context.capsule.json"),
      },
      deps,
      () => buildContextCapsule(request, deps)
    )
  ).rejects.toThrow("Conflict");
  expect(await Bun.file(outputPath).text()).toBe("My manual edit");
});
test("stale refresh rebuilds while preserving original Capsule", async () => {
  await compile();
  const original = await Bun.file(capsulePath).text();
  await seed("The launch owner is Nora.");
  expect((await checkContextFile({ outputPath }, deps)).status).toBe("stale");
  const fresh = join(root, "fresh.gno-context.capsule.json");
  expect(
    (
      await refreshContextFile(
        { outputPath, capsuleOutputPath: fresh },
        deps,
        (input) => buildContextCapsule(input, deps)
      )
    ).status
  ).toBe("written");
  expect((await checkContextFile({ outputPath }, deps)).status).toBe("current");
  expect(await Bun.file(capsulePath).text()).toBe(original);
  expect(await Bun.file(outputPath).text()).toContain("Nora");
});
test("failed destination and failed rebuild leave the complete prior artifact", async () => {
  await compile();
  const markdown = await Bun.file(outputPath).text();
  const metadata = await Bun.file(`${outputPath}.json`).text();
  await seed("The launch owner is Nora.");
  await expect(
    refreshContextFile(
      {
        outputPath,
        capsuleOutputPath: join(
          root,
          "missing",
          "fresh.gno-context.capsule.json"
        ),
      },
      deps,
      () => {
        throw new Error("must preflight destination");
      }
    )
  ).rejects.toThrow();
  await expect(
    refreshContextFile(
      {
        outputPath,
        capsuleOutputPath: join(root, "fresh.gno-context.capsule.json"),
      },
      deps,
      () => {
        throw new Error("build failed");
      }
    )
  ).rejects.toThrow("build failed");
  expect(await Bun.file(outputPath).text()).toBe(markdown);
  expect(await Bun.file(`${outputPath}.json`).text()).toBe(metadata);
});
test("symlink output and parent traversal are refused", async () => {
  await symlink(capsulePath, outputPath);
  await expect(compile()).rejects.toThrow("Unsafe");
  const alias = join(root, "alias");
  await symlink(root, alias);
  await expect(
    compileContextFile(
      {
        capsulePath,
        outputPath: join(alias, "other.gno-context.md"),
        budgetTokens: 20_000,
      },
      deps
    )
  ).rejects.toThrow("Unsafe");
});
test("missing companion is unverifiable", async () => {
  await Bun.write(outputPath, "orphan");
  expect((await checkContextFile({ outputPath }, deps)).status).toBe(
    "unverifiable"
  );
});

test("interrupted replacement keeps the previous artifact checkable", async () => {
  await compile();
  const metadata = JSON.parse(await Bun.file(`${outputPath}.json`).text());
  const previous = {
    capsulePath: metadata.capsulePath,
    outputDigest: metadata.outputDigest,
    settings: metadata.settings,
  };
  await Bun.write(
    `${outputPath}.json`,
    JSON.stringify({
      ...metadata,
      outputDigest: "f".repeat(64),
      capsulePath: join(root, "unpublished.json"),
      previous,
    })
  );
  expect((await checkContextFile({ outputPath }, deps)).status).toBe("current");
});

test("concurrent hand edit during rebuild prevents publication", async () => {
  await compile();
  await seed("The launch owner is Nora.");
  const target = join(root, "fresh.gno-context.capsule.json");
  await expect(
    refreshContextFile(
      { outputPath, capsuleOutputPath: target },
      deps,
      async (input) => {
        const capsule = await buildContextCapsule(input, deps);
        await Bun.write(outputPath, "Concurrent manual edit");
        return capsule;
      }
    )
  ).rejects.toThrow("Conflict");
  expect(await Bun.file(outputPath).text()).toBe("Concurrent manual edit");
  expect(await Bun.file(target).exists()).toBe(false);
});
