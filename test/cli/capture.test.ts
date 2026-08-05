import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureReceipt } from "../../src/core/capture";

import { formatCaptureReceipt } from "../../src/cli/commands/capture";
import { runCli } from "../../src/cli/run";
import { captureProofSyncReason } from "../../src/ingestion";
import { createDefaultConfig } from "../../src/sdk";
import { safeRm } from "../helpers/cleanup";

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function captureOutput(): void {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...args: unknown[]) => {
    stdoutData += `${args.join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderrData += `${args.join(" ")}\n`;
  };
}

function restoreOutput(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

describe("gno capture", () => {
  let testDir: string;
  let notesDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `gno-capture-${Date.now()}`);
    notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");

    const init = await cli("init", notesDir, "--name", "notes");
    expect(init.code).toBe(0);
  });

  afterEach(async () => {
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  test("captures inline content and returns a JSON receipt", async () => {
    const result = await cli(
      "capture",
      "Remember this",
      "--collection",
      "notes",
      "--source-kind",
      "web",
      "--source-url",
      "https://example.com/post",
      "--tags",
      "Inbox,Project",
      "--json"
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.uri).toStartWith("gno://notes/inbox/");
    expect(receipt.created).toBe(true);
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.embed.status).toBe("not_requested");
    expect(receipt.source.kind).toBe("web");
    expect(receipt.source.url).toBe("https://example.com/post");
    expect(receipt.tags).toEqual(["inbox", "project"]);

    const content = await Bun.file(join(notesDir, receipt.relPath)).text();
    expect(content).toContain("Remember this");
    expect(content).toContain("source:");
  });

  test("quiet output prints only the URI", async () => {
    const result = await cli(
      "--quiet",
      "capture",
      "Quiet note",
      "--collection",
      "notes"
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toStartWith("gno://notes/inbox/");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("rejects conflicting content sources", async () => {
    const clipPath = join(testDir, "clip.md");
    await writeFile(clipPath, "clip");
    const result = await cli(
      "capture",
      "Inline",
      "--file",
      clipPath,
      "--collection",
      "notes",
      "--json"
    );

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.message).toContain("Use only one content source");
  });

  test("rejects binary-like file captures", async () => {
    const binaryPath = join(testDir, "clip.bin");
    await writeFile(binaryPath, Buffer.from([0x47, 0x49, 0x46, 0x01, 0x02]));
    const result = await cli(
      "capture",
      "--file",
      binaryPath,
      "--collection",
      "notes",
      "--json"
    );

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.message).toContain("binary-like");
  });

  test("captures into a real nested directory and indexes it", async () => {
    // Non-discriminating regression guard: this passes at fc38f2de too. It is
    // here so the two refusals below cannot be satisfied by refusing captures
    // into subdirectories wholesale.
    const result = await cli(
      "capture",
      "Nested body",
      "--collection",
      "notes",
      "--path",
      "deep/nested/note.md",
      "--json"
    );

    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.relPath).toBe("deep/nested/note.md");
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.docid).toBeTruthy();

    const stored = await cli("get", receipt.uri, "--json");
    expect(stored.code).toBe(0);
    expect(stored.stdout).toContain("Nested body");
  });

  test("refuses to capture beneath a symlinked parent inside the collection", async () => {
    // `mkdir -p` FOLLOWS `alias`, so before the fix the note was written into
    // `real/`, the indexer (no-follow) never saw it, and the receipt still
    // reported `sync.status: completed` with a `gno://` URI resolving to
    // nothing. DISCRIMINATING: at fc38f2de this exits 0.
    await mkdir(join(notesDir, "real"), { recursive: true });
    await symlink(join(notesDir, "real"), join(notesDir, "alias"));

    const result = await cli(
      "capture",
      "Through the alias",
      "--collection",
      "notes",
      "--path",
      "alias/note.md",
      "--json"
    );

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.message).toContain("symlink");
    expect(payload.error.details.code).toBe("PATH_NOT_WALKABLE");
    // Nothing was written through the alias.
    expect(await Bun.file(join(notesDir, "real", "note.md")).exists()).toBe(
      false
    );
  });

  test("reports containment when a symlinked parent escapes the collection", async () => {
    // DISCRIMINATING: at fc38f2de this wrote the file OUTSIDE the collection
    // and exited 0 with `sync.status: completed` - a containment failure
    // downgraded to silent success.
    const escapeTarget = join(testDir, "outside");
    await mkdir(escapeTarget, { recursive: true });
    await symlink(escapeTarget, join(notesDir, "escape"));

    const result = await cli(
      "capture",
      "Out of bounds",
      "--collection",
      "notes",
      "--path",
      "escape/note.md",
      "--json"
    );

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.details.code).toBe("PATH_OUTSIDE_COLLECTION");
    expect(await Bun.file(join(escapeTarget, "note.md")).exists()).toBe(false);
  });

  test("detects disk-only collisions", async () => {
    await writeFile(join(notesDir, "project-plan.md"), "# Existing\n");
    const result = await cli(
      "capture",
      "# Project Plan",
      "--collection",
      "notes",
      "--title",
      "Project Plan",
      "--collision-policy",
      "create_with_suffix",
      "--json"
    );

    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.relPath).toBe("project-plan-2.md");
    expect(receipt.createdWithSuffix).toBe(true);
    expect(receipt.collisionPolicyResult).toBe("created_with_suffix");
  });
});

/**
 * Opening an existing file has to answer "is it indexed?" the same way the
 * post-write proof does - by EFFECTIVE SOURCE PATH. A record container is
 * indexed as N logical records at virtual `.gno/records/...` paths with nothing
 * at its own rel path, so a `getDocument`-only answer is "no" for a container
 * that is in fact fully indexed.
 */
describe("gno capture - opening an existing record container", () => {
  let testDir: string;
  let recordsDir: string;

  const RECORDS = `${[
    { id: "one", title: "First", text: "Zephyr ships Friday" },
    { id: "two", title: "Second", text: "Budget capped at forty" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;

  beforeEach(async () => {
    // `mkdtemp` rather than a `Date.now()`/`Math.random()` name under the OS
    // temp dir: the latter is a PREDICTABLE path in a world-writable directory,
    // so another local user can pre-create it (or plant a symlink at it) and
    // this suite then writes its fixtures through their file.
    testDir = await mkdtemp(join(tmpdir(), "gno-capture-records-"));
    recordsDir = join(testDir, "records");
    await mkdir(recordsDir, { recursive: true });
    await mkdir(join(testDir, "config"), { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");

    const config = createDefaultConfig();
    config.collections = [
      {
        name: "records",
        path: recordsDir,
        pattern: "**/*",
        include: [],
        exclude: [],
        recordAdapters: {
          jsonl: {
            fieldMapping: { id: "/id", title: "/title", body: "/text" },
          },
        },
      },
    ];
    await Bun.write(
      join(testDir, "config", "index.yml"),
      Bun.YAML.stringify(config)
    );
  });

  afterEach(async () => {
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  const openExisting = (...extra: string[]) =>
    cli(
      "capture",
      "ignored on open",
      "--collection",
      "records",
      "--path",
      "export.jsonl",
      "--collision-policy",
      "open_existing",
      ...extra
    );

  test("reports the opened container as indexed, not as unindexed", async () => {
    const created = await cli(
      "capture",
      RECORDS,
      "--collection",
      "records",
      "--path",
      "export.jsonl",
      "--json"
    );
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout).sync.status).toBe("completed");

    const opened = await openExisting("--json");

    expect(opened.code).toBe(0);
    const receipt = JSON.parse(opened.stdout);
    expect(receipt.openedExisting).toBe(true);
    // DISCRIMINATING against 5d3c7939: the opened-existing branch asked only
    // `getDocument(collection, relPath)`, which is null for a container, so
    // this receipt reported `skipped` / "Existing file is not indexed yet."
    // for a file indexed as two records.
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.sync.reason).toContain("2 logical record documents");
    expect(receipt.sync.reason).not.toContain("not indexed");
    // No docid: the container path has no document of its own, and any one of
    // its records would disagree with the receipt URI.
    expect(receipt.docid).toBeUndefined();
  });

  test("the text output states the container fact instead of a bare success", async () => {
    const created = await cli(
      "capture",
      RECORDS,
      "--collection",
      "records",
      "--path",
      "export.jsonl",
      "--json"
    );
    expect(created.code).toBe(0);

    const opened = await openExisting();

    expect(opened.code).toBe(0);
    expect(opened.stdout).toContain("Opened existing capture.");
    // DISCRIMINATING against 5d3c7939: this read "Sync: skipped" followed by
    // "Note: Existing file is not indexed yet."
    expect(opened.stdout).toContain("Sync: completed");
    expect(opened.stdout).toContain(
      "Note: Existing file is a record container"
    );
    expect(opened.stdout).not.toContain("is not indexed yet");
  });

  test("an opened ordinary markdown file is still reported plainly", async () => {
    const created = await cli(
      "capture",
      "# Plain\n\nOrdinary body\n",
      "--collection",
      "records",
      "--path",
      "plain.md",
      "--json"
    );
    expect(created.code).toBe(0);

    const opened = await cli(
      "capture",
      "ignored on open",
      "--collection",
      "records",
      "--path",
      "plain.md",
      "--collision-policy",
      "open_existing",
      "--json"
    );

    expect(opened.code).toBe(0);
    const receipt = JSON.parse(opened.stdout);
    expect(receipt.openedExisting).toBe(true);
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.sync.reason).toBeUndefined();
    expect(receipt.docid).toBeTruthy();
  });

  test("an unindexed existing file is still reported as unindexed", async () => {
    await writeFile(join(recordsDir, "export.jsonl"), RECORDS);

    const opened = await openExisting("--json");

    expect(opened.code).toBe(0);
    const receipt = JSON.parse(opened.stdout);
    expect(receipt.openedExisting).toBe(true);
    // The record-aware lookup must not become a rubber stamp: nothing ran a
    // sync over this file, so it is on disk and in no index.
    expect(receipt.sync.status).toBe("skipped");
    expect(receipt.sync.reason).toBe("Existing file is not indexed yet.");
  });

  /**
   * An adapter that accepts SOME of what was written is not an error: the
   * container's own file result is `added`/`updated` and the rejected records
   * are disclosed only in `recordImport.failures`. A receipt that stops at
   * `completed` therefore reports a malformed capture as a clean one.
   */
  test("a container whose adapter rejected a record says so", async () => {
    const PARTIAL = `${JSON.stringify({
      id: "one",
      title: "First",
      text: "Zephyr ships Friday",
    })}\n{ this line is not JSON\n`;

    const created = await cli(
      "capture",
      PARTIAL,
      "--collection",
      "records",
      "--path",
      "partial.jsonl",
      "--json"
    );

    expect(created.code).toBe(0);
    const receipt = JSON.parse(created.stdout);
    // DISCRIMINATING against 5e5ed7ca: there the reason was built from the
    // PROOF alone, which only knows the container shape, so this receipt read
    // exactly like the fully valid capture below - `completed`, one sentence
    // about record documents, and no hint that a line was thrown away.
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.sync.reason).toContain("Record import was partial");
    expect(receipt.sync.reason).toContain(
      "rejected by the adapter/jsonl adapter and NOT indexed"
    );
    expect(receipt.sync.reason).toContain("(1 accepted)");
    // The container fact is still stated alongside it - two independent facts,
    // both said, neither replacing the other.
    expect(receipt.sync.reason).toContain("Written as a record container");
    // The text surface a person actually reads carries it too.
    const text = await cli(
      "capture",
      PARTIAL,
      "--collection",
      "records",
      "--path",
      "partial-text.jsonl"
    );
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Record import was partial");
  });

  /**
   * `gno capture` wraps EVERY payload in YAML frontmatter, `.jsonl` included,
   * so the header lines it writes are themselves records the adapter rejects.
   * That is a real pre-existing defect in capturing a container through this
   * surface (tracked separately, not fixed here); what matters for this receipt
   * is that the count is the caller's own bad line ON TOP of that baseline, so
   * the disclosure tracks the payload rather than being a constant.
   */
  test("the rejected count tracks the payload, not just the frontmatter", async () => {
    const clean = await cli(
      "capture",
      RECORDS,
      "--collection",
      "records",
      "--path",
      "clean.jsonl",
      "--json"
    );
    const partial = await cli(
      "capture",
      `${RECORDS}{ this line is not JSON\n`,
      "--collection",
      "records",
      "--path",
      "one-bad.jsonl",
      "--json"
    );

    expect(clean.code).toBe(0);
    expect(partial.code).toBe(0);
    const rejected = (stdout: string): number =>
      Number(
        /Record import was partial: (\d+) records? rejected/.exec(
          JSON.parse(stdout).sync.reason
        )?.[1]
      );
    expect(rejected(partial.stdout)).toBe(rejected(clean.stdout) + 1);
    expect(JSON.parse(clean.stdout).sync.reason).toContain("(2 accepted)");
    expect(JSON.parse(partial.stdout).sync.reason).toContain("(2 accepted)");
  });
});

describe("formatCaptureReceipt text output", () => {
  const baseReceipt: CaptureReceipt = {
    uri: "gno://notes/export.jsonl",
    collection: "notes",
    relPath: "export.jsonl",
    absPath: "/tmp/notes/export.jsonl",
    created: true,
    openedExisting: false,
    createdWithSuffix: false,
    contentHash: "sha256:abc",
    source: { kind: "direct", capturedAt: "2026-08-04T10:00:00.000Z" },
    tags: [],
    sync: { status: "completed" },
    embed: { status: "not_requested" },
    collisionPolicyResult: "created",
  };

  test("surfaces sync.reason so a container capture does not read as ordinary", () => {
    // A record container's whole explanation - the URI names the written FILE
    // and no document - lives in `sync.reason`. DISCRIMINATING against
    // 0a3b57f5: the formatter there printed "Captured note." / "Sync:
    // completed" and dropped the reason, so the only thing a person reads
    // claimed an ordinary success.
    const reason = captureProofSyncReason({
      ok: true,
      kind: "record-container",
      records: [{}, {}] as never,
    });
    const output = formatCaptureReceipt({
      ...baseReceipt,
      sync: { status: "completed", reason },
    });

    expect(output).toContain("Sync: completed");
    expect(output).toContain(`Note: ${reason}`);
    expect(output).toContain("2 logical record documents");
    // Still after Sync and before Embed - the reason qualifies the sync line.
    const lines = output.split("\n");
    expect(lines.indexOf("Sync: completed")).toBeLessThan(
      lines.findIndex((line) => line.startsWith("Note: "))
    );
    expect(lines.findIndex((line) => line.startsWith("Note: "))).toBeLessThan(
      lines.indexOf("Embed: not_requested")
    );
  });

  test("an ordinary capture prints no Note line and json/quiet are untouched", () => {
    const output = formatCaptureReceipt(baseReceipt);
    expect(output).not.toContain("Note: ");
    expect(formatCaptureReceipt(baseReceipt, { quiet: true })).toBe(
      baseReceipt.uri
    );
    expect(
      JSON.parse(formatCaptureReceipt(baseReceipt, { json: true })).uri
    ).toBe(baseReceipt.uri);
  });
});
