import { afterEach, beforeEach } from "bun:test";
import { GlobalWindow } from "happy-dom";

const windowInstance = new GlobalWindow({
  url: "http://localhost/",
  width: 1280,
  height: 800,
});

function bindGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

bindGlobal("window", windowInstance);
bindGlobal("self", windowInstance);
bindGlobal("document", windowInstance.document);
bindGlobal("Document", windowInstance.Document);
bindGlobal("DocumentFragment", windowInstance.DocumentFragment);
bindGlobal("history", windowInstance.history);
bindGlobal("location", windowInstance.location);
bindGlobal("navigator", windowInstance.navigator);
bindGlobal("localStorage", windowInstance.localStorage);
bindGlobal("sessionStorage", windowInstance.sessionStorage);
bindGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
}));
bindGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
  setTimeout(() => callback(performance.now()), 0)
);
bindGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
bindGlobal("ResizeObserver", windowInstance.ResizeObserver);
bindGlobal("IntersectionObserver", windowInstance.IntersectionObserver);
bindGlobal("MutationObserver", windowInstance.MutationObserver);
bindGlobal("DOMRect", windowInstance.DOMRect);
bindGlobal("DOMParser", windowInstance.DOMParser);
bindGlobal("HTMLElement", windowInstance.HTMLElement);
bindGlobal("Element", windowInstance.Element);
bindGlobal("Node", windowInstance.Node);
bindGlobal("Text", windowInstance.Text);
bindGlobal("Event", windowInstance.Event);
bindGlobal("EventTarget", windowInstance.EventTarget);
bindGlobal("CustomEvent", windowInstance.CustomEvent);
bindGlobal("FocusEvent", windowInstance.FocusEvent);
bindGlobal("InputEvent", windowInstance.InputEvent);
bindGlobal("KeyboardEvent", windowInstance.KeyboardEvent);
bindGlobal("MouseEvent", windowInstance.MouseEvent);
bindGlobal("PointerEvent", windowInstance.PointerEvent);
bindGlobal("SubmitEvent", windowInstance.SubmitEvent);
bindGlobal(
  "getComputedStyle",
  windowInstance.getComputedStyle.bind(windowInstance)
);
bindGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const { cleanup } = await import("@testing-library/react");

Object.defineProperty(windowInstance.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async () => undefined,
    readText: async () => "",
  },
});

windowInstance.HTMLElement.prototype.scrollIntoView = () => undefined;
windowInstance.HTMLElement.prototype.hasPointerCapture = () => false;
windowInstance.HTMLElement.prototype.releasePointerCapture = () => undefined;
windowInstance.HTMLElement.prototype.setPointerCapture = () => undefined;

beforeEach(() => {
  windowInstance.document.body.innerHTML = "";
  windowInstance.document.head.innerHTML = "";
  windowInstance.history.replaceState({}, "", "/");
  windowInstance.localStorage.clear();
  windowInstance.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  windowInstance.document.body.innerHTML = "";
});
