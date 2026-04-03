import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

describe("TagFacets DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  test("renders accessible groups and routes active tag actions", async () => {
    apiFetch.mockImplementation(async () =>
      apiOk({
        tags: [
          { tag: "work", count: 5 },
          { tag: "project/docs", count: 2 },
          { tag: "project/api", count: 1 },
        ],
        meta: { totalTags: 3 },
      })
    );

    const { TagFacets } =
      await import("../../../../src/serve/public/components/TagFacets");
    const onTagSelect = mock(() => undefined);
    const onTagRemove = mock(() => undefined);
    const { user } = renderWithUser(
      <TagFacets
        activeTags={["work", "project/docs"]}
        onTagRemove={onTagRemove}
        onTagSelect={onTagSelect}
      />
    );

    await screen.findByRole("heading", { name: "Tags" });

    await user.click(screen.getByRole("button", { name: /work/i }));
    expect(onTagRemove).toHaveBeenCalledWith("work");

    const projectToggle = screen.getByRole("button", { name: /project/i });
    await user.click(projectToggle);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /docs/i })).toBeNull();
    });

    await user.click(projectToggle);
    const docsButton = await screen.findByRole("button", { name: /docs/i });
    await user.click(docsButton);
    expect(onTagRemove).toHaveBeenCalledWith("project/docs");

    await user.click(screen.getByRole("button", { name: /clear all/i }));
    expect(onTagRemove).toHaveBeenCalledWith("work");
    expect(onTagRemove).toHaveBeenCalledWith("project/docs");
  });
});
