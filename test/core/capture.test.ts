import { describe, expect, test } from "bun:test";

import {
  buildCaptureReceipt,
  extractCaptureSourceFromFrontmatter,
  hashCaptureContent,
  mergeCaptureFrontmatter,
  planCapture,
} from "../../src/core/capture";

const FIXED_NOW = new Date("2026-06-04T12:34:56.000Z");

describe("capture core", () => {
  test("plans default UTC inbox path from normalized body hash", () => {
    const plan = planCapture({
      input: {
        collection: "notes",
        content: "  Remember this\r\n",
      },
      existingRelPaths: [],
      now: FIXED_NOW,
    });

    const hash = hashCaptureContent("Remember this");
    expect(plan.relPath).toBe(
      `inbox/2026-06-04/capture-${hash.slice(0, 12)}.md`
    );
    expect(plan.collisionPolicy).toBe("open_existing");
    expect(plan.contentHash).toBe(hash);
    expect(plan.source.capturedAt).toBe("2026-06-04T12:34:56.000Z");
    expect(plan.content).toContain("source:");
  });

  test("uses indexed and disk-only paths for collision planning", () => {
    const plan = planCapture({
      input: {
        collection: "notes",
        title: "Project Plan",
        content: "# Project Plan\n",
        collisionPolicy: "create_with_suffix",
      },
      existingRelPaths: ["project-plan.md"],
      diskRelPaths: ["project-plan-2.md"],
      now: FIXED_NOW,
    });

    expect(plan.relPath).toBe("project-plan-3.md");
    expect(plan.createdWithSuffix).toBe(true);
    expect(plan.collisionPolicyResult).toBe("created_with_suffix");
  });

  test("allows scaffold-capable presets without explicit content", () => {
    const plan = planCapture({
      input: {
        collection: "notes",
        title: "Launch Work",
        presetId: "project-note",
      },
      existingRelPaths: [],
      now: FIXED_NOW,
    });

    expect(plan.content).toContain("## Goal");
    expect(plan.content).toContain("source:");
    expect(plan.tags).toContain("project");
  });

  test("rejects empty content without a preset", () => {
    expect(() =>
      planCapture({
        input: {
          collection: "notes",
          content: "   ",
        },
        existingRelPaths: [],
        now: FIXED_NOW,
      })
    ).toThrow("Capture content is required");
  });

  test("rejects NUL byte content", () => {
    expect(() =>
      planCapture({
        input: {
          collection: "notes",
          content: "hello\0world",
        },
        existingRelPaths: [],
        now: FIXED_NOW,
      })
    ).toThrow("NUL byte");
  });

  test("validates source URLs and dates", () => {
    expect(() =>
      planCapture({
        input: {
          collection: "notes",
          content: "clip",
          source: {
            kind: "web",
            url: "not a url",
          },
        },
        existingRelPaths: [],
        now: FIXED_NOW,
      })
    ).toThrow("source.url");

    expect(() =>
      planCapture({
        input: {
          collection: "notes",
          content: "clip",
          source: {
            observedAt: "not a date",
          },
        },
        existingRelPaths: [],
        now: FIXED_NOW,
      })
    ).toThrow("source.observedAt");
  });

  test("merges structured source frontmatter while preserving unknown fields", () => {
    const merged = mergeCaptureFrontmatter({
      content: '---\ncategory: "research"\ntags: [old]\n---\n\n# Body\n',
      title: "Body",
      tags: ["new"],
      source: {
        kind: "web",
        url: "https://example.com",
        capturedAt: FIXED_NOW.toISOString(),
      },
    });

    expect(merged).toContain('category: "research"');
    expect(merged).toContain("tags: [old]");
    expect(merged).toContain("source:");
    expect(merged).toContain('  url: "https://example.com"');
    expect(merged).toContain("# Body");
  });

  test("extracts structured and legacy source fields", () => {
    const source = extractCaptureSourceFromFrontmatter(
      [
        "---",
        'gno_source_docid: "#abc"',
        "source:",
        '  kind: "file"',
        '  uri: "gno://notes/source.pdf"',
        '  capturedAt: "2026-06-04T12:34:56.000Z"',
        "---",
        "",
      ].join("\n")
    );

    expect(source.docid).toBe("#abc");
    expect(source.kind).toBe("file");
    expect(source.uri).toBe("gno://notes/source.pdf");
  });

  test("builds receipt with explicit sync and embed statuses", () => {
    const plan = planCapture({
      input: {
        collection: "notes",
        content: "receipt",
      },
      existingRelPaths: [],
      now: FIXED_NOW,
    });
    const receipt = buildCaptureReceipt({
      plan,
      docid: "#abc123",
      absPath: "/tmp/notes/receipt.md",
      sync: { status: "completed" },
    });

    expect(receipt.docid).toBe("#abc123");
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.embed.status).toBe("not_requested");
    expect(receipt.collisionPolicyResult).toBe("created");
  });
});
