import type { CaptureDestinationDetails } from "./contracts";
import type { ExtractionResult } from "./types";

import { captureDestinationDetailsSchema } from "./contracts";
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
      return controller.acceptStartedPair(
        typeof input.gatewayOrigin === "string" ? input.gatewayOrigin : "",
        input.started as never
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

/**
 * Carry the structured refusal reason across the message boundary.
 *
 * The service worker is the last hop where `details` still exists as an object;
 * dropping it here would leave every reader - popup, preview UI - with prose
 * only. Re-validating keeps the serialized shape exactly the wire shape rather
 * than whatever an arbitrary thrown value happens to hang off `details`.
 */
const errorDetails = (error: unknown): CaptureDestinationDetails | null => {
  if (error === null || typeof error !== "object" || !("details" in error)) {
    return null;
  }
  const parsed = captureDestinationDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => {
      const details = errorDetails(error);
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
          ...(details ? { details } : {}),
        },
      });
    }
  );
  return true;
});
