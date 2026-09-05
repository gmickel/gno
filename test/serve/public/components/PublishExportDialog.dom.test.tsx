import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(
  async (
    ..._args: unknown[]
  ): Promise<{ data: unknown; error: string | null }> => apiOk<unknown>({})
);
void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

const { PublishExportDialog } =
  await import("../../../../src/serve/public/components/PublishExportDialog");
const { buildPublishExportRequest } =
  await import("../../../../src/serve/public/lib/publish-export");

const response = (visibility: string) => ({
  artifact: {
    version: visibility === "encrypted" ? 2 : 1,
    spaces: [{ visibility }],
  },
  fileName: "synthetic-note.json",
  uploadUrl: "https://gno.sh/studio",
});

// Only the download boundary is observed here; artifact encryption/schema tests
// exercise the real exporter in test/publish and test/cli/publish-export.test.ts.
let downloads: number;
let anchorClick: ReturnType<typeof spyOn>;
const originalCreateObjectURL = URL.createObjectURL.bind(URL);
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

import { afterEach } from "bun:test";

afterEach(() => {
  anchorClick.mockRestore();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

beforeEach(() => {
  anchorClick = spyOn(
    window.HTMLAnchorElement.prototype,
    "click"
  ).mockImplementation(() => undefined);
  apiFetch.mockReset();
  downloads = 0;
  URL.createObjectURL = () => {
    downloads += 1;
    return "blob:synthetic-export";
  };
  URL.revokeObjectURL = () => undefined;
  globalThis.NodeFilter ??= window.NodeFilter;
  globalThis.HTMLInputElement ??= window.HTMLInputElement;
});

function ExportHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Export note
      </button>
      {open && (
        <PublishExportDialog
          onClose={() => setOpen(false)}
          target="atlas"
          title="Atlas"
        />
      )}
    </>
  );
}

describe("explicit local publish export", () => {
  test("keyboard cancellation returns focus and reopening clears the previous access", async () => {
    const { user } = renderWithUser(<ExportHarness />);
    const trigger = screen.getByRole("button", { name: "Export note" });
    await user.click(trigger);
    await user.click(screen.getByRole("radio", { name: /^Secret link / }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("radio")
          .every((radio) => !(radio as HTMLInputElement).checked)
      ).toBe(true)
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  test("starts without access and cancels without a request or artifact", async () => {
    const onClose = mock(() => undefined);
    const { user } = renderWithUser(
      <PublishExportDialog onClose={onClose} target="atlas" title="Atlas" />
    );
    for (const radio of screen.getAllByRole("radio"))
      expect((radio as HTMLInputElement).checked).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Download export",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    await user.click(screen.getByRole("radio", { name: /^Public / }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(downloads).toBe(0);
  });

  test.each([
    ["public", "Public"],
    ["secret-link", "Secret link"],
    ["invite-only", "Invite only"],
    ["encrypted", "Encrypted"],
  ])(
    "exports exactly the confirmed %s mode through the local API",
    async (visibility, label) => {
      apiFetch.mockImplementation(async () => apiOk(response(visibility)));
      const onClose = mock(() => undefined);
      const { user } = renderWithUser(
        <PublishExportDialog
          onClose={onClose}
          target="gno://atlas/note.md"
          title="Synthetic note"
        />
      );
      await user.click(
        screen.getByRole("radio", { name: new RegExp(`^${label} `) })
      );
      expect(
        (
          screen.getByRole("button", {
            name: "Download export",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      if (visibility === "encrypted") {
        await user.type(
          screen.getByLabelText("Passphrase", { exact: true }),
          "synthetic test passphrase"
        );
        await user.type(
          screen.getByLabelText("Confirm passphrase"),
          "synthetic test passphrase"
        );
      }
      await user.click(screen.getByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: "Download export" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(apiFetch).toHaveBeenCalledTimes(1);
      const [endpoint, options] = apiFetch.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(endpoint).toBe("/api/publish/export");
      expect(JSON.parse(options.body as string)).toEqual({
        target: "gno://atlas/note.md",
        visibility,
        ...(visibility === "encrypted"
          ? { encryptionPassphrase: "synthetic test passphrase" }
          : {}),
      });
      expect(downloads).toBe(1);
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    }
  );

  test("requires matching encryption inputs and renews confirmation after access changes", async () => {
    const { user } = renderWithUser(
      <PublishExportDialog
        onClose={() => undefined}
        target="atlas"
        title="Atlas"
      />
    );
    await user.click(screen.getByRole("radio", { name: /^Encrypted / }));
    await user.click(screen.getByRole("checkbox"));
    const download = screen.getByRole("button", {
      name: "Download export",
    }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    await user.type(
      screen.getByLabelText("Passphrase", { exact: true }),
      "synthetic"
    );
    await user.type(screen.getByLabelText("Confirm passphrase"), "different");
    expect(download.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("do not match");
    await user.click(screen.getByRole("radio", { name: /^Public / }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false
    );
    await user.click(screen.getByRole("radio", { name: /^Encrypted / }));
    expect(
      (screen.getByLabelText("Passphrase", { exact: true }) as HTMLInputElement)
        .value
    ).toBe("");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(downloads).toBe(0);
  });

  test("retains the review on failure and refuses a mismatched artifact", async () => {
    apiFetch.mockImplementationOnce(async () => ({
      data: null,
      error: "Egress denied",
    }));
    apiFetch.mockImplementationOnce(async () => apiOk(response("public")));
    const onClose = mock(() => undefined);
    const { user } = renderWithUser(
      <PublishExportDialog onClose={onClose} target="atlas" title="Atlas" />
    );
    await user.click(screen.getByRole("radio", { name: /^Secret link / }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Download export" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Egress denied"
    );
    expect(
      (screen.getByRole("radio", { name: /^Secret link / }) as HTMLInputElement)
        .checked
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Download export" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "does not match"
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(downloads).toBe(0);
  });

  test("rejects invalid choices and incomplete review before building a request", () => {
    for (const patch of [
      { visibility: null },
      { visibility: "friends-only" },
      { audienceConfirmed: false },
      { visibility: "encrypted", passphrase: "", passphraseConfirmation: "" },
      {
        visibility: "encrypted",
        passphrase: "one",
        passphraseConfirmation: "two",
      },
    ]) {
      expect(() =>
        buildPublishExportRequest({
          target: "atlas",
          visibility: "public",
          passphrase: "",
          passphraseConfirmation: "",
          audienceConfirmed: true,
          ...patch,
        })
      ).toThrow();
    }
  });
});
