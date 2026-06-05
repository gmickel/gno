import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

void mock.module(
  "../../../../src/serve/public/components/IndexingProgress",
  () => ({
    IndexingProgress: ({ jobId }: { jobId: string }) => (
      <div>Indexing job {jobId}</div>
    ),
  })
);

void mock.module(
  "../../../../src/serve/public/components/WikiLinkAutocomplete",
  () => ({
    WikiLinkAutocomplete: () => null,
  })
);

describe("CaptureModal DOM interactions", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  test("submits a note from the dialog with keyboard interaction and tag input", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/status") {
        return apiOk({
          collections: [{ name: "notes", path: "/tmp/notes" }],
        });
      }
      if (endpoint === "/api/tags") {
        return apiOk({
          tags: [{ tag: "work", count: 9 }],
          meta: { total: 1 },
        });
      }
      if (endpoint === "/api/capture") {
        return apiOk({
          uri: "gno://notes/shipping-plan.md",
          collection: "notes",
          relPath: "shipping-plan.md",
          created: true,
          openedExisting: false,
          createdWithSuffix: false,
          overwritten: false,
          contentHash:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          source: {
            kind: "direct",
            capturedAt: "2026-06-04T12:34:56.000Z",
          },
          tags: ["work"],
          sync: { status: "pending", jobId: "job-123" },
          embed: {
            status: "not_requested",
            reason: "Capture does not embed automatically.",
          },
          collisionPolicyResult: "created",
        });
      }
      return apiOk({});
    });

    const { CaptureModal } =
      await import("../../../../src/serve/public/components/CaptureModal");
    const onOpenChange = mock(() => undefined);
    const onSuccess = mock(() => undefined);
    const { user } = renderWithUser(
      <CaptureModal
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open={true}
      />
    );

    const dialog = await screen.findByRole("dialog", { name: "New note" });
    expect(dialog).toBeTruthy();

    const titleInput = screen.getByLabelText("Title");
    expect(document.activeElement).toBe(titleInput);

    await user.type(titleInput, "Shipping plan");
    await user.type(
      screen.getByLabelText("Content"),
      "Plan the launch checklist and handoff."
    );

    const tagInput = screen.getByRole("combobox", {
      name: "Add tags to this note",
    });
    await user.click(tagInput);
    await user.type(tagInput, "wor");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");

    await user.click(screen.getByLabelText("Content"));
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith("gno://notes/shipping-plan.md");
    });

    expect(await screen.findByText("Note captured")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Not requested")).toBeTruthy();
    expect(screen.getByText("Indexing job job-123")).toBeTruthy();

    const captureCall = apiFetch.mock.calls.find(
      (call) => call[0] === "/api/capture"
    );
    expect(captureCall).toBeDefined();
    const body = JSON.parse(
      (captureCall?.[1] as { body: string } | undefined)?.body ?? "{}"
    );
    expect(body).toMatchObject({
      collection: "notes",
      title: "Shipping plan",
      collisionPolicy: "create_with_suffix",
      source: { kind: "direct" },
      tags: ["work"],
    });
  });

  test("shows missing collection state", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/status") {
        return apiOk({ collections: [] });
      }
      return apiOk({});
    });

    const { CaptureModal } =
      await import("../../../../src/serve/public/components/CaptureModal");
    const { user } = renderWithUser(
      <CaptureModal onOpenChange={() => undefined} open={true} />
    );

    await screen.findByText("No collections found. Add one first.");
    await user.type(screen.getByLabelText("Title"), "No target");
    await user.type(screen.getByLabelText("Content"), "Needs a collection.");

    expect(
      (screen.getByRole("button", { name: "Create note" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  test("submits provenance fields and shows skipped sync without job progress", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/status") {
        return apiOk({
          collections: [{ name: "notes", path: "/tmp/notes" }],
        });
      }
      if (endpoint === "/api/capture") {
        return apiOk({
          uri: "gno://notes/source-note.md",
          collection: "notes",
          relPath: "source-note.md",
          created: true,
          openedExisting: false,
          createdWithSuffix: false,
          overwritten: false,
          contentHash:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          source: {
            kind: "direct",
            title: "Source page",
            url: "https://example.com/source",
            author: "Ada",
            externalId: "src-1",
            capturedAt: "2026-06-04T12:34:56.000Z",
          },
          tags: [],
          sync: { status: "skipped", reason: "Sync is already running." },
          embed: {
            status: "not_requested",
            reason: "Capture does not embed automatically.",
          },
          collisionPolicyResult: "created",
        });
      }
      return apiOk({});
    });

    const { CaptureModal } =
      await import("../../../../src/serve/public/components/CaptureModal");
    const { user } = renderWithUser(
      <CaptureModal onOpenChange={() => undefined} open={true} />
    );

    await screen.findByRole("dialog", { name: "New note" });
    await user.type(screen.getByLabelText("Title"), "Source note");
    await user.type(screen.getByLabelText("Content"), "Captured from source.");
    await user.click(screen.getByText("Source"));
    await user.type(screen.getByLabelText("Source title"), "Source page");
    await user.type(screen.getByLabelText("URL"), "https://example.com/source");
    await user.type(screen.getByLabelText("Author"), "Ada");
    await user.type(screen.getByLabelText("External ID"), "src-1");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByText("Skipped")).toBeTruthy();
    expect(screen.getByText("Sync is already running.")).toBeTruthy();
    expect(screen.queryByText(/Indexing job/u)).toBeNull();

    const captureCall = apiFetch.mock.calls.find(
      (call) => call[0] === "/api/capture"
    );
    const body = JSON.parse(
      (captureCall?.[1] as { body: string } | undefined)?.body ?? "{}"
    );
    expect(body.source).toMatchObject({
      kind: "direct",
      title: "Source page",
      url: "https://example.com/source",
      author: "Ada",
      externalId: "src-1",
    });
  });

  test("submits untouched preset scaffold as preset only", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint === "/api/status") {
        return apiOk({
          collections: [{ name: "notes", path: "/tmp/notes" }],
        });
      }
      if (endpoint === "/api/capture") {
        return apiOk({
          uri: "gno://notes/research-brief.md",
          collection: "notes",
          relPath: "research-brief.md",
          created: true,
          openedExisting: false,
          createdWithSuffix: false,
          overwritten: false,
          contentHash:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          source: {
            kind: "direct",
            capturedAt: "2026-06-04T12:34:56.000Z",
          },
          tags: ["research"],
          sync: { status: "pending", jobId: "job-123" },
          embed: {
            status: "not_requested",
            reason: "Capture does not embed automatically.",
          },
          collisionPolicyResult: "created",
        });
      }
      return apiOk({});
    });

    const { CaptureModal } =
      await import("../../../../src/serve/public/components/CaptureModal");
    const { user } = renderWithUser(
      <CaptureModal
        onOpenChange={() => undefined}
        open={true}
        presetId="research-note"
      />
    );

    await screen.findByRole("dialog", { name: "New note" });
    await user.type(screen.getByLabelText("Title"), "Research brief");
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Content") as HTMLTextAreaElement).value
      ).toContain("## Summary");
    });
    await user.click(screen.getByRole("button", { name: "Create note" }));

    await screen.findByText("Note captured");
    const captureCall = apiFetch.mock.calls.find(
      (call) => call[0] === "/api/capture"
    );
    const body = JSON.parse(
      (captureCall?.[1] as { body: string } | undefined)?.body ?? "{}"
    );
    expect(body.presetId).toBe("research-note");
    expect(body.content).toBeUndefined();
  });
});
