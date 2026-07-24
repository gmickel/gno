import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { renderWithUser } from "../../helpers/dom";

const pairId = "a".repeat(64);
const csrfToken = "b".repeat(64);
const origin = `chrome-extension://${"c".repeat(32)}`;
const originalFetch = globalThis.fetch;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

beforeEach(() => {
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected request");
  }) as unknown as typeof fetch;
});

describe("browser clipper approval page", () => {
  test("requires explicit eight-digit approval and performs CSRF GET before POST", async () => {
    const requests: Request[] = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const inputUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const request = new Request(
          new URL(inputUrl, "http://127.0.0.1:3000"),
          init
        );
        requests.push(request);
        if (request.url.endsWith("/api/clipper/pair/csrf")) {
          return json({ schemaVersion: "1.0", csrfToken });
        }
        return json({
          schemaVersion: "1.0",
          status: "approved",
          origin,
          expiresAt: "2026-08-24T08:00:00.000Z",
        });
      }
    ) as unknown as typeof fetch;

    const { default: ClipperPairing } =
      await import("../../../src/serve/public/pages/ClipperPairing");
    const { user } = renderWithUser(<ClipperPairing pairId={pairId} />);
    const approve = screen.getByRole("button", { name: "Approve extension" });
    expect((approve as HTMLButtonElement).disabled).toBeTrue();

    await user.type(screen.getByLabelText("Pairing code"), "12345678");
    expect((approve as HTMLButtonElement).disabled).toBeFalse();
    await user.click(approve);

    expect(await screen.findByText("Browser paired")).toBeTruthy();
    expect(screen.getByText(origin)).toBeTruthy();
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.headers.get("X-GNO-CSRF")).toBe(csrfToken);
    expect(await requests[1]?.json()).toEqual({
      pairId,
      pairingCode: "12345678",
    });
    expect(document.body.textContent).not.toContain(pairId);
    expect(document.body.textContent).not.toContain(csrfToken);
  });

  test("lets the user retry an invalid code without retaining it", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) =>
      (typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      ).endsWith("/csrf")
        ? json({ schemaVersion: "1.0", csrfToken })
        : json(
            {
              error: {
                code: "CLIPPER_PAIR_INVALID_CODE",
                message: "Pairing could not be approved",
              },
            },
            403
          )
    ) as unknown as typeof fetch;
    const { default: ClipperPairing } =
      await import("../../../src/serve/public/pages/ClipperPairing");
    const { user } = renderWithUser(<ClipperPairing pairId={pairId} />);
    const input = screen.getByLabelText("Pairing code");
    await user.type(input, "12345678");
    await user.click(screen.getByRole("button", { name: "Approve extension" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pairing could not be approved"
    );
    expect((input as HTMLInputElement).value).toBe("");
    expect(
      screen.getByRole("button", { name: "Approve extension" })
    ).toBeTruthy();
  });

  test("fails closed and clears terminal or unknown responses", async () => {
    const responses = [
      json({ schemaVersion: "1.0", csrfToken }),
      json(
        {
          error: {
            code: "CLIPPER_PAIR_EXPIRED",
            message: "Pairing expired",
          },
        },
        410
      ),
    ];
    globalThis.fetch = mock(
      async () => responses.shift()!
    ) as unknown as typeof fetch;
    const { default: ClipperPairing } =
      await import("../../../src/serve/public/pages/ClipperPairing");
    const { user } = renderWithUser(<ClipperPairing pairId={pairId} />);
    await user.type(screen.getByLabelText("Pairing code"), "12345678");
    await user.click(screen.getByRole("button", { name: "Approve extension" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pairing expired"
    );
    expect(
      screen.queryByRole("button", { name: "Approve extension" })
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Back to GNO" })).toBeTruthy();
  });

  test("keeps approval retryable while the local gateway is offline", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { default: ClipperPairing } =
      await import("../../../src/serve/public/pages/ClipperPairing");
    const { user } = renderWithUser(<ClipperPairing pairId={pairId} />);
    await user.type(screen.getByLabelText("Pairing code"), "12345678");
    await user.click(screen.getByRole("button", { name: "Approve extension" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Could not reach")
    );
    expect(
      screen.getByRole("button", { name: "Approve extension" })
    ).toBeTruthy();
  });
});
