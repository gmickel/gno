/**
 * Unit tests for GET /api/tags endpoint.
 */

import { describe, expect, test } from "bun:test";

import { handleTags } from "../../../src/serve/routes/api";

// Minimal mock store for testing
function createMockStore(tagCounts: Array<{ tag: string; count: number }>) {
  return {
    getTagCounts(options?: { collection?: string; prefix?: string }) {
      let filtered = tagCounts;

      if (options?.collection) {
        // Simulate filtering - in real store this filters by collection
        filtered = tagCounts.filter((t) =>
          t.tag.startsWith(options.collection ?? "")
        );
      }

      if (options?.prefix) {
        // Filter by prefix
        filtered = filtered.filter(
          (t) =>
            t.tag === options.prefix || t.tag.startsWith(`${options.prefix}/`)
        );
      }

      return Promise.resolve({ ok: true as const, value: filtered });
    },
  };
}

interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
  meta: { totalTags: number; collection?: string; prefix?: string };
}

describe("GET /api/tags", () => {
  test("returns 200 with valid JSON and meta", async () => {
    const store = createMockStore([
      { tag: "work", count: 5 },
      { tag: "personal", count: 3 },
    ]);

    const url = new URL("http://localhost/api/tags");
    const res = await handleTags(store as never, url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as TagsResponse;
    expect(body.tags).toBeArrayOfSize(2);
    expect(body.tags[0]).toEqual({ tag: "work", count: 5 });
    expect(body.tags[1]).toEqual({ tag: "personal", count: 3 });
    expect(body.meta.totalTags).toBe(2);
  });

  test("filters by collection and includes in meta", async () => {
    const store = createMockStore([
      { tag: "notes/meeting", count: 2 },
      { tag: "notes/idea", count: 1 },
    ]);

    const url = new URL("http://localhost/api/tags?collection=notes");
    const res = await handleTags(store as never, url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as TagsResponse;
    expect(body.tags).toBeArrayOfSize(2);
    expect(body.meta.collection).toBe("notes");
  });

  test("filters by prefix and includes in meta", async () => {
    const store = createMockStore([
      { tag: "work", count: 5 },
      { tag: "work/project-a", count: 3 },
      { tag: "work/project-b", count: 2 },
      { tag: "personal", count: 4 },
    ]);

    const url = new URL("http://localhost/api/tags?prefix=work");
    const res = await handleTags(store as never, url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as TagsResponse;
    expect(body.tags).toBeArrayOfSize(3);
    expect(body.tags.map((t) => t.tag)).toEqual([
      "work",
      "work/project-a",
      "work/project-b",
    ]);
    expect(body.meta.prefix).toBe("work");
  });

  test("returns empty array when no tags exist", async () => {
    const store = createMockStore([]);

    const url = new URL("http://localhost/api/tags");
    const res = await handleTags(store as never, url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as TagsResponse;
    expect(body.tags).toBeArrayOfSize(0);
    expect(body.meta.totalTags).toBe(0);
  });

  test("handles store error gracefully", async () => {
    const store = {
      getTagCounts() {
        return Promise.resolve({
          ok: false as const,
          error: { code: "QUERY_FAILED", message: "Database error" },
        });
      },
    };

    const url = new URL("http://localhost/api/tags");
    const res = await handleTags(store as never, url);

    expect(res.status).toBe(500);

    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("RUNTIME");
    expect(body.error.message).toBe("Database error");
  });
});
