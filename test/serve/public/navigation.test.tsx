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
    expect(html).toContain("Connectors");
    expect(html).toContain("Browse");
    expect(html).toContain("Graph");
    expect(html).toContain("Trace history");
  });

  test("browse exposes collection management and reindex actions", async () => {
    const { default: Browse } =
      await import("../../../src/serve/public/pages/Browse");

    const html = renderToStaticMarkup(<Browse navigate={() => undefined} />);

    expect(html).toContain("Collection Controls");
    expect(html).toContain("Collections");
    expect(html).toContain("Re-index All");
  });

  test("trace history exposes bounded local management actions", async () => {
    const { default: TraceHistory } =
      await import("../../../src/serve/public/pages/TraceHistory");
    const html = renderToStaticMarkup(
      <TraceHistory navigate={() => undefined} />
    );
    expect(html).toContain("Trace history");
    expect(html).toContain("Export");
    expect(html).toContain("Purge all");
    expect(html).toContain("Private receipts");
  });
});
