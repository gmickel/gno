import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

void mock.module("../../../../src/serve/public/hooks/use-doc-events", () => ({
  useDocEvents: () => null,
}));

void mock.module(
  "../../../../src/serve/public/hooks/useKeyboardShortcuts",
  () => ({
    useKeyboardShortcuts: () => undefined,
  })
);

void mock.module(
  "../../../../src/serve/public/components/AIModelSelector",
  () => ({
    AIModelSelector: () => <div data-testid="model-selector">Preset</div>,
  })
);

void mock.module("../../../../src/serve/public/components/TagFacets", () => ({
  TagFacets: ({
    activeTags,
    onTagSelect,
    onTagRemove,
  }: {
    activeTags: string[];
    onTagSelect: (tag: string) => void;
    onTagRemove: (tag: string) => void;
  }) => (
    <div>
      <button onClick={() => onTagSelect("work")} type="button">
        Mock add tag
      </button>
      {activeTags.includes("work") && (
        <button onClick={() => onTagRemove("work")} type="button">
          Mock remove tag
        </button>
      )}
    </div>
  ),
}));

describe("Search page DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  test("manages advanced retrieval state and renders the empty state", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/capabilities") {
        return apiOk({
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        });
      }
      if (endpoint === "/api/collections") {
        return apiOk([{ name: "notes" }]);
      }
      if (endpoint === "/api/presets") {
        return apiOk({ activePreset: "local" });
      }
      if (endpoint === "/api/search") {
        return apiOk({
          results: [],
          meta: {
            query: "cache invalidation",
            mode: "search",
            totalResults: 0,
          },
        });
      }
      return apiOk({});
    });

    const { default: Search } =
      await import("../../../../src/serve/public/pages/Search");
    const navigate = mock(() => undefined);
    const { user } = renderWithUser(<Search navigate={navigate} />);

    await screen.findByRole("heading", { name: "Search" });

    await user.click(
      screen.getByRole("button", { name: /advanced retrieval/i })
    );
    await user.type(
      screen.getByPlaceholderText("Add query mode text"),
      "postmortem checklist"
    );
    await user.click(screen.getByRole("button", { name: "Add mode" }));

    expect(screen.getByText(/Term: postmortem checklist/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Mock add tag" }));
    expect(
      screen.getByRole("button", { name: "Mock remove tag" })
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /clear advanced/i }));
    expect(screen.queryByText(/Term: postmortem checklist/)).toBeNull();

    const queryInput = screen.getByPlaceholderText(/Search your documents/);
    await user.type(queryInput, "cache invalidation");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("No matches found")).toBeTruthy();
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeTruthy();
  });

  test("navigates to a document from search results", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/capabilities") {
        return apiOk({
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        });
      }
      if (endpoint === "/api/collections") {
        return apiOk([{ name: "notes" }]);
      }
      if (endpoint === "/api/presets") {
        return apiOk({ activePreset: "local" });
      }
      if (endpoint === "/api/search") {
        return apiOk({
          results: [
            {
              docid: "doc-1",
              uri: "file:///tmp/notes/smoke.md",
              title: "Smoke note",
              snippet: "A <mark>smoke</mark> test note",
              score: 0.91,
              snippetRange: {
                startLine: 4,
                endLine: 6,
              },
            },
          ],
          meta: {
            query: "smoke",
            mode: "search",
            totalResults: 1,
          },
        });
      }
      return apiOk({});
    });

    const { default: Search } =
      await import("../../../../src/serve/public/pages/Search");
    const navigate = mock(() => undefined);
    const { user } = renderWithUser(<Search navigate={navigate} />);

    await screen.findByRole("heading", { name: "Search" });
    await user.type(
      screen.getByPlaceholderText(/Search your documents/),
      "smoke"
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("Smoke note");
    await user.click(screen.getByText("Smoke note"));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        expect.stringContaining(
          "/doc?uri=file%3A%2F%2F%2Ftmp%2Fnotes%2Fsmoke.md"
        )
      );
    });
  });
});
