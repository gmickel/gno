import { screen } from "@testing-library/react";
import { describe, expect, test } from "bun:test";

import { renderWithUser } from "../../../helpers/dom";

describe("MarkdownPreview", () => {
  test("renders resolved wiki links as clickable document links", async () => {
    const { MarkdownPreview } =
      await import("../../../../src/serve/public/components/editor/MarkdownPreview");

    renderWithUser(
      <MarkdownPreview
        collection="ai"
        content={
          "See also [[Autoresearch - Overview]] and [[Other Note|alias]]."
        }
        wikiLinks={[
          {
            targetRef: "Autoresearch - Overview",
            resolvedUri: "gno://ai/Autoresearch/Autoresearch%20-%20Overview.md",
          },
          {
            targetRef: "Other Note",
            resolvedUri: "gno://ai/Other%20Note.md",
          },
        ]}
      />
    );

    expect(
      screen
        .getByRole("link", { name: "Autoresearch - Overview" })
        .getAttribute("href")
    ).toBe(
      "/doc?uri=gno%3A%2F%2Fai%2FAutoresearch%2FAutoresearch%2520-%2520Overview.md"
    );
    expect(
      screen.getByRole("link", { name: "alias" }).getAttribute("href")
    ).toBe("/doc?uri=gno%3A%2F%2Fai%2FOther%2520Note.md");
  });

  test("rewrites note-relative image sources through doc asset route", async () => {
    const { MarkdownPreview } =
      await import("../../../../src/serve/public/components/editor/MarkdownPreview");

    renderWithUser(
      <MarkdownPreview
        content={"![figure](Images/4-1.png)"}
        docUri={"gno://reading/book/source/04-implementing-gpt.md"}
      />
    );

    expect(
      screen.getByRole("img", { name: "figure" }).getAttribute("src")
    ).toBe(
      "/api/doc-asset?uri=gno%3A%2F%2Freading%2Fbook%2Fsource%2F04-implementing-gpt.md&path=Images%2F4-1.png"
    );
  });

  test("keeps external image sources unchanged", async () => {
    const { MarkdownPreview } =
      await import("../../../../src/serve/public/components/editor/MarkdownPreview");

    renderWithUser(
      <MarkdownPreview content={"![figure](https://example.com/figure.png)"} />
    );

    expect(
      screen.getByRole("img", { name: "figure" }).getAttribute("src")
    ).toBe("https://example.com/figure.png");
  });
});
