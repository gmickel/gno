/** Prepare frozen, synthetic, isolated paired handoffs; never invokes a reader. */
// Bun has no temporary-directory or directory lifecycle APIs.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// Bun has no OS/path utilities.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Config } from "../src/config/types";

import {
  previewCompiledContext,
  checkCompiledContext,
} from "../src/app/compiled-context";
import { buildContextCapsule } from "../src/app/context-runtime";
import { canonicalContextCapsuleJson } from "../src/core/context-capsule";
import { sha256Text } from "../src/core/context-capsule-validation";
import { SqliteAdapter } from "../src/store/sqlite/adapter";

type Case = {
  id: string;
  goal: string;
  documents: { path: string; text: string; padding?: number }[];
  requiredPaths: string[];
};
const fixturesPath = resolve("evals/fixtures/compiled-context/cases.json");
const cases = (await Bun.file(fixturesPath).json()) as Case[];
const output = resolve(
  process.argv[2] ??
    ".flow/artifacts/fn-169-compiled-project-context-from-verified/eval"
);
await mkdir(output, { recursive: true });
if (await Bun.file(join(output, "prepared.json")).exists())
  throw new Error("Refusing to overwrite frozen preparation");
const records = [];
for (const fixture of cases) {
  const root = await mkdtemp(join(tmpdir(), "gno-compiled-eval-"));
  const store = new SqliteAdapter();
  try {
    const opened = await store.open(join(root, "default.sqlite"), "unicode61");
    if (!opened.ok) throw new Error(opened.error.message);
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61",
      contexts: [],
      collections: [
        {
          name: "eval",
          path: root,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    };
    const synced = await store.syncCollections(config.collections);
    if (!synced.ok) throw new Error(synced.error.message);
    for (const doc of fixture.documents) {
      const text =
        doc.text +
        (doc.padding
          ? "\n" +
            "blue ".repeat(Math.ceil(doc.padding / 5)).slice(0, doc.padding)
          : "");
      const hash = sha256Text(text);
      const document = await store.upsertDocument({
        collection: "eval",
        relPath: doc.path,
        sourceHash: hash,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: text.length,
        sourceMtime: "2026-09-23T10:00:00.000Z",
        mirrorHash: hash,
        title: fixture.goal,
      });
      if (!document.ok) throw new Error(document.error.message);
      const content = await store.upsertContent(hash, text);
      if (!content.ok) throw new Error(content.error.message);
      const chunks = await store.upsertChunks(hash, [
        {
          seq: 0,
          pos: 0,
          text,
          startLine: 1,
          endLine: text.split("\n").length,
        },
      ]);
      if (!chunks.ok) throw new Error(chunks.error.message);
      const fts = await store.rebuildFtsForHash(hash);
      if (!fts.ok) throw new Error(fts.error.message);
    }
    const deps = { store, config, indexName: "default" };
    const capsule = await buildContextCapsule(
      {
        goal: fixture.goal,
        collections: ["eval"],
        budgetTokens: 12_000,
        budgetBytes: 12_000,
        depthPolicy: "fast",
        safetyMarginTokens: 0,
        safetyMarginBytes: 0,
      },
      deps
    );
    const input = { capsule, budgetTokens: 12_000, budgetBytes: 12_000 };
    const compiled = await previewCompiledContext(input, deps);
    const repeated = await previewCompiledContext(input, deps);
    const baseline = canonicalContextCapsuleJson(capsule);
    const requiredUris = fixture.requiredPaths.map(
      (path) => `gno://eval/${path}`
    );
    const selectedUris = capsule.evidence
      .filter((item) => compiled.evidenceIds.includes(item.evidenceId))
      .map((item) => item.uri);
    const current = await checkCompiledContext(
      { capsule, markdown: compiled.markdown },
      deps
    );
    let privacyRejected = false;
    try {
      await previewCompiledContext(input, {
        ...deps,
        config: { ...config, collections: [] },
      });
    } catch {
      privacyRejected = true;
    }
    const first = fixture.documents[0]!;
    const changed = await store.upsertDocument({
      collection: "eval",
      relPath: first.path,
      sourceHash: sha256Text("changed-source"),
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 20,
      sourceMtime: "2026-09-24T10:00:00.000Z",
      mirrorHash: sha256Text(first.text),
      title: fixture.goal,
    });
    if (!changed.ok) throw new Error(changed.error.message);
    const stale = await checkCompiledContext(
      { capsule, markdown: compiled.markdown },
      deps
    );
    const guards = {
      deterministic: compiled.markdown === repeated.markdown,
      baselineBudget: Buffer.byteLength(baseline) <= 12_000,
      compiledBudget:
        compiled.budget.usedBytes <= 12_000 &&
        compiled.budget.usedTokens <= 12_000,
      requiredEvidence: requiredUris.every((uri) => selectedUris.includes(uri)),
      citations: requiredUris.every((uri) => compiled.markdown.includes(uri)),
      privacyRejected,
      current: current.status === "current",
      stale: stale.status === "stale",
    };
    await Bun.write(join(output, `${fixture.id}.capsule.txt`), baseline);
    await Bun.write(
      join(output, `${fixture.id}.compiled.txt`),
      compiled.markdown
    );
    records.push({
      id: fixture.id,
      requiredUris,
      guards,
      capsuleId: capsule.capsuleId,
      baselineBytes: Buffer.byteLength(baseline),
      compiledBytes: compiled.budget.usedBytes,
      estimator: compiled.budget.estimator,
      omissions: compiled.omissions,
      coverage: compiled.coverage,
      stale,
      sha256: {
        capsule: sha256Text(baseline),
        compiled: sha256Text(compiled.markdown),
      },
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
const manifest: Record<string, string> = {};
for (const path of [
  fixturesPath,
  "evals/fixtures/compiled-context/PREREGISTER.md",
  "evals/compiled-context-prepare.ts",
  "src/core/compiled-context.ts",
  "src/app/compiled-context.ts",
]) {
  manifest[path] = sha256Text(await Bun.file(path).text());
}
await Bun.write(
  join(output, "prepared.json"),
  JSON.stringify(
    {
      schemaVersion: "1.0",
      fixtureSha256: manifest[fixturesPath],
      manifest,
      records,
      guardsPassed: records.every((record) =>
        Object.values(record.guards).every(Boolean)
      ),
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    cases: records.length,
    guardsPassed: records.every((record) =>
      Object.values(record.guards).every(Boolean)
    ),
    output,
  })
);
