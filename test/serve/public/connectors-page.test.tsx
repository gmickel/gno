import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

const connectorsResponse = {
  connectors: [
    {
      id: "cursor-mcp",
      appName: "Cursor",
      installKind: "mcp",
      target: "cursor",
      scope: "user",
      installed: true,
      path: "/tmp/.cursor/mcp.json",
      summary: "Cursor MCP is configured.",
      nextAction: "Restart Cursor to reload the server.",
      mode: {
        label: "Read/search via MCP",
        detail: "Recommended default.",
      },
    },
    {
      id: "codex-skill",
      appName: "Codex",
      installKind: "skill",
      target: "codex",
      scope: "user",
      installed: true,
      path: "/tmp/.codex/skills/gno",
      summary: "Codex skill is installed.",
      nextAction: "Restart the agent to reload the skill.",
      mode: {
        label: "Read/search via skill",
        detail: "Recommended default.",
      },
    },
  ],
  collections: ["alpha", "notes"],
};

let verificationResponse: {
  verification: {
    collection: string;
    lexicalReady: boolean;
    connectorReady: boolean;
    generatedAt: string;
    stages: { connector: { status: string; code?: string } };
  };
  remediation: string | null;
};

describe("connectors page", () => {
  beforeEach(() => {
    verificationResponse = {
      verification: {
        collection: "notes",
        lexicalReady: true,
        connectorReady: true,
        generatedAt: "2026-07-22T12:00:00.000Z",
        stages: { connector: { status: "passed" } },
      },
      remediation: null,
    };
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = args[0];
      if (endpoint === "/api/connectors") {
        return apiOk(connectorsResponse);
      }
      if (endpoint === "/api/connectors/verify") {
        return apiOk(verificationResponse);
      }
      return apiOk({});
    });
  });

  test("renders explicit MCP proof action and honest skill semantics", async () => {
    const { default: Connectors } =
      await import("../../../src/serve/public/pages/Connectors");
    renderWithUser(<Connectors navigate={() => undefined} />);

    expect(await screen.findByText("Cursor")).toBeTruthy();
    expect(screen.getByText("Agent Connectors")).toBeTruthy();
    expect(
      (screen.getByLabelText("Proof collection") as HTMLSelectElement).value
    ).toBe("alpha");
    expect(
      screen.getByRole("button", { name: "Verify retrieval" })
    ).toBeTruthy();

    const codexCard = screen.getByText("Codex").closest("[data-slot=card]");
    expect(codexCard).not.toBeNull();
    expect(
      within(codexCard as HTMLElement).getByText(
        "Runtime verification unavailable"
      )
    ).toBeTruthy();
    expect(
      within(codexCard as HTMLElement).getByText(/target_runtime_unverifiable/)
    ).toBeTruthy();
    expect(
      within(codexCard as HTMLElement).queryByRole("button", {
        name: "Verify retrieval",
      })
    ).toBeNull();
  });

  test("runs retrieval proof only after the user chooses a collection and clicks", async () => {
    const { default: Connectors } =
      await import("../../../src/serve/public/pages/Connectors");
    const { user } = renderWithUser(<Connectors navigate={() => undefined} />);

    const selector = await screen.findByLabelText("Proof collection");
    expect(
      apiFetch.mock.calls.filter(
        ([endpoint]) => endpoint === "/api/connectors/verify"
      )
    ).toHaveLength(0);

    await user.selectOptions(selector, "notes");
    await user.click(screen.getByRole("button", { name: "Verify retrieval" }));

    await waitFor(() => {
      const verifyCall = apiFetch.mock.calls.find(
        ([endpoint]) => endpoint === "/api/connectors/verify"
      );
      const options = verifyCall?.[1] as RequestInit | undefined;
      expect(verifyCall).toBeDefined();
      expect(options).toMatchObject({ method: "POST" });
      expect(typeof options?.body).toBe("string");
      if (typeof options?.body !== "string") {
        throw new Error("Expected JSON request body");
      }
      expect(JSON.parse(options.body)).toEqual({
        connectorId: "cursor-mcp",
        collection: "notes",
      });
    });
    expect(await screen.findByText("passed")).toBeTruthy();
    expect(
      screen.getByText(
        "Retrieval returned the expected indexed source. No action needed."
      )
    ).toBeTruthy();
  });

  test("renders a failed proof code with its plain next action", async () => {
    verificationResponse = {
      verification: {
        collection: "alpha",
        lexicalReady: true,
        connectorReady: false,
        generatedAt: "2026-07-22T12:00:00.000Z",
        stages: {
          connector: { status: "failed", code: "connector_timeout" },
        },
      },
      remediation:
        "Retry Cursor verification; inspect local MCP startup if it times out again.",
    };
    const { default: Connectors } =
      await import("../../../src/serve/public/pages/Connectors");
    const { user } = renderWithUser(<Connectors navigate={() => undefined} />);

    await screen.findByLabelText("Proof collection");
    await user.click(screen.getByRole("button", { name: "Verify retrieval" }));

    expect(await screen.findByText(/connector_timeout/)).toBeTruthy();
    expect(
      screen.getByText(
        "Retry Cursor verification; inspect local MCP startup if it times out again."
      )
    ).toBeTruthy();
  });
});
