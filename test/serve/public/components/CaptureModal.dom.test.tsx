import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

void mock.module(
  "../../../../src/serve/public/components/IndexingProgress",
  () => ({
    IndexingProgress: ({ jobId }: { jobId: string }) => (
      <div>Indexing job {jobId}</div>
    ),
  })
);

void mock.module(
  "../../../../src/serve/public/components/WikiLinkAutocomplete",
  () => ({
    WikiLinkAutocomplete: () => null,
  })
);

describe("CaptureModal DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  test("submits a note from the dialog with keyboard interaction and tag input", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/status") {
        return apiOk({
          collections: [{ name: "notes", path: "/tmp/notes" }],
        });
      }
      if (endpoint === "/api/tags") {
        return apiOk({
          tags: [{ tag: "work", count: 9 }],
          meta: { total: 1 },
        });
      }
      if (endpoint === "/api/docs") {
        return apiOk({
          uri: "file:///tmp/notes/shipping-plan.md",
          path: "/tmp/notes/shipping-plan.md",
          jobId: "job-123",
          note: "created",
        });
      }
      return apiOk({});
    });

    const { CaptureModal } =
      await import("../../../../src/serve/public/components/CaptureModal");
    const onOpenChange = mock(() => undefined);
    const onSuccess = mock(() => undefined);
    const { user } = renderWithUser(
      <CaptureModal
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open={true}
      />
    );

    const dialog = await screen.findByRole("dialog", { name: "New note" });
    expect(dialog).toBeTruthy();

    const titleInput = screen.getByLabelText("Title");
    expect(document.activeElement).toBe(titleInput);

    await user.type(titleInput, "Shipping plan");
    await user.type(
      screen.getByLabelText("Content"),
      "Plan the launch checklist and handoff."
    );

    const tagInput = screen.getByRole("combobox", {
      name: "Add tags to this note",
    });
    await user.click(tagInput);
    await user.type(tagInput, "wor");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");

    await user.click(screen.getByLabelText("Content"));
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(
        "file:///tmp/notes/shipping-plan.md"
      );
    });

    expect(await screen.findByText("Note created successfully")).toBeTruthy();
    expect(screen.getByText("Indexing job job-123")).toBeTruthy();
  });
});
