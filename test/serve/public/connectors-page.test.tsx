import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

void mock.module("../../../src/serve/public/hooks/use-api", () => ({
  apiFetch: async () => ({
    data: {
      connectors: [
        {
          id: "claude-code-skill",
          appName: "Claude Code",
          installKind: "skill",
          target: "claude",
          scope: "user",
          installed: false,
          path: "/tmp/.claude/skills/gno",
          summary: "Claude Code skill is not installed yet.",
          nextAction: "Install the skill from the app.",
          mode: {
            label: "Read/search via skill",
            detail: "Recommended default.",
          },
        },
      ],
    },
    error: null,
  }),
}));

describe("connectors page", () => {
  test("renders connector center copy", async () => {
    const { default: Connectors } =
      await import("../../../src/serve/public/pages/Connectors");
    const html = renderToStaticMarkup(
      <Connectors navigate={() => undefined} />
    );

    expect(html).toContain("Agent Connectors");
    expect(html).toContain("Install GNO into your coding agents");
    expect(html).toContain("Back to Dashboard");
  });
});
