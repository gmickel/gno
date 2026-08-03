import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, stat } from "node:fs/promises";
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
  });
});
