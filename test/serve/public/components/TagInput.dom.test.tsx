import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

describe("TagInput DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  test("adds hierarchical suggestions with keyboard combobox semantics", async () => {
    apiFetch.mockImplementation(async () =>
      apiOk({
        tags: [
          { tag: "project/docs", count: 12 },
          { tag: "project/api", count: 6 },
          { tag: "work", count: 3 },
        ],
        meta: { total: 3 },
      })
    );

    const { TagInput } =
      await import("../../../../src/serve/public/components/TagInput");
    const onChange = mock(() => undefined);
    const { user } = renderWithUser(
      <TagInput
        aria-label="Filter tags"
        onChange={onChange}
        value={["existing"]}
      />
    );

    const input = screen.getByRole("combobox", { name: "Filter tags" });
    await user.click(input);
    await user.type(input, "proj");

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(options).toHaveLength(2);

    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(
      options[0]?.id ?? null
    );

    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith(["existing", "project/docs"]);
    expect(screen.getByRole("status", { hidden: true }).textContent).toContain(
      "Added tag: project/docs"
    );
  });

  test("shows validation errors and removes the last tag with backspace", async () => {
    apiFetch.mockImplementation(async () =>
      apiOk({
        tags: [{ tag: "work", count: 3 }],
        meta: { total: 1 },
      })
    );

    const { TagInput } =
      await import("../../../../src/serve/public/components/TagInput");

    function Harness() {
      const [tags, setTags] = useState(["alpha", "beta"]);
      return (
        <TagInput aria-label="Edit tags" onChange={setTags} value={tags} />
      );
    }

    const { user } = renderWithUser(<Harness />);
    const input = screen.getByRole("combobox", { name: "Edit tags" });

    await user.click(input);
    await user.type(input, "Bad Tag");
    await user.keyboard("{Enter}");

    expect(screen.getByRole("alert").textContent).toContain("Invalid");

    await user.clear(input);
    await user.keyboard("{Backspace}");

    await waitFor(() => {
      expect(screen.queryByText("beta")).toBeNull();
    });
    expect(document.activeElement).toBe(input);
  });
});
