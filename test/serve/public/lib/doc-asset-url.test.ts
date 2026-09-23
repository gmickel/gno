import { describe, expect, test } from "bun:test";
import { join, dirname, resolve } from "node:path";

import {
  assetPathFromRelPath,
  buildDocAssetUrl,
  isExtractedTextAvailable,
  isPdfDocument,
} from "../../../../src/serve/public/lib/doc-asset-url";

describe("doc-asset-url (fn-112 task .5 N5)", () => {
  test("assetPathFromRelPath uses basename only", () => {
    expect(assetPathFromRelPath("nested/dir/report.pdf")).toBe("report.pdf");
    expect(assetPathFromRelPath("report.pdf")).toBe("report.pdf");
    expect(assetPathFromRelPath("container/source/docs/a.pdf")).toBe("a.pdf");
    expect(assetPathFromRelPath("win\\style\\path.pdf")).toBe("path.pdf");
  });

  test("buildDocAssetUrl encodes uri and basename path", () => {
    const url = buildDocAssetUrl(
      "gno://notes/nested/dir/report.pdf",
      "nested/dir/report.pdf"
    );
    expect(url.startsWith("/api/doc-asset?")).toBe(true);
    const u = new URL(url, "http://localhost");
    expect(u.searchParams.get("uri")).toBe("gno://notes/nested/dir/report.pdf");
    expect(u.searchParams.get("path")).toBe("report.pdf");
  });

  test("dirname+basename resolves nested document and not sibling dir", () => {
    // Mirrors handleDocAsset: resolve(dirname(fullPath), basename(relPath))
    const coll = resolve("/collections/notes");
    const nestedFull = join(coll, "nested/dir/report.pdf");
    const siblingFull = join(coll, "other/report.pdf");
    const bas = "report.pdf";

    const fromNested = resolve(dirname(nestedFull), bas);
    const fromSibling = resolve(dirname(siblingFull), bas);

    expect(fromNested).toBe(nestedFull);
    expect(fromSibling).toBe(siblingFull);
    expect(fromNested).not.toBe(fromSibling);

    // Full relPath as path would double-nest (wrong)
    const wrong = resolve(dirname(nestedFull), "nested/dir/report.pdf");
    expect(wrong).not.toBe(nestedFull);
  });

  test("recordSourcePath-shaped relPath still basename-resolves", () => {
    // API returns relPath = recordSourcePath ?? relPath
    const recordRel = "imports/container/doc.pdf";
    const full = resolve("/collections/vault", recordRel);
    expect(resolve(dirname(full), assetPathFromRelPath(recordRel))).toBe(full);
  });

  test("isPdfDocument is case-insensitive mime or ext", () => {
    expect(isPdfDocument({ mime: "application/pdf", ext: ".bin" })).toBe(true);
    expect(isPdfDocument({ mime: "Application/PDF", ext: "" })).toBe(true);
    expect(isPdfDocument({ mime: "text/plain", ext: ".pdf" })).toBe(true);
    expect(isPdfDocument({ mime: "text/plain", ext: ".PDF" })).toBe(true);
    expect(isPdfDocument({ mime: "text/markdown", ext: ".md" })).toBe(false);
  });

  test("isExtractedTextAvailable predicate table", () => {
    expect(
      isExtractedTextAvailable({ contentAvailable: false, content: "x" })
    ).toBe(false);
    expect(
      isExtractedTextAvailable({ contentAvailable: true, content: null })
    ).toBe(false);
    expect(
      isExtractedTextAvailable({ contentAvailable: true, content: "" })
    ).toBe(false);
    expect(
      isExtractedTextAvailable({ contentAvailable: true, content: "  \n\t" })
    ).toBe(false);
    expect(
      isExtractedTextAvailable({ contentAvailable: true, content: "body" })
    ).toBe(true);
  });
});
