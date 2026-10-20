import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";

import {
  MAX_REQUEST_COLLECTIONS,
  normalizeCollectionList,
  resolveCollectionScope,
} from "../../src/core/collection-scope";
import { modelCollectionForList } from "../../src/llm/registry";

const configured = ["alpha", "beta", "gamma"].map((name) => ({ name }));
const names = (count: number) =>
  Array.from({ length: count }, (_, i) => `c${String(i).padStart(3, "0")}`);

describe("normalizeCollectionList", () => {
  test("trims, lowercases, de-duplicates and sorts", () => {
    expect(normalizeCollectionList([" Work", "notes", "work "])).toEqual({
      ok: true,
      value: ["notes", "work"],
    });
  });

  test("accepts exactly the bound and rejects one more", () => {
    expect(MAX_REQUEST_COLLECTIONS).toBe(256);
    expect(normalizeCollectionList(names(256)).ok).toBe(true);
    expect(normalizeCollectionList(names(257))).toEqual({
      ok: false,
      message: "collections must list at most 256 names",
    });
  });

  test("counts the bound after normalization", () => {
    const duplicated = [...names(256), "C000", " c001 "];
    expect(normalizeCollectionList(duplicated).ok).toBe(true);
  });

  test("rejects empty lists, non-arrays, blank and non-string members", () => {
    expect(normalizeCollectionList([])).toEqual({
      ok: false,
      message: "collections must list at least one name",
    });
    expect(normalizeCollectionList("work").ok).toBe(false);
    expect(normalizeCollectionList(["work", " "]).ok).toBe(false);
    expect(normalizeCollectionList(["work", 3]).ok).toBe(false);
  });
});

describe("resolveCollectionScope", () => {
  test("absent collections leaves single-collection behaviour unchanged", () => {
    expect(resolveCollectionScope({ collection: "alpha" }, configured)).toEqual(
      { ok: true, collections: undefined }
    );
  });

  test("refuses collection together with collections", () => {
    expect(
      resolveCollectionScope(
        { collection: "alpha", collections: ["alpha"] },
        configured
      )
    ).toEqual({
      ok: false,
      kind: "validation",
      message: "Pass either collection or collections, not both",
    });
  });

  test("names every unknown collection", () => {
    expect(
      resolveCollectionScope(
        { collections: ["alpha", "nope", "missing"] },
        configured
      )
    ).toEqual({
      ok: false,
      kind: "not_found",
      message: "Collections not found: missing, nope",
    });
    expect(
      resolveCollectionScope({ collections: ["nope"] }, configured)
    ).toEqual({
      ok: false,
      kind: "not_found",
      message: "Collection not found: nope",
    });
  });

  test("matches configured names case-insensitively", () => {
    expect(
      resolveCollectionScope({ collections: ["Beta", "ALPHA"] }, configured)
    ).toEqual({ ok: true, collections: ["alpha", "beta"] });
  });
});

describe("modelCollectionForList", () => {
  const config = {
    collections: [
      { name: "alpha", models: { embed: "hf:custom/embed.gguf" } },
      { name: "beta", models: { embed: "hf:custom/embed.gguf" } },
      { name: "gamma" },
    ],
  } as unknown as Config;

  test("uses the shared model when every listed collection agrees", () => {
    expect(modelCollectionForList(config, "embed", ["alpha", "beta"])).toBe(
      "alpha"
    );
  });

  test("falls back to unscoped resolution when listed collections differ", () => {
    expect(
      modelCollectionForList(config, "embed", ["alpha", "gamma"])
    ).toBeUndefined();
  });

  test("returns undefined without a list", () => {
    expect(modelCollectionForList(config, "embed", undefined)).toBeUndefined();
  });
});
