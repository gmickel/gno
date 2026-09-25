import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { withoutHostPaths } from "../../../../src/core/host-paths";
import {
  apiError,
  apiOk,
  renderWithUser,
  setTestLocation,
} from "../../../helpers/dom";

type ApiResult = { data: unknown; error: string | null };

const apiFetch = mock(
  async (..._args: unknown[]): Promise<ApiResult> => apiOk<unknown>({})
);

void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

void mock.module("../../../../src/serve/public/hooks/use-doc-events", () => ({
  useDocEvents: () => null,
}));

void mock.module(
  "../../../../src/serve/public/components/BacklinksPanel",
  () => ({
    BacklinksPanel: () => null,
  })
);

void mock.module(
  "../../../../src/serve/public/components/OutgoingLinksPanel",
  () => ({
    OutgoingLinksPanel: () => null,
  })
);

void mock.module(
  "../../../../src/serve/public/components/RelatedNotesSidebar",
  () => ({
    RelatedNotesSidebar: () => null,
  })
);

void mock.module("../../../../src/serve/public/components/editor", () => ({
  // Module mocks are process-wide: keep every export later suites import.
  CodeMirrorEditor: () => null,
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));

// Contained DocView-only mocks so the real suites are not sticky-mocked
// (fn-123.2 / fn-112.5 isolation).
void mock.module(
  "../../../../src/serve/public/pages/doc-frontmatter-display",
  () => ({
    FrontmatterDisplay: () => <div>No frontmatter</div>,
    parseFrontmatter: (content: string) => ({ data: {}, body: content }),
  })
);

void mock.module("../../../../src/serve/public/pages/doc-pdf-viewer", () => ({
  default: function PdfViewerStub() {
    return <div data-testid="pdf-viewer-stub" />;
  },
}));

type CapabilitiesMode = "local" | "remote" | "failure";

interface DocFixture {
  uri: string;
  relPath: string;
  source: { absPath?: string; mime: string; ext: string };
  editable: boolean;
}

const PDF_URI = "gno://notes/report.pdf";
const MD_URI = "gno://notes/alpha.md";

const readOnlyPdf: DocFixture = {
  uri: PDF_URI,
  relPath: "report.pdf",
  source: {
    absPath: "/srv/notes/report.pdf",
    mime: "application/pdf",
    ext: ".pdf",
  },
  editable: false,
};

const editableMarkdown: DocFixture = {
  uri: MD_URI,
  relPath: "alpha.md",
  source: { absPath: "/srv/notes/alpha.md", mime: "text/markdown", ext: ".md" },
  editable: true,
};

const readOnlyImage: DocFixture = {
  uri: "gno://notes/diagram.png",
  relPath: "diagram.png",
  source: {
    absPath: "/srv/notes/diagram.png",
    mime: "image/png",
    ext: ".png",
  },
  editable: false,
};

function mockApi(doc: DocFixture, capabilities: CapabilitiesMode) {
  apiFetch.mockImplementation(async (...args: unknown[]) => {
    const endpoint = typeof args[0] === "string" ? args[0] : "";
    if (endpoint === "/api/capabilities") {
      if (capabilities === "failure") {
        return apiError("Network error");
      }
      return apiOk({
        bm25: true,
        vector: false,
        hybrid: false,
        answer: false,
        localClient: capabilities === "local",
      });
    }
    if (endpoint.startsWith("/api/doc?uri=")) {
      return apiOk({
        docid: "doc-1",
        uri: doc.uri,
        title: "Doc",
        content: "Body text.",
        contentAvailable: true,
        collection: "notes",
        relPath: doc.relPath,
        tags: [],
        source: {
          // The server strips host paths for a caller it judges remote.
          ...(capabilities === "remote"
            ? withoutHostPaths(doc.source)
            : doc.source),
          modifiedAt: "2026-07-31T10:00:00.000Z",
          sizeBytes: 4096,
          sourceHash: "hash-1",
        },
        capabilities: {
          editable: doc.editable,
          tagsEditable: doc.editable,
          tagsWriteback: doc.editable,
          canCreateEditableCopy: !doc.editable,
          mode: doc.editable ? "editable" : "read_only",
        },
      });
    }
    if (endpoint.includes("/links")) {
      return apiOk({ links: [] });
    }
    return apiOk({});
  });
}

async function renderDoc(doc: DocFixture, capabilities: CapabilitiesMode) {
  mockApi(doc, capabilities);
  setTestLocation(`/doc?uri=${encodeURIComponent(doc.uri)}`);
  const { default: DocView } =
    await import("../../../../src/serve/public/pages/DocView");
  renderWithUser(<DocView navigate={mock(() => undefined)} />);
  await screen.findByText("Doc");
  await waitFor(() => {
    expect(
      apiFetch.mock.calls.some((call) => call[0] === "/api/capabilities")
    ).toBe(true);
  });
}

function openOriginal(): HTMLAnchorElement | null {
  return screen.queryByTestId("doc-open-original") as HTMLAnchorElement | null;
}

describe("DocView locality-aware actions", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    apiFetch.mockReset();
  });

  test("local client: read-only Reveal site and file:// Open original render", async () => {
    await renderDoc(readOnlyPdf, "local");

    await screen.findByTestId("doc-reveal");
    expect(screen.getAllByTestId("doc-reveal")).toHaveLength(1);
    const link = openOriginal();
    expect(link?.getAttribute("href")).toBe("file:///srv/notes/report.pdf");
    expect(screen.getByTestId("pdf-header-download")).toBeTruthy();
  });

  test("local client: editable Reveal site renders", async () => {
    await renderDoc(editableMarkdown, "local");

    await screen.findByTestId("doc-reveal");
    expect(screen.getAllByTestId("doc-reveal")).toHaveLength(1);
  });

  test("remote client: Reveal hidden, Open original is an inline asset link, Download unchanged", async () => {
    await renderDoc(readOnlyPdf, "remote");

    const link = openOriginal();
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toMatch(/^\/api\/doc-asset\?/);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
    expect(screen.queryByTestId("doc-reveal")).toBeNull();
    const download = screen.getByTestId("pdf-header-download");
    expect(download.getAttribute("href")).toBe(
      link?.getAttribute("href") ?? ""
    );
    expect(download.hasAttribute("download")).toBe(true);
  });

  test("remote client: non-PDF read-only source keeps an inline Open original", async () => {
    await renderDoc(readOnlyImage, "remote");

    const link = openOriginal();
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toMatch(/^\/api\/doc-asset\?/);
    expect(link?.getAttribute("href")).toContain(
      encodeURIComponent("gno://notes/diagram.png")
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
    expect(screen.queryByTestId("doc-reveal")).toBeNull();
    // Download original stays a PDF-only affordance.
    expect(screen.queryByTestId("pdf-header-download")).toBeNull();
  });

  test("remote client: editable document shows no Reveal", async () => {
    await renderDoc(editableMarkdown, "remote");

    expect(screen.queryByTestId("doc-reveal")).toBeNull();
    expect(openOriginal()).toBeNull();
  });

  test("capabilities fetch failure treats the client as remote", async () => {
    await renderDoc(readOnlyPdf, "failure");

    expect(screen.queryByTestId("doc-reveal")).toBeNull();
    expect(openOriginal()?.getAttribute("href")).toMatch(/^\/api\/doc-asset\?/);
  });

  test("header action row wraps so a 375px viewport does not clip actions", async () => {
    await renderDoc(readOnlyPdf, "remote");

    const actions = await screen.findByTestId("doc-header-actions");
    expect(actions.className).toContain("flex-wrap");
    expect(actions.className).toContain("min-w-0");
    expect(openOriginal()).not.toBeNull();
    expect(screen.getByTestId("pdf-header-download")).toBeTruthy();
  });
});
