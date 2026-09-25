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
/** Source hash the server reports for the document after the first load. */
let diskHash = "hash-0";
let docLoads = 0;
let diskReadFails = false;
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
  diskHash = "hash-0";
  docLoads = 0;
  diskReadFails = false;
  setTestLocation(`/edit?uri=${encodeURIComponent(DOC.uri)}`);
  let revision = 0;
  putResponses = [];
  apiFetch.mockImplementation(async (...args: unknown[]) => {
    const [endpoint, init] = args as [string, { method?: string } | undefined];
    if (endpoint.startsWith("/api/doc?")) {
      docLoads += 1;
      if (docLoads > 1 && diskReadFails)
        return apiError("Failed to fetch") as never;
      return apiOk(
        docLoads === 1
          ? DOC
          : { ...DOC, source: { ...DOC.source, sourceHash: diskHash } }
      );
    }
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

  const replayedSave = (sourceHash: string) => () =>
    apiOk({
      success: true,
      version: { sourceHash, modifiedAt: "2026-09-24T00:00:01.000Z" },
      request: { replayed: true },
    });

  const UNCONFIRMED = /save may have completed/u;
  const OUTSIDE = /changed on disk/u;

  let eventCount = 0;
  async function changeEvent(rerender: ReturnType<typeof render>["rerender"]) {
    eventCount += 1;
    docEvent = { uri: DOC.uri, changedAt: `2026-09-25T00:00:${eventCount}Z` };
    const { default: DocumentEditor } =
      await import("../../../../src/serve/public/pages/DocumentEditor");
    rerender(<DocumentEditor navigate={() => undefined} />);
  }

  /** A save whose response is lost, then the change event of its own commit. */
  async function lostSaveThenEvent() {
    putResponses.push(
      () =>
        Promise.resolve({
          data: null,
          error: "Failed to fetch",
          outcomeUnknown: true,
        }) as never
    );
    const { editor, rerender } = await openEditor();
    fireEvent.change(editor, { target: { value: "v1" } });
    ctrlS();
    // Phones hide the inline status text; the failure gets its own row.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Failed to fetch"
    );
    await screen.findByText(UNCONFIRMED);
    await changeEvent(rerender);
    return { editor, rerender };
  }

  test("a lost save response offers retry instead of claiming an outside change", async () => {
    await lostSaveThenEvent();

    expect(screen.getByText(UNCONFIRMED)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry save" })).toBeTruthy();
    expect(screen.queryByText(OUTSIDE)).toBeNull();
  });

  test("a change event with no save pending shows the reload banner", async () => {
    const { rerender } = await openEditor();
    await changeEvent(rerender);

    await screen.findByText(OUTSIDE);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  test("a replayed retry clears the notice when disk still holds that commit", async () => {
    await lostSaveThenEvent();
    diskHash = "hash-v1";
    putResponses.push(replayedSave("hash-v1"));
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const [lost, retry] = puts();
    expect(retry.requestId).toBe(lost.requestId);
    await waitFor(() => expect(screen.queryByText(UNCONFIRMED)).toBeNull());
    expect(screen.queryByText(OUTSIDE)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a replayed retry shows the reload banner when another writer changed disk since", async () => {
    await lostSaveThenEvent();
    diskHash = "hash-v2-from-someone-else";
    putResponses.push(replayedSave("hash-v1"));
    ctrlS();

    await screen.findByText(OUTSIDE);
    expect(screen.queryByText(UNCONFIRMED)).toBeNull();
  });

  test("a replayed retry whose disk read fails claims no outside change", async () => {
    await lostSaveThenEvent();
    diskReadFails = true;
    putResponses.push(replayedSave("hash-v1"));
    ctrlS();

    await waitFor(() => expect(docLoads).toBe(2));
    await waitFor(() => expect(screen.queryByText(UNCONFIRMED)).toBeNull());
    expect(screen.queryByText(OUTSIDE)).toBeNull();
  });

  test("a retry whose outcome is still unknown keeps offering retry", async () => {
    await lostSaveThenEvent();
    putResponses.push(
      () =>
        Promise.resolve({
          data: null,
          error: "Request is accepted and still in progress",
          outcomeUnknown: true,
        }) as never
    );
    ctrlS();

    await waitFor(() => expect(puts()).toHaveLength(2));
    await screen.findAllByText(/still in progress/u);
    expect(screen.getByText(UNCONFIRMED)).toBeTruthy();
    expect(screen.queryByText(OUTSIDE)).toBeNull();
  });

  test("a rejected retry attributes the held change to another writer", async () => {
    await lostSaveThenEvent();
    putResponses.push(
      () => apiError("Document changed on disk. Reload before saving.") as never
    );
    ctrlS();

    await screen.findByText(/Reload before continuing/u);
    expect(screen.queryByText(UNCONFIRMED)).toBeNull();
  });

  test("Retry save resolves a lost save after the draft is undone to the loaded text", async () => {
    const { editor, rerender } = await lostSaveThenEvent();
    fireEvent.change(editor, { target: { value: DOC.content } });
    diskHash = "hash-v1";
    putResponses.push(replayedSave("hash-v1"));
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const [lost, retry] = puts();
    expect(retry.requestId).toBe(lost.requestId);
    await waitFor(() => expect(screen.queryByText(UNCONFIRMED)).toBeNull());
    // Change events are no longer held once the outcome is known.
    await changeEvent(rerender);
    await screen.findByText(OUTSIDE);
  });

  test("a lost save keeps an existing outside-change warning", async () => {
    putResponses.push(
      () =>
        Promise.resolve({
          data: null,
          error: "Failed to fetch",
          outcomeUnknown: true,
        }) as never,
      () => apiError("Document changed on disk. Reload before saving.") as never
    );
    const { editor, rerender } = await openEditor();
    await changeEvent(rerender);
    await screen.findByText(OUTSIDE);

    fireEvent.change(editor, { target: { value: "v1" } });
    ctrlS();
    await screen.findByRole("alert");
    expect(screen.getByText(OUTSIDE)).toBeTruthy();
    expect(screen.queryByText(UNCONFIRMED)).toBeNull();

    ctrlS();
    await waitFor(() => expect(puts()).toHaveLength(2));
    await screen.findAllByText(/Reload before saving/u);
    expect(screen.getByText(/Reload before continuing/u)).toBeTruthy();
  });
});
