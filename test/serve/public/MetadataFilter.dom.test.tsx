import { screen } from "@testing-library/react";
import { expect, test } from "bun:test";
import { useState } from "react";

import { MetadataFilter } from "../../../src/serve/public/components/MetadataFilter";
import { parseMetadataFilter } from "../../../src/serve/public/lib/metadata-filter";
import { renderWithUser } from "../../helpers/dom";

function FilterHarness() {
  const [value, setValue] = useState("");
  return (
    <>
      <MetadataFilter onChange={setValue} value={value} />
      <output data-testid="raw">{value}</output>
    </>
  );
}

test("basic controls retain invalid values and allow correction without widening the filter", async () => {
  const { user } = renderWithUser(<FilterHarness />);
  await user.click(screen.getByRole("button", { name: "Add metadata filter" }));
  const input = screen.getByLabelText("Value (JSON)");
  await user.clear(input);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(
    parseMetadataFilter(screen.getByTestId("raw").textContent ?? "").error
  ).toBeTruthy();
  await user.type(input, '"draft"');
  expect(
    parseMetadataFilter(screen.getByTestId("raw").textContent ?? "").filter
  ).toEqual({ op: "eq", key: "status", value: "draft" });
  await user.click(
    screen.getByRole("button", { name: "Clear metadata filter" })
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("raw").textContent).toBe("");
});
