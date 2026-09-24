import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { forwardRef, useImperativeHandle } from "react";

import { apiError, apiOk, setTestLocation } from "../../../helpers/dom";

const AUTOSAVE_WAIT_MS = 2_300;

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));
let docEvent: { uri: string; changedAt: string } | null = null;

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

void mock.module("../../../../src/serve/public/hooks/use-doc-events", () => ({
  useDocEvents: () => docEvent,
}));

void mock.module("../../../../src/serve/public/components/editor", () => ({
  MarkdownPreview: () => null,
  CodeMirrorEditor: forwardRef<
    object,
    { initialContent: string; onChange: (value: string) => void }
  >(({ initialContent, onChange }, ref) => {
    useImperativeHandle(ref, () => ({
      setValue: () => undefined,
      getCursorInfo: () => null,
      scrollToPercent: () => false,
      revealLine: () => false,
    }));
    return (
      <textarea
        aria-label="Editor"
        defaultValue={initialContent}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }),
}));

const DOC = {
  docid: "#abc123",
  uri: "gno://notes/doc.md",
  title: "Doc",
  collection: "notes",
  relPath: "doc.md",
  content: "v0",
  tags: [],
  source: { sourceHash: "hash-0", modifiedAt: "2026-09-24T00:00:00.000Z" },
  capabilities: {
    editable: true,
    tagsEditable: true,
    tagsWriteback: true,
    canCreateEditableCopy: false,
    mode: "editable",
  },
};

let putResponses: Array<() => ReturnType<typeof apiOk<unknown>>>;
const puts = () =>
  apiFetch.mock.calls
    .filter(
      (call) => (call[1] as { method?: string } | undefined)?.method === "PUT"
    )
    .map((call) => JSON.parse((call[1] as { body: string }).body));

beforeEach(() => {
  apiFetch.mockReset();
  sessionStorage.clear();
  docEvent = null;
  setTestLocation(`/edit?uri=${encodeURIComponent(DOC.uri)}`);
  let revision = 0;
  putResponses = [];
  apiFetch.mockImplementation(async (...args: unknown[]) => {
    const [endpoint, init] = args as [string, { method?: string } | undefined];
    if (endpoint.startsWith("/api/doc?")) return apiOk(DOC);
    if (init?.method === "PUT") {
      const next = putResponses.shift();
      if (next) return next();
      revision += 1;
      return apiOk({
        success: true,
        version: {
          sourceHash: `hash-${revision}`,
          modifiedAt: `2026-09-24T00:00:0${revision}.000Z`,
        },
      });
    }
    return apiOk({});
  });
});

afterEach(cleanup);

async function openEditor() {
  const { default: DocumentEditor } =
    await import("../../../../src/serve/public/pages/DocumentEditor");
  const view = render(<DocumentEditor navigate={() => undefined} />);
  const editor = await screen.findByLabelText("Editor");
  return { ...view, editor };
}

const ctrlS = () => fireEvent.keyDown(window, { key: "s", ctrlKey: true });

describe("DocumentEditor saves", () => {
  test("Ctrl+S supersedes the pending autosave: one PUT, no false conflict", async () => {
    const { editor } = await openEditor();
    fireEvent.change(editor, { target: { value: "v1" } });
    ctrlS();
    await waitFor(() => expect(puts()).toHaveLength(1));
    await act(() => Bun.sleep(AUTOSAVE_WAIT_MS));

    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({
      content: "v1",
      expectedSourceHash: "hash-0",
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("an autosave of already committed content is not sent", async () => {
    const { editor } = await openEditor();
    fireEvent.change(editor, { target: { value: "v1" } });
    ctrlS();
    await waitFor(() => expect(puts()).toHaveLength(1));
    // Typing away and back to the committed text schedules an autosave.
    fireEvent.change(editor, { target: { value: "v1 draft" } });
    fireEvent.change(editor, { target: { value: "v1" } });
    await act(() => Bun.sleep(AUTOSAVE_WAIT_MS));

    expect(puts()).toHaveLength(1);
  });

  test("a replayed save after a lost response clears the stale change notice", async () => {
    putResponses.push(() => apiError("Failed to fetch") as never);
    const { editor, rerender } = await openEditor();
    fireEvent.change(editor, { target: { value: "v1" } });
    ctrlS();

    // Phones hide the inline status text; the failure gets its own row.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Failed to fetch"
    );
    // The lost save's own sync job reports the file as changed on disk.
    docEvent = { uri: DOC.uri, changedAt: new Date().toISOString() };
    const { default: DocumentEditor } =
      await import("../../../../src/serve/public/pages/DocumentEditor");
    rerender(<DocumentEditor navigate={() => undefined} />);
    await screen.findByText(/changed on disk/u);

    ctrlS();
    await waitFor(() => expect(puts()).toHaveLength(2));
    const [lost, retry] = puts();
    expect(retry.requestId).toBe(lost.requestId);
    await waitFor(() =>
      expect(screen.queryByText(/changed on disk/u)).toBeNull()
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
