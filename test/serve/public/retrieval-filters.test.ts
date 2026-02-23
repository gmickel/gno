import { describe, expect, test } from "bun:test";

import {
  applyFiltersToUrl,
  parseFiltersFromSearch,
  parseQueryModeSpec,
  parseQueryModes,
  parseTagsCsv,
  type RetrievalFiltersState,
} from "../../../src/serve/public/lib/retrieval-filters";

describe("retrieval filters", () => {
  test("parseTagsCsv normalizes, validates, dedupes", () => {
    expect(parseTagsCsv("Urgent, project/Alpha, invalid tag, urgent")).toEqual([
      "urgent",
      "project/alpha",
    ]);
  });

  test("parseQueryModeSpec parses valid mode:text", () => {
    expect(parseQueryModeSpec("term:vector search")).toEqual({
      mode: "term",
      text: "vector search",
    });
    expect(parseQueryModeSpec("hyde:  realistic answer draft  ")).toEqual({
      mode: "hyde",
      text: "realistic answer draft",
    });
  });

  test("parseQueryModeSpec rejects invalid values", () => {
    expect(parseQueryModeSpec("unknown:text")).toBeNull();
    expect(parseQueryModeSpec("term:")).toBeNull();
    expect(parseQueryModeSpec("missing-delimiter")).toBeNull();
  });

  test("parseQueryModes enforces single hyde and dedupes", () => {
    expect(
      parseQueryModes([
        "term:auth",
        "hyde:answer draft",
        "hyde:another draft",
        "term:auth",
        "intent:find canonical docs",
      ])
    ).toEqual([
      { mode: "term", text: "auth" },
      { mode: "hyde", text: "answer draft" },
      { mode: "intent", text: "find canonical docs" },
    ]);
  });

  test("URL roundtrip for filters", () => {
    const source = parseFiltersFromSearch(
      "?collection=notes&since=2025-01-01&until=2025-12-31&category=engineering&author=gordon&tagsAll=project/alpha,urgent&qm=term:vector%20search&qm=intent:find%20best%20docs"
    );
    expect(source).toEqual({
      collection: "notes",
      since: "2025-01-01",
      until: "2025-12-31",
      category: "engineering",
      author: "gordon",
      tagMode: "all",
      tags: ["project/alpha", "urgent"],
      queryModes: [
        { mode: "term", text: "vector search" },
        { mode: "intent", text: "find best docs" },
      ],
    });

    const target = new URL("http://localhost/search");
    const filters: RetrievalFiltersState = {
      collection: "notes",
      since: "2025-01-01",
      until: "2025-12-31",
      category: "engineering",
      author: "gordon",
      tagMode: "all",
      tags: ["project/alpha", "urgent"],
      queryModes: [
        { mode: "term", text: "vector search" },
        { mode: "intent", text: "find best docs" },
      ],
    };
    applyFiltersToUrl(target, filters);
    expect(target.searchParams.get("collection")).toBe("notes");
    expect(target.searchParams.get("tagsAll")).toBe("project/alpha,urgent");
    expect(target.searchParams.get("tagsAny")).toBeNull();
    expect(target.searchParams.getAll("qm")).toEqual([
      "term:vector search",
      "intent:find best docs",
    ]);
  });
});
