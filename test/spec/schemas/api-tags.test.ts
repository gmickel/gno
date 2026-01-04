/**
 * Contract tests for tags-list schema.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("tags-list schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("tags-list");
  });

  describe("valid inputs", () => {
    test("validates minimal response", () => {
      const response = {
        tags: [],
        meta: { totalTags: 0 },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with tags", () => {
      const response = {
        tags: [
          { tag: "work", count: 5 },
          { tag: "personal", count: 3 },
        ],
        meta: { totalTags: 2 },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with collection filter", () => {
      const response = {
        tags: [{ tag: "meeting", count: 2 }],
        meta: { totalTags: 1, collection: "notes" },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with prefix filter", () => {
      const response = {
        tags: [
          { tag: "project", count: 5 },
          { tag: "project/alpha", count: 3 },
          { tag: "project/beta", count: 2 },
        ],
        meta: { totalTags: 3, prefix: "project" },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with both filters", () => {
      const response = {
        tags: [{ tag: "work/urgent", count: 1 }],
        meta: { totalTags: 1, collection: "tasks", prefix: "work" },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates hierarchical tags", () => {
      const response = {
        tags: [
          { tag: "dev/frontend/react", count: 10 },
          { tag: "dev/backend/node", count: 8 },
        ],
        meta: { totalTags: 2 },
      };
      expect(assertValid(response, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing tags array", () => {
      const response = {
        meta: { totalTags: 0 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta object", () => {
      const response = {
        tags: [],
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta.totalTags", () => {
      const response = {
        tags: [],
        meta: {},
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects negative meta.totalTags", () => {
      const response = {
        tags: [],
        meta: { totalTags: -1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects tag without tag field", () => {
      const response = {
        tags: [{ count: 5 }],
        meta: { totalTags: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects tag without count field", () => {
      const response = {
        tags: [{ tag: "work" }],
        meta: { totalTags: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects count less than 1", () => {
      const response = {
        tags: [{ tag: "work", count: 0 }],
        meta: { totalTags: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects non-integer count", () => {
      const response = {
        tags: [{ tag: "work", count: 2.5 }],
        meta: { totalTags: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects non-integer totalTags", () => {
      const response = {
        tags: [],
        meta: { totalTags: 1.5 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });
  });
});
