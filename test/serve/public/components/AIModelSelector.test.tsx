import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AppStatusResponse } from "../../../../src/serve/status-model";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

describe("AIModelSelector", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/presets") {
        return apiOk({
          presets: [
            {
              id: "slim",
              name: "Slim (~1GB)",
              embed: "embed",
              rerank: "rerank",
              gen: "gen",
              active: true,
            },
          ],
          activePreset: "slim",
          capabilities: {
            bm25: true,
            vector: true,
            hybrid: true,
            answer: true,
          },
        });
      }
      if (endpoint === "/api/models/status") {
        return apiOk({
          active: false,
          currentType: null,
          progress: null,
          completed: [],
          failed: [],
          startedAt: null,
        });
      }
      return apiOk({});
    });
  });

  test("uses parent status without issuing a duplicate status request", async () => {
    const { AIModelSelector } =
      await import("../../../../src/serve/public/components/AIModelSelector");
    const appStatus = {
      bootstrap: {
        models: {
          cachedCount: 4,
          totalCount: 4,
        },
      },
    } as AppStatusResponse;

    renderWithUser(<AIModelSelector appStatus={appStatus} />);

    await waitFor(() => {
      expect(
        apiFetch.mock.calls.some((call) => call[0] === "/api/presets")
      ).toBe(true);
    });
    expect(
      apiFetch.mock.calls.filter((call) => call[0] === "/api/status")
    ).toHaveLength(0);
  });
});
