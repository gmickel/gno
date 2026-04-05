import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { RECENT_DOCS_STORAGE_KEY } from "../../../../src/serve/public/lib/navigation-state";
import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

describe("QuickSwitcher DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
  });

  test("offers contextual note creation inside browse location", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/search") {
        return apiOk({
          results: [],
        });
      }
      return apiOk({});
    });

    const { QuickSwitcher } =
      await import("../../../../src/serve/public/components/QuickSwitcher");
    const navigate = mock(() => undefined);
    const onCreateNote = mock(() => undefined);
    const onOpenChange = mock(() => undefined);
    const { user } = renderWithUser(
      <QuickSwitcher
        location="/browse?collection=notes&path=projects"
        navigate={navigate}
        onCreateNote={onCreateNote}
        onOpenChange={onOpenChange}
        open={true}
      />
    );

    await user.type(screen.getByRole("combobox"), "Project Plan");
    await user.click(await screen.findByText("New note in current location"));

    expect(onCreateNote).toHaveBeenCalledWith({
      defaultCollection: "notes",
      defaultFolderPath: "projects",
      draftTitle: "Project Plan",
    });
  });

  test("shows core actions even before typing", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint.startsWith("/api/doc?uri=")) {
        return apiOk({
          docid: "doc-1",
          uri: "file:///tmp/notes/alpha.md",
        });
      }
      if (endpoint === "/api/doc/doc-1/sections") {
        return apiOk({
          sections: [
            { anchor: "intro", level: 2, line: 4, title: "Intro" },
            { anchor: "details", level: 2, line: 10, title: "Details" },
          ],
        });
      }
      return apiOk({});
    });

    const { QuickSwitcher } =
      await import("../../../../src/serve/public/components/QuickSwitcher");
    const { user } = renderWithUser(
      <QuickSwitcher
        location="/doc?uri=file%3A%2F%2F%2Ftmp%2Fnotes%2Falpha.md"
        navigate={() => undefined}
        onCreateNote={() => undefined}
        onOpenChange={() => undefined}
        open={true}
      />
    );

    expect(await screen.findByText("Create new note")).toBeTruthy();
    expect(screen.getByText("Rename current note")).toBeTruthy();
    expect(screen.getByText("Move current note")).toBeTruthy();
    expect(screen.getByText("Duplicate current note")).toBeTruthy();
    expect(screen.getByText("Project Note")).toBeTruthy();
    expect(screen.getByText("Intro")).toBeTruthy();

    await user.click(screen.getByText("Home"));
  });

  test("filters recent items when typing", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/search") {
        return apiOk({
          results: [],
        });
      }
      return apiOk({});
    });

    const { QuickSwitcher } =
      await import("../../../../src/serve/public/components/QuickSwitcher");
    const navigate = mock(() => undefined);
    localStorage.setItem(
      RECENT_DOCS_STORAGE_KEY,
      JSON.stringify([
        {
          uri: "gno://notes/Autoresearch - Karpathy nanochat.md",
          href: "/doc?uri=gno%3A%2F%2Fnotes%2FAutoresearch%20-%20Karpathy%20nanochat.md",
          label: "Autoresearch - Karpathy nanochat.md",
        },
        {
          uri: "gno://notes/Infrastructure.md",
          href: "/doc?uri=gno%3A%2F%2Fnotes%2FInfrastructure.md",
          label: "Infrastructure.md",
        },
      ])
    );
    const { user } = renderWithUser(
      <QuickSwitcher
        location="/browse?collection=notes"
        navigate={navigate}
        onCreateNote={() => undefined}
        onOpenChange={() => undefined}
        open={true}
      />
    );

    await user.type(screen.getByRole("combobox"), "Karpathy");

    expect(
      await screen.findByText("Autoresearch - Karpathy nanochat.md")
    ).toBeTruthy();
    expect(screen.queryByText("Infrastructure.md")).toBeNull();
  });

  test("arrow keys change the selected command item", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/search") {
        return apiOk({
          results: [],
        });
      }
      return apiOk({});
    });

    const { QuickSwitcher } =
      await import("../../../../src/serve/public/components/QuickSwitcher");
    localStorage.setItem(
      RECENT_DOCS_STORAGE_KEY,
      JSON.stringify([
        {
          uri: "gno://notes/One.md",
          href: "/doc?uri=gno%3A%2F%2Fnotes%2FOne.md",
          label: "One.md",
        },
        {
          uri: "gno://notes/Two.md",
          href: "/doc?uri=gno%3A%2F%2Fnotes%2FTwo.md",
          label: "Two.md",
        },
      ])
    );

    const { user } = renderWithUser(
      <QuickSwitcher
        location="/browse?collection=notes"
        navigate={() => undefined}
        onCreateNote={() => undefined}
        onOpenChange={() => undefined}
        open={true}
      />
    );

    const input = screen.getByRole("combobox");
    await user.click(input);
    const before = document.querySelector('[cmdk-item][data-selected="true"]');
    await user.keyboard("{ArrowDown}");

    const firstSelected = document.querySelector(
      '[cmdk-item][data-selected="true"]'
    );
    expect(firstSelected?.textContent).not.toBe(before?.textContent);

    await user.keyboard("{ArrowDown}");
    const secondSelected = document.querySelector(
      '[cmdk-item][data-selected="true"]'
    );
    expect(secondSelected?.textContent).not.toBe(firstSelected?.textContent);
  });
});
