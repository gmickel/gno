import { describe, expect, test } from "bun:test";

import {
  buildBrowseTree,
  createBrowseNodeId,
  findBrowseNode,
  getBrowseAncestorIds,
  getImmediateChildFolders,
  normalizeBrowsePath,
} from "../../src/serve/browse-tree";

describe("browse tree model", () => {
  test("builds collection roots and nested folders with counts", () => {
    const tree = buildBrowseTree(
      [{ name: "notes" }, { name: "docs" }],
      [
        {
          collection: "notes",
          relPath: "alpha.md",
          active: true,
        },
        {
          collection: "notes",
          relPath: "projects/gno/spec.md",
          active: true,
        },
        {
          collection: "notes",
          relPath: "projects/gno/tasks.md",
          active: true,
        },
        {
          collection: "docs",
          relPath: "api/search.md",
          active: true,
        },
        {
          collection: "docs",
          relPath: "inactive.md",
          active: false,
        },
      ]
    );

    expect(tree).toHaveLength(2);
    expect(tree[0]?.name).toBe("docs");
    expect(tree[1]?.name).toBe("notes");

    const notesRoot = findBrowseNode(tree, "notes");
    expect(notesRoot?.documentCount).toBe(3);
    expect(notesRoot?.directDocumentCount).toBe(1);

    const projects = findBrowseNode(tree, "notes", "projects");
    expect(projects?.documentCount).toBe(2);
    expect(projects?.directDocumentCount).toBe(0);

    const gno = findBrowseNode(tree, "notes", "projects/gno");
    expect(gno?.documentCount).toBe(2);
    expect(gno?.directDocumentCount).toBe(2);
  });

  test("normalizes paths and computes ancestor ids", () => {
    expect(normalizeBrowsePath("/projects\\gno/")).toBe("projects/gno");
    expect(getBrowseAncestorIds("notes", "projects/gno")).toEqual([
      createBrowseNodeId("notes"),
      createBrowseNodeId("notes", "projects"),
      createBrowseNodeId("notes", "projects/gno"),
    ]);
  });

  test("returns immediate child folders for the selected node", () => {
    const tree = buildBrowseTree(
      [{ name: "notes" }],
      [
        {
          collection: "notes",
          relPath: "projects/gno/spec.md",
          active: true,
        },
        {
          collection: "notes",
          relPath: "projects/roadmap.md",
          active: true,
        },
        {
          collection: "notes",
          relPath: "areas/work/tasks.md",
          active: true,
        },
      ]
    );

    const rootChildren = getImmediateChildFolders(tree, "notes");
    expect(rootChildren.map((node) => node.name)).toEqual([
      "areas",
      "projects",
    ]);

    const projectChildren = getImmediateChildFolders(tree, "notes", "projects");
    expect(projectChildren.map((node) => node.name)).toEqual(["gno"]);
  });

  test("merges empty filesystem folders into the tree", () => {
    const tree = buildBrowseTree(
      [{ name: "notes" }],
      [],
      [
        { collection: "notes", path: "projects" },
        { collection: "notes", path: "projects/research" },
      ]
    );

    const rootChildren = getImmediateChildFolders(tree, "notes");
    expect(rootChildren.map((node) => node.name)).toEqual(["projects"]);

    const projectChildren = getImmediateChildFolders(tree, "notes", "projects");
    expect(projectChildren.map((node) => node.name)).toEqual(["research"]);
  });
});
