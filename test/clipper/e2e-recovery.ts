import type { BrowserContext, Page } from "playwright";

import { expect } from "bun:test";

import type {
  BrowserClipPayload,
  ClipperLocalState,
  PendingCapture,
} from "../../browser-extension/src/types";
import type { ClipperE2EHarness, RecordedResponse } from "./e2e-harness";

import { waitForReceipt } from "./e2e-assertions";

const CLIPPER_STATE_KEY = "gnoClipperLocalState";

interface RecoveryOptions {
  context: BrowserContext;
  extensionOrigin: string;
  harness: ClipperE2EHarness;
  popup: Page;
  records: RecordedResponse[];
}

interface RuntimeReply {
  error?: { code?: string; message?: string };
  ok?: boolean;
}

const readLocalState = (page: Page): Promise<ClipperLocalState> =>
  page.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return stored[key] as ClipperLocalState;
  }, CLIPPER_STATE_KEY);

const restoreLocalState = (
  page: Page,
  state: ClipperLocalState
): Promise<void> =>
  page.evaluate(
    async ({ key, value }) => {
      await chrome.storage.local.set({ [key]: value });
    },
    { key: CLIPPER_STATE_KEY, value: state }
  );

const pendingState = async (
  page: Page
): Promise<{
  local: ClipperLocalState;
  pending: PendingCapture;
}> => {
  const local = await readLocalState(page);
  expect(local.pending).not.toBeNull();
  return { local, pending: local.pending as PendingCapture };
};

const restartServiceWorker = async (
  context: BrowserContext,
  popup: Page,
  extensionOrigin: string
): Promise<Page> => {
  const internals = await context.newPage();
  await internals.goto("chrome://serviceworker-internals");
  const registration = internals
    .locator(".serviceworker-registration")
    .filter({ hasText: extensionOrigin });
  expect(await registration.count()).toBe(1);
  const runningStatus = registration.locator(
    ".serviceworker-running-status .value"
  );
  expect(await runningStatus.textContent()).toBe("RUNNING");
  await popup.close().catch(() => undefined);
  await registration.locator('cr-button[data-command="stop"]').click();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runningStatus.textContent()) === "STOPPED") break;
    await Bun.sleep(50);
  }
  expect(await runningStatus.textContent()).toBe("STOPPED");

  const nextPopup = await context.newPage();
  await nextPopup.goto(`${extensionOrigin}/preview.html`);
  await nextPopup
    .getByRole("button", { name: "Retry saved write" })
    .waitFor({ state: "visible" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runningStatus.textContent()) === "RUNNING") break;
    await Bun.sleep(50);
  }
  expect(await runningStatus.textContent()).toBe("RUNNING");
  await internals.close();
  return nextPopup;
};

const nextCaptureResponse = async (
  records: RecordedResponse[],
  startIndex: number,
  status: number
): Promise<RecordedResponse> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = records.slice(startIndex).find((record) => {
      const path = new URL(record.url).pathname;
      return (
        path === "/api/capture/clip" &&
        record.method === "POST" &&
        record.status === status
      );
    });
    if (match) return match;
    await Bun.sleep(25);
  }
  throw new Error(`Missing recovery capture response with HTTP ${status}`);
};

export const exerciseClipperRecovery = async (
  options: RecoveryOptions
): Promise<Page> => {
  let { popup } = options;
  await options.harness.stopResident();
  await popup.getByRole("button", { name: "Confirm capture" }).click();
  await popup.locator(".error").waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await popup.reload();
  await popup
    .getByRole("button", { name: "Retry saved write" })
    .waitFor({ state: "visible" });
  expect(await popup.getByRole("button", { name: "Extract now" }).count()).toBe(
    0
  );

  const first = await pendingState(popup);
  const differentPayload = structuredClone(
    first.pending.payload
  ) as BrowserClipPayload;
  differentPayload.note = "different capture while recovery is pending";
  const refused = await popup.evaluate(
    async ({ payload, previewDigest }) =>
      (await chrome.runtime.sendMessage({
        type: "CAPTURE",
        payload,
        previewDigest,
      })) as RuntimeReply,
    {
      payload: differentPayload,
      previewDigest: first.pending.previewDigest,
    }
  );
  expect(refused.ok).toBe(false);
  expect(refused.error?.message).toContain(
    "A different capture is awaiting recovery"
  );

  popup = await restartServiceWorker(
    options.context,
    popup,
    options.extensionOrigin
  );
  await popup
    .getByRole("button", { name: "Retry saved write" })
    .waitFor({ state: "visible" });
  const afterRestart = await pendingState(popup);
  expect(afterRestart.pending).toEqual(first.pending);

  await options.harness.startResident();
  let recordStart = options.records.length;
  await popup.getByRole("button", { name: "Retry saved write" }).click();
  await waitForReceipt(popup, "created");
  const firstWrite = await nextCaptureResponse(
    options.records,
    recordStart,
    202
  );
  expect(firstWrite.headers["idempotency-key"]).toBe(
    first.pending.idempotencyKey
  );
  expect(firstWrite.responseHeaders["idempotent-replay"]).not.toBe("true");

  // Recreate the exact post-write/pre-local-receipt crash boundary in the
  // trusted extension context; retry still crosses the real HTTP gateway.
  await restoreLocalState(popup, first.local);
  await popup.reload();
  recordStart = options.records.length;
  await popup.getByRole("button", { name: "Retry saved write" }).click();
  await waitForReceipt(popup, "created");
  const replay = await nextCaptureResponse(options.records, recordStart, 202);
  expect(replay.headers["idempotency-key"]).toBe(first.pending.idempotencyKey);
  expect(replay.responseHeaders["idempotent-replay"]).toBe("true");

  // Recreate the same exact saved write so Stop recovery exercises the popup
  // and extension discard boundary instead of a test-only controller seam.
  await restoreLocalState(popup, first.local);
  await popup.reload();
  await popup.getByRole("button", { name: "Stop recovery" }).click();
  await popup
    .getByRole("heading", { name: "Capture visible context" })
    .waitFor({ state: "visible" });
  expect((await readLocalState(popup)).pending).toBeNull();
  return popup;
};
