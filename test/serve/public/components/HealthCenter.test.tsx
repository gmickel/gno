import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HealthCenter } from "../../../../src/serve/public/components/HealthCenter";

describe("HealthCenter", () => {
  test("renders health checks and actions", () => {
    const html = renderToStaticMarkup(
      <HealthCenter
        health={{
          state: "needs-attention",
          summary: "GNO works, but a few issues still need attention.",
          checks: [
            {
              id: "models",
              title: "Models",
              status: "warn",
              summary:
                "Balanced is usable, but answer models are still missing",
              detail:
                "Core search is ready. Download the rest of the preset for best ranking and local AI answers.",
              actionLabel: "Download models",
              actionKind: "download-models",
            },
          ],
        }}
        onAction={() => undefined}
      />
    );

    expect(html).toContain("Health Center");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Download models");
    expect(html).toContain("Balanced is usable");
  });
});
