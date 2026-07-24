import { afterEach, describe, expect, test } from "bun:test";

import { extractVisiblePage } from "../src/extract";
import { buildBrowserClipPayload } from "../src/payload";

const originalSelection = globalThis.getSelection;

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  Object.defineProperty(globalThis, "getSelection", {
    configurable: true,
    value: originalSelection,
  });
});

describe("explicit visible-page extraction", () => {
  test("emits only the supported Reader AST and omits active or embedded content", () => {
    document.title = "Reader fixture";
    document.head.innerHTML = `
      <link rel="canonical" href="https://example.com/canonical">
      <meta name="author" content="Ada">
    `;
    document.body.innerHTML = `
      <article hidden><p>hidden first root secret</p></article>
      <main>
        <h1>Visible <a href="https://example.com/detail">heading</a></h1>
        <p>Paragraph <script>steal()</script><img src="private.png"></p>
        <blockquote>Quoted</blockquote>
        <ul><li>First</li><li><a href="javascript:bad()">Unsafe link text</a></li></ul>
        <pre><code class="language-ts">const café = true;</code></pre>
        <hr>
        <iframe src="https://private.example"></iframe>
        <form><p>Secret field</p></form>
      </main>
    `;

    const result = extractVisiblePage();
    expect(result.readerBlocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "quote",
      "list",
      "code",
      "horizontal_rule",
    ]);
    expect(JSON.stringify(result.readerBlocks)).not.toContain("<");
    expect(JSON.stringify(result.readerBlocks)).not.toContain("private.png");
    expect(JSON.stringify(result.readerBlocks)).not.toContain("Secret field");
    expect(JSON.stringify(result.readerBlocks)).not.toContain("javascript:");
    expect(JSON.stringify(result.readerBlocks)).toContain("Unsafe link text");
    expect(result.warnings).toContain("reader_partial");
  });

  test("rejects hidden ancestors, code descendants, geometry, and selections", () => {
    document.body.innerHTML = `
      <main>
        <section hidden><p>hidden attribute secret</p></section>
        <section style="opacity: 0"><p>transparent secret</p></section>
        <section style="content-visibility: hidden"><p>skipped secret</p></section>
        <p id="no-box">zero geometry secret</p>
        <p id="visible">Visible paragraph</p>
        <pre><code>visible code<span hidden>hidden code secret</span></code></pre>
      </main>
    `;
    const bodyRects = document.body.getClientRects.bind(document.body);
    const noBox = document.querySelector("#no-box");
    Object.defineProperty(document.body, "getClientRects", {
      configurable: true,
      value: () => [{ width: 100, height: 100 }],
    });
    Object.defineProperty(noBox, "getClientRects", {
      configurable: true,
      value: () => [],
    });

    const hiddenText = document.querySelector("section[hidden] p")?.firstChild;
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(hiddenText!);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = extractVisiblePage();
    const serialized = JSON.stringify(result.readerBlocks);
    expect(serialized).toContain("Visible paragraph");
    expect(serialized).toContain("visible code");
    expect(serialized).not.toContain("secret");
    expect(result.selectionText).toBeNull();
    expect(result.warnings).toContain("reader_partial");

    Object.defineProperty(document.body, "getClientRects", {
      configurable: true,
      value: bodyRects,
    });
  });

  test("preserves exact Unicode, controls, and huge selections for server validation", () => {
    const exact = `${"é漢字🙂\u0001".repeat(140_000)}`;
    Object.defineProperty(globalThis, "getSelection", {
      configurable: true,
      value: () => ({ toString: () => exact }),
    });
    document.body.innerHTML = "<main><p>Visible</p></main>";

    const result = extractVisiblePage();
    expect(result.selectionText).toBe(exact);
    expect(
      new TextEncoder().encode(result.selectionText ?? "").byteLength
    ).toBeGreaterThan(512 * 1024);

    const payload = buildBrowserClipPayload(result, {
      mode: "selection",
      authenticated: true,
      destination: {
        collection: "notes",
        relPath: null,
        folderPath: null,
        collisionPolicy: "error",
      },
      tags: [],
      note: null,
      editedMarkdown: null,
    });
    expect(payload.mode).toBe("selection");
    expect(payload.mode === "selection" && payload.selection.exactText).toBe(
      exact
    );
    expect(payload.extraction.warnings).toContain(
      "authenticated_visible_content"
    );
  });

  test("takes a new immutable SPA snapshot on each explicit action", () => {
    history.replaceState({ route: "one" }, "", "/first");
    document.body.innerHTML = "<main><p>First route</p></main>";
    const first = extractVisiblePage();
    document.body.innerHTML = "<main><p>Second route</p></main>";
    const second = extractVisiblePage();

    expect(JSON.stringify(first.readerBlocks)).toContain("First route");
    expect(JSON.stringify(first.readerBlocks)).not.toContain("Second route");
    expect(JSON.stringify(second.readerBlocks)).toContain("Second route");
    expect(second.warnings).toContain("spa_snapshot");
  });

  test("keeps invalid page URL input untouched for authoritative server rejection", () => {
    const result = {
      ...extractVisiblePage(),
      sourceUrl: "file:///private/article.html",
      selectionText: "Visible",
    };
    const payload = buildBrowserClipPayload(result, {
      mode: "selection",
      authenticated: false,
      destination: {
        collection: "notes",
        relPath: null,
        folderPath: null,
        collisionPolicy: "error",
      },
      tags: [],
      note: null,
      editedMarkdown: null,
    });
    expect(payload.sourceUrl).toBe("file:///private/article.html");
  });
});
