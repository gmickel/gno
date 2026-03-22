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
        onSync={() => undefined}
      />
    );

    expect(html).toContain("Start by connecting the folders you care about");
    expect(html).toContain("Choose how GNO should feel");
    expect(html).toContain("Documents");
    expect(html).toContain("Add first folder");
  });
});
