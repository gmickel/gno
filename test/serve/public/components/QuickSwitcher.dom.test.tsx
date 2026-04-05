import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

describe("QuickSwitcher DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
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
});
