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
  automation: {
    daemon: { state: "not_running", heartbeatAt: null },
    timezone: "UTC",
    profiles: [
      {
        id: "nightly",
        sources: ["codex-main"],
        collections: ["work"],
        state: "idle",
        hook: null,
        schedule: { enabled: true, cadence: "30m", nextDueAt: null },
        limit: 200,
        retries: 3,
        pending: null,
        running: null,
        lastTrigger: null,
        lastRun: null,
        lastSuccessAt: null,
        retryAt: null,
        recovery: null,
      },
    ],
  },
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

const discovery = {
  schemaVersion: "1",
  candidates: [
    {
      harness: "claude-code",
      path: "/tmp/synthetic-home/.claude/projects",
      units: 2,
      bytes: 2048,
      truncated: false,
      formatVersions: [],
      registeredAs: null,
    },
  ],
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
      if (endpoint === "/api/sessions/discover") return ok(discovery);
      if (endpoint === "/api/sessions/sources") {
        return ok({ id: "claude-code-main", registered: true });
      }
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

  test("automation switches reflect status and a schedule without a daemon is not shown as due", async () => {
    await renderPage();
    const schedule = await screen.findByRole("switch", {
      name: /Daemon schedule/,
    });
    const hook = screen.getByRole("switch", {
      name: /Claude Code SessionEnd hook/,
    });
    expect((schedule as HTMLInputElement).checked).toBe(true);
    expect((hook as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("every 30m; not running: no daemon")).toBeTruthy();
  });

  test("automation actions move keyboard focus to their outcome", async () => {
    const { user } = await renderPage();
    const failWith = (text: string): Promise<SessionsApiResult> =>
      Promise.resolve({
        data: null,
        error: text,
        sessionsCode: "SESSIONS_INVALID_INPUT",
        status: 400,
      });
    sessionsApi.mockImplementation(async (...args: unknown[]) => {
      const endpoint = String(args[0]);
      const method = (args[1] as RequestInit | undefined)?.method ?? "GET";
      if (endpoint === "/api/sessions/status") return statusResult();
      if (endpoint.endsWith("/preview")) {
        return ok({
          archiveRoot: "/a",
          sources: [],
          collections: [],
          hook: { settings: "/s", command: "c" },
          daemon: { state: "not_running", command: "gno daemon" },
          notes: [],
        });
      }
      if (endpoint.endsWith("/enable")) return failWith("Cadence is invalid");
      if (method === "PUT" || method === "DELETE") return ok({});
      if (endpoint.endsWith("/disable")) return ok({});
      return ok({});
    });

    // Create profile: focus lands on the announcement.
    await user.type(await screen.findByLabelText("Profile ID"), "web");
    await user.click(screen.getByRole("checkbox", { name: /codex-main/ }));
    await user.click(screen.getByRole("button", { name: /Create profile/ }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        "Profile web created"
      )
    );

    // Pause: the Pause button disappears; focus lands on a switch.
    const paused = structuredClone(status);
    paused.automation.profiles[0]!.schedule!.enabled = false;
    statusResult = () => ok(paused);
    await user.click(screen.getByRole("button", { name: "Pause nightly" }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("role")).toBe("switch")
    );

    // An invalid cadence error takes focus, also when it repeats.
    const scheduleSwitch = screen.getByRole("switch", {
      name: /Daemon schedule/,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      (scheduleSwitch as HTMLInputElement).focus();
      await user.click(scheduleSwitch);
      await user.click(await screen.findByRole("button", { name: "Enable" }));
      await waitFor(() =>
        expect(document.activeElement?.textContent).toContain(
          "Cadence is invalid"
        )
      );
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    }

    // Remove: the card disappears; focus lands on the announcement.
    await user.click(
      screen.getByRole("button", { name: "Remove profile nightly" })
    );
    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        "Profile nightly removed"
      )
    );
  });

  test("a failed status poll keeps the panel and polling alive", async () => {
    const running = structuredClone(status);
    running.automation.profiles[0]!.state = "running";
    statusResult = () => ok(running);
    await renderPage();
    await screen.findByText("running");
    statusResult = () =>
      Promise.resolve({
        data: null,
        error: "Server unavailable",
        sessionsCode: null,
        status: 503,
      });
    await screen.findByText("Server unavailable", undefined, { timeout: 3500 });
    expect(screen.getByText("running")).toBeTruthy();
    statusResult = () => ok(status);
    await screen.findByText("idle", undefined, { timeout: 3500 });
  });

  test("a failed profile shows its recovery, not queued work, and Remove moves focus to Confirm", async () => {
    const failed = structuredClone(status);
    Object.assign(failed.automation.profiles[0]!, {
      state: "failed",
      pending: { since: "2026-09-24T10:00:00.000Z", triggers: ["manual"] },
      recovery: "A selected source is missing: fix it, then run again.",
    });
    statusResult = () => ok(failed);
    const { user } = await renderPage();
    await screen.findByText(/A selected source is missing/);
    expect(screen.queryByText("Pending")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Remove profile nightly" })
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Confirm remove")
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Remove profile nightly"
      )
    );
  });

  test("a retryable Run now failure shows its retry time, not a missing recovery action", async () => {
    const retrying = structuredClone(status);
    Object.assign(retrying.automation.profiles[0]!, {
      state: "retrying",
      retryAt: "2026-09-24T10:05:00.000Z",
      recovery: null,
    });
    statusResult = () => ok(retrying);
    sessionsApi.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "/api/sessions/status") return statusResult();
      if (args[0] === "/api/sessions/automation/run") {
        return ok({
          schemaVersion: "1",
          profileId: "nightly",
          ran: true,
          outcome: "failed",
          reason: "busy",
          pending: true,
          receipts: [],
        });
      }
      return ok({});
    });
    const { user } = await renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Run nightly now" })
    );
    const line = await screen.findByText(/Run now: failed \(busy\)/);
    expect(line.textContent).toContain("retried automatically at");
    expect(line.textContent).not.toContain("recovery action");
  });

  test("status is polled while a profile is running", async () => {
    const running = structuredClone(status);
    running.automation.profiles[0]!.state = "running";
    statusResult = () => ok(running);
    await renderPage();
    await screen.findByText("running");
    const calls = () =>
      sessionsApi.mock.calls.filter(
        (args) => args[0] === "/api/sessions/status"
      ).length;
    const before = calls();
    await waitFor(() => expect(calls()).toBeGreaterThan(before), {
      timeout: 3500,
    });
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

  test("search snippets render <mark> highlights and drop Markdown escapes", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "/api/search") {
        return apiOk({
          results: [
            {
              docid: "#m1",
              uri: "gno://work/hermes/hermes-main/t1.md",
              title: "Human · Hermes · theta",
              snippet:
                "Theta <mark>decision</mark>: locator state.db\\#messages/15 · main/agent.sqlite\\#transcript\\_events <b>x</b>",
              categories: ["session", "harness/hermes", "role/human"],
              record: { author: "human" },
            },
          ],
        });
      }
      return apiOk({});
    });
    const { user } = await renderPage();
    await screen.findByText("codex-main");
    await user.type(screen.getByLabelText("Session search query"), "decision");
    await user.click(screen.getByRole("button", { name: "Search" }));
    const results = await screen.findByRole("list", {
      name: "Session search results",
    });
    const mark = results.querySelector("mark");
    expect(mark?.textContent).toBe("decision");
    const text = results.textContent ?? "";
    expect(text).not.toContain("<mark>");
    expect(text).not.toContain("\\#");
    expect(text).not.toContain("\\_");
    expect(text).toContain("state.db#messages/15");
    expect(text).toContain("transcript_events");
    // Other markup stays inert text, never parsed as HTML.
    expect(results.querySelector("b")).toBeNull();
    expect(text).toContain("<b>x</b>");
  });

  test("registration requires an explicit destination and focuses the outcome", async () => {
    const { user } = await renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Discover local sources" })
    );
    const form = await screen.findByRole("form", {
      name: "Register Claude Code source",
    });
    const destination = within(form).getByLabelText(
      "Destination archive collection"
    ) as HTMLSelectElement;
    expect(destination.value).toBe("");
    const register = within(form).getByRole("button", {
      name: "Register source",
    }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    expect(
      within(form).getByText(/Choose a destination collection to register/)
    ).toBeTruthy();

    await user.selectOptions(destination, "work");
    expect(register.disabled).toBe(false);
    await user.click(register);

    const call = sessionsApi.mock.calls.find(
      (args) => args[0] === "/api/sessions/sources"
    );
    expect(requestBody(call)).toEqual({
      id: "claude-code-main",
      harness: "claude-code",
      path: "/tmp/synthetic-home/.claude/projects",
      collection: "work",
    });
    const notice = await screen.findByText(
      "Registered source claude-code-main → collection work. Nothing was imported yet."
    );
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  test("a failed registration moves focus to the error message", async () => {
    sessionsApi.mockImplementation(async (...args: unknown[]) => {
      const endpoint = args[0];
      if (endpoint === "/api/sessions/status") return statusResult();
      if (endpoint === "/api/sessions/discover") return ok(discovery);
      if (endpoint === "/api/sessions/sources") {
        return {
          data: null,
          error: "Source ID already registered.",
          sessionsCode: "SESSIONS_INVALID_INPUT",
          status: 400,
        };
      }
      return ok({});
    });
    const { user } = await renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Discover local sources" })
    );
    const form = await screen.findByRole("form", {
      name: "Register Claude Code source",
    });
    await user.selectOptions(
      within(form).getByLabelText("Destination archive collection"),
      "work"
    );
    await user.click(
      within(form).getByRole("button", { name: "Register source" })
    );
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe("Source ID already registered.");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  test("preview moves focus to the receipt region", async () => {
    const { user } = await renderPage();
    await user.click(
      await screen.findByRole("button", {
        name: "Preview import of codex-main (dry run)",
      })
    );
    const receipt = await screen.findByRole("region", {
      name: "Import preview",
    });
    expect(receipt.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(receipt));
  });
});
