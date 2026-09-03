import { describe, expect, test } from "bun:test";

import type { MemoryFixtureManifest } from "../../evals/helpers/memory-fixtures";

import {
  MEMORY_FIXTURE_FILES,
  buildFixtureManifest,
  checkFixtureManifest,
  verifyFixtureManifest,
} from "../../evals/helpers/memory-fixtures";

const actualManifest = (): Promise<MemoryFixtureManifest> =>
  buildFixtureManifest();

const withFiles = (
  manifest: MemoryFixtureManifest,
  patch: Record<string, unknown>
): unknown => ({ ...manifest, files: { ...manifest.files, ...patch } });

describe("memory fixture manifest", () => {
  test("the committed manifest verifies against the fixture bytes", async () => {
    const committed = await verifyFixtureManifest();
    const actual = await actualManifest();
    expect(committed.algorithm).toBe("sha256");
    expect(committed.files).toEqual(actual.files);
  });

  test("accepts a manifest that matches the writer's output exactly", async () => {
    const actual = await actualManifest();
    const committed = JSON.parse(JSON.stringify(actual)) as unknown;
    expect(checkFixtureManifest(committed, actual)).toEqual(actual);
  });

  test("fails closed on an unexpected algorithm even when hashes match", async () => {
    const actual = await actualManifest();
    expect(() =>
      checkFixtureManifest({ ...actual, algorithm: "md5" }, actual)
    ).toThrow(/algorithm is "md5", expected "sha256"/);
    expect(() => checkFixtureManifest({ files: actual.files }, actual)).toThrow(
      /algorithm is undefined/
    );
  });

  test("fails closed when a pinned fixture has no string hash", async () => {
    const actual = await actualManifest();
    const [first, second] = MEMORY_FIXTURE_FILES;
    const missing = { ...actual.files };
    delete missing[first];
    expect(() =>
      checkFixtureManifest({ algorithm: "sha256", files: missing }, actual)
    ).toThrow(new RegExp(`no hash for: ${first}`));
    expect(() =>
      checkFixtureManifest(withFiles(actual, { [second]: "" }), actual)
    ).toThrow(new RegExp(`no hash for: ${second}`));
    expect(() =>
      checkFixtureManifest(withFiles(actual, { [second]: 42 }), actual)
    ).toThrow(new RegExp(`no hash for: ${second}`));
  });

  test("fails closed on a malformed manifest", async () => {
    const actual = await actualManifest();
    for (const malformed of [null, [], "sha256", { algorithm: "sha256" }]) {
      expect(() => checkFixtureManifest(malformed, actual)).toThrow(
        /malformed/
      );
    }
  });

  test("fails closed on hash drift and names the drifted file", async () => {
    const actual = await actualManifest();
    const [, , drifted] = MEMORY_FIXTURE_FILES;
    expect(() =>
      checkFixtureManifest(
        withFiles(actual, { [drifted]: "0".repeat(64) }),
        actual
      )
    ).toThrow(new RegExp(`drifted from manifest.json: ${drifted}`));
  });
});
