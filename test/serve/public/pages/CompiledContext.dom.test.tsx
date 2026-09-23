import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, expect, mock, spyOn, test } from "bun:test";

import { apiError, apiOk, renderWithUser } from "../../../helpers/dom";

const source = '<script>alert("source")</script>\nKeep exact bytes.\n';
const apiFetch = mock(
  async (
    endpoint: string,
    _options?: unknown
  ): Promise<{ data: unknown; error: string | null }> => {
    if (endpoint.endsWith("check"))
      return apiOk({ status: "stale", reasons: ["Source changed"] });
    return apiOk({
      markdown: source,
      digest: "abc",
      verificationDigest: "def",
      budget: { usedTokens: 200, usedBytes: 500, estimator: "utf8" },
      coverage: {
        complete: false,
        coveredFacets: ["overview"],
        unresolvedFacets: ["decision"],
      },
      evidenceIds: ["e1"],
      omissions: [{ evidenceId: "e2", reason: "budget" }],
    });
  }
);
void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));
const { default: CompiledContext } =
  await import("../../../../src/serve/public/pages/CompiledContext");
beforeEach(() => {
  apiFetch.mockClear();
});

const supplyCapsule = () =>
  fireEvent.change(screen.getByLabelText("Or paste Capsule JSON"), {
    target: { value: '{"id":"capsule-test"}' },
  });

test("preview keeps source inert, reports omissions, downloads exact bytes, and invalidates edited inputs", async () => {
  const { user, container } = renderWithUser(
    <CompiledContext navigate={() => undefined} />
  );
  supplyCapsule();
  await user.click(
    screen.getByRole("button", { name: "Preview verified context" })
  );
  expect(await screen.findByText("Incomplete coverage")).toBeTruthy();
  expect(screen.getByText("Unresolved facets: decision")).toBeTruthy();
  expect(screen.getByLabelText("Compiled Markdown preview").textContent).toBe(
    source
  );
  expect(container.querySelector("script")).toBeNull();
  const request = apiFetch.mock.calls[0];
  if (!request) throw new Error("Missing preview request");
  expect(request?.[0]).toBe("/api/context/compiled/preview");
  expect(JSON.parse((request[1] as { body: string }).body)).toEqual({
    capsule: { id: "capsule-test" },
    budgetTokens: 12000,
  });
  const locationBeforeDownload = window.location.href;
  const original = URL.createObjectURL.bind(URL);
  let captured: Blob | undefined;
  let downloaded: { href: string; filename: string } | undefined;
  // Happy DOM treats download anchors as navigation, replacing the shared
  // window with blob:test. Intercept the browser download boundary only.
  const downloadClick = spyOn(
    window.HTMLAnchorElement.prototype,
    "click"
  ).mockImplementation(function (this: HTMLAnchorElement) {
    downloaded = { href: this.href, filename: this.download };
  });
  URL.createObjectURL = (blob) => {
    captured = blob as Blob;
    return "blob:test";
  };
  try {
    await user.click(screen.getByRole("button", { name: "Download Markdown" }));
    expect(await captured?.text()).toBe(source);
    expect(captured?.type).toBe("text/markdown;charset=utf-8");
    expect(downloaded).toEqual({
      href: "blob:test",
      filename: "project.gno-context.md",
    });
    expect(window.location.href).toBe(locationBeforeDownload);
  } finally {
    URL.createObjectURL = original;
    downloadClick.mockRestore();
  }
  fireEvent.change(screen.getByLabelText("Token budget"), {
    target: { value: "400" },
  });
  expect(
    screen.queryByRole("button", { name: "Download Markdown" })
  ).toBeNull();
});

test("freshness check submits inline bytes and renders stale reasons", async () => {
  const { user } = renderWithUser(
    <CompiledContext navigate={() => undefined} />
  );
  supplyCapsule();
  fireEvent.change(screen.getByLabelText("Or paste compiled Markdown"), {
    target: { value: source },
  });
  await user.click(screen.getByRole("button", { name: "Check freshness" }));
  expect(await screen.findByText("Artifact: stale")).toBeTruthy();
  expect(screen.getByText("Source changed")).toBeTruthy();
  const request = apiFetch.mock.calls[0];
  if (!request) throw new Error("Missing check request");
  expect(JSON.parse((request[1] as { body: string }).body)).toEqual({
    capsule: { id: "capsule-test" },
    markdown: source,
  });
});

test("oversize pasted input is rejected before any request", async () => {
  const { user } = renderWithUser(
    <CompiledContext navigate={() => undefined} />
  );
  fireEvent.change(screen.getByLabelText("Or paste Capsule JSON"), {
    target: { value: "x".repeat(4 * 1024 * 1024 + 1) },
  });
  await user.click(
    screen.getByRole("button", { name: "Preview verified context" })
  );
  expect((await screen.findByRole("alert")).textContent).toContain("4 MiB");
  expect(apiFetch).not.toHaveBeenCalled();
});

test("failed verification exposes the error without a download", async () => {
  apiFetch.mockImplementationOnce(() => apiError("Source access revoked"));
  const { user } = renderWithUser(
    <CompiledContext navigate={() => undefined} />
  );
  supplyCapsule();
  await user.click(
    screen.getByRole("button", { name: "Preview verified context" })
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Source access revoked"
  );
  expect(
    screen.queryByRole("button", { name: "Download Markdown" })
  ).toBeNull();
});

test("file upload uses contents, rejects oversized replacement, and keeps server paths out of requests", async () => {
  const { user } = renderWithUser(
    <CompiledContext navigate={() => undefined} />
  );
  await user.upload(
    screen.getByLabelText("Upload Capsule JSON"),
    new File(['{"id":"uploaded"}'], "private-capsule.json", {
      type: "application/json",
    })
  );
  expect(
    (screen.getByLabelText("Or paste Capsule JSON") as HTMLTextAreaElement)
      .value
  ).toBe('{"id":"uploaded"}');
  await user.click(
    screen.getByRole("button", { name: "Preview verified context" })
  );
  expect(await screen.findByText("Verified preview")).toBeTruthy();
  const request = apiFetch.mock.calls[0];
  if (!request) throw new Error("Missing uploaded preview request");
  expect(JSON.parse((request[1] as { body: string }).body)).toEqual({
    capsule: { id: "uploaded" },
    budgetTokens: 12000,
  });
  await user.upload(
    screen.getByLabelText("Upload Capsule JSON"),
    new File(["x".repeat(4 * 1024 * 1024 + 1)], "large.json", {
      type: "application/json",
    })
  );
  expect((await screen.findByRole("alert")).textContent).toContain("4 MiB");
  expect(
    (screen.getByLabelText("Or paste Capsule JSON") as HTMLTextAreaElement)
      .value
  ).toBe("");
  expect(
    screen.queryByRole("button", { name: "Download Markdown" })
  ).toBeNull();
});
