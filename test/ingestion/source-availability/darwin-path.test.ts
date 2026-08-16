import { describe, expect, test } from "bun:test";

import { classifyDarwinFileProviderPath } from "../../../src/ingestion/source-availability";

const home = "/Users/tester";

describe("Darwin File Provider path support", () => {
  test.each([
    {
      path: `${home}/Library/CloudStorage/GoogleDrive-user/My Drive/docs/a.md`,
      expected: "google-drive",
    },
    {
      path: `${home}/Library/Mobile Documents/com~apple~CloudDocs/a.md`,
      expected: "icloud-drive",
    },
    {
      path: `${home}/Library/CloudStorage/OneDrive-org-SharedLibraries/Team/docs/a.md`,
      expected: "onedrive-sharepoint",
    },
  ])("recognizes evidenced layout: $expected", ({ path, expected }) => {
    expect(classifyDarwinFileProviderPath(path, home)).toBe(expected);
  });

  test.each([
    `${home}/Documents/a.md`,
    `${home}/Library/CloudStorage/Dropbox/a.md`,
    `${home}/Library/CloudStorage/OneDrive-org/a.md`,
    "/Volumes/remote/a.md",
  ])("unsupported storage fails closed: %s", (path) => {
    expect(classifyDarwinFileProviderPath(path, home)).toBe("unsupported");
  });

  test("relative paths are unknown", () => {
    expect(classifyDarwinFileProviderPath("relative/a.md", home)).toBe(
      "unknown"
    );
  });
});
