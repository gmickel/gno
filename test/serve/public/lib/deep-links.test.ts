import { describe, expect, test } from "bun:test";

import {
  buildDocDeepLink,
  buildEditDeepLink,
  parseDocumentDeepLink,
} from "../../../../src/serve/public/lib/deep-links";

describe("deep link helpers", () => {
  test("buildDocDeepLink includes source view and line range", () => {
    expect(
      buildDocDeepLink({
        uri: "gno://notes/readme.md",
        view: "source",
        lineStart: 12,
        lineEnd: 14,
      })
    ).toBe(
      "/doc?uri=gno%3A%2F%2Fnotes%2Freadme.md&view=source&lineStart=12&lineEnd=14"
    );
  });

  test("buildEditDeepLink omits invalid lineEnd without lineStart", () => {
    expect(
      buildEditDeepLink({
        uri: "gno://notes/readme.md",
        lineEnd: 14,
      })
    ).toBe("/edit?uri=gno%3A%2F%2Fnotes%2Freadme.md");
  });

  test("parseDocumentDeepLink reads line range and defaults view", () => {
    expect(
      parseDocumentDeepLink(
        "?uri=gno%3A%2F%2Fnotes%2Freadme.md&lineStart=12&lineEnd=14"
      )
    ).toEqual({
      uri: "gno://notes/readme.md",
      view: "rendered",
      lineStart: 12,
      lineEnd: 14,
    });
  });
});
