import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory lifecycle and directory creation have no Bun equivalent.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os: temporary directory discovery has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path construction has no Bun equivalent.
import { dirname, join } from "node:path";

import type {
  AgenticFixtureManifest,
  NativeIndexPreparation,
} from "../../../evals/agentic/types";

import { canonicalFingerprint } from "../../../evals/agentic/canonical";
import {
  AGENTIC_FIXTURE_ROOT,
  cleanupNativeIndexPreparation,
  loadAgenticFixture,
  prepareGnoNativeIndex,
  recordAdapterNativeIndex,
} from "../../../evals/agentic/fixture-db";

const temporaryRoots: string[] = [];
const nativePreparations: NativeIndexPreparation[] = [];

afterEach(async () => {
  for (const preparation of nativePreparations.splice(0)) {
    await cleanupNativeIndexPreparation(preparation);
  }
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

const copyFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "gno-agentic-fixture-copy-"));
  temporaryRoots.push(root);
  const manifest = (await Bun.file(
    join(AGENTIC_FIXTURE_ROOT, "manifest.json")
  ).json()) as AgenticFixtureManifest;
  for (const entry of manifest.files) {
    const target = join(root, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(
      target,
      await Bun.file(join(AGENTIC_FIXTURE_ROOT, entry.path)).bytes()
    );
  }
  await Bun.write(
    join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return root;
};

describe("agentic corpus snapshot", () => {
  test("is immutable and exact-manifest fingerprinted", async () => {
    const fixture = await loadAgenticFixture();
    expect(Object.isFrozen(fixture.snapshot)).toBe(true);
    expect(Object.isFrozen(fixture.snapshot.files)).toBe(true);
    const firstFile = fixture.snapshot.files[0];
    if (!firstFile) throw new Error("snapshot file missing");
    expect(Object.isFrozen(firstFile)).toBe(true);
    const originalContent = firstFile.content;
    expect(() => {
      (firstFile as { content: string }).content = "tampered";
    }).toThrow();
    expect(firstFile.content).toBe(originalContent);
    expect(fixture.snapshot.fingerprint).toBe(
      fixture.manifest.corpusFingerprint
    );
    expect(
      new Set(fixture.snapshot.files.map((file) => file.sourceHash)).size
    ).toBe(fixture.snapshot.files.length);
  });

  test("fails closed when a manifest-pinned source changes", async () => {
    const root = await copyFixture();
    const manifest = (await Bun.file(
      join(root, "manifest.json")
    ).json()) as AgenticFixtureManifest;
    const corpusEntry = manifest.files.find((entry) => entry.kind === "corpus");
    if (!corpusEntry) throw new Error("corpus entry missing");
    await Bun.write(join(root, corpusEntry.path), "# Tampered\n");
    expect(loadAgenticFixture(root)).rejects.toThrow("hash mismatch");
  });

  test("fails closed when an oracle evidence span is tampered", async () => {
    const root = await copyFixture();
    const manifest = (await Bun.file(
      join(root, "manifest.json")
    ).json()) as AgenticFixtureManifest;
    const oracleEntry = manifest.files.find((entry) => entry.kind === "oracle");
    if (!oracleEntry) throw new Error("oracle entry missing");
    const oracle = (await Bun.file(join(root, oracleEntry.path)).json()) as {
      claims: Array<{ requiredEvidence: Array<{ spanHash: string }> }>;
    };
    const coordinate = oracle.claims[0]?.requiredEvidence[0];
    if (!coordinate) throw new Error("required evidence missing");
    coordinate.spanHash = "f".repeat(64);
    const changed = `${JSON.stringify(oracle, null, 2)}\n`;
    await Bun.write(join(root, oracleEntry.path), changed);
    oracleEntry.sha256 = new Bun.CryptoHasher("sha256")
      .update(changed)
      .digest("hex");
    await Bun.write(
      join(root, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    expect(loadAgenticFixture(root)).rejects.toThrow("span hash mismatch");
  });

  test("binds separate adapter indexes to one corpus fingerprint", async () => {
    const fixture = await loadAgenticFixture();
    const lexical = recordAdapterNativeIndex(fixture.snapshot, {
      adapterId: "lexical",
      indexFingerprint: canonicalFingerprint({ format: "sqlite-fts5" }),
      observations: { preparationMs: 2, details: { documents: 34 } },
    });
    const qmd = recordAdapterNativeIndex(fixture.snapshot, {
      adapterId: "qmd",
      indexFingerprint: canonicalFingerprint({ format: "qmd-native" }),
      observations: { preparationMs: 4, details: { documents: 34 } },
    });
    expect(lexical.corpusFingerprint).toBe(fixture.snapshot.fingerprint);
    expect(qmd.corpusFingerprint).toBe(fixture.snapshot.fingerprint);
    expect(lexical.indexFingerprint).not.toBe(qmd.indexFingerprint);
    expect(lexical.observations).not.toEqual(qmd.observations);
  });
});

describe("production-native fixture index", () => {
  test("ingests the immutable snapshot without global config mutation", async () => {
    const fixture = await loadAgenticFixture();
    const preparation = await prepareGnoNativeIndex(fixture.snapshot);
    nativePreparations.push(preparation);
    expect(preparation.corpusFingerprint).toBe(fixture.snapshot.fingerprint);
    expect(preparation.documentCount).toBe(fixture.snapshot.files.length);
    expect(preparation.collectionCount).toBeGreaterThanOrEqual(24);
    expect(preparation.observations.filesProcessed).toBe(
      fixture.snapshot.files.length
    );
    expect(preparation.observations.filesErrored).toBe(0);
    expect(preparation.indexFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(preparation.dbPath).exists()).toBe(true);
  });

  test("produces the same native index fingerprint from unchanged bytes", async () => {
    const fixture = await loadAgenticFixture();
    const first = await prepareGnoNativeIndex(fixture.snapshot);
    const second = await prepareGnoNativeIndex(fixture.snapshot);
    nativePreparations.push(first, second);
    expect(first.indexFingerprint).toBe(second.indexFingerprint);
    expect(first.rootPath).not.toBe(second.rootPath);
    expect(first.observations.preparationMs).toBeGreaterThanOrEqual(0);
  });
});
