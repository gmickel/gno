import { extractVisiblePage } from "./extract";

const MARKER = "__gnoBrowserClipperInstalled";
const target = globalThis as typeof globalThis & Record<string, unknown>;

if (target[MARKER] !== true) {
  target[MARKER] = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      message !== null &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "GNO_CLIPPER_EXTRACT"
    ) {
      sendResponse({ ok: true, extraction: extractVisiblePage() });
    }
  });
}
