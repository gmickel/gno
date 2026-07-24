import type { ExtractionResult } from "./types";

import { ClipperController } from "./controller";

const extractFromActiveTab = async (): Promise<ExtractionResult> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("No active browser tab found.");
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });
  const response = (await chrome.tabs.sendMessage(tab.id, {
    type: "GNO_CLIPPER_EXTRACT",
  })) as { ok?: unknown; extraction?: unknown };
  if (response?.ok !== true || !response.extraction) {
    throw new Error("Visible page extraction failed.");
  }
  return response.extraction as ExtractionResult;
};

void chrome.storage.local.setAccessLevel?.({
  accessLevel: "TRUSTED_CONTEXTS",
});

const controller = new ClipperController({
  local: chrome.storage.local,
  session: chrome.storage.session,
  extensionOrigin: `chrome-extension://${chrome.runtime.id}`,
  openApproval: async (url) => {
    await chrome.tabs.create({ url });
  },
  extract: extractFromActiveTab,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomKey: () => crypto.randomUUID(),
});

const handleMessage = async (message: unknown): Promise<unknown> => {
  if (message === null || typeof message !== "object") {
    throw new Error("Invalid browser clipper message");
  }
  const input = message as Record<string, unknown>;
  switch (input.type) {
    case "STATE":
      return controller.state();
    case "START_PAIR":
      return controller.startPair(
        typeof input.gatewayOrigin === "string" ? input.gatewayOrigin : ""
      );
    case "POLL_PAIR":
      return controller.pollPair();
    case "EXTRACT":
      return controller.extract();
    case "PREVIEW":
      return controller.preview(input.payload as never);
    case "CAPTURE":
      return controller.capture(
        input.payload as never,
        typeof input.previewDigest === "string" ? input.previewDigest : ""
      );
    case "RESUME_PENDING":
      return controller.resumePending();
    case "DISCARD_PENDING":
      await controller.discardPending();
      return { discarded: true };
    case "REVOKE":
      await controller.revoke();
      return { revoked: true };
    default:
      throw new Error("Unsupported browser clipper message");
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) =>
      sendResponse({
        ok: false,
        error: {
          code:
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "CLIPPER_CLIENT",
          message: error instanceof Error ? error.message : "Clipper failed",
        },
      })
  );
  return true;
});
