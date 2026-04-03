import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser, setTestLocation } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

void mock.module("../../../../src/serve/public/hooks/use-doc-events", () => ({
  useDocEvents: () => null,
}));

void mock.module(
  "../../../../src/serve/public/components/BacklinksPanel",
  () => ({
    BacklinksPanel: () => null,
  })
);

void mock.module(
  "../../../../src/serve/public/components/OutgoingLinksPanel",
  () => ({
    OutgoingLinksPanel: () => null,
  })
);

void mock.module(
  "../../../../src/serve/public/components/RelatedNotesSidebar",
  () => ({
    RelatedNotesSidebar: () => null,
  })
);

void mock.module("../../../../src/serve/public/components/editor", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));

void mock.module(
  "../../../../src/serve/public/components/FrontmatterDisplay",
  () => ({
    FrontmatterDisplay: () => null,
    parseFrontmatter: (content: string) => ({ data: {}, body: content }),
  })
);

describe("DocView DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    setTestLocation("/doc?uri=file%3A%2F%2F%2Ftmp%2Fnotes%2Falpha.md");
  });

  test("edits tags with the shared TagInput flow and persists them", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      const options = args[1] as RequestInit | undefined;
      if (endpoint.startsWith("/api/doc?uri=")) {
        return apiOk({
          docid: "doc-1",
          uri: "file:///tmp/notes/alpha.md",
          title: "Alpha Note",
          content: "# Alpha Note\n\nBody",
          contentAvailable: true,
          collection: "notes",
          relPath: "alpha.md",
          tags: ["work"],
          source: {
            mime: "text/markdown",
            ext: ".md",
            modifiedAt: "2026-04-03T10:00:00.000Z",
            sizeBytes: 120,
            sourceHash: "hash-1",
          },
          capabilities: {
            editable: true,
            tagsEditable: true,
            tagsWriteback: true,
            canCreateEditableCopy: false,
            mode: "editable",
          },
        });
      }
      if (endpoint === "/api/tags") {
        return apiOk({
          tags: [
            { tag: "work", count: 3 },
            { tag: "project/docs", count: 2 },
          ],
          meta: { total: 2 },
        });
      }
      if (endpoint === "/api/docs/doc-1" && options?.method === "PUT") {
        return apiOk({
          success: true,
          docId: "doc-1",
          uri: "file:///tmp/notes/alpha.md",
          path: "/tmp/notes/alpha.md",
          jobId: null,
          version: {
            sourceHash: "hash-2",
            modifiedAt: "2026-04-03T10:05:00.000Z",
          },
        });
      }
      return apiOk({});
    });

    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    const navigate = mock(() => undefined);
    const { user } = renderWithUser(<DocView navigate={navigate} />);

    await screen.findByRole("heading", { name: "Alpha Note" });

    await user.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    const input = await screen.findByRole("combobox", {
      name: "Edit document tags",
    });
    await user.click(input);
    await user.type(input, "proj");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeTruthy();
    });
    expect(screen.getByText("project/docs")).toBeTruthy();
  });
});
