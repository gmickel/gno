import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser, setTestLocation } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

void mock.module("../../../../src/serve/public/hooks/use-doc-events", () => ({
  useDocEvents: () => null,
}));

void mock.module("../../../../src/serve/public/hooks/useCaptureModal", () => ({
  useCaptureModal: () => ({
    openCapture: () => undefined,
    isOpen: false,
  }),
}));

describe("Browse page DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    setTestLocation("/browse?collection=notes&path=projects");
  });

  test("renders tree navigation, folder contents, and keyboard traversal", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/browse/tree") {
        return apiOk({
          collections: [
            {
              id: "collection:notes",
              kind: "collection",
              collection: "notes",
              path: "",
              name: "notes",
              depth: 0,
              documentCount: 3,
              directDocumentCount: 0,
              children: [
                {
                  id: "folder:notes:projects",
                  kind: "folder",
                  collection: "notes",
                  path: "projects",
                  name: "projects",
                  depth: 1,
                  documentCount: 3,
                  directDocumentCount: 1,
                  children: [
                    {
                      id: "folder:notes:projects/gno",
                      kind: "folder",
                      collection: "notes",
                      path: "projects/gno",
                      name: "gno",
                      depth: 2,
                      documentCount: 2,
                      directDocumentCount: 2,
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
          totalCollections: 1,
          totalDocuments: 3,
        });
      }

      if (endpoint.startsWith("/api/docs?")) {
        return apiOk({
          documents: [
            {
              docid: "doc-1",
              uri: "file:///tmp/notes/projects/roadmap.md",
              title: "Roadmap",
              collection: "notes",
              relPath: "projects/roadmap.md",
              sourceExt: ".md",
            },
          ],
          total: 1,
          limit: 25,
          offset: 0,
          pathPrefix: "projects",
          directChildrenOnly: true,
          availableDateFields: [],
          sortField: "modified",
          sortOrder: "desc",
        });
      }

      return apiOk({});
    });

    const { default: Browse } =
      await import("../../../../src/serve/public/pages/Browse");
    const navigate = mock(() => undefined);
    const { user } = renderWithUser(<Browse navigate={navigate} />);

    expect(
      await screen.findByRole("tree", { name: "Browse tree" })
    ).toBeTruthy();
    expect(screen.getByText("Roadmap")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open folder/i })).toBeTruthy();

    const projectsNode = screen.getByRole("treeitem", { name: /projects/i });
    const gnoNode = screen.getByRole("treeitem", { name: /gno/i });

    projectsNode.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(gnoNode);

    await user.click(gnoNode);
    expect(navigate).toHaveBeenCalledWith(
      "/browse?collection=notes&path=projects%2Fgno"
    );
  });
});
