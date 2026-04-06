import { describe, expect, test } from "bun:test";

import type { SearchResults } from "../../src/pipeline/types";

import { formatSearchResults } from "../../src/cli/format/search-results";

function makeResults(overrides: Partial<SearchResults> = {}): SearchResults {
  return {
    results: [
      {
        docid: "#abc123",
        score: 0.9,
        uri: "gno://notes/test.md",
        title: "Test",
        snippet: "example snippet",
        snippetRange: { startLine: 7, endLine: 9 },
        source: {
          relPath: "test.md",
          absPath: "/tmp/notes/test.md",
          mime: "text/markdown",
          ext: ".md",
        },
      },
    ],
    meta: {
      query: "test",
      mode: "hybrid",
      totalResults: 1,
    },
    ...overrides,
  };
}

describe("formatSearchResults terminal links", () => {
  test("emits OSC 8 hyperlinks for terminal TTY output", () => {
    const output = formatSearchResults(makeResults(), {
      format: "terminal",
      terminalLinks: { isTTY: true, editorUriTemplate: null },
    });

    expect(output).toContain("\u001B]8;;file:///tmp/notes/test.md\u0007");
    expect(output).toContain("gno://notes/test.md");
    expect(output).toContain("\u001B]8;;\u0007");
  });

  test("uses editor template with line hint when present", () => {
    const output = formatSearchResults(makeResults(), {
      format: "terminal",
      terminalLinks: {
        isTTY: true,
        editorUriTemplate: "vscode://file/{path}:{line}:{col}",
      },
    });

    expect(output).toContain(
      "\u001B]8;;vscode://file//tmp/notes/test.md:7:1\u0007"
    );
  });

  test("falls back to plain text when line is absent but template needs line", () => {
    const output = formatSearchResults(
      makeResults({
        results: [
          {
            ...makeResults().results[0]!,
            snippetRange: undefined,
          },
        ],
      }),
      {
        format: "terminal",
        terminalLinks: {
          isTTY: true,
          editorUriTemplate: "vscode://file/{path}:{line}:{col}",
        },
      }
    );

    expect(output).not.toContain("\u001B]8;;");
    expect(output).toContain("gno://notes/test.md");
  });

  test("falls back to plain text when absPath is missing", () => {
    const output = formatSearchResults(
      makeResults({
        results: [
          {
            ...makeResults().results[0]!,
            source: {
              relPath: "test.md",
              mime: "text/markdown",
              ext: ".md",
            },
          },
        ],
      }),
      {
        format: "terminal",
        terminalLinks: { isTTY: true, editorUriTemplate: null },
      }
    );

    expect(output).not.toContain("\u001B]8;;");
    expect(output).toContain("gno://notes/test.md");
  });

  test("does not emit OSC 8 for non-TTY output", () => {
    const output = formatSearchResults(makeResults(), {
      format: "terminal",
      terminalLinks: { isTTY: false, editorUriTemplate: null },
    });

    expect(output).not.toContain("\u001B]8;;");
  });

  test("does not emit OSC 8 for structured output formats", () => {
    const json = formatSearchResults(makeResults(), {
      format: "json",
      terminalLinks: { isTTY: true, editorUriTemplate: null },
    });
    const csv = formatSearchResults(makeResults(), {
      format: "csv",
      terminalLinks: { isTTY: true, editorUriTemplate: null },
    });
    const xml = formatSearchResults(makeResults(), {
      format: "xml",
      terminalLinks: { isTTY: true, editorUriTemplate: null },
    });
    const files = formatSearchResults(makeResults(), {
      format: "files",
      terminalLinks: { isTTY: true, editorUriTemplate: null },
    });

    expect(json).not.toContain("\u001B]8;;");
    expect(csv).not.toContain("\u001B]8;;");
    expect(xml).not.toContain("\u001B]8;;");
    expect(files).not.toContain("\u001B]8;;");
  });
});
