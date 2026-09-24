import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../helpers/dom";

interface SessionsApiResult {
  data: unknown;
  error: string | null;
  sessionsCode: string | null;
  status: number;
}

const ok = (data: unknown): Promise<SessionsApiResult> =>
  Promise.resolve({ data, error: null, sessionsCode: null, status: 200 });

const sessionsApi = mock(
  async (..._args: unknown[]): Promise<SessionsApiResult> => ok({})
);
const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../src/serve/public/components/sessions/api", () => ({
  sessionsApi,
}));
void mock.module("../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

const status = {
  schemaVersion: "1",
  configured: true,
  index: "sessions",
  collections: [{ name: "work", threads: 3 }],
  sources: [
    {
      id: "codex-main",
      harness: "codex",
      collection: "work",
      available: true,
      units: { total: 4, complete: 2, incomplete: 1, failed: 0, pending: 1 },
      archivedThreads: 3,
      staleParser: 0,
      sourceUnavailable: 0,
      lastImportAt: null,
    },
  ],
  warnings: [],
};

const partialPreview = {
  schemaVersion: "1",
  dryRun: true,
  index: "sessions",
  sourceIds: ["codex-main"],
  status: "partial",
  counts: {
    imported: 2,
    updated: 0,
    unchanged: 0,
    skippedPolicy: 0,
    unsupported: 0,
    incomplete: 1,
    failed: 0,
  },
  turns: {
    human: 4,
    assistant: 5,
    redactions: 3,
    injectedSkipped: 2,
    copiedHistorySkipped: 0,
    overLimit: 0,
  },
  units: [
    {
      sourceId: "codex-main",
      harness: "codex",
      locator: "rollout-synthetic-4.jsonl",
      outcome: "incomplete",
      reason: "truncated_tail",
      threads: 1,
      turns: 2,
      collections: ["work"],
    },
  ],
  unitsTruncated: false,
  deferredUnits: 0,
  lexical: { status: "skipped", collections: [] },
  embedding: { backlog: null },
  warnings: [],
};

function requestBody(call: unknown[] | undefined): unknown {
  const init = call?.[1] as RequestInit | undefined;
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

let localClient = true;
let statusResult: () => Promise<SessionsApiResult>;

async function renderPage() {
  const { default: Sessions } =
    await import("../../../src/serve/public/pages/Sessions");
  const navigate = mock((_to: string | number) => undefined);
  return { navigate, ...renderWithUser(<Sessions navigate={navigate} />) };
}

describe("sessions page", () => {
  beforeEach(() => {
    localClient = true;
    statusResult = () => ok(status);
    sessionsApi.mockReset();
    sessionsApi.mockImplementation(async (...args: unknown[]) => {
      const endpoint = args[0];
      if (endpoint === "/api/sessions/status") return statusResult();
      if (endpoint === "/api/sessions/import") return ok(partialPreview);
      return ok({});
    });
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = args[0];
      if (endpoint === "/api/capabilities") {
        return apiOk({
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
          localClient,
        });
      }
      if (endpoint === "/api/tags?prefix=project") {
        return apiOk({
          tags: [
            { tag: "project/alpha", count: 3 },
            { tag: "project-id/0123456789ab", count: 3 },
          ],
        });
      }
      if (endpoint === "/api/search") {
        return apiOk({
          results: [
            {
              docid: "#a1",
              uri: "gno://work/codex/codex-main/t1.jsonl",
              title: "Assistant turn · Codex · alpha · time unknown",
              snippet: "Assistant: consider option B",
              categories: [
                "session",
                "harness/codex",
                "project/alpha",
                "role/assistant",
              ],
              record: { author: "assistant" },
            },
            {
              docid: "#h1",
              uri: "gno://work/codex/codex-main/t2.jsonl",
              title: "Human turn · Codex · alpha · 2026-09-20 10:00",
              snippet: "Human: we go with option A",
              categories: ["session", "harness/codex", "role/human"],
              record: {
                author: "human",
                dateFields: { recorded: "2026-09-20T10:00:00.000Z" },
              },
            },
          ],
        });
      }
      return apiOk({});
    });
  });

  test("states the bound archive index, manual import and index separation", async () => {
    await renderPage();
    expect(await screen.findByText("codex-main")).toBeTruthy();
    expect(screen.getByText("sessions")).toBeTruthy();
    expect(screen.getByText(/Import is manual/)).toBeTruthy();
    expect(screen.getByText(/separate from your curated index/)).toBeTruthy();
    expect(screen.getByText(/1 incomplete/)).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Discover local sources" })
    ).toBeTruthy();
  });

  test("preview shows a partial receipt with redaction and destination policy", async () => {
    const { user } = await renderPage();
    await user.click(
      await screen.findByRole("button", {
        name: "Preview import of codex-main (dry run)",
      })
    );
    const call = sessionsApi.mock.calls.find(
      (args) => args[0] === "/api/sessions/import"
    );
    expect(requestBody(call)).toEqual({
      sourceId: "codex-main",
      dryRun: true,
    });
    const receipt = await screen.findByRole("region", {
      name: "Import preview",
    });
    const badge = within(receipt).getByRole("status");
    expect(badge.getAttribute("data-status")).toBe("partial");
    expect(badge.textContent).toContain("Partial");
    expect(
      within(receipt).getByText("Preview only — nothing was written")
    ).toBeTruthy();
    const redactions = within(receipt).getByText("Redactions");
    expect(redactions.nextElementSibling?.textContent).toBe("3");
    expect(within(receipt).getByText("work")).toBeTruthy();
    expect(within(receipt).getByText(/reason: truncated_tail/)).toBeTruthy();
  });

  test("remote clients get import controls but no owner-only actions", async () => {
    localClient = false;
    await renderPage();
    expect(
      await screen.findByRole("button", { name: "Import codex-main" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some((a) => a[0] === "/api/capabilities")
      ).toBe(true)
    );
    expect(
      screen.queryByRole("button", { name: "Discover local sources" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove source codex-main" })
    ).toBeNull();
  });

  test("an unbound instance explains how to create and launch an archive", async () => {
    statusResult = () =>
      Promise.resolve({
        data: null,
        error: "No session archive is configured for this config.",
        sessionsCode: "SESSIONS_NOT_CONFIGURED",
        status: 400,
      });
    const { user } = await renderPage();
    expect(
      await screen.findByText("This server is not a session archive")
    ).toBeTruthy();
    expect(
      screen.getByText(
        "gno --config <archive.yml> --index sessions sessions init --archive <dir> --collection <name>"
      )
    ).toBeTruthy();
    expect(
      screen.getByText("gno --config <archive.yml> --index sessions serve")
    ).toBeTruthy();
    const form = await screen.findByRole("form", {
      name: "Create session archive",
    });
    await user.type(
      within(form).getByLabelText(/Archive directory/),
      "/tmp/synthetic-archive"
    );
    await user.click(
      within(form).getByRole("button", {
        name: "Create archive for this instance",
      })
    );
    const call = sessionsApi.mock.calls.find(
      (args) => args[0] === "/api/sessions/init"
    );
    expect(requestBody(call)).toEqual({
      archive: "/tmp/synthetic-archive",
      collection: "sessions",
    });
  });

  test("session search filters by harness/project/role and labels authorship", async () => {
    const { user, navigate } = await renderPage();
    await screen.findByText("codex-main");
    await user.selectOptions(screen.getByLabelText("Harness"), "codex");
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Project") as HTMLSelectElement).options.length
      ).toBe(2)
    );
    await user.selectOptions(screen.getByLabelText("Project"), "alpha");
    await user.selectOptions(screen.getByLabelText("Speaker"), "assistant");
    await user.type(screen.getByLabelText("Session search query"), "option");
    await user.click(screen.getByRole("button", { name: "Search" }));

    const call = apiFetch.mock.calls.find((args) => args[0] === "/api/search");
    expect(requestBody(call)).toEqual({
      query: "option",
      limit: 20,
      tagsAll: "session,harness/codex,project/alpha,role/assistant",
    });
    const results = await screen.findByRole("list", {
      name: "Session search results",
    });
    expect(
      within(results).getByText("Assistant — suggestion, not a user decision")
    ).toBeTruthy();
    expect(within(results).getByText("Human")).toBeTruthy();
    expect(
      within(results).getByText("project alpha · time unknown", {
        normalizer: (text) => text.replace(/\s+/g, " ").trim(),
      })
    ).toBeTruthy();
    const link = within(results).getByRole("link", {
      name: /Human turn · Codex/,
    });
    expect(link.getAttribute("href")).toBe(
      "/doc?uri=gno%3A%2F%2Fwork%2Fcodex%2Fcodex-main%2Ft2.jsonl"
    );
    await user.click(link);
    expect(navigate).toHaveBeenCalledWith(link.getAttribute("href"));
  });
});
