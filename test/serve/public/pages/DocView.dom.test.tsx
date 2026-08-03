import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useRef } from "react";

import { extractSections } from "../../../../src/core/sections";
import { apiOk, renderWithUser, setTestLocation } from "../../../helpers/dom";

const apiFetch = mock(async (..._args: unknown[]) => apiOk<unknown>({}));

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
  MarkdownPreview: ({ content }: { content: string }) => (
    <div>
      {extractSections(content).map((section) => (
        <div
          data-section-anchor={section.anchor}
          id={section.anchor}
          key={section.anchor}
        />
      ))}
      <div>{content}</div>
    </div>
  ),
}));

void mock.module(
  "../../../../src/serve/public/components/FrontmatterDisplay",
  () => ({
    FrontmatterDisplay: ({ content }: { content: string }) => (
      <div>
        {content.includes("sources:") ? "Frontmatter card" : "No frontmatter"}
      </div>
    ),
    parseFrontmatter: (content: string) => {
      if (!content.startsWith("---")) {
        return { data: {}, body: content };
      }
      return {
        data: {
          tags: ["work"],
          sources: ["https://example.com"],
        },
        body: content.replace(/^---[\s\S]*?---\n\n/u, ""),
      };
    },
  })
);

// ── Isolated PdfViewer stub with mount identity tracking (B5-03) ──────────
// Module-level trackers reset per test via resetPdfViewerStubTrackers().

type MountEvent = {
  id: number;
  event: "mount" | "unmount";
  assetUrl: string;
};

const stubMountLog: MountEvent[] = [];
let stubMountSeq = 0;

function resetPdfViewerStubTrackers(): void {
  stubMountLog.length = 0;
  stubMountSeq = 0;
}

/**
 * Contained lazy PdfViewer mock via DocView-only re-export path so the real
 * components/pdf/PdfViewer suite is not sticky-mocked (fn-112.5 isolation).
 */
void mock.module("../../../../src/serve/public/pages/doc-pdf-viewer", () => ({
  default: function PdfViewerStub(props: {
    assetUrl: string | null;
    downloadUrl: string;
    extractedTextAvailable: boolean;
    onFallback: (reason: string) => void;
  }) {
    const mountIdRef = useRef<number | null>(null);
    if (mountIdRef.current === null) {
      stubMountSeq += 1;
      mountIdRef.current = stubMountSeq;
    }
    const mountId = mountIdRef.current;
    const asset = props.assetUrl ?? "";

    useEffect(() => {
      stubMountLog.push({ id: mountId, event: "mount", assetUrl: asset });
      return () => {
        stubMountLog.push({ id: mountId, event: "unmount", assetUrl: asset });
      };
    }, [mountId, asset]);

    return (
      <div
        data-asset-url={asset}
        data-download-url={props.downloadUrl}
        data-extracted={String(props.extractedTextAvailable)}
        data-mount-id={String(mountId)}
        data-testid="pdf-viewer-stub"
      >
        {(["corrupt", "password", "network", "bootstrap"] as const).map(
          (reason) => (
            <button
              data-testid={`stub-fallback-${reason}`}
              key={reason}
              onClick={() => {
                props.onFallback(reason);
              }}
              type="button"
            >
              fire-{reason}
            </button>
          )
        )}
      </div>
    );
  },
}));

type DocPayload = {
  docid?: string;
  uri: string;
  title?: string | null;
  content?: string | null;
  contentAvailable: boolean;
  collection?: string;
  relPath: string;
  tags?: string[];
  source: {
    absPath?: string;
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
    sourceHash?: string;
  };
  capabilities?: {
    editable: boolean;
    tagsEditable: boolean;
    tagsWriteback: boolean;
    canCreateEditableCopy: boolean;
    mode: "editable" | "read_only";
  };
};

function basePdf(overrides: Partial<DocPayload> = {}): DocPayload {
  const {
    source: sourceOverride,
    capabilities: capsOverride,
    ...rest
  } = overrides;
  return {
    docid: "pdf-1",
    uri: "gno://notes/nested/dir/report.pdf",
    title: "Report",
    content: "Extracted PDF body text.",
    contentAvailable: true,
    collection: "notes",
    relPath: "nested/dir/report.pdf",
    tags: [],
    ...rest,
    source: {
      mime: "application/pdf",
      ext: ".pdf",
      modifiedAt: "2026-07-31T10:00:00.000Z",
      sizeBytes: 4096,
      sourceHash: "pdf-hash",
      ...sourceOverride,
    },
    capabilities: {
      editable: false,
      tagsEditable: false,
      tagsWriteback: false,
      canCreateEditableCopy: false,
      mode: "read_only",
      ...capsOverride,
    },
  };
}

function mockDocApi(doc: DocPayload) {
  apiFetch.mockImplementation(async (...args: unknown[]) => {
    const endpoint = typeof args[0] === "string" ? args[0] : "";
    if (endpoint.startsWith("/api/doc?uri=")) {
      return apiOk({
        docid: doc.docid ?? "pdf-1",
        uri: doc.uri,
        title: doc.title ?? "Report",
        content: doc.content ?? null,
        contentAvailable: doc.contentAvailable,
        collection: doc.collection ?? "notes",
        relPath: doc.relPath,
        tags: doc.tags ?? [],
        source: doc.source,
        capabilities: doc.capabilities ?? {
          editable: false,
          tagsEditable: false,
          tagsWriteback: false,
          canCreateEditableCopy: false,
          mode: "read_only",
        },
      });
    }
    if (endpoint.includes("/links")) {
      return apiOk({ links: [] });
    }
    return apiOk({});
  });
}

describe("DocView DOM interactions", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    apiFetch.mockReset();
    setTestLocation("/doc?uri=file%3A%2F%2F%2Ftmp%2Fnotes%2Falpha.md");
  });

  test("edits tags with the shared TagInput flow and persists them", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      const options = args[1] as RequestInit | undefined;
      if (endpoint.startsWith("/api/doc?uri=")) {
        return apiOk({
          docid: "doc-1",
          uri: "file:///tmp/notes/alpha.md",
          title: "Alpha Note",
          content:
            "---\ntags:\n  - work\nsources:\n  - https://example.com\n---\n\n# Alpha Note\n\nSee [[Beta Note]].",
          contentAvailable: true,
          collection: "notes",
          relPath: "alpha.md",
          tags: ["work"],
          source: {
            mime: "text/markdown",
            ext: ".md",
            modifiedAt: "2026-04-03T10:00:00.000Z",
            sizeBytes: 120,
            sourceHash: "hash-1",
          },
          capabilities: {
            editable: true,
            tagsEditable: true,
            tagsWriteback: true,
            canCreateEditableCopy: false,
            mode: "editable",
          },
        });
      }
      if (endpoint === "/api/tags") {
        return apiOk({
          tags: [
            { tag: "work", count: 3 },
            { tag: "project/docs", count: 2 },
          ],
          meta: { total: 2 },
        });
      }
      if (endpoint === "/api/doc/doc-1/links?type=wiki") {
        return apiOk({
          links: [
            {
              targetRef: "Beta Note",
              targetRefNorm: "beta note",
              linkType: "wiki",
              startLine: 1,
              startCol: 1,
              endLine: 1,
              endCol: 12,
              source: "parsed",
              resolved: true,
              resolvedDocid: "#beta",
              resolvedUri: "gno://notes/Beta%20Note.md",
              resolvedTitle: "Beta Note",
            },
          ],
        });
      }
      if (endpoint === "/api/docs/doc-1" && options?.method === "PUT") {
        return apiOk({
          success: true,
          docId: "doc-1",
          uri: "file:///tmp/notes/alpha.md",
          path: "/tmp/notes/alpha.md",
          jobId: null,
          version: {
            sourceHash: "hash-2",
            modifiedAt: "2026-04-03T10:05:00.000Z",
          },
        });
      }
      return apiOk({});
    });

    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    const navigate = mock(() => undefined);
    const { user } = renderWithUser(<DocView navigate={navigate} />);

    await screen.findByRole("heading", { name: "Alpha Note" });
    expect(screen.getAllByText("Frontmatter card").length).toBeGreaterThan(0);
    // Markdown still uses Source/Rendered, not Pages/Text
    expect(screen.queryByTestId("pdf-pages-text-toggle")).toBeNull();
    expect(screen.queryByTestId("pdf-viewer-stub")).toBeNull();

    await user.click(screen.getAllByRole("button", { name: "Edit tags" })[0]!);
    const input = (
      await screen.findAllByRole("combobox", {
        name: "Edit document tags",
      })
    )[0]!;
    await user.click(input);
    await user.type(input, "proj");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");

    await user.click(screen.getAllByRole("button", { name: "Save" })[0]!);

    await waitFor(() => {
      expect(screen.getAllByText("Saved").length).toBeGreaterThan(0);
    });
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/docs/doc-1",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("project/docs"),
      })
    );
  });
});

describe("DocView PDF integration (fn-112.5)", () => {
  afterEach(() => {
    cleanup();
    resetPdfViewerStubTrackers();
  });

  beforeEach(() => {
    apiFetch.mockReset();
    resetPdfViewerStubTrackers();
  });

  test("mime/ext classification renders lazy PdfViewer stub with basename asset URL", async () => {
    const doc = basePdf({
      uri: "gno://notes/nested/dir/report.pdf",
      relPath: "nested/dir/report.pdf",
    });
    mockDocApi(doc);
    setTestLocation(`/doc?uri=${encodeURIComponent(doc.uri)}`);

    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    renderWithUser(<DocView navigate={mock(() => undefined)} />);

    const stub = await screen.findByTestId("pdf-viewer-stub");
    const expected = `/api/doc-asset?uri=${encodeURIComponent(doc.uri)}&path=${encodeURIComponent("report.pdf")}`;
    expect(stub.getAttribute("data-asset-url")).toBe(expected);
    expect(stub.getAttribute("data-download-url")).toBe(expected);
    expect(stub.getAttribute("data-extracted")).toBe("true");
    expect(screen.getByTestId("pdf-pages-text-toggle").textContent).toContain(
      "Text"
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("object")).toBeNull();
    expect(document.querySelector("embed")).toBeNull();
    expect(screen.getByTestId("pdf-header-download")).toBeTruthy();
  });

  test("case-insensitive Application/PDF and .PDF ext classify as PDF", async () => {
    const doc = basePdf({
      source: { mime: "Application/PDF", ext: ".PDF" },
    });
    mockDocApi(doc);
    setTestLocation(`/doc?uri=${encodeURIComponent(doc.uri)}`);
    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    renderWithUser(<DocView navigate={mock(() => undefined)} />);
    await screen.findByTestId("pdf-viewer-stub");
  });

  test("Pages/Text pill toggles branches; no viewer when Text", async () => {
    mockDocApi(basePdf());
    setTestLocation(
      `/doc?uri=${encodeURIComponent("gno://notes/nested/dir/report.pdf")}`
    );
    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    const { user } = renderWithUser(
      <DocView navigate={mock(() => undefined)} />
    );
    await screen.findByTestId("pdf-viewer-stub");
    await user.click(screen.getByTestId("pdf-pages-text-toggle"));
    await waitFor(() => {
      expect(screen.queryByTestId("pdf-viewer-stub")).toBeNull();
    });
    expect(screen.getByText("Extracted PDF body text.")).toBeTruthy();
    expect(screen.getByTestId("pdf-pages-text-toggle").textContent).toContain(
      "Pages"
    );
  });

  test("view=source and lineStart deep links land on Text", async () => {
    mockDocApi(basePdf());
    setTestLocation(
      `/doc?uri=${encodeURIComponent("gno://notes/nested/dir/report.pdf")}&view=source`
    );
    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    renderWithUser(<DocView navigate={mock(() => undefined)} />);
    await waitFor(() => {
      expect(screen.queryByTestId("pdf-viewer-stub")).toBeNull();
    });
    expect(screen.getByText("Extracted PDF body text.")).toBeTruthy();

    cleanup();
    mockDocApi(basePdf());
    setTestLocation(
      `/doc?uri=${encodeURIComponent("gno://notes/nested/dir/report.pdf")}&lineStart=2&lineEnd=4`
    );
    const { default: DocView2 } =
      await import("../../../../src/serve/public/pages/DocView");
    renderWithUser(<DocView2 navigate={mock(() => undefined)} />);
    await waitFor(() => {
      expect(screen.queryByTestId("pdf-viewer-stub")).toBeNull();
    });
    expect(screen.getByText("Extracted PDF body text.")).toBeTruthy();
  });

  test.each([
    [
      "corrupt",
      "CANNOT RENDER",
      "This PDF could not be rendered. View the extracted text or download the original.",
    ],
    [
      "password",
      "PASSWORD PROTECTED",
      "This PDF is password protected. Showing the extracted text instead. Download the original to open it in a PDF reader.",
    ],
    [
      "network",
      "COULD NOT LOAD",
      "The document could not be loaded from this session. Showing the extracted text instead. Switch to Pages to try again, or download the original.",
    ],
    [
      "bootstrap",
      "VIEWER UNAVAILABLE",
      "The PDF viewer could not start in this window. Showing the extracted text instead. Download the original to read it.",
    ],
  ] as const)(
    "fallback %s: exact notice, hook, download only, clears on Pages",
    async (reason, eyebrow, body) => {
      mockDocApi(basePdf());
      setTestLocation(
        `/doc?uri=${encodeURIComponent("gno://notes/nested/dir/report.pdf")}`
      );
      const { default: DocView } =
        await import("../../../../src/serve/public/pages/DocView");
      const { user } = renderWithUser(
        <DocView navigate={mock(() => undefined)} />
      );
      const stubA = await screen.findByTestId("pdf-viewer-stub");
      const idA = stubA.getAttribute("data-mount-id");
      expect(idA).toBeTruthy();
      await user.click(screen.getByTestId(`stub-fallback-${reason}`));

      const notice = await screen.findByTestId(`pdf-fallback-${reason}`);
      expect(notice.getAttribute("role")).toBe("status");
      expect(notice.textContent).toContain(eyebrow);
      expect(notice.textContent).toContain(body);
      expect(screen.getByTestId("pdf-notice-download").textContent).toContain(
        "Download original"
      );
      expect(screen.queryByTestId("pdf-action-retry")).toBeNull();
      expect(
        document.querySelectorAll('[data-testid^="pdf-fallback-"]')
      ).toHaveLength(1);
      // Mutual exclusion: no pdf-state-* alongside notice
      expect(
        document.querySelectorAll('[data-testid^="pdf-state-"]')
      ).toHaveLength(0);
      expect(screen.queryByTestId("pdf-viewer-stub")).toBeNull();
      const unmountedA = stubMountLog.some(
        (e) => e.id === Number(idA) && e.event === "unmount"
      );
      expect(unmountedA).toBe(true);

      // Toggle back to Pages clears notice and remounts a *fresh* instance B ≠ A
      await user.click(screen.getByTestId("pdf-pages-text-toggle"));
      const stubB = await screen.findByTestId("pdf-viewer-stub");
      const idB = stubB.getAttribute("data-mount-id");
      expect(idB).toBeTruthy();
      expect(idB).not.toBe(idA);
      expect(
        document.querySelectorAll('[data-testid^="pdf-fallback-"]')
      ).toHaveLength(0);
    }
  );

  test("B5-01: predicate-false spurious onFallback does not switch view or unmount viewer", async () => {
    const cases: Array<{
      label: string;
      partial: Partial<DocPayload>;
    }> = [
      {
        label: "contentAvailable false",
        partial: { contentAvailable: false, content: "x" },
      },
      {
        label: "content null",
        partial: { contentAvailable: true, content: null },
      },
      {
        label: "content empty",
        partial: { contentAvailable: true, content: "" },
      },
      {
        label: "whitespace only",
        partial: { contentAvailable: true, content: "  \n\t  " },
      },
    ];
    const reasons = ["corrupt", "password", "network", "bootstrap"] as const;

    for (const c of cases) {
      cleanup();
      resetPdfViewerStubTrackers();
      mockDocApi(basePdf(c.partial));
      setTestLocation(
        `/doc?uri=${encodeURIComponent("gno://notes/nested/dir/report.pdf")}`
      );
      const { default: DocView } =
        await import("../../../../src/serve/public/pages/DocView");
      const { user } = renderWithUser(
        <DocView navigate={mock(() => undefined)} />
      );
      const stub = await screen.findByTestId("pdf-viewer-stub");
      expect(stub.getAttribute("data-extracted")).toBe("false");
      const mountId = stub.getAttribute("data-mount-id");
      expect(mountId).toBeTruthy();

      // Spuriously invoke every reason — must not leave Pages
      for (const reason of reasons) {
        await user.click(screen.getByTestId(`stub-fallback-${reason}`));
      }

      // Same viewer instance remains mounted (no illegal Text transition)
      const still = screen.getByTestId("pdf-viewer-stub");
      expect(still.getAttribute("data-mount-id")).toBe(mountId);
      expect(screen.queryByTestId("pdf-no-extracted-text")).toBeNull();
      expect(
        screen.queryByText(
          /Content not available \(document may need re-indexing\)/u
        )
      ).toBeNull();
      expect(
        document.querySelectorAll('[data-testid^="pdf-fallback-"]')
      ).toHaveLength(0);
      // Pill still offers Text as the *target* (currently on Pages)
      expect(screen.getByTestId("pdf-pages-text-toggle").textContent).toContain(
        "Text"
      );
      // No unmount of this instance from the spurious callbacks
      expect(
        stubMountLog.some(
          (e) => e.id === Number(mountId) && e.event === "unmount"
        )
      ).toBe(false);
    }
  });

  test("predicate true + manual empty Text: no extracted sub-state, zero fallbacks", async () => {
    mockDocApi(
      basePdf({
        contentAvailable: true,
        content: "   ",
      })
    );
    setTestLocation(
      `/doc?uri=${encodeURIComponent("gno://notes/nested/dir/report.pdf")}`
    );
    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    const { user } = renderWithUser(
      <DocView navigate={mock(() => undefined)} />
    );
    const stub = await screen.findByTestId("pdf-viewer-stub");
    expect(stub.getAttribute("data-extracted")).toBe("false");
    await user.click(screen.getByTestId("pdf-pages-text-toggle"));
    expect(screen.getByTestId("pdf-no-extracted-text").textContent).toContain(
      "No extracted text for this document."
    );
    expect(
      document.querySelectorAll('[data-testid^="pdf-fallback-"]')
    ).toHaveLength(0);
    // Download still reachable
    expect(
      screen.getAllByText("Download original").length
    ).toBeGreaterThanOrEqual(1);
  });

  test("asset URL: nested, recordSourcePath-shaped, container, same-basename sibling uris", async () => {
    const cases = [
      {
        uri: "gno://notes/nested/dir/report.pdf",
        relPath: "nested/dir/report.pdf",
        path: "report.pdf",
      },
      {
        uri: "gno://notes/imports/container/doc.pdf",
        relPath: "imports/container/doc.pdf",
        path: "doc.pdf",
      },
      {
        uri: "gno://notes/container-backed/source.pdf",
        relPath: "container-backed/source.pdf",
        path: "source.pdf",
      },
      {
        uri: "gno://notes/dir1/report.pdf",
        relPath: "dir1/report.pdf",
        path: "report.pdf",
      },
      {
        uri: "gno://notes/dir2/report.pdf",
        relPath: "dir2/report.pdf",
        path: "report.pdf",
      },
    ];
    const seen = new Map<string, string>();
    for (const c of cases) {
      cleanup();
      mockDocApi(basePdf({ uri: c.uri, relPath: c.relPath }));
      setTestLocation(`/doc?uri=${encodeURIComponent(c.uri)}`);
      const { default: DocView } =
        await import("../../../../src/serve/public/pages/DocView");
      renderWithUser(<DocView navigate={mock(() => undefined)} />);
      const stub = await screen.findByTestId("pdf-viewer-stub");
      const asset = stub.getAttribute("data-asset-url") ?? "";
      const u = new URL(asset, "http://localhost");
      expect(u.searchParams.get("path")).toBe(c.path);
      expect(u.searchParams.get("uri")).toBe(c.uri);
      seen.set(c.uri, asset);
    }
    // Same basename, different uri → different full endpoint (uri anchors dir)
    expect(seen.get("gno://notes/dir1/report.pdf")).not.toBe(
      seen.get("gno://notes/dir2/report.pdf")
    );
    expect(seen.get("gno://notes/dir1/report.pdf")).toContain(
      "path=report.pdf"
    );
    expect(seen.get("gno://notes/dir2/report.pdf")).toContain(
      "path=report.pdf"
    );
  });

  test("B5-03: App-equivalent location key remount unmounts A and mounts B with new asset URL", async () => {
    // App remount contract (src/serve/public/app.tsx):
    //   const pageKey = basePath === "/browse" ? basePath : location;
    //   <Page key={pageKey} ... />
    // So /doc?uri=A → /doc?uri=B fully remounts DocView.
    const uriA = "gno://notes/dir1/report.pdf";
    const uriB = "gno://notes/dir2/report.pdf";
    const docA = basePdf({
      uri: uriA,
      relPath: "dir1/report.pdf",
      content: "Text A",
    });
    const docB = basePdf({
      uri: uriB,
      relPath: "dir2/report.pdf",
      content: "Text B",
    });

    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const endpoint = typeof args[0] === "string" ? args[0] : "";
      if (endpoint.startsWith("/api/doc?uri=")) {
        const q = new URL(endpoint, "http://localhost");
        const uri = q.searchParams.get("uri") ?? "";
        const doc = uri === uriB ? docB : docA;
        return apiOk({
          docid: doc.docid ?? "pdf-1",
          uri: doc.uri,
          title: doc.title ?? "Report",
          content: doc.content ?? null,
          contentAvailable: doc.contentAvailable,
          collection: doc.collection ?? "notes",
          relPath: doc.relPath,
          tags: doc.tags ?? [],
          source: doc.source,
          capabilities: doc.capabilities,
        });
      }
      if (endpoint.includes("/links")) {
        return apiOk({ links: [] });
      }
      return apiOk({});
    });

    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");

    // Mount A (fallback to Text to prove notice clears on navigation remount)
    setTestLocation(`/doc?uri=${encodeURIComponent(uriA)}`);
    const { user, rerender } = renderWithUser(
      <DocView
        key={`/doc?uri=${encodeURIComponent(uriA)}`}
        navigate={mock(() => undefined)}
      />
    );
    const stubA = await screen.findByTestId("pdf-viewer-stub");
    const idA = stubA.getAttribute("data-mount-id");
    expect(idA).toBeTruthy();
    expect(stubA.getAttribute("data-asset-url")).toContain(
      encodeURIComponent(uriA)
    );
    await user.click(screen.getByTestId("stub-fallback-corrupt"));
    await screen.findByTestId("pdf-fallback-corrupt");
    expect(screen.queryByTestId("pdf-viewer-stub")).toBeNull();

    // Navigate to B with App-equivalent key change (full DocView remount)
    setTestLocation(`/doc?uri=${encodeURIComponent(uriB)}`);
    rerender(
      <DocView
        key={`/doc?uri=${encodeURIComponent(uriB)}`}
        navigate={mock(() => undefined)}
      />
    );

    const stubB = await screen.findByTestId("pdf-viewer-stub");
    const idB = stubB.getAttribute("data-mount-id");
    expect(idB).toBeTruthy();
    expect(idB).not.toBe(idA);
    expect(stubB.getAttribute("data-asset-url")).toContain(
      encodeURIComponent(uriB)
    );
    expect(stubB.getAttribute("data-asset-url")).not.toContain(
      encodeURIComponent(uriA)
    );
    // Old fallback notice/state must not survive remount
    expect(screen.queryByTestId("pdf-fallback-corrupt")).toBeNull();
    expect(
      document.querySelectorAll('[data-testid^="pdf-fallback-"]')
    ).toHaveLength(0);
    // A unmounted
    expect(
      stubMountLog.some((e) => e.id === Number(idA) && e.event === "unmount")
    ).toBe(true);
    expect(
      stubMountLog.some((e) => e.id === Number(idB) && e.event === "mount")
    ).toBe(true);
  });

  test("content not available remains distinct from no-extracted-text", async () => {
    mockDocApi(
      basePdf({
        contentAvailable: false,
        content: null,
      })
    );
    setTestLocation(
      `/doc?uri=${encodeURIComponent("gno://notes/nested/dir/report.pdf")}`
    );
    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    const { user } = renderWithUser(
      <DocView navigate={mock(() => undefined)} />
    );
    await screen.findByTestId("pdf-viewer-stub");
    await user.click(screen.getByTestId("pdf-pages-text-toggle"));
    expect(
      screen.getByText(
        /Content not available \(document may need re-indexing\)/u
      )
    ).toBeTruthy();
    expect(screen.queryByTestId("pdf-no-extracted-text")).toBeNull();
  });
});

const SECTION_OUTLINE_URI = "gno://work/notes/pilot.md";
const SECTION_OUTLINE_CONTENT = [
  "# Guide",
  "",
  "## Setup",
  "",
  "Install Bun first.",
  "Then run tests.",
  "",
  "## Usage",
  "",
  "Call createSectionTarget.",
].join("\n");

function mockSectionOutlineDoc() {
  apiFetch.mockImplementation(async (...args: unknown[]) => {
    const endpoint = typeof args[0] === "string" ? args[0] : "";
    if (endpoint.startsWith("/api/doc?uri=")) {
      return apiOk({
        docid: "outline-1",
        uri: SECTION_OUTLINE_URI,
        title: "Guide",
        content: SECTION_OUTLINE_CONTENT,
        contentAvailable: true,
        collection: "work",
        relPath: "notes/pilot.md",
        tags: [],
        source: {
          mime: "text/markdown",
          ext: ".md",
          modifiedAt: "2026-08-03T10:00:00.000Z",
          sizeBytes: 180,
          sourceHash: "outline-hash",
        },
        capabilities: {
          editable: true,
          tagsEditable: true,
          tagsWriteback: true,
          canCreateEditableCopy: false,
          mode: "editable",
        },
      });
    }
    if (endpoint.includes("/links")) {
      return apiOk({ links: [] });
    }
    return apiOk({});
  });
}

function installClipboardMock(writeText: (text: string) => Promise<void>) {
  const clipboard = window.navigator.clipboard as {
    writeText: (text: string) => Promise<void>;
    readText: () => Promise<string>;
  };
  const previousWriteText = clipboard.writeText.bind(clipboard);
  const calls: string[] = [];
  clipboard.writeText = async (text: string) => {
    calls.push(text);
    await writeText(text);
  };
  return {
    calls,
    restore: () => {
      clipboard.writeText = previousWriteText;
    },
  };
}

describe("DocView outline section links (fn-61.7)", () => {
  let restoreClipboard: (() => void) | null = null;

  afterEach(() => {
    restoreClipboard?.();
    restoreClipboard = null;
    cleanup();
  });

  beforeEach(() => {
    apiFetch.mockReset();
    mockSectionOutlineDoc();
    setTestLocation(
      `/doc?uri=${encodeURIComponent(SECTION_OUTLINE_URI)}&view=rendered`
    );
  });

  test("outline exposes readable and citation controls with distinct copy payloads", async () => {
    const clipboard = installClipboardMock(async () => undefined);
    restoreClipboard = clipboard.restore;

    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    const { user } = renderWithUser(
      <DocView navigate={mock(() => undefined)} />
    );

    await screen.findByText("Outline");
    const readable = await screen.findByRole("button", {
      name: "Copy link to Setup",
    });
    const citation = screen.getByRole("button", {
      name: "Copy local citation link to Setup",
    });
    expect(readable).toBeTruthy();
    expect(citation).toBeTruthy();

    await user.click(readable);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Copied section link"
      );
    });
    expect(clipboard.calls).toHaveLength(1);
    expect(clipboard.calls[0]).toContain("#setup");
    expect(clipboard.calls[0]).not.toContain("st=");

    await user.click(citation);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Copied citation link"
      );
    });
    expect(clipboard.calls).toHaveLength(2);
    expect(clipboard.calls[1]).toContain("#setup");
    expect(clipboard.calls[1]).toMatch(/[?&]st=1\./u);
    expect(clipboard.calls[1]!.length).toBeLessThan(4000);
  });

  test("clipboard rejection shows unavailable feedback without copied-success", async () => {
    const clipboard = installClipboardMock(async () => {
      throw new Error("clipboard denied");
    });
    restoreClipboard = clipboard.restore;

    const { default: DocView } =
      await import("../../../../src/serve/public/pages/DocView");
    const { user } = renderWithUser(
      <DocView navigate={mock(() => undefined)} />
    );

    await screen.findByText("Outline");
    await user.click(
      await screen.findByRole("button", { name: "Copy link to Setup" })
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Could not copy link"
      );
    });
    expect(clipboard.calls).toHaveLength(1);
    expect(screen.queryByText("Copied section link")).toBeNull();
    expect(screen.queryByText("Copied citation link")).toBeNull();
  });

  test("invalid citation selector blocks hash navigation at the DocView boundary", async () => {
    const scrolledIds: string[] = [];
    const proto = window.HTMLElement.prototype;
    const originalScrollDescriptor = Object.getOwnPropertyDescriptor(
      proto,
      "scrollIntoView"
    );
    proto.scrollIntoView = function scrollIntoViewSpy(
      this: HTMLElement,
      ..._args: unknown[]
    ) {
      if (this.id) {
        scrolledIds.push(this.id);
      }
    };

    try {
      setTestLocation(
        `/doc?uri=${encodeURIComponent(SECTION_OUTLINE_URI)}&view=rendered&st=1.not-valid-base64!!!#setup`
      );

      const { default: DocView } =
        await import("../../../../src/serve/public/pages/DocView");
      renderWithUser(<DocView navigate={mock(() => undefined)} />);

      await screen.findByText("Outline");
      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toBe(
          "Invalid section citation — not navigating"
        );
      });

      // Flush any pending rAF scroll attempts from mount effects.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      });

      expect(scrolledIds).not.toContain("setup");
      expect(window.location.search).toContain("st=1.not-valid-base64");
      expect(window.location.hash).toBe("#setup");
    } finally {
      if (originalScrollDescriptor) {
        Object.defineProperty(
          proto,
          "scrollIntoView",
          originalScrollDescriptor
        );
      }
    }
  });
});
