import { screen } from "@testing-library/react";
import { describe, expect, mock, test } from "bun:test";

import { renderWithUser } from "../../../helpers/dom";

describe("BrowseTreeSidebar", () => {
  test("allows collapsing the selected collection root in root view", async () => {
    const { BrowseTreeSidebar } =
      await import("../../../../src/serve/public/components/BrowseTreeSidebar");

    const onToggle = mock(() => undefined);
    const onSelect = mock(() => undefined);
    const onToggleFavoriteCollection = mock(() => undefined);
    const { user } = renderWithUser(
      <BrowseTreeSidebar
        collections={[
          {
            id: "collection:ai",
            kind: "collection",
            collection: "ai",
            path: "",
            name: "ai",
            depth: 0,
            documentCount: 65,
            directDocumentCount: 0,
            children: [
              {
                id: "folder:ai:Autoresearch",
                kind: "folder",
                collection: "ai",
                path: "Autoresearch",
                name: "Autoresearch",
                depth: 1,
                documentCount: 8,
                directDocumentCount: 8,
                children: [],
              },
            ],
          },
        ]}
        expandedNodeIds={["collection:ai"]}
        favoriteCollections={[]}
        onSelect={onSelect}
        onToggle={onToggle}
        onToggleFavoriteCollection={onToggleFavoriteCollection}
        selectedNodeId={"collection:ai"}
      />
    );

    await user.click(screen.getByRole("button", { name: "Collapse ai" }));
    expect(onToggle).toHaveBeenCalledWith("collection:ai");
  });
});
