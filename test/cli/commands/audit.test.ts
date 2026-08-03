import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises provides filesystem metadata mutation with no Bun equivalent.
import { chmod, mkdir, mkdtemp, rename, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getIndexDbPath } from "../../../src/app/constants";
import { audit } from "../../../src/cli/commands/audit";
import { runCli } from "../../../src/cli/run";
import { safeRm } from "../../helpers/cleanup";

const hashFile = async (path: string): Promise<string> =>
  new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");

describe("gno audit CLI", () => {
  let root: string;
  let notes: string;
  let output = "";
  let originalStdoutWrite: typeof process.stdout.write;
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-cli-audit-"));
    notes = join(root, "notes");
    await mkdir(notes, { recursive: true });
    previousEnvironment = {
      GNO_CONFIG_DIR: process.env.GNO_CONFIG_DIR,
      GNO_DATA_DIR: process.env.GNO_DATA_DIR,
      GNO_CACHE_DIR: process.env.GNO_CACHE_DIR,
    };
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    await Bun.write(join(notes, "a.md"), "# A\n\n[[B]]\n");
    await Bun.write(join(notes, "b.md"), "# B\n");
    expect(await runCli(["bun", "gno", "init", notes, "--name", "notes"])).toBe(
      0
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);
    output = "";
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    await safeRm(root);
  });

  test("returns clean JSON from the shared report without mutating truth surfaces", async () => {
    const configPath = join(process.env.GNO_CONFIG_DIR!, "index.yml");
    const dbPath = getIndexDbPath();
    const before = {
      config: await hashFile(configPath),
      database: await hashFile(dbPath),
      source: await hashFile(join(notes, "a.md")),
    };
    const code = await runCli(["bun", "gno", "audit", "links", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(output);
    expect(report.status).toBe("complete");
    expect(report.counts.findings.total).toBe(0);
    expect(report.scope.categories).toEqual(["links"]);
    expect({
      config: await hashFile(configPath),
      database: await hashFile(dbPath),
      source: await hashFile(join(notes, "a.md")),
    }).toEqual(before);
  });

  test("uses exit 4 for findings and preserves exact totals under truncation", async () => {
    await Bun.write(
      join(notes, "broken.md"),
      "# Broken\n\n[missing](none.md)\n"
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);
    output = "";
    const code = await runCli([
      "bun",
      "gno",
      "audit",
      "links",
      "--max-findings",
      "1",
      "--json",
    ]);
    expect(code).toBe(4);
    const report = JSON.parse(output);
    expect(report.counts.findings.total).toBeGreaterThan(1);
    expect(report.counts.findings.returned).toBe(1);
    expect(report.counts.findings.truncated).toBe(true);
    const firstIds = report.findings.map(({ id }: { id: string }) => id);
    output = "";
    expect(
      await runCli([
        "bun",
        "gno",
        "audit",
        "links",
        "--max-findings",
        "1",
        "--json",
      ])
    ).toBe(4);
    expect(
      JSON.parse(output).findings.map(({ id }: { id: string }) => id)
    ).toEqual(firstIds);
  });

  test("uses exit 5 for cancellation and rejects invalid input", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await audit({
      category: "all",
      signal: controller.signal,
    });
    expect(cancelled.success).toBe(true);
    if (cancelled.success) {
      expect(cancelled.exitCode).toBe(5);
      expect(cancelled.report.status).toBe("partial");
    }
    expect(await audit({ category: "contradictions" })).toEqual({
      success: false,
      invalid: true,
      error: "category must be links, provenance, freshness, or all",
    });
  });

  test("normalizes and validates tag filters", async () => {
    await Bun.write(
      join(notes, "tagged.md"),
      "---\ntags: [project]\n---\n# Tagged\n\n[[B]]\n"
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);
    const normalized = await audit({ category: "links", tags: [" Project "] });
    expect(normalized.success).toBe(true);
    if (normalized.success) {
      expect(normalized.report.scope.tags).toEqual(["project"]);
      expect(normalized.report.counts.examined.documents).toBeGreaterThan(0);
    }
    expect(await audit({ category: "links", tags: ["bad tag"] })).toEqual({
      success: false,
      invalid: true,
      error: 'Invalid tag: "bad tag"',
    });
  });

  test("treats a root-like path filter as the unfiltered collection root", async () => {
    const unfiltered = await audit({ category: "links" });
    const rootFiltered = await audit({
      category: "links",
      paths: ["/", "a.md"],
    });
    expect(unfiltered.success).toBe(true);
    expect(rootFiltered.success).toBe(true);
    if (!(unfiltered.success && rootFiltered.success)) return;
    expect(rootFiltered.report.scope.paths).toEqual([]);
    expect(rootFiltered.report.counts.examined).toEqual(
      unfiltered.report.counts.examined
    );
    expect(rootFiltered.report.rules).toEqual(unfiltered.report.rules);
  });

  test("normalizes trailing slashes in directory path filters", async () => {
    await mkdir(join(notes, "projects"), { recursive: true });
    await Bun.write(join(notes, "projects", "plan.md"), "# Plan\n");
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);

    const bare = await audit({ category: "freshness", paths: ["projects"] });
    const trailing = await audit({
      category: "freshness",
      paths: ["/projects/"],
    });
    expect(bare.success).toBe(true);
    expect(trailing.success).toBe(true);
    if (bare.success && trailing.success) {
      expect(trailing.report.scope.paths).toEqual(["projects"]);
      expect(trailing.report.counts.examined).toEqual(
        bare.report.counts.examined
      );
      expect(trailing.report.fingerprints).toEqual(bare.report.fingerprints);
    }
  });

  test("matches path prefixes case-sensitively", async () => {
    await mkdir(join(notes, "case-scope"));
    await Bun.write(join(notes, "case-scope", "lower.md"), "# Lower\n");
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);
    const database = new Database(getIndexDbPath());
    database.run(
      "UPDATE documents SET rel_path = ?, uri = ? WHERE rel_path = ?",
      ["Case-scope/upper.md", "gno://notes/Case-scope/upper.md", "a.md"]
    );
    database.close();

    const scoped = await audit({
      category: "links",
      paths: ["case-scope"],
    });
    expect(scoped.success).toBe(true);
    if (scoped.success) {
      expect(
        scoped.report.findings
          .filter(({ ruleId }) => ruleId === "links.orphans")
          .map(({ subject }) => subject)
      ).toEqual(["gno://notes/case-scope/lower.md"]);
    }
  });

  test("rejects scope filters beyond the report schema bound", async () => {
    const paths = Array.from({ length: 257 }, (_, index) => `path-${index}`);
    expect(await audit({ category: "links", paths })).toEqual({
      success: false,
      invalid: true,
      error: "paths must contain at most 256 values",
    });
  });

  test("rejects empty and overlong paths before widening or emitting scope", async () => {
    expect(await audit({ category: "links", paths: ["   "] })).toEqual({
      success: false,
      invalid: true,
      error: "path filters must not be empty or whitespace-only",
    });
    expect(
      await audit({ category: "links", paths: ["x".repeat(2049)] })
    ).toEqual({
      success: false,
      invalid: true,
      error: "path filters must be at most 2048 characters",
    });
  });

  test("rejects tags beyond the report scope bound", async () => {
    expect(await audit({ category: "links", tags: ["x".repeat(257)] })).toEqual(
      {
        success: false,
        invalid: true,
        error: "tags entries must be at most 256 characters",
      }
    );
  });

  test("retains incoming links when a path filter narrows audit scope", async () => {
    await mkdir(join(notes, "scoped"));
    await Bun.write(
      join(notes, "outside.md"),
      "# Outside\n\n[[scoped/inside]]\n"
    );
    await Bun.write(join(notes, "scoped", "inside.md"), "# Inside\n");
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);
    const scoped = await audit({ category: "links", paths: ["scoped"] });
    expect(scoped.success).toBe(true);
    if (scoped.success) {
      expect(
        scoped.report.findings.some(
          ({ ruleId, subject }) =>
            ruleId === "links.orphans" &&
            subject === "gno://notes/scoped/inside.md"
        )
      ).toBe(false);
    }
  });

  test("retains duplicate-mirror evidence outside a narrowed path scope", async () => {
    await mkdir(join(notes, "scoped"));
    await Bun.write(join(notes, "scoped", "copy.md"), "# Shared\n");
    await Bun.write(join(notes, "outside-copy.md"), "# Shared\n");
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);

    const database = new Database(getIndexDbPath());
    database.run(
      "UPDATE documents SET mirror_hash = ? WHERE rel_path IN (?, ?)",
      ["shared-mirror", "scoped/copy.md", "outside-copy.md"]
    );
    database.close();

    const scoped = await audit({ category: "links", paths: ["scoped"] });
    expect(scoped.success).toBe(true);
    if (scoped.success) {
      expect(
        scoped.report.findings.some(
          ({ ruleId, subject }) =>
            ruleId === "links.orphans" &&
            subject === "gno://notes/scoped/copy.md"
        )
      ).toBe(false);
    }
  });

  test("canonicalizes equivalent orphan policies in the rules fingerprint", async () => {
    const first = await audit({
      category: "links",
      orphanRoots: ["gno://notes/b.md", "gno://notes/a.md"],
      orphanIgnorePrefixes: ["drafts", "archive", "drafts"],
    });
    const second = await audit({
      category: "links",
      orphanRoots: ["gno://notes/a.md", "gno://notes/b.md", "gno://notes/a.md"],
      orphanIgnorePrefixes: ["archive", "drafts"],
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(first.report.fingerprints.rules).toBe(
        second.report.fingerprints.rules
      );
    }
  });

  test("audits every Markdown extension and discloses capped frontmatter", async () => {
    const incompleteSource =
      "---\nsource:\n  kind: web\n---\n# Capture provenance\n";
    await Bun.write(join(notes, "capture-markdown.md"), incompleteSource);
    await Bun.write(join(notes, "capture-mdx.md"), incompleteSource);
    await Bun.write(
      join(notes, "oversized.md"),
      `---\nsource:\n  kind: web\npadding: ${"x".repeat(70_000)}\n---\n# Oversized\n`
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);
    const database = new Database(getIndexDbPath());
    for (const [from, to] of [
      ["capture-markdown.md", "capture.markdown"],
      ["capture-mdx.md", "capture.mdx"],
      ["oversized.md", "oversized.mdx"],
    ] as const) {
      await rename(join(notes, from), join(notes, to));
      database.run(
        "UPDATE documents SET rel_path = ?, uri = ?, source_ext = ? WHERE rel_path = ?",
        [to, `gno://notes/${to}`, to.slice(to.lastIndexOf(".")), from]
      );
    }
    database.close();

    const result = await audit({ category: "provenance" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.exitCode).toBe(5);
      expect(result.report.status).toBe("partial");
      expect(
        result.report.findings
          .filter(({ ruleId }) => ruleId === "provenance.capture-source")
          .map(({ subject }) => subject)
      ).toEqual(
        expect.arrayContaining([
          "gno://notes/capture.markdown",
          "gno://notes/capture.mdx",
        ])
      );
      expect(result.report.rules).toContainEqual(
        expect.objectContaining({
          ruleId: "provenance.capture-source",
          status: "unavailable",
          skipReason: "source_unavailable",
        })
      );
    }
  });

  test("treats short unterminated frontmatter as unavailable", async () => {
    await Bun.write(
      join(notes, "unterminated.md"),
      "---\nsource:\n  kind: web\n# Missing closing delimiter\n"
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);

    const result = await audit({ category: "provenance" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.exitCode).toBe(5);
      expect(result.report.status).toBe("partial");
      expect(result.report.rules).toContainEqual(
        expect.objectContaining({
          ruleId: "provenance.capture-source",
          status: "unavailable",
          skipReason: "source_unavailable",
        })
      );
    }
  });

  test("reports unavailable sources and repeated snapshot drift as partial", async () => {
    await rename(notes, join(root, "offline-notes"));
    const unavailableProvenance = await audit({ category: "provenance" });
    expect(unavailableProvenance.success).toBe(true);
    if (unavailableProvenance.success) {
      expect(unavailableProvenance.exitCode).toBe(5);
      expect(unavailableProvenance.report.status).toBe("partial");
      expect(unavailableProvenance.report.rules).toContainEqual(
        expect.objectContaining({
          ruleId: "provenance.capture-source",
          status: "unavailable",
          skipReason: "source_unavailable",
        })
      );
    }
    const unavailable = await audit({ category: "freshness" });
    expect(unavailable.success).toBe(true);
    if (unavailable.success) {
      expect(unavailable.exitCode).toBe(5);
      expect(unavailable.report.status).toBe("partial");
      expect(unavailable.report.rules).toContainEqual(
        expect.objectContaining({
          ruleId: "freshness.source-readable",
          status: "unavailable",
        })
      );
    }

    await rename(join(root, "offline-notes"), notes);
    let mutations = 0;
    const changed = await audit({
      category: "freshness",
      onProgress: async ({ phase, completed }) => {
        if (phase !== "snapshot" || completed === 0) return;
        mutations += 1;
        await Bun.write(
          join(notes, "a.md"),
          `# A\n\n[[B]]\n\nchange ${mutations}\n`
        );
      },
    });
    expect(changed.success).toBe(true);
    if (changed.success) {
      expect(changed.exitCode).toBe(5);
      expect(changed.report.status).toBe("changed_during_audit");
    }
    expect(mutations).toBe(2);
  });

  test("reports an unreadable source as unavailable instead of failing", async () => {
    const sourcePath = join(notes, "a.md");
    await chmod(sourcePath, 0o000);
    try {
      const result = await audit({ category: "provenance" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.exitCode).toBe(5);
        expect(result.report.status).toBe("partial");
        expect(result.report.rules).toContainEqual(
          expect.objectContaining({
            ruleId: "provenance.capture-source",
            status: "unavailable",
            skipReason: "source_unavailable",
          })
        );
      }
    } finally {
      await chmod(sourcePath, 0o644);
    }
  });

  test("detects graph drift without document revision changes", async () => {
    const database = new Database(getIndexDbPath());
    const revisionsBefore = database
      .query<
        { id: number; source_hash: string; indexed_at: string | null },
        []
      >("SELECT id, source_hash, indexed_at FROM documents ORDER BY id")
      .all();
    let mutations = 0;
    const changed = await audit({
      category: "links",
      onProgress: ({ phase, completed }) => {
        if (phase !== "snapshot" || completed === 0) return;
        mutations += 1;
        const target = mutations % 2 === 0 ? "b" : "missing";
        database.run(
          "UPDATE doc_links SET target_ref = ?, target_ref_norm = ?",
          [target, target]
        );
      },
    });
    expect(changed.success).toBe(true);
    if (changed.success) {
      expect(changed.exitCode).toBe(5);
      expect(changed.report.status).toBe("changed_during_audit");
    }
    expect(mutations).toBe(2);
    expect(
      database
        .query<
          { id: number; source_hash: string; indexed_at: string | null },
          []
        >("SELECT id, source_hash, indexed_at FROM documents ORDER BY id")
        .all()
    ).toEqual(revisionsBefore);
    database.close();
  });

  test("does not read the graph for a source-only audit", async () => {
    const database = new Database(getIndexDbPath());
    database.run("DROP TABLE doc_links");
    database.close();
    const result = await audit({ category: "provenance" });
    expect(result.success).toBe(true);
  });

  test("does not read the global graph for an empty filtered link scope", async () => {
    const database = new Database(getIndexDbPath());
    database.run("DROP TABLE doc_links");
    database.close();

    const result = await audit({
      category: "links",
      paths: ["does-not-exist"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe("complete");
      expect(result.report.counts.findings.total).toBe(0);
    }
  });

  test("checks logical records through their physical source container", async () => {
    const database = new Database(getIndexDbPath());
    database.run(
      `UPDATE documents
       SET rel_path = ?, uri = ?, source_hash = ?, record_key = ?,
           record_source_path = ?, record_source_locator = ?,
           converter_id = ?, converter_version = ?, record_adapter_fingerprint = ?
       WHERE rel_path = ?`,
      [
        ".gno/records/jsonl/b.md",
        "gno://notes/.gno/records/jsonl/b.md",
        "record-specific-hash",
        "record-b",
        "b.md",
        "line:1",
        "jsonl",
        "1",
        "adapter-v1",
        "b.md",
      ]
    );
    database.close();

    const result = await audit({ category: "freshness" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe("complete");
      expect(result.report.findings).toEqual([]);
      expect(
        result.report.rules.find(
          ({ ruleId }) => ruleId === "freshness.source-index-drift"
        )
      ).toMatchObject({
        examinedCount: 1,
        message:
          "0 source revisions differ from the index; 1 logical records excluded from byte comparison",
        status: "pass",
      });
    }
  });

  test("detects logical-record container drift during freshness audit", async () => {
    const database = new Database(getIndexDbPath());
    database.run(
      `UPDATE documents
       SET rel_path = ?, uri = ?, source_hash = ?, record_key = ?,
           record_source_path = ?
       WHERE rel_path = ?`,
      [
        ".gno/records/jsonl/b.md",
        "gno://notes/.gno/records/jsonl/b.md",
        "record-specific-hash",
        "record-b",
        "b.md",
        "b.md",
      ]
    );
    database.close();

    let mutations = 0;
    const changed = await audit({
      category: "freshness",
      onProgress: async ({ phase, completed }) => {
        if (phase !== "snapshot" || completed === 0) return;
        mutations += 1;
        await Bun.write(
          join(notes, "b.md"),
          mutations % 2 === 0 ? "# B\n" : "# Changed container\n"
        );
      },
    });
    expect(changed.success).toBe(true);
    if (changed.success) {
      expect(changed.exitCode).toBe(5);
      expect(changed.report.status).toBe("changed_during_audit");
    }
    expect(mutations).toBe(2);
  });

  test("detects indexed provenance drift without source revision changes", async () => {
    const database = new Database(getIndexDbPath());
    const revisionsBefore = database
      .query<{ source_hash: string; indexed_at: string | null }, [string]>(
        "SELECT source_hash, indexed_at FROM documents WHERE rel_path = ?"
      )
      .get("a.md");
    let mutations = 0;
    const changed = await audit({
      category: "provenance",
      onProgress: ({ phase, completed }) => {
        if (phase !== "snapshot" || completed === 0) return;
        mutations += 1;
        database.run("UPDATE documents SET record_key = ? WHERE rel_path = ?", [
          `record-${mutations}`,
          "a.md",
        ]);
      },
    });
    expect(changed.success).toBe(true);
    if (changed.success) {
      expect(changed.exitCode).toBe(5);
      expect(changed.report.status).toBe("changed_during_audit");
    }
    expect(mutations).toBe(2);
    expect(
      database
        .query<{ source_hash: string; indexed_at: string | null }, [string]>(
          "SELECT source_hash, indexed_at FROM documents WHERE rel_path = ?"
        )
        .get("a.md")
    ).toEqual(revisionsBefore);
    database.close();
  });

  test("detects record metadata drift without source revision changes", async () => {
    const database = new Database(getIndexDbPath());
    let mutations = 0;
    const changed = await audit({
      category: "provenance",
      onProgress: ({ phase, completed }) => {
        if (phase !== "snapshot" || completed === 0) return;
        mutations += 1;
        const declared = mutations % 2 === 1;
        database.run(
          "UPDATE documents SET record_metadata = ?, record_anchors = ? WHERE rel_path = ?",
          [
            declared ? '{"title":"changed"}' : null,
            declared ? '[{"kind":"page","value":"1"}]' : null,
            "a.md",
          ]
        );
      },
    });
    expect(changed.success).toBe(true);
    if (changed.success) {
      expect(changed.exitCode).toBe(5);
      expect(changed.report.status).toBe("changed_during_audit");
    }
    expect(mutations).toBe(2);
    database.close();
  });

  test("hashes freshness bytes even when size and mtime match the index", async () => {
    const database = new Database(getIndexDbPath(), { readonly: true });
    const indexed = database
      .query<{ source_mtime: string; source_size: number }, [string]>(
        "SELECT source_mtime, source_size FROM documents WHERE rel_path = ?"
      )
      .get("a.md");
    database.close();
    if (!indexed) throw new Error("Expected indexed a.md");

    const sourcePath = join(notes, "a.md");
    await Bun.write(sourcePath, "# X\n\n[[B]]\n");
    const indexedTime = new Date(indexed.source_mtime);
    await utimes(sourcePath, indexedTime, indexedTime);
    const current = await stat(sourcePath);
    expect(current.size).toBe(indexed.source_size);
    expect(current.mtime.toISOString()).toBe(indexed.source_mtime);

    const result = await audit({ category: "freshness" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.exitCode).toBe(4);
      expect(result.report.status).toBe("complete");
      expect(result.report.findings).toContainEqual(
        expect.objectContaining({
          ruleId: "freshness.source-index-drift",
          subject: "gno://notes/a.md",
        })
      );
    }
  });

  test("detects same-stat source changes during freshness audit", async () => {
    const database = new Database(getIndexDbPath(), { readonly: true });
    const indexed = database
      .query<{ source_mtime: string }, [string]>(
        "SELECT source_mtime FROM documents WHERE rel_path = ?"
      )
      .get("a.md");
    database.close();
    if (!indexed) throw new Error("Expected indexed a.md");

    const sourcePath = join(notes, "a.md");
    const indexedTime = new Date(indexed.source_mtime);
    let mutations = 0;
    const changed = await audit({
      category: "freshness",
      onProgress: async ({ phase, completed }) => {
        if (phase !== "snapshot" || completed === 0) return;
        mutations += 1;
        await Bun.write(
          sourcePath,
          mutations % 2 === 0 ? "# A\n\n[[B]]\n" : "# X\n\n[[B]]\n"
        );
        await utimes(sourcePath, indexedTime, indexedTime);
      },
    });
    expect(changed.success).toBe(true);
    if (changed.success) {
      expect(changed.exitCode).toBe(5);
      expect(changed.report.status).toBe("changed_during_audit");
    }
    expect(mutations).toBe(2);
  });

  test("uses exit 2 when the configured index is unavailable", async () => {
    await rename(getIndexDbPath(), join(root, "offline-index.sqlite"));
    expect(await audit({ category: "all" })).toEqual({
      success: false,
      invalid: false,
      error: expect.stringContaining("Index database not found"),
    });
    expect(await runCli(["bun", "gno", "audit", "--json"])).toBe(2);
  });

  test("writes an explicitly requested private report artifact", async () => {
    const reportPath = join(root, "audit.json");
    await Bun.write(reportPath, "pre-existing\n");
    await chmod(reportPath, 0o644);
    const originalInode = (await stat(reportPath)).ino;
    const code = await runCli([
      "bun",
      "gno",
      "audit",
      "links",
      "--json",
      "--output",
      reportPath,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(await Bun.file(reportPath).text()).schemaVersion).toBe(
      "1.0"
    );
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect((await stat(reportPath)).ino).not.toBe(originalInode);
  });
});
