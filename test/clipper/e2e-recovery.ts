import type { BrowserContext, Page, Worker } from "playwright";

import { expect } from "bun:test";
// node:path is required because Bun has no path utilities.
import { join } from "node:path";

import type {
  BrowserClipPayload,
  ClipperLocalState,
  PendingCapture,
} from "../../browser-extension/src/types";
import type { ClipperE2EHarness, RecordedResponse } from "./e2e-harness";

import { activateFixtureSelection } from "./e2e-harness";

const CLIPPER_STATE_KEY = "gnoClipperLocalState";

interface RecoveryOptions {
  context: BrowserContext;
  extensionOrigin: string;
  fixturePage: Page;
  harness: ClipperE2EHarness;
  popup: Page;
  records: RecordedResponse[];
}

interface RuntimeReply {
  error?: { code?: string; message?: string };
  ok?: boolean;
}

const waitForReceipt = async (popup: Page, outcome: string): Promise<void> => {
  await popup
    .locator(".receipt")
    .getByText(outcome, { exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
};

const readLocalState = (worker: Worker): Promise<ClipperLocalState> =>
  worker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return stored[key] as ClipperLocalState;
  }, CLIPPER_STATE_KEY);

const restoreLocalState = (
  worker: Worker,
  state: ClipperLocalState
): Promise<void> =>
  worker.evaluate(
    async ({ key, value }) => {
      await chrome.storage.local.set({ [key]: value });
    },
    { key: CLIPPER_STATE_KEY, value: state }
  );

const pendingState = async (
  worker: Worker
): Promise<{
  local: ClipperLocalState;
  pending: PendingCapture;
}> => {
  const local = await readLocalState(worker);
  expect(local.pending).not.toBeNull();
  return { local, pending: local.pending as PendingCapture };
};

const waitForNewWorker = async (
  context: BrowserContext,
  previous: Worker
): Promise<Worker> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = context
      .serviceWorkers()
      .find((worker) => worker !== previous);
    if (current) return current;
    await Bun.sleep(50);
  }
  throw new Error("Extension service worker did not restart");
};

const restartExtension = async (
  context: BrowserContext,
  popup: Page,
  extensionOrigin: string
): Promise<{ popup: Page; worker: Worker }> => {
  const previous = context.serviceWorkers()[0];
  if (!previous) throw new Error("Browser clipper service worker is missing");
  await previous
    .evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __gnoClipperE2eMarker?: string;
        }
      ).__gnoClipperE2eMarker = "before-reload";
      (
        chrome.runtime as typeof chrome.runtime & {
          reload(): void;
        }
      ).reload();
    })
    .catch(() => undefined);
  await popup.close().catch(() => undefined);

  const nextPopup = await context.newPage();
  await nextPopup.goto(`${extensionOrigin}/preview.html`);
  const worker = await waitForNewWorker(context, previous);
  const staleMarker = await worker.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __gnoClipperE2eMarker?: string;
        }
      ).__gnoClipperE2eMarker ?? null
  );
  expect(staleMarker).toBeNull();
  return { popup: nextPopup, worker };
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

const createOfflinePending = async (
  popup: Page,
  fixturePage: Page,
  harness: ClipperE2EHarness,
  relPath: string
): Promise<void> => {
  await activateFixtureSelection(fixturePage);
  await popup.getByRole("button", { name: "Reader" }).click();
  await popup.getByRole("button", { name: "Extract now" }).click();
  await popup.getByLabel("Collection", { exact: true }).fill("notes");
  await popup
    .getByLabel("Relative path (optional)", { exact: true })
    .fill(relPath);
  await popup
    .getByLabel("Collision policy", { exact: true })
    .selectOption("error");
  await popup.getByRole("button", { name: "Server preview" }).click();
  await popup.locator(".preview").waitFor({ state: "visible" });
  await harness.stopResident();
  await popup.getByRole("button", { name: "Confirm capture" }).click();
  await popup.locator(".error").waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await popup.reload();
  await popup
    .getByRole("button", { name: "Retry saved write" })
    .waitFor({ state: "visible" });
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

  let worker = options.context.serviceWorkers()[0];
  if (!worker) throw new Error("Browser clipper service worker is missing");
  const first = await pendingState(worker);
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

  const restarted = await restartExtension(
    options.context,
    popup,
    options.extensionOrigin
  );
  popup = restarted.popup;
  worker = restarted.worker;
  await popup
    .getByRole("button", { name: "Retry saved write" })
    .waitFor({ state: "visible" });
  const afterRestart = await pendingState(worker);
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
  // trusted worker context; retry still crosses the real HTTP gateway.
  await restoreLocalState(worker, first.local);
  await popup.reload();
  recordStart = options.records.length;
  await popup.getByRole("button", { name: "Retry saved write" }).click();
  await waitForReceipt(popup, "created");
  const replay = await nextCaptureResponse(options.records, recordStart, 202);
  expect(replay.headers["idempotency-key"]).toBe(first.pending.idempotencyKey);
  expect(replay.responseHeaders["idempotent-replay"]).toBe("true");

  // Recreate the same exact saved write so Stop recovery exercises the popup
  // and worker discard boundary instead of a test-only controller seam.
  await restoreLocalState(worker, first.local);
  await popup.reload();
  await popup.getByRole("button", { name: "Stop recovery" }).click();
  await popup
    .getByRole("heading", { name: "Capture visible context" })
    .waitFor({ state: "visible" });
  expect((await readLocalState(worker)).pending).toBeNull();

  await createOfflinePending(
    popup,
    options.fixturePage,
    options.harness,
    "clips/recovery-conflict.md"
  );
  const conflict = await pendingState(worker);
  expect(conflict.pending.payload.destination.relPath).toBe(
    "clips/recovery-conflict.md"
  );
  await Bun.write(
    join(options.harness.collectionDir, "clips", "recovery-conflict.md"),
    "# Foreign exact-path content\n"
  );
  await options.harness.startResident();
  recordStart = options.records.length;
  await popup.getByRole("button", { name: "Retry saved write" }).click();
  await waitForReceipt(popup, "conflict");
  const conflictResponse = await nextCaptureResponse(
    options.records,
    recordStart,
    409
  );
  expect(conflictResponse.headers["idempotency-key"]).toBe(
    conflict.pending.idempotencyKey
  );
  expect((await readLocalState(worker)).pending).toBeNull();

  const conflictFiles: string[] = [];
  const glob = new Bun.Glob("recovery-conflict*.md");
  for await (const path of glob.scan({
    cwd: join(options.harness.collectionDir, "clips"),
  })) {
    conflictFiles.push(path);
  }
  expect(conflictFiles).toEqual(["recovery-conflict.md"]);
  return popup;
};
