import { describe, expect, test } from "bun:test";

import type { GraphLink, GraphNode } from "../../src/store/types";

import { analyzeGraphCommunities } from "../../src/core/graph-analysis";

const node = (id: string, degree = 1): GraphNode => ({
  id,
  uri: `gno://notes/${id.slice(1)}.md`,
  title: id,
  collection: "notes",
  relPath: `${id.slice(1)}.md`,
  degree,
});

const link = (
  source: string,
  target: string,
  weight = 1,
  confidence: GraphLink["confidence"] = "explicit"
): GraphLink => ({
  source,
  target,
  type: "wiki",
  weight,
  confidence,
  audit: { resolution: "exact-title", matchCount: 1 },
});

describe("analyzeGraphCommunities", () => {
  test("detects two dense communities with a weak bridge deterministically", () => {
    const nodes = ["#a1", "#a2", "#a3", "#b1", "#b2", "#b3"].map((id) =>
      node(id, 3)
    );
    const links: GraphLink[] = [
      link("#a1", "#a2"),
      link("#a2", "#a3"),
      link("#a1", "#a3"),
      link("#b1", "#b2"),
      link("#b2", "#b3"),
      link("#b1", "#b3"),
      link("#a3", "#b1", 0.1, "similarity"),
    ];

    const first = analyzeGraphCommunities(nodes, links);
    const second = analyzeGraphCommunities(nodes, links);

    expect(first.skipped).toBe(false);
    expect(first.total).toBe(2);
    expect(first.communities.map((community) => community.size)).toEqual([
      3, 3,
    ]);
    expect(first.assignments).toEqual(second.assignments);
    expect(first.communities.map((community) => community.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  test("keeps isolates as singleton communities", () => {
    const result = analyzeGraphCommunities(
      [node("#a1", 1), node("#a2", 1), node("#z", 0)],
      [link("#a1", "#a2")]
    );

    expect(result.total).toBe(2);
    expect(result.assignments["#z"]).toBeDefined();
    expect(
      result.communities.some(
        (community) => community.size === 1 && community.edgeCount === 0
      )
    ).toBe(true);
  });

  test("handles sparse graphs", () => {
    const result = analyzeGraphCommunities(
      [node("#a", 1), node("#b", 1), node("#c", 0)],
      [link("#a", "#b")]
    );

    expect(result.skipped).toBe(false);
    expect(result.total).toBe(2);
    expect(result.communities[0]?.edgeCount).toBe(1);
  });

  test("skips large graphs with a warning", () => {
    const nodes = Array.from({ length: 6 }, (_, index) => node(`#n${index}`));
    const result = analyzeGraphCommunities(nodes, [], { nodeCap: 5 });

    expect(result.skipped).toBe(true);
    expect(result.total).toBe(0);
    expect(result.warnings[0]).toContain("Community detection skipped");
  });
});
