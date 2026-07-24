import type {
  ExtractionResult,
  InlineNode,
  ReaderBlock,
  WarningCode,
} from "./types";

const EXCLUDED = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "FORM",
  "NAV",
  "ASIDE",
  "IFRAME",
  "EMBED",
  "OBJECT",
  "IMG",
  "PICTURE",
  "VIDEO",
  "AUDIO",
  "CANVAS",
  "SVG",
  "MATH",
]);

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,blockquote,ol,ul,pre,hr";

const meta = (names: readonly string[]): string | null => {
  for (const name of names) {
    const value = document
      .querySelector<HTMLMetaElement>(
        `meta[name="${name}"],meta[property="${name}"]`
      )
      ?.content.trim();
    if (value) return value;
  }
  return null;
};

const hasLayout = (): boolean =>
  (document.body?.getClientRects().length ?? 0) > 0;

const rendered = (element: Element): boolean => {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      EXCLUDED.has(current.tagName) ||
      current.hasAttribute("hidden") ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = globalThis.getComputedStyle?.(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse" ||
      style?.opacity === "0" ||
      style?.contentVisibility === "hidden"
    ) {
      return false;
    }
  }
  return !hasLayout() || element.getClientRects().length > 0;
};

const visibleText = (parent: Element, warnings: Set<WarningCode>): string => {
  let text = "";
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentElement && rendered(node.parentElement)) {
        text += node.textContent ?? "";
      }
      return;
    }
    if (
      !(node instanceof Element) ||
      EXCLUDED.has(node.tagName) ||
      !rendered(node)
    ) {
      if (node instanceof Element) warnings.add("reader_partial");
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of parent.childNodes) visit(child);
  return text;
};

const inlineNodes = (
  parent: Element,
  warnings: Set<WarningCode>
): InlineNode[] => {
  const nodes: InlineNode[] = [];
  const appendText = (text: string) => {
    if (text.length === 0) return;
    const previous = nodes.at(-1);
    if (previous?.type === "text") previous.text += text;
    else nodes.push({ type: "text", text });
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (
      !(node instanceof Element) ||
      EXCLUDED.has(node.tagName) ||
      !rendered(node)
    ) {
      if (node instanceof Element) warnings.add("reader_partial");
      return;
    }
    if (node.tagName === "A") {
      const anchor = node as HTMLAnchorElement;
      const text = visibleText(anchor, warnings);
      if (text.trim().length === 0) {
        warnings.add("reader_partial");
        return;
      }
      if (/^https?:\/\//iu.test(anchor.href)) {
        nodes.push({ type: "link", text, href: anchor.href });
      } else {
        appendText(text);
        warnings.add("reader_partial");
      }
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of parent.childNodes) visit(child);
  return nodes.filter(
    (node) => node.type === "link" || node.text.trim().length > 0
  );
};

const blockFor = (
  element: Element,
  warnings: Set<WarningCode>
): ReaderBlock | null => {
  if (!rendered(element)) return null;
  const tag = element.tagName;
  if (/^H[1-6]$/u.test(tag)) {
    return {
      type: "heading",
      level: Number(tag.slice(1)),
      content: inlineNodes(element, warnings),
    };
  }
  if (tag === "P") {
    return { type: "paragraph", content: inlineNodes(element, warnings) };
  }
  if (tag === "BLOCKQUOTE") {
    return { type: "quote", content: inlineNodes(element, warnings) };
  }
  if (tag === "HR") return { type: "horizontal_rule" };
  if (tag === "PRE") {
    const language =
      element
        .querySelector("code")
        ?.className.match(/language-(\w[\w+-]*)/u)?.[1] ?? null;
    return { type: "code", language, text: visibleText(element, warnings) };
  }
  if (tag === "OL" || tag === "UL") {
    const items = [...element.children]
      .filter((child) => child.tagName === "LI" && rendered(child))
      .map((child) => inlineNodes(child, warnings))
      .filter((item) => item.length > 0);
    return items.length > 0
      ? { type: "list", ordered: tag === "OL", items }
      : null;
  }
  return null;
};

const selectionIsVisible = (selection: Selection): boolean => {
  if (selection.rangeCount < 1 || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!container || !rendered(container)) return false;
    if (hasLayout() && range.getClientRects().length === 0) return false;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (
        range.intersectsNode(node) &&
        node.textContent?.length &&
        (!node.parentElement || !rendered(node.parentElement))
      ) {
        return false;
      }
      node = walker.nextNode();
    }
  }
  return true;
};

const visibleSelectionText = (warnings: Set<WarningCode>): string | null => {
  const selection = globalThis.getSelection?.();
  if (!selection) return null;
  const text = selection.toString();
  if (!text) return null;
  if (!selectionIsVisible(selection)) {
    warnings.add("reader_partial");
    return null;
  }
  return text;
};

export const extractVisiblePage = (): ExtractionResult => {
  const warnings = new Set<WarningCode>();
  if (
    document.querySelector(
      "iframe,img,picture,video,audio,canvas,embed,object,svg,math"
    )
  ) {
    warnings.add("reader_partial");
  }
  if (globalThis.history.state !== null) warnings.add("spa_snapshot");

  const root =
    [...document.querySelectorAll("article,main,[role='main']")].find(
      rendered
    ) ?? document.body;
  const readerBlocks = [...root.querySelectorAll(BLOCK_SELECTOR)]
    .filter(
      (element) =>
        !element.parentElement?.closest("ol,ul,pre") ||
        element.parentElement === root
    )
    .map((element) => blockFor(element, warnings))
    .filter((block): block is ReaderBlock => block !== null)
    .filter(
      (block) =>
        block.type === "horizontal_rule" ||
        block.type === "code" ||
        ("content" in block ? block.content.length > 0 : block.items.length > 0)
    );
  const selectionText = visibleSelectionText(warnings);
  const canonicalHref =
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ??
    null;
  if (canonicalHref && canonicalHref !== location.href) {
    warnings.add("canonical_url_differs");
  }

  return {
    sourceUrl: location.href,
    canonicalUrl: canonicalHref,
    title: document.title || location.hostname,
    author: meta(["author", "article:author"]),
    site: meta(["og:site_name", "application-name"]),
    publishedAt: meta(["article:published_time", "datePublished", "date"]),
    observedAt: new Date().toISOString(),
    browser: {
      name: "Chromium",
      version: null,
      platform: navigator.platform || null,
    },
    warnings: [...warnings],
    selectionText,
    readerBlocks,
  };
};
