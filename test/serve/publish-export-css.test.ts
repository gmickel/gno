import { expect, test } from "bun:test";

import { loadEmbeddedProductionSpa } from "../../src/serve/spa-production";

test("production export dialog ships a bounded panel and independently scrolling form", async () => {
  const spa = await loadEmbeddedProductionSpa();
  const css = Object.values(spa.files)
    .filter((file) => file.type.startsWith("text/css"))
    .map((file) => file.text)
    .join("\n");
  const panel = css.match(/\.publish-export-dialog\s*\{([^}]+)\}/u)?.[1] ?? "";
  const body =
    css.match(/\.publish-export-dialog-body\s*\{([^}]+)\}/u)?.[1] ?? "";
  const footer =
    css.match(/\.publish-export-dialog-footer\s*\{([^}]+)\}/u)?.[1] ?? "";

  // Inspect the shipped CSS, not JSX utility names or an output hash: a fresh
  // JS snapshot with stale prebuilt CSS caused the original clipped modal.
  expect(panel).toMatch(/max-height:calc\(100dvh\s*-\s*2rem\)/u);
  expect(panel).toMatch(/width:min\(36rem,/u);
  expect(panel).toContain("overflow:hidden");
  expect(body).toContain("min-height:0");
  expect(body).toContain("overflow-y:auto");
  expect(body).toContain("overscroll-behavior:contain");
  expect(footer).toContain("flex-shrink:0");
});
