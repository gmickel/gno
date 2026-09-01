import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";

import {
  BEGIN_MARKER,
  BLOCK_VERSION,
  END_MARKER,
  extractBlock,
  extractFileReferences,
  hashBlockBody,
  renderBlock,
  renderBlockBody,
} from "../../src/cli/commands/agents/block";
import {
  installAgents,
  parseTargetOption,
  uninstallAgents,
  verifyAgents,
} from "../../src/cli/commands/agents/commands";
import { unifiedDiff } from "../../src/cli/commands/agents/engine";
import { resolveTargets } from "../../src/cli/commands/agents/harnesses";
import { CliError } from "../../src/cli/errors";
import { resetGlobals } from "../../src/cli/program";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-agents-tests");
const FAKE_HOME = join(TEST_DIR, "home");

let stdoutOutput: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const mockWrite = (chunk: string | Uint8Array): boolean => {
  stdoutOutput.push(String(chunk));
  return true;
};

function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

async function setupHome(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await mkdir(join(FAKE_HOME, dir), { recursive: true });
  }
}

const CODEX_FILE = join(FAKE_HOME, ".codex/AGENTS.md");
const CLAUDE_FILE = join(FAKE_HOME, ".claude/CLAUDE.md");
const EXISTING_CODEX_CONTENT = "# My rules\n\nKeep it simple.\n";

describe("agents CLI commands", () => {
  beforeEach(async () => {
    process.stdout.write = mockWrite as typeof process.stdout.write;
    stdoutOutput = [];
    resetGlobals();
    await safeRm(TEST_DIR);
    await mkdir(FAKE_HOME, { recursive: true });
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await safeRm(TEST_DIR);
  });

  describe("block rendering", () => {
    test("block body stays well under the 1500-character budget", () => {
      for (const skillInstalled of [true, false]) {
        expect(renderBlockBody({ skillInstalled }).length).toBeLessThan(1300);
      }
    });

    test("block carries version stamp and marker bounds", () => {
      const block = renderBlock({ skillInstalled: false });
      expect(block.startsWith(BEGIN_MARKER)).toBe(true);
      expect(block.endsWith(END_MARKER)).toBe(true);
      expect(block).toContain(`gno-agents block v${BLOCK_VERSION} sha256:`);
    });

    test("skill pointer is state-aware", () => {
      expect(renderBlockBody({ skillInstalled: true })).toContain("`/gno`");
      expect(renderBlockBody({ skillInstalled: false })).toContain(
        "gno skill install"
      );
    });

    test("`/gno` skill command is not a filesystem link (verify stays ok)", () => {
      // Regression: `/gno` matched the absolute-path regex, so verify probed
      // existsSync("/gno") and flagged a fresh skill-installed block outdated.
      const body = renderBlockBody({ skillInstalled: true });
      expect(extractFileReferences(body)).toEqual([]);
      // Real paths are still extracted.
      expect(
        extractFileReferences("see `~/notes/a.md` and /etc/hosts and /gno")
      ).toEqual(["~/notes/a.md", "/etc/hosts"]);
    });
  });

  describe("extractBlock", () => {
    test("round-trips an installed block", () => {
      const block = renderBlock({ skillInstalled: false });
      const content = `# Mine\n\n${block}\n`;
      const result = extractBlock(content, "x.md");
      if (!result.found) {
        throw new Error("expected block");
      }
      expect(result.block.stamp?.version).toBe(BLOCK_VERSION);
      expect(result.block.stamp?.hash).toBe(hashBlockBody(result.block.body));
    });

    test("fails closed on duplicate markers", () => {
      const block = renderBlock({ skillInstalled: false });
      const content = `${block}\n${BEGIN_MARKER}\n`;
      expect(() => extractBlock(content, "x.md")).toThrow(CliError);
    });

    test("fails closed on END before BEGIN", () => {
      const content = `${END_MARKER}\nmiddle\n${BEGIN_MARKER}\n`;
      expect(() => extractBlock(content, "x.md")).toThrow(CliError);
    });
  });

  describe("install (R1)", () => {
    test("installs to detected harnesses, preserves outside bytes, second run is a no-op", async () => {
      await setupHome([".claude", ".codex", ".openclaw/workspace"]);
      await Bun.write(CODEX_FILE, EXISTING_CODEX_CONTENT);

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });

      const codexAfter = await Bun.file(CODEX_FILE).text();
      // Outside-marker content is byte-identical (hash-verified).
      const outside = codexAfter.slice(0, codexAfter.indexOf(BEGIN_MARKER));
      expect(sha256(outside)).toBe(sha256(`${EXISTING_CODEX_CONTENT}\n`));
      expect(codexAfter).toContain(BEGIN_MARKER);
      expect(await Bun.file(CLAUDE_FILE).text()).toContain(BEGIN_MARKER);
      expect(
        await Bun.file(join(FAKE_HOME, ".openclaw/workspace/AGENTS.md")).text()
      ).toContain(BEGIN_MARKER);

      // Second run: no-op, file bytes identical.
      stdoutOutput = [];
      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const codexResult = report.results.find(
        (r: { target: string }) => r.target === "codex"
      );
      expect(codexResult.action).toBe("current");
      expect(sha256(await Bun.file(CODEX_FILE).text())).toBe(
        sha256(codexAfter)
      );
    });

    test("skips undetected harnesses without creating their trees", async () => {
      await setupHome([".claude"]);
      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const codexResult = report.results.find(
        (r: { target: string }) => r.target === "codex"
      );
      expect(codexResult.action).toBe("not-detected");
      expect(existsSync(join(FAKE_HOME, ".codex"))).toBe(false);
      // Cursor writes ~/AGENTS.md but only when ~/.cursor is detected.
      expect(existsSync(join(FAKE_HOME, "AGENTS.md"))).toBe(false);
    });

    test("--extra-dir installs into an explicit dir, picking the existing instruction file", async () => {
      await setupHome([".claude", "instances/work"]);
      const extraDir = join(FAKE_HOME, "instances/work");
      await Bun.write(join(extraDir, "CLAUDE.md"), "# Instance\n");

      await installAgents({
        target: "claude",
        extraDirs: [extraDir],
        homeDir: FAKE_HOME,
        json: true,
      });

      const content = await Bun.file(join(extraDir, "CLAUDE.md")).text();
      expect(content).toContain(BEGIN_MARKER);
      expect(content.startsWith("# Instance\n")).toBe(true);
    });

    test("--extra-dir rejects a nonexistent directory", async () => {
      await setupHome([".claude"]);
      let thrown: unknown;
      try {
        await installAgents({
          target: "claude",
          extraDirs: [join(FAKE_HOME, "nope")],
          homeDir: FAKE_HOME,
          json: true,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
    });
  });

  describe("import chains and shared files (R2)", () => {
    test("grok is covered via claude — no separate block", async () => {
      await setupHome([".claude", ".grok"]);
      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const grokResult = report.results.find(
        (r: { target: string }) => r.target === "grok"
      );
      expect(grokResult.action).toBe("covered");
      expect(grokResult.via).toBe("claude");
      expect(existsSync(join(FAKE_HOME, ".grok/AGENTS.md"))).toBe(false);
    });

    test("--target grok resolves the covering claude target and installs its block", async () => {
      await setupHome([".claude", ".grok"]);
      await installAgents({ target: "grok", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));

      const claudeResult = report.results.find(
        (r: { target: string }) => r.target === "claude"
      );
      expect(claudeResult.action).toBe("install");
      const grokResult = report.results.find(
        (r: { target: string }) => r.target === "grok"
      );
      expect(grokResult.action).toBe("covered");
      expect(grokResult.via).toBe("claude");

      expect(await Bun.file(CLAUDE_FILE).text()).toContain(BEGIN_MARKER);
      expect(existsSync(join(FAKE_HOME, ".grok/AGENTS.md"))).toBe(false);
    });

    test("verify --target grok fails when the covering claude file has no block", async () => {
      await setupHome([".claude", ".grok"]);
      let thrown: unknown;
      try {
        await verifyAgents({ target: "grok", homeDir: FAKE_HOME, json: true });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.ok).toBe(false);
      const claudeResult = report.results.find(
        (r: { target: string }) => r.target === "claude"
      );
      expect(claudeResult.status).toBe("missing");
      const grokResult = report.results.find(
        (r: { target: string }) => r.target === "grok"
      );
      expect(grokResult.status).toBe("covered");
    });

    test("verify --target grok passes once the covering claude block is installed", async () => {
      await setupHome([".claude", ".grok"]);
      await installAgents({ target: "grok", homeDir: FAKE_HOME, json: true });
      stdoutOutput = [];
      await verifyAgents({ target: "grok", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.ok).toBe(true);
      const claudeResult = report.results.find(
        (r: { target: string }) => r.target === "claude"
      );
      expect(claudeResult.status).toBe("ok");
    });

    test("install --target grok skips the covering claude target when grok is absent", async () => {
      // Regression: with ~/.claude present but ~/.grok absent, the covering
      // chain must not activate — the run must not touch Claude's file on
      // behalf of a harness that is not installed.
      await setupHome([".claude"]);
      await installAgents({ target: "grok", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));

      expect(report.results).toHaveLength(1);
      const grokResult = report.results.find(
        (r: { target: string }) => r.target === "grok"
      );
      expect(grokResult.action).toBe("not-detected");
      expect(existsSync(CLAUDE_FILE)).toBe(false);
    });

    test("uninstall --target grok leaves the claude installation intact when grok is absent", async () => {
      await setupHome([".claude"]);
      await installAgents({ target: "claude", homeDir: FAKE_HOME, json: true });
      stdoutOutput = [];

      await uninstallAgents({
        target: "grok",
        homeDir: FAKE_HOME,
        json: true,
      });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results).toHaveLength(1);
      expect(report.results[0].target).toBe("grok");
      expect(report.results[0].action).toBe("not-detected");
      // Claude's block survives.
      expect(await Bun.file(CLAUDE_FILE).text()).toContain(BEGIN_MARKER);
    });

    test("verify --target grok reports not-detected instead of failing on claude state", async () => {
      // ~/.claude exists with no block — that must not fail a grok verify
      // when grok itself is absent.
      await setupHome([".claude"]);
      await verifyAgents({ target: "grok", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.ok).toBe(true);
      expect(report.results).toHaveLength(1);
      expect(report.results[0].target).toBe("grok");
      expect(report.results[0].status).toBe("not-detected");
    });

    test("detected grok promotes an undetected claude covering target", async () => {
      // ~/.claude does not exist, but grok imports the claude global file —
      // coverage is only real once that file carries the block.
      await setupHome([".grok"]);
      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const claudeResult = report.results.find(
        (r: { target: string }) => r.target === "claude"
      );
      expect(claudeResult.action).toBe("install");
      expect(await Bun.file(CLAUDE_FILE).text()).toContain(BEGIN_MARKER);
    });

    test("targets resolving to the same real file are written once", async () => {
      await setupHome([".codex", ".cursor"]);
      await Bun.write(CODEX_FILE, "# Shared\n");
      // Cursor's ~/AGENTS.md symlinked to the codex file: one real file.
      await symlink(CODEX_FILE, join(FAKE_HOME, "AGENTS.md"));

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const cursorResult = report.results.find(
        (r: { target: string }) => r.target === "cursor"
      );
      expect(cursorResult.action).toBe("covered");

      const content = await Bun.file(CODEX_FILE).text();
      expect(content.split(BEGIN_MARKER).length - 1).toBe(1);
      // The symlink itself is untouched.
      expect(await readlink(join(FAKE_HOME, "AGENTS.md"))).toBe(CODEX_FILE);
    });

    test("verify dedupes shared real files even when skill states differ", async () => {
      // Regression: cursor's skill target is claude; codex has its own. With
      // ~/AGENTS.md symlinked to the codex file and only the claude skill
      // installed, install writes once with codex's skill pointer — verify
      // must treat cursor as covered by the same-file owner, not re-render
      // expectations under cursor's skill state and flag the block outdated.
      await setupHome([".codex", ".cursor", ".claude/skills/gno"]);
      await Bun.write(
        join(FAKE_HOME, ".claude/skills/gno/SKILL.md"),
        "# gno\n"
      );
      await Bun.write(CODEX_FILE, "# Shared\n");
      await symlink(CODEX_FILE, join(FAKE_HOME, "AGENTS.md"));

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });

      stdoutOutput = [];
      await verifyAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.ok).toBe(true);
      const codexResult = report.results.find(
        (r: { target: string }) => r.target === "codex"
      );
      expect(codexResult.status).toBe("ok");
      const cursorResult = report.results.find(
        (r: { target: string }) => r.target === "cursor"
      );
      expect(cursorResult.status).toBe("covered");
      expect(cursorResult.via).toBe("codex");
    });
  });

  describe("marker safety, dry-run, backups (R3)", () => {
    test("malformed markers fail closed with guidance; file untouched", async () => {
      await setupHome([".codex"]);
      const malformed = `# Rules\n\n${BEGIN_MARKER}\nx\n${BEGIN_MARKER}\n${END_MARKER}\n`;
      await Bun.write(CODEX_FILE, malformed);

      let thrown: unknown;
      try {
        await installAgents({
          target: "codex",
          homeDir: FAKE_HOME,
          json: true,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(String(thrown)).toMatch(/failed for 1 target/);
      expect(await Bun.file(CODEX_FILE).text()).toBe(malformed);
    });

    test("--dry-run prints the diff and writes nothing (no backup either)", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING_CODEX_CONTENT);

      await installAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        dryRun: true,
        json: true,
      });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.dryRun).toBe(true);
      expect(report.diffs.join("")).toContain(`+${BEGIN_MARKER}`);
      expect(await Bun.file(CODEX_FILE).text()).toBe(EXISTING_CODEX_CONTENT);
      expect(
        readdirSync(join(FAKE_HOME, ".codex")).filter((f) =>
          f.includes(".gno-agents.bak.")
        )
      ).toHaveLength(0);
    });

    test("every touched existing file gets a backup before the write", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING_CODEX_CONTENT);

      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const backup = report.results[0].backup as string;
      expect(backup).toContain(".gno-agents.bak.");
      expect(await Bun.file(backup).text()).toBe(EXISTING_CODEX_CONTENT);
    });
  });

  describe("verify, update, uninstall (R4)", () => {
    test("verify reports ok after install and fails on a tampered block", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING_CODEX_CONTENT);
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });

      stdoutOutput = [];
      await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const okReport = JSON.parse(stdoutOutput.join(""));
      expect(okReport.ok).toBe(true);
      expect(okReport.results[0].status).toBe("ok");
      expect(okReport.results[0].blockVersion).toBe(BLOCK_VERSION);
      expect(okReport.results[0].hashOk).toBe(true);
      expect(okReport.results[0].linksOk).toBe(true);

      // Tamper inside the markers: hash no longer matches the stamp.
      const content = await Bun.file(CODEX_FILE).text();
      await Bun.write(CODEX_FILE, content.replace("Ladder", "LADDER"));
      stdoutOutput = [];
      let thrown: unknown;
      try {
        await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      } catch (err) {
        thrown = err;
      }
      expect(String(thrown)).toMatch(/verification failed/);
      const badReport = JSON.parse(stdoutOutput.join(""));
      expect(badReport.results[0].status).toBe("outdated");
      expect(badReport.results[0].hashOk).toBe(false);
    });

    test("update migrates a stale block in place", async () => {
      await setupHome([".codex"]);
      const staleBlock = `${BEGIN_MARKER}\n<!-- gno-agents block v0 sha256:0000000000000000 stale -->\nold body\n${END_MARKER}`;
      await Bun.write(CODEX_FILE, `# Rules\n\n${staleBlock}\n\n# After\n`);

      await installAgents(
        { target: "codex", homeDir: FAKE_HOME, json: true },
        "update"
      );
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results[0].action).toBe("update");
      const content = await Bun.file(CODEX_FILE).text();
      expect(content).toContain(`gno-agents block v${BLOCK_VERSION}`);
      expect(content).not.toContain("old body");
      // Content outside the block is byte-identical.
      expect(content.startsWith("# Rules\n\n")).toBe(true);
      expect(content.endsWith("\n\n# After\n")).toBe(true);
    });

    test("uninstall restores the pre-install file byte-identically", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING_CODEX_CONTENT);
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe(EXISTING_CODEX_CONTENT);
      const after = await Bun.file(CODEX_FILE).text();
      expect(after).not.toContain(BEGIN_MARKER);
      expect(after).not.toContain(END_MARKER);
    });

    test("uninstall preserves a missing final newline byte-identically", async () => {
      await setupHome([".codex"]);
      const noFinalNewline = "# My rules\n\nKeep it simple.";
      await Bun.write(CODEX_FILE, noFinalNewline);
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });

      const installed = await Bun.file(CODEX_FILE).text();
      expect(installed.startsWith(`${noFinalNewline}\n${BEGIN_MARKER}`)).toBe(
        true
      );

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe(noFinalNewline);
    });
  });

  describe("target resolution", () => {
    test("parseTargetOption rejects unknown harnesses", () => {
      expect(() => parseTargetOption("vim")).toThrow(CliError);
      expect(parseTargetOption("all")).toBe("all");
      expect(parseTargetOption("hermes")).toBe("hermes");
    });

    test("resolves standard matrix locations from home", () => {
      const targets = resolveTargets("all", { homeDir: FAKE_HOME });
      const byId = new Map(targets.map((t) => [t.id, t.file]));
      expect(byId.get("claude")).toBe(join(FAKE_HOME, ".claude/CLAUDE.md"));
      expect(byId.get("codex")).toBe(join(FAKE_HOME, ".codex/AGENTS.md"));
      expect(byId.get("cursor")).toBe(join(FAKE_HOME, "AGENTS.md"));
      expect(byId.get("opencode")).toBe(
        join(FAKE_HOME, ".config/opencode/AGENTS.md")
      );
      expect(byId.get("hermes")).toBe(join(FAKE_HOME, ".hermes/SOUL.md"));
      expect(byId.get("openclaw")).toBe(
        join(FAKE_HOME, ".openclaw/workspace/AGENTS.md")
      );
    });

    test("explicit homeDir suppresses harness config-dir env overrides", () => {
      const prev = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = "/somewhere/else";
      try {
        const targets = resolveTargets("claude", { homeDir: FAKE_HOME });
        expect(targets[0]?.file).toBe(join(FAKE_HOME, ".claude/CLAUDE.md"));
      } finally {
        if (prev === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = prev;
        }
      }
    });
  });

  describe("unifiedDiff", () => {
    test("returns empty string for identical content", () => {
      expect(unifiedDiff("a\nb\n", "a\nb\n", "x")).toBe("");
    });

    test("emits one hunk with context for a block append", () => {
      const diff = unifiedDiff("a\nb\n", "a\nb\n\nNEW\n", "x");
      expect(diff).toContain("+NEW");
      expect(diff).toContain("--- x");
    });
  });
});
