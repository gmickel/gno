import { screen } from "@testing-library/react";
import { describe, expect, test } from "bun:test";

import { renderWithUser } from "../../../helpers/dom";

describe("FrontmatterDisplay", () => {
  test("renders YAML link arrays as clickable links and tags as chips", async () => {
    const { FrontmatterDisplay } =
      await import("../../../../src/serve/public/components/FrontmatterDisplay");

    renderWithUser(
      <FrontmatterDisplay
        content={`---
tags:
  - ai
  - llm
  - resource
date: 2026-04-01
sources:
  - https://www.aibyaakash.com/p/autoresearch-guide
  - https://www.news.aakashg.com/p/autoresearch-guide-for-pms
---

# Title`}
      />
    );

    expect(screen.getByText("ai")).toBeTruthy();
    expect(screen.getByText("llm")).toBeTruthy();
    expect(screen.getByText("resource")).toBeTruthy();

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(
      "https://www.aibyaakash.com/p/autoresearch-guide"
    );
    expect(links[1]?.getAttribute("href")).toBe(
      "https://www.news.aakashg.com/p/autoresearch-guide-for-pms"
    );
  });
});
