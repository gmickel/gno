import { describe, expect, test } from "bun:test";

import type { ContextRow, StorePort } from "../../src/store/types";

import {
  ContextResolver,
  contextIdentityFromUri,
  resolveContextSnapshot,
} from "../../src/core/context-resolver";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { ok } from "../../src/store/types";

const syncedAt = "2026-07-21T12:00:00.000Z";

function context(
  scopeType: ContextRow["scopeType"],
  scopeKey: string,
  text: string
): ContextRow {
  return { scopeType, scopeKey, text, syncedAt };
}

describe("resolveContextSnapshot", () => {
  test("orders global, collection, and nested prefixes broadest first", () => {
    const resolved = resolveContextSnapshot(
      [
        context("prefix", "gno://notes/projects/alpha", "Alpha guidance"),
        context("collection", "notes:", "Notes guidance"),
        context("prefix", "gno://notes/projects", "Projects guidance"),
        context("global", "/", "Global guidance"),
      ],
      { collection: "notes", relPath: "projects/alpha/readme.md" }
    );

    expect(resolved?.text).toBe(
      "Global guidance\n\nNotes guidance\n\nProjects guidance\n\nAlpha guidance"
    );
    expect(resolved?.provenance.map((entry) => entry.scopeKey)).toEqual([
      "/",
      "notes:",
      "gno://notes/projects",
      "gno://notes/projects/alpha",
    ]);
  });

  test("normalizes slashes and enforces segment boundaries", () => {
    const resolved = resolveContextSnapshot(
      [
        context("prefix", "gno://notes/projects//alpha/", "Match"),
        context("prefix", "gno://notes/projects/al", "Partial segment"),
        context("prefix", "gno://notes/projects/alpha-two", "Sibling"),
      ],
      { collection: "notes", relPath: "projects\\alpha\\readme.md" }
    );

    expect(resolved?.text).toBe("Match");
    expect(resolved?.provenance[0]?.normalizedScopeKey).toBe(
      "gno://notes/projects/alpha"
    );
  });

  test("collapses normalized record and joined-text duplicates", () => {
    const resolved = resolveContextSnapshot(
      [
        context("prefix", "gno://notes/projects//alpha", "Shared\r\ntext"),
        context("prefix", "gno://notes/projects/alpha/", "Shared\ntext"),
        context("collection", "notes:", "Shared\ntext"),
      ],
      { collection: "notes", relPath: "projects/alpha/readme.md" }
    );

    expect(resolved?.text).toBe("Shared\ntext");
    expect(resolved?.provenance).toHaveLength(2);
    expect(resolved?.provenance.map((entry) => entry.scopeType)).toEqual([
      "collection",
      "prefix",
    ]);
  });

  test("returns no match for other collections or unsafe identities", () => {
    const contexts = [
      context("collection", "notes:", "Notes"),
      context("prefix", "gno://notes/projects", "Projects"),
    ];

    expect(
      resolveContextSnapshot(contexts, {
        collection: "work",
        relPath: "projects/readme.md",
      })
    ).toBeUndefined();
    expect(
      resolveContextSnapshot(contexts, {
        collection: "notes",
        relPath: "projects/../secrets.md",
      })
    ).toBeUndefined();
  });

  test("derives canonical identities from indexed and Windows-style URIs", () => {
    expect(
      contextIdentityFromUri(
        "gno://notes/projects%5Calpha/readme.md?index=personal"
      )
    ).toEqual({ collection: "notes", relPath: "projects/alpha/readme.md" });
    expect(contextIdentityFromUri("file:///notes/readme.md")).toBeNull();
  });
});

describe("ContextResolver", () => {
  test("reads contexts once per store generation for any result count", async () => {
    let generation = 1;
    let reads = 0;
    let contexts = [context("global", "/", "Before sync")];
    const store = {
      getContextGeneration: () => generation,
      getContexts: async () => {
        reads += 1;
        return ok(contexts);
      },
    } as unknown as StorePort;
    const resolver = new ContextResolver(store);

    const first = await resolver.resolveMany([
      { collection: "notes", relPath: "one.md" },
      { collection: "notes", relPath: "two.md" },
      { collection: "work", relPath: "three.md" },
    ]);
    await resolver.resolve({ collection: "notes", relPath: "four.md" });

    expect(first.map((entry) => entry?.text)).toEqual([
      "Before sync",
      "Before sync",
      "Before sync",
    ]);
    expect(reads).toBe(1);

    contexts = [context("global", "/", "After sync")];
    generation += 1;
    const refreshed = await resolver.resolve({
      collection: "notes",
      relPath: "one.md",
    });

    expect(refreshed?.text).toBe("After sync");
    expect(reads).toBe(2);
  });

  test("drops stale context and retries after a failed refreshed read", async () => {
    let generation = 1;
    let shouldFail = false;
    let reads = 0;
    const store = {
      getContextGeneration: () => generation,
      getContexts: async () => {
        reads += 1;
        if (shouldFail) {
          return {
            ok: false as const,
            error: { code: "QUERY_FAILED" as const, message: "temporary" },
          };
        }
        return ok([context("global", "/", `Generation ${generation}`)]);
      },
    } as unknown as StorePort;
    const resolver = new ContextResolver(store);

    expect(
      (await resolver.resolve({ collection: "notes", relPath: "one.md" }))?.text
    ).toBe("Generation 1");

    generation = 2;
    shouldFail = true;
    expect(
      await resolver.resolve({ collection: "notes", relPath: "one.md" })
    ).toBeUndefined();

    shouldFail = false;
    expect(
      (await resolver.resolve({ collection: "notes", relPath: "one.md" }))?.text
    ).toBe("Generation 2");
    expect(reads).toBe(3);
  });

  test("observes successful SqliteAdapter context syncs", async () => {
    const store = new SqliteAdapter();
    const openResult = await store.open(":memory:", "unicode61");
    expect(openResult.ok).toBe(true);

    const initialGeneration = store.getContextGeneration();
    await store.syncContexts([
      { scopeType: "global", scopeKey: "/", text: "First" },
    ]);
    expect(store.getContextGeneration()).toBe(initialGeneration + 1);

    const resolver = new ContextResolver(store);
    expect(
      (await resolver.resolve({ collection: "notes", relPath: "one.md" }))?.text
    ).toBe("First");

    await store.syncContexts([
      { scopeType: "global", scopeKey: "/", text: "Second" },
    ]);
    expect(
      (await resolver.resolve({ collection: "notes", relPath: "one.md" }))?.text
    ).toBe("Second");
    await store.close();
  });
});
