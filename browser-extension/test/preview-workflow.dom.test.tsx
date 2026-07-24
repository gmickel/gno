import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, mock, test } from "bun:test";

import { extraction, previewResponse, receiptResponse } from "./fixtures";

describe("browser clipper preview workflow", () => {
  test("renders only server canonical evidence and invalidates every edit", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const messages: Array<Record<string, unknown>> = [];
    let pending = {
      payload: {
        ...previewResponse.preview.destination,
      },
    } as unknown;
    pending = {
      payload: {
        ...extraction,
        schemaVersion: "1.0",
        extraction: {
          visibility: "user_visible",
          authenticated: false,
          extractorVersion: "gno-browser-clipper/1.0",
          warnings: [],
        },
        destination: previewResponse.preview.destination,
        tags: [],
        note: null,
        mode: "selection",
        selection: {
          exactText: extraction.selectionText,
          editedMarkdown: null,
        },
      },
      previewDigest: previewResponse.preview.digest,
    };
    const sendMessage = mock(async (message: Record<string, unknown>) => {
      messages.push(message);
      switch (message.type) {
        case "STATE":
          return {
            ok: true,
            result: {
              connected: true,
              expiresAt: "2099-08-24T08:00:00.000Z",
              pending,
              pairing: null,
            },
          };
        case "RESUME_PENDING":
          pending = null;
          return {
            ok: true,
            result: { receipt: receiptResponse, replayed: true },
          };
        case "EXTRACT":
          return { ok: true, result: extraction };
        case "PREVIEW":
          return { ok: true, result: previewResponse };
        case "CAPTURE":
          return {
            ok: true,
            result: { receipt: receiptResponse, replayed: false },
          };
        default:
          throw new Error(`Unexpected message: ${String(message.type)}`);
      }
    });
    Object.assign(globalThis, {
      chrome: {
        runtime: { sendMessage },
      },
    });

    await act(async () => {
      await import("../src/preview");
    });
    const user = userEvent.setup();
    await screen.findByText("Recover saved capture");
    expect(screen.getByText("Saved write awaiting safe recovery")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Extract now" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry saved write" }));
    expect(await screen.findByText(receiptResponse.uri)).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByText("Saved write awaiting safe recovery")
      ).toBeNull()
    );
    await screen.findByText("Capture visible context");
    await user.click(screen.getByRole("button", { name: "Extract now" }));
    await user.type(screen.getByLabelText("Collection"), "notes");
    await user.click(screen.getByRole("button", { name: "Server preview" }));

    const markdown = await screen.findByLabelText("Canonical capture Markdown");
    expect((markdown as HTMLTextAreaElement).value).toBe(
      previewResponse.preview.body
    );
    expect(screen.getByText(previewResponse.preview.digest)).toBeTruthy();
    expect(screen.getByText("notes/clips/example.md")).toBeTruthy();
    expect(screen.getByText("Server provenance and destination")).toBeTruthy();

    await user.type(markdown, "\nEdited");
    expect(screen.getByLabelText("Canonical capture Markdown")).toBeTruthy();
    expect(screen.getByText(/Capture changed/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm capture",
        }) as HTMLButtonElement
      ).disabled
    ).toBeTrue();

    await user.click(screen.getByRole("button", { name: "Refresh preview" }));
    await user.click(screen.getByRole("button", { name: "Confirm capture" }));
    expect(await screen.findByText(receiptResponse.uri)).toBeTruthy();
    expect(screen.getAllByText("created")).toHaveLength(2);

    const previews = messages.filter((message) => message.type === "PREVIEW");
    expect(previews).toHaveLength(2);
    const secondPayload = previews[1]?.payload as {
      selection: { exactText: string; editedMarkdown: string };
    };
    expect(secondPayload.selection.exactText).toBe(
      extraction.selectionText ?? ""
    );
    expect(secondPayload.selection.editedMarkdown).toContain("Edited");
    expect(
      messages.filter((message) => message.type === "CAPTURE")
    ).toHaveLength(1);
    await waitFor(() =>
      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(5)
    );
  });
});
