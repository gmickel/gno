import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

void mock.module("../../../src/serve/public/hooks/useCaptureModal", () => ({
  useCaptureModal: () => ({
    openCapture: () => {},
  }),
}));

describe("web UI collections discoverability", () => {
  test("dashboard exposes collections navigation", async () => {
    const { default: Dashboard } =
      await import("../../../src/serve/public/pages/Dashboard");

    const html = renderToStaticMarkup(<Dashboard navigate={() => undefined} />);

    expect(html).toContain("Collections");
    expect(html).toContain("Browse");
    expect(html).toContain("Graph");
  });

  test("browse exposes collection management and reindex actions", async () => {
    const { default: Browse } =
      await import("../../../src/serve/public/pages/Browse");

    const html = renderToStaticMarkup(<Browse navigate={() => undefined} />);

    expect(html).toContain("Collection Controls");
    expect(html).toContain("Collections");
    expect(html).toContain("Re-index All");
  });
});
