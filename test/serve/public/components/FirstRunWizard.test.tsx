import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FirstRunWizard } from "../../../../src/serve/public/components/FirstRunWizard";

const onboarding = {
  ready: false,
  stage: "add-collection" as const,
  headline: "Start by connecting the folders you care about",
  detail:
    "Pick notes, docs, or a project directory. GNO will scan them and build search automatically.",
  suggestedCollections: [
    {
      label: "Documents",
      path: "/Users/test/Documents",
      reason: "Good default for notes and docs",
    },
  ],
  steps: [
    {
      id: "folders",
      title: "Pick folders",
      status: "current" as const,
      detail: "Choose the folders you want GNO to watch and index.",
    },
  ],
};

describe("FirstRunWizard", () => {
  test("renders onboarding copy and suggested folders", () => {
    const html = renderToStaticMarkup(
      <FirstRunWizard
        onboarding={onboarding}
        onAddCollection={() => undefined}
        onDownloadModels={() => undefined}
        onEmbed={() => undefined}
        onSync={() => undefined}
      />
    );

    expect(html).toContain("Start by connecting the folders you care about");
    expect(html).toContain("Setup wizard");
    expect(html).toContain("Step 1 of 1");
    expect(html).toContain("Documents");
    expect(html).toContain("Add first folder");
    expect(html).toContain(
      "You can jump between steps without losing progress."
    );
  });

  test("shows exact lexical remediation without treating embeddings as blocking", () => {
    const html = renderToStaticMarkup(
      <FirstRunWizard
        onboarding={{
          ready: false,
          stage: "indexing",
          headline: "Finish the first lexical retrieval proof",
          detail:
            "alpha: lexical/retrieval_mismatch. Run: gno index alpha --no-embed",
          suggestedCollections: [],
          steps: [
            {
              id: "folders",
              title: "Pick folders",
              status: "complete",
              detail: "1 folder connected.",
              action: "add-collection",
            },
            {
              id: "indexing",
              title: "Prove lexical retrieval",
              status: "current",
              detail:
                "alpha: lexical/retrieval_mismatch. Run: gno index alpha --no-embed",
              action: "sync",
            },
          ],
        }}
        onAddCollection={() => undefined}
        onDownloadModels={() => undefined}
        onEmbed={() => undefined}
        onSync={() => undefined}
      />
    );

    expect(html).toContain("Prove lexical retrieval");
    expect(html).toContain("lexical/retrieval_mismatch");
    expect(html).toContain("gno index alpha --no-embed");
    expect(html).toContain("Run sync");
    expect(html).not.toContain("Finish embeddings");
  });
});
