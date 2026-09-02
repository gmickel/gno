import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  BEGIN_MARKER,
  BLOCK_VERSION,
  END_MARKER,
  extractBlock,
  extractFileReferences,
  hashBlockBody,
  quotePathForShell,
  renderBlock,
  renderBlockBody,
  separatorContextHash,
} from "../../src/cli/commands/agents/block";
import {
  installAgents,
  parseTargetOption,
  uninstallAgents,
  verifyAgents,
} from "../../src/cli/commands/agents/commands";
import {
  aggregateRemediation,
  applyPlan,
  planTargets,
  unifiedDiff,
} from "../../src/cli/commands/agents/engine";
import {
  type ResolvedTarget,
  resolveTargets,
  skillStateLocation,
  skillStateLocations,
} from "../../src/cli/commands/agents/harnesses";
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

    test("skill pointer is state-aware and remediation is scoped to consumers", () => {
      expect(renderBlockBody({ skillInstalled: true })).toContain("`/gno`");
      // No consumer information → generic fallback.
      expect(renderBlockBody({ skillInstalled: false })).toContain(
        "gno skill install --scope user --force --target all"
      );
      // Consumers known → one install per harness lacking the skill, plus the
      // instance-local env form for an --extra-dir; never `--target all`.
      const scoped = renderBlockBody({
        skillInstalled: false,
        remediation: { targets: ["codex", "opencode"], extraDirs: ["/x/inst"] },
      });
      expect(scoped).toContain(
        "gno skill install --scope user --force --target codex; "
      );
      expect(scoped).toContain("--target opencode; ");
      expect(scoped).toContain(
        "gno skill install --scope user --force --target claude --skills-dir '/x/inst/skills'"
      );
      expect(scoped).not.toContain("--target all");
      // The quoted instance path is not a link to validate.
      expect(extractFileReferences(scoped)).toEqual([]);
      // Paths with spaces, `$VAR`, `$(…)`, backticks, and quotes stay one
      // literal argument: single quotes suppress every expansion, and an
      // embedded `'` uses the POSIX '\'' idiom.
      const hostile = renderBlockBody({
        skillInstalled: false,
        remediation: {
          targets: [],
          extraDirs: ["/x/my $HOME `id` $(rm) it's dir"],
        },
      });
      expect(hostile).toContain(
        "--skills-dir '/x/my $HOME `id` $(rm) it'\\''s dir/skills'"
      );
      // The WHOLE quoted operand is masked from link extraction — a backtick
      // inside the path must not open a fresh `/…` reference (`/z/skills`).
      expect(extractFileReferences(hostile)).toEqual([]);
      const backtickPath = renderBlockBody({
        skillInstalled: false,
        remediation: { targets: [], extraDirs: ["/tmp/a`/z"] },
      });
      expect(extractFileReferences(backtickPath)).toEqual([]);
    });

    test("remediation path quoting uses the active shell's apostrophe idiom", () => {
      // POSIX: close/reopen. PowerShell: double it (about_Quoting_Rules).
      expect(quotePathForShell("/x/O'Brien/skills", "linux")).toBe(
        "'/x/O'\\''Brien/skills'"
      );
      expect(quotePathForShell("C:\\Users\\O'Brien\\skills", "win32")).toBe(
        "'C:\\Users\\O''Brien\\skills'"
      );
      // No expansion characters are ever escaped or altered — single quotes
      // make them literal on both platforms.
      expect(quotePathForShell("/x/$HOME/`id`/$(rm)", "linux")).toBe(
        "'/x/$HOME/`id`/$(rm)'"
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

    test("--extra-dir skill state comes from that instance, not standard harnesses", async () => {
      // Regression: an extra dir used any-standard-harness skill presence, so
      // an instance without the skill got a `/gno` pointer it cannot load.
      await setupHome([".claude", ".claude/skills/gno"]);
      await Bun.write(
        join(FAKE_HOME, ".claude/skills/gno/SKILL.md"),
        "# gno\n"
      );
      const instance = join(FAKE_HOME, "instance");
      await mkdir(instance, { recursive: true });

      await installAgents({
        target: "claude",
        homeDir: FAKE_HOME,
        extraDirs: [instance],
        json: true,
      });
      const withoutSkill = await Bun.file(join(instance, "AGENTS.md")).text();
      // The remediation addresses the instance itself via its skills dir.
      expect(withoutSkill).toContain(
        `gno skill install --scope user --force --target claude --skills-dir '${instance}/skills'`
      );
      expect(withoutSkill).not.toContain("`/gno`");

      // Install the skill INTO the instance → the pointer flips on update.
      await mkdir(join(instance, "skills", "gno"), { recursive: true });
      await Bun.write(join(instance, "skills/gno/SKILL.md"), "# gno\n");
      stdoutOutput = [];
      await installAgents(
        {
          target: "claude",
          homeDir: FAKE_HOME,
          extraDirs: [instance],
          json: true,
        },
        "update"
      );
      const withSkill = await Bun.file(join(instance, "AGENTS.md")).text();
      expect(withSkill).toContain("`/gno`");
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

    test("aliases of a not-yet-created file via symlinked parents dedupe", async () => {
      // Regression: realpathSync(file) throws for a file that does not exist
      // yet, and the old fallback (normalize) left two aliases through
      // symlinked parent dirs with different identities — planTargets then
      // applied two backup-less install writes to the same physical file.
      await setupHome([".codex"]);
      // ~/.codex/AGENTS.md does not exist; an extra dir reaches the same
      // (missing) file through a symlinked parent.
      const alias = join(FAKE_HOME, "codex-alias");
      await symlink(join(FAKE_HOME, ".codex"), alias);

      await installAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        extraDirs: [alias],
        json: true,
      });
      const report = JSON.parse(stdoutOutput.join(""));
      const codexResult = report.results.find(
        (r: { target: string }) => r.target === "codex"
      );
      expect(codexResult.action).toBe("install");
      const extraResult = report.results.find(
        (r: { target: string }) => r.target === "extra-dir"
      );
      expect(extraResult.action).toBe("covered");
      expect(extraResult.via).toBe("codex");

      const content = await Bun.file(CODEX_FILE).text();
      expect(content.split(BEGIN_MARKER).length - 1).toBe(1);
    });

    test("--extra-dir selects a dangling instruction-file symlink as the candidate", async () => {
      // Regression: `existsSync` follows the link and reported the dangling
      // CLAUDE.md absent, so a fresh AGENTS.md was created beside it and the
      // file the instance actually reads stayed unmanaged.
      await setupHome([".claude", "instance", "shared"]);
      const instance = join(FAKE_HOME, "instance");
      const sharedTarget = join(FAKE_HOME, "shared", "instance-rules.md"); // absent
      await symlink(sharedTarget, join(instance, "CLAUDE.md"));

      await installAgents({
        target: "claude",
        homeDir: FAKE_HOME,
        extraDirs: [instance],
        json: true,
      });
      const report = JSON.parse(stdoutOutput.join(""));
      const extra = report.results.find(
        (r: { target: string }) => r.target === "extra-dir"
      );
      expect(extra.path).toBe(join(instance, "CLAUDE.md"));
      expect(extra.action).toBe("install");
      // Written THROUGH the link: the shared target now exists with the block,
      // and no stray AGENTS.md was created.
      expect(await Bun.file(sharedTarget).text()).toContain(BEGIN_MARKER);
      expect(existsSync(join(instance, "AGENTS.md"))).toBe(false);
    });

    test("redirected Cursor still defers to a Codex install on a shared file", () => {
      // Cursor with skillHome (CLAUDE_CONFIG_DIR active) shares a file with a
      // skill-less Codex: the codex target satisfies Cursor, so no standard
      // Claude dir is added to the remediation.
      const shared = join(FAKE_HOME, ".codex", "AGENTS.md");
      const codex: ResolvedTarget = {
        id: "codex",
        label: "Codex",
        configDir: join(FAKE_HOME, ".codex"),
        file: shared,
        realFile: shared,
        detected: true,
        skillInstalled: false,
        skillTarget: "codex",
        skillTargets: ["codex"],
      };
      const cursor: ResolvedTarget = {
        id: "cursor",
        label: "Cursor Agent",
        configDir: join(FAKE_HOME, ".cursor"),
        file: join(FAKE_HOME, "AGENTS.md"),
        realFile: shared,
        detected: true,
        skillInstalled: false,
        skillTarget: "claude",
        skillTargets: ["claude", "codex"],
        skillHome: join(FAKE_HOME, ".claude"),
      };
      expect(aggregateRemediation([codex, cursor]).get(shared)).toEqual({
        targets: ["codex"],
        extraDirs: [],
      });
      // Alone, the redirected Cursor still remediates via its standard dir.
      expect(aggregateRemediation([cursor]).get(shared)).toEqual({
        targets: [],
        extraDirs: [join(FAKE_HOME, ".claude")],
      });
    });

    test("a redirected Claude selected in pass 1 does not satisfy a co-consuming Cursor", () => {
      // Claude and Cursor share a file, both lack the skill, CLAUDE_CONFIG_DIR
      // redirects Claude: `--target claude` installs into the redirected
      // instance while Cursor keeps loading `~/.claude/skills`, so Cursor
      // still needs the standard dir. (A Grok that already forced that
      // standard dir satisfies Cursor without a further entry.)
      const shared = join(FAKE_HOME, "AGENTS.md");
      const standardHome = join(FAKE_HOME, ".claude");
      const claude: ResolvedTarget = {
        id: "claude",
        label: "Claude Code",
        configDir: join(FAKE_HOME, "redirected-claude"),
        file: shared,
        realFile: shared,
        detected: true,
        skillInstalled: false,
        skillTarget: "claude",
        skillTargets: ["claude"],
      };
      const cursor: ResolvedTarget = {
        id: "cursor",
        label: "Cursor Agent",
        configDir: join(FAKE_HOME, ".cursor"),
        file: shared,
        realFile: shared,
        detected: true,
        skillInstalled: false,
        skillTarget: "claude",
        skillTargets: ["claude", "codex"],
        skillHome: standardHome,
        redirectedSkillTargets: ["claude"],
      };
      expect(aggregateRemediation([claude, cursor]).get(shared)).toEqual({
        targets: ["claude"],
        extraDirs: [standardHome],
      });
      const grok: ResolvedTarget = {
        id: "grok",
        label: "Grok Build",
        configDir: join(FAKE_HOME, ".grok"),
        file: shared,
        realFile: shared,
        detected: true,
        skillInstalled: false,
        skillTarget: "claude",
        skillTargets: ["claude"],
        skillHome: standardHome,
        redirectedSkillTargets: ["claude"],
      };
      expect(aggregateRemediation([grok, cursor]).get(shared)).toEqual({
        targets: [],
        extraDirs: [standardHome],
      });
    });

    test("dangling instruction-file symlinks to one missing target dedupe", async () => {
      // Regression: when the instruction files themselves are dangling
      // symlinks to the same not-yet-created shared file, the parent-only
      // fallback kept each link's distinct basename, so the aliases got
      // different identities and the second install overwrote the first
      // (backup-less, possibly with a different skill-pointer render).
      await setupHome([".codex", ".cursor", "shared"]);
      const shared = join(FAKE_HOME, "shared", "AGENTS.md"); // does not exist yet
      await symlink(shared, CODEX_FILE);
      await symlink(shared, join(FAKE_HOME, "AGENTS.md")); // cursor's file

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const byTarget = (id: string) =>
        report.results.find((r: { target: string }) => r.target === id);
      expect(byTarget("codex").action).toBe("install");
      expect(byTarget("cursor").action).toBe("covered");
      expect(byTarget("cursor").via).toBe("codex");

      const content = await Bun.file(shared).text();
      expect(content.split(BEGIN_MARKER).length - 1).toBe(1);
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

    test("shared real file renders the conservative pointer when any consumer lacks the skill", async () => {
      // Regression: codex owns the write to the shared file, but OpenCode
      // (its own skill dir, absent here) reads the same file via a symlink.
      // Rendering from the owner's skill state alone would emit `/gno`, a
      // pointer OpenCode cannot follow — the block must aggregate all
      // consumers and stay conservative.
      await setupHome([".codex/skills/gno", ".config/opencode"]);
      await Bun.write(join(FAKE_HOME, ".codex/skills/gno/SKILL.md"), "# gno\n");
      await Bun.write(CODEX_FILE, "# Shared\n");
      await symlink(CODEX_FILE, join(FAKE_HOME, ".config/opencode/AGENTS.md"));

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });

      const content = await Bun.file(CODEX_FILE).text();
      // Only OpenCode lacks the skill → remediation names exactly that target,
      // not `all` (which would fabricate absent harnesses).
      expect(content).toContain(
        "run `gno skill install --scope user --force --target opencode`"
      );
      expect(content).not.toContain("--target all");
      expect(content).not.toContain("`/gno`");

      // Verify mirrors the same aggregation: the shared file is ok, not
      // "outdated" against the owner's solo skill state.
      stdoutOutput = [];
      await verifyAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.ok).toBe(true);
      const codexResult = report.results.find(
        (r: { target: string }) => r.target === "codex"
      );
      expect(codexResult.status).toBe("ok");
    });

    test("shared real file renders the skill pointer once every consumer has the skill", async () => {
      // Codex's file shared with cursor via ~/AGENTS.md. Only the CODEX skill
      // is installed — but Cursor loads skills from both ~/.claude/skills and
      // ~/.codex/skills (spec/cli.md compatibility), so every consumer can
      // follow `/gno` and no remediation is rendered.
      await setupHome([".codex/skills/gno", ".cursor"]);
      await Bun.write(join(FAKE_HOME, ".codex/skills/gno/SKILL.md"), "# gno\n");
      await Bun.write(CODEX_FILE, "# Shared\n");
      await symlink(CODEX_FILE, join(FAKE_HOME, "AGENTS.md"));

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      expect(await Bun.file(CODEX_FILE).text()).toContain("`/gno`");

      stdoutOutput = [];
      await verifyAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      expect(JSON.parse(stdoutOutput.join("")).ok).toBe(true);
    });

    test("remediation for a shared file is minimal across consumers with alternatives", async () => {
      // Codex and Cursor share the file, neither has the skill. Codex can only
      // be fixed by `--target codex`; Cursor loads codex OR claude, so the
      // codex install already satisfies it — adding `--target claude` would
      // fabricate ~/.claude for a harness the operator never had.
      await setupHome([".codex", ".cursor"]);
      await Bun.write(CODEX_FILE, "# Shared\n");
      await symlink(CODEX_FILE, join(FAKE_HOME, "AGENTS.md"));

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      const content = await Bun.file(CODEX_FILE).text();
      expect(content).toContain(
        "run `gno skill install --scope user --force --target codex` and load"
      );
      expect(content).not.toContain("--target claude");
    });

    test("explicit-target install aggregates unrequested detected consumers of a shared file", async () => {
      // Regression: OpenCode's AGENTS.md symlinked to Codex's file, only the
      // codex skill installed. `install --target codex` filters resolution to
      // codex, but the skill aggregation must still span the full harness
      // matrix — otherwise the run emits `/gno` into a shared file OpenCode
      // cannot follow, and `verify --target all` flags the fresh block
      // outdated.
      await setupHome([".codex/skills/gno", ".config/opencode"]);
      await Bun.write(join(FAKE_HOME, ".codex/skills/gno/SKILL.md"), "# gno\n");
      await Bun.write(CODEX_FILE, "# Shared\n");
      await symlink(CODEX_FILE, join(FAKE_HOME, ".config/opencode/AGENTS.md"));

      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      // Explicit-target runs still only write the requested target's file.
      expect(report.results).toHaveLength(1);
      expect(report.results[0].target).toBe("codex");
      expect(report.results[0].action).toBe("install");

      const content = await Bun.file(CODEX_FILE).text();
      // OpenCode is the consumer lacking the skill → scoped remediation.
      expect(content).toContain(
        "run `gno skill install --scope user --force --target opencode`"
      );
      expect(content).not.toContain("`/gno`");

      // The bot-reported symptom: an all-target verify right after an
      // explicit-target install must pass, not report the block outdated.
      stdoutOutput = [];
      await verifyAgents({ target: "all", homeDir: FAKE_HOME, json: true });
      expect(JSON.parse(stdoutOutput.join("")).ok).toBe(true);
    });

    test("explicit-target verify mirrors the full-matrix aggregation", async () => {
      // Same shared-file layout, converged via --target all: a filtered
      // `verify --target codex` must render its expectation from every
      // detected consumer, not from codex's solo skill state.
      await setupHome([".codex/skills/gno", ".config/opencode"]);
      await Bun.write(join(FAKE_HOME, ".codex/skills/gno/SKILL.md"), "# gno\n");
      await Bun.write(CODEX_FILE, "# Shared\n");
      await symlink(CODEX_FILE, join(FAKE_HOME, ".config/opencode/AGENTS.md"));

      await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });

      stdoutOutput = [];
      await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.ok).toBe(true);
      const codexResult = report.results.find(
        (r: { target: string }) => r.target === "codex"
      );
      expect(codexResult.status).toBe("ok");
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

    test("refuses to write when the file changed after planning (no backup, nothing written)", async () => {
      // TOCTOU: an editor / dotfile sync / concurrent `gno agents` changes the
      // file between plan and write. The stale plan must not overwrite it.
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "# Original\n");
      const targets = resolveTargets("codex", { homeDir: FAKE_HOME });
      const [plan] = await planTargets(targets, "install");
      expect(plan?.action).toBe("install");

      await Bun.write(CODEX_FILE, "# Edited concurrently\n");
      let thrown: unknown;
      try {
        await applyPlan(plan!);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(String(thrown)).toMatch(/changed after it was planned/);
      expect(await Bun.file(CODEX_FILE).text()).toBe("# Edited concurrently\n");
      expect(
        readdirSync(join(FAKE_HOME, ".codex")).filter((f) =>
          f.includes(".gno-agents.bak.")
        )
      ).toEqual([]);
    });

    test("refuses to write when the instruction-file symlink was retargeted after planning", async () => {
      // The plan resolved ~/.codex/AGENTS.md → shared-1. Retargeting the link
      // to shared-2 before apply must fail: writing the cached destination
      // would modify a file the harness no longer reads.
      await setupHome([".codex", "shared"]);
      const shared1 = join(FAKE_HOME, "shared", "one.md");
      const shared2 = join(FAKE_HOME, "shared", "two.md");
      await Bun.write(shared1, "# One\n");
      await Bun.write(shared2, "# Two\n");
      await symlink(shared1, CODEX_FILE);
      const targets = resolveTargets("codex", { homeDir: FAKE_HOME });
      const [plan] = await planTargets(targets, "install");
      expect(plan?.action).toBe("install");

      await unlink(CODEX_FILE);
      await symlink(shared2, CODEX_FILE);
      let thrown: unknown;
      try {
        await applyPlan(plan!);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(String(thrown)).toMatch(/symlink retargeted/);
      expect(await Bun.file(shared1).text()).toBe("# One\n");
      expect(await Bun.file(shared2).text()).toBe("# Two\n");
    });

    test("a dangling link whose target parent is missing is written through the resolved target", async () => {
      // Regression: the link's target dir did not exist yet, so opening the
      // lexical link failed with ENOENT and the harness stayed unmanaged.
      // The resolved parent is created; the symlink itself is preserved.
      await setupHome([".codex"]);
      const sharedTarget = join(FAKE_HOME, "shared", "rules", "AGENTS.md");
      await symlink(sharedTarget, CODEX_FILE);
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results[0].action).toBe("install");
      expect(report.results[0].error).toBeUndefined();
      expect(await Bun.file(sharedTarget).text()).toContain(BEGIN_MARKER);
      expect((await stat(sharedTarget)).isFile()).toBe(true);
      expect(await readlink(CODEX_FILE)).toBe(sharedTarget);
    });

    test("refuses to recreate a dangling link's resolved parent removed after planning", async () => {
      // The link points outside the config dir; its target dir existed at plan
      // time. Removing it before apply must not be undone by the mkdir.
      await setupHome([".codex", "shared/rules"]);
      const sharedTarget = join(FAKE_HOME, "shared", "rules", "AGENTS.md");
      await symlink(sharedTarget, CODEX_FILE);
      const targets = resolveTargets("codex", { homeDir: FAKE_HOME });
      const [plan] = await planTargets(targets, "install");
      expect(plan?.fileExists).toBe(false);

      await rm(join(FAKE_HOME, "shared"), { recursive: true });
      let thrown: unknown;
      try {
        await applyPlan(plan!);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(String(thrown)).toMatch(/disappeared or moved/);
      expect(existsSync(join(FAKE_HOME, "shared"))).toBe(false);
    });

    test("refuses to recreate a config dir removed after a new file was planned", async () => {
      // The leaf check sees absent === absent; without revalidating the parent,
      // Bun.write would fabricate ~/.codex again and report success.
      await setupHome([".codex"]);
      const targets = resolveTargets("codex", { homeDir: FAKE_HOME });
      const [plan] = await planTargets(targets, "install");
      expect(plan?.fileExists).toBe(false);

      await rm(join(FAKE_HOME, ".codex"), { recursive: true });
      let thrown: unknown;
      try {
        await applyPlan(plan!);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(String(thrown)).toMatch(/disappeared or moved/);
      expect(existsSync(join(FAKE_HOME, ".codex"))).toBe(false);
    });

    test("an absent explicit covered target never resolves its covering chain", () => {
      // `--target grok` with ~/.grok absent must report the leaf not-detected
      // even when Claude's env is misconfigured — the covering harness is only
      // resolved once the leaf is detected.
      if (existsSync(join(homedir(), ".grok"))) {
        return; // real ~/.grok present: the covering chain would legitimately expand
      }
      const saved = {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        GNO_AGENTS_HOME_OVERRIDE: process.env.GNO_AGENTS_HOME_OVERRIDE,
      };
      process.env.CLAUDE_CONFIG_DIR = "relative/claude";
      delete process.env.GNO_AGENTS_HOME_OVERRIDE;
      try {
        const results = resolveTargets("grok"); // read-only detection against the real home
        expect(results.map((t) => t.id)).toEqual(["grok"]);
        expect(results[0]?.detected).toBe(false);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    test("an invalid dedicated skills override fails a requested harness, not 'skill missing'", () => {
      // CLAUDE_SKILLS_DIR=relative is a broken environment; treating it as an
      // absent skill would write a block whose remediation inherits the same
      // invalid env and fails immediately. Requested → VALIDATION; unrequested
      // (lenient aggregation) → dropped.
      const saved = process.env.CLAUDE_SKILLS_DIR;
      process.env.CLAUDE_SKILLS_DIR = "relative/skills";
      try {
        expect(() => resolveTargets("claude", { homeDir: FAKE_HOME })).toThrow(
          CliError
        );
        const lenient = resolveTargets("all", {
          homeDir: FAKE_HOME,
          lenient: true,
        });
        expect(lenient.some((t) => t.id === "claude")).toBe(false);
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_SKILLS_DIR;
        else process.env.CLAUDE_SKILLS_DIR = saved;
      }
    });

    test("lenient resolution drops an unrequested harness with misconfigured env", () => {
      // An explicit-target run aggregates skill state over the full matrix;
      // an unrelated harness's bad env (relative CLAUDE_CONFIG_DIR) must not
      // abort it. Requested/strict resolution still fails closed.
      const saved = {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        GNO_AGENTS_HOME_OVERRIDE: process.env.GNO_AGENTS_HOME_OVERRIDE,
      };
      process.env.CLAUDE_CONFIG_DIR = "relative/claude";
      delete process.env.GNO_AGENTS_HOME_OVERRIDE; // env redirects apply only without a home override
      try {
        expect(() => resolveTargets("all")).toThrow(CliError);
        const lenient = resolveTargets("all", { lenient: true }); // read-only detection against the real home
        expect(lenient.some((t) => t.id === "claude")).toBe(false);
        expect(lenient.some((t) => t.id === "codex")).toBe(true);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    test("a skill consumer is checked at the standard location despite the owner's redirect", () => {
      // Cursor loads Claude's skill from ~/.claude/skills even when
      // CLAUDE_CONFIG_DIR redirects Claude itself; Claude's own state follows
      // the redirect. While the redirect is active the consumer's remediation
      // must target the standard dir, not the redirected instance.
      const standardSkills = join(FAKE_HOME, ".claude", "skills");
      const saved = {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CLAUDE_SKILLS_DIR: process.env.CLAUDE_SKILLS_DIR,
      };
      const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      };
      try {
        // Config-dir redirect: Claude follows it; Cursor pins the standard dir.
        delete process.env.CLAUDE_SKILLS_DIR;
        process.env.CLAUDE_CONFIG_DIR = join(TEST_DIR, "redirected-claude");
        expect(skillStateLocation("claude", FAKE_HOME, false)).toEqual({
          target: "claude",
          homeDir: undefined,
        });
        expect(skillStateLocation("cursor", FAKE_HOME, false)).toEqual({
          target: "claude",
          skillsDir: standardSkills,
          skillHome: join(FAKE_HOME, ".claude"),
        });
        // Dedicated skills-dir override: also ignored for the borrowed skill.
        delete process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_SKILLS_DIR = join(TEST_DIR, "custom-claude-skills");
        expect(skillStateLocation("cursor", FAKE_HOME, false)).toEqual({
          target: "claude",
          skillsDir: standardSkills,
          skillHome: join(FAKE_HOME, ".claude"),
        });
        // Explicit home (isolation): pinned standard dir, no remediation redirect.
        expect(skillStateLocation("cursor", FAKE_HOME, true)).toEqual({
          target: "claude",
          skillsDir: standardSkills,
        });
        // Cursor can load from either Claude's or Codex's standard dir; the
        // first location is the remediation vehicle.
        expect(
          skillStateLocations("cursor", FAKE_HOME, true).map((l) => l.skillsDir)
        ).toEqual([standardSkills, join(FAKE_HOME, ".codex", "skills")]);
      } finally {
        restore();
      }

      // The remediation for such a consumer installs into the standard dir.
      const consumer: ResolvedTarget = {
        id: "cursor",
        label: "Cursor Agent",
        configDir: join(FAKE_HOME, ".cursor"),
        file: join(FAKE_HOME, "AGENTS.md"),
        realFile: join(FAKE_HOME, "AGENTS.md"),
        detected: true,
        skillInstalled: false,
        skillTarget: "claude",
        skillTargets: ["claude", "codex"],
        skillHome: join(FAKE_HOME, ".claude"),
      };
      const remediation = aggregateRemediation([consumer]).get(
        consumer.realFile
      );
      expect(remediation).toEqual({
        targets: [],
        extraDirs: [join(FAKE_HOME, ".claude")],
      });
      expect(renderBlockBody({ skillInstalled: false, remediation })).toContain(
        `--skills-dir '${join(FAKE_HOME, ".claude")}/skills'`
      );
    });

    test("runtime apply failures exit with the RUNTIME code, receipt still emitted", async () => {
      if (process.platform === "win32" || process.getuid?.() === 0) {
        return; // needs POSIX permission enforcement (root bypasses it)
      }
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "# Rules\n");
      const codexDir = join(FAKE_HOME, ".codex");
      await chmod(codexDir, 0o500); // backup file cannot be created
      let thrown: unknown;
      try {
        await installAgents({
          target: "codex",
          homeDir: FAKE_HOME,
          json: true,
        });
      } catch (err) {
        thrown = err;
      } finally {
        await chmod(codexDir, 0o700);
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe("RUNTIME");
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results[0].action).toBe("error");
      expect(report.results[0].detail).toMatch(/Backup failed/);
      expect(await Bun.file(CODEX_FILE).text()).toBe("# Rules\n");
    });

    test("an unreadable instruction file is a RUNTIME failure, not validation", async () => {
      if (process.platform === "win32" || process.getuid?.() === 0) {
        return; // needs POSIX permission enforcement (root bypasses it)
      }
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "# Rules\n");
      await chmod(CODEX_FILE, 0o000);
      let thrown: unknown;
      try {
        await installAgents({
          target: "codex",
          homeDir: FAKE_HOME,
          json: true,
        });
      } catch (err) {
        thrown = err;
      } finally {
        await chmod(CODEX_FILE, 0o600);
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe("RUNTIME");
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results[0].action).toBe("error");
      expect(report.results[0].detail).toMatch(/cannot read/);
    });

    test("backup inherits the source file's restrictive mode", async () => {
      if (process.platform === "win32") {
        return; // POSIX permission bits only
      }
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "# Private rules\n");
      await chmod(CODEX_FILE, 0o600);

      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      const backup = report.results[0].backup as string;
      expect(backup).toBeTruthy();
      // The backup is a byte-for-byte copy of private content — it must be
      // exactly as private, not umask-default 0644.
      expect((await stat(backup)).mode & 0o777).toBe(0o600);
      // The live file is replaced atomically via a sibling temp file; the
      // replacement keeps the source mode and no temp file is left behind.
      expect((await stat(CODEX_FILE)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(CODEX_FILE).text()).toContain(BEGIN_MARKER);
      expect(
        readdirSync(join(FAKE_HOME, ".codex")).filter((f) =>
          f.includes(".gno-agents.tmp.")
        )
      ).toEqual([]);
    });

    test("preserves a UTF-8 BOM across install, verify, and uninstall", async () => {
      await setupHome([".codex"]);
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const body = new TextEncoder().encode("# Rules\n\nKeep it simple.\n");
      const original = new Uint8Array(bom.length + body.length);
      original.set(bom);
      original.set(body, bom.length);
      await Bun.write(CODEX_FILE, original);

      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const installed = await Bun.file(CODEX_FILE).bytes();
      // BOM still leads the file; the block was spliced after the body.
      expect(Array.from(installed.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder().decode(installed)).toContain(BEGIN_MARKER);

      stdoutOutput = [];
      await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      expect(JSON.parse(stdoutOutput.join("")).ok).toBe(true);

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(Array.from(await Bun.file(CODEX_FILE).bytes())).toEqual(
        Array.from(original)
      );
    });

    test("separator-provenance token is authenticated by the stamp hash", async () => {
      // Regression: the hash covered the body only, so deleting the provenance
      // token from the stamp left the block "current" while uninstall would
      // then leave the install-added newline behind.
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "abc"); // no final newline → install stamps sep:nl
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const installed = await Bun.file(CODEX_FILE).text();
      expect(installed).toMatch(/ sep:nl pre:[0-9a-f]{8} /);

      // Tamper: strip the provenance token by hand.
      await Bun.write(
        CODEX_FILE,
        installed.replace(/ sep:nl pre:[0-9a-f]{8} /, " ")
      );
      stdoutOutput = [];
      let thrown: unknown;
      try {
        await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results[0].status).toBe("outdated");
      expect(report.results[0].hashOk).toBe(false);

      // Update re-stamps; the tampered provenance is dropped rather than
      // trusted, so a later uninstall consumes NO byte outside the markers —
      // neither the install-added leading newline nor the newline after END
      // (both stay: "abc" + "\n" + "\n"). Byte-identity is forfeited only
      // because the operator edited inside the managed block.
      await installAgents(
        { target: "codex", homeDir: FAKE_HOME, json: true },
        "update"
      );
      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe("abc\n\n");
    });

    test("uninstall never consumes a newline on a forged sep:nl claim", async () => {
      // A user-owned newline precedes the block; someone edits the stamp's
      // provenance to claim install added it. The token fails the body+token
      // hash, so uninstall must preserve that newline instead of trusting it.
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "abc\n");
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const installed = await Bun.file(CODEX_FILE).text();
      // Installed shape: "abc\n\n<block>\n" stamped sep:blank. Collapse to one
      // user newline and forge the provenance token to sep:nl.
      const forged = installed
        .replace("abc\n\n", "abc\n")
        .replace(/ sep:blank pre:([0-9a-f]{8}) —/, " sep:nl pre:$1 —");
      expect(forged).toMatch(/ sep:nl pre:[0-9a-f]{8} —/);
      await Bun.write(CODEX_FILE, forged);

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      // Unproven claim → the user's newline AND the newline after END stay.
      expect(await Bun.file(CODEX_FILE).text()).toBe("abc\n\n");
    });

    test("refuses to rewrite a non-UTF-8 file; bytes untouched", async () => {
      await setupHome([".codex"]);
      // 0xff is never valid in UTF-8.
      const original = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]);
      await Bun.write(CODEX_FILE, original);

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
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results[0].action).toBe("error");
      expect(report.results[0].detail).toMatch(/not valid UTF-8/);
      expect(Array.from(await Bun.file(CODEX_FILE).bytes())).toEqual(
        Array.from(original)
      );
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
      // The added newline is recorded inside the block, not inferred later.
      expect(installed).toMatch(/ sep:nl pre:[0-9a-f]{8} —/);

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe(noFinalNewline);
    });

    test("uninstall preserves user-owned newlines around an unstamped block", async () => {
      // Regression: a block preceded by exactly one newline (e.g. pasted
      // after a normally terminated line) carries no separator provenance, so
      // BOTH the newline before it and the one after its END marker are user
      // content — nothing outside the markers is consumed.
      await setupHome([".codex"]);
      const block = renderBlock({ skillInstalled: false });
      await Bun.write(CODEX_FILE, `# My rules\n${block}\n`);

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe("# My rules\n\n");
    });

    test("uninstall keeps the line break after an inline pasted block", async () => {
      // Regression: the newline after END was consumed unconditionally, so
      // `abc<block>\nxyz` collapsed to `abcxyz`. Without provenance that byte
      // is the operator's line break.
      await setupHome([".codex"]);
      const block = renderBlock({ skillInstalled: false });
      await Bun.write(CODEX_FILE, `abc${block}\nxyz`);

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe("abc\nxyz");
    });

    test("install into an empty file round-trips to empty (sep:none)", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "");
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      expect(await Bun.file(CODEX_FILE).text()).toMatch(
        /^<!-- gno:agents:begin -->\n<!-- gno-agents block v\d+ sha256:[0-9a-f]{16} sep:none pre:[0-9a-f]{8} /
      );
      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe("");
    });

    test("uninstall leaves an operator's blank line intact under a moved block", async () => {
      // Regression: the `\n\n` branch consumed a newline unconditionally, so a
      // block pasted after an existing blank line (`abc\n\n<block>`) lost the
      // operator's newline. A moved block carries a valid stamp whose context
      // hash does not match its new surroundings — provenance must not apply.
      await setupHome([".codex"]);
      const moved = renderBlock({
        skillInstalled: false,
        separator: { kind: "blank", pre: separatorContextHash("elsewhere\n") },
      });
      await Bun.write(CODEX_FILE, `abc\n\n${moved}\n`);

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      // No proven provenance here → neither the blank line above nor the
      // newline after END is consumed; only the markers and body go.
      expect(await Bun.file(CODEX_FILE).text()).toBe("abc\n\n\n");
    });

    test("install after a newline-terminated file round-trips byte-identically", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "abc\n");
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      expect(await Bun.file(CODEX_FILE).text()).toMatch(
        /^abc\n\n<!-- gno:agents:begin -->\n<!-- gno-agents block v\d+ sha256:[0-9a-f]{16} sep:blank pre:[0-9a-f]{8} /
      );
      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe("abc\n");
    });

    test("update preserves the separator provenance across block replacement", async () => {
      await setupHome([".codex"]);
      const noFinalNewline = "# My rules\n\nKeep it simple.";
      await Bun.write(CODEX_FILE, noFinalNewline);
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });

      // Simulate a stale-but-genuine block from an older release: different
      // version and body, sep:nl token kept with its real context hash, and a
      // stamp hash that AUTHENTICATES that body+token (a forged/unauthenticated
      // token is dropped instead — covered by the tamper tests).
      const installed = await Bun.file(CODEX_FILE).text();
      const separator = {
        kind: "nl" as const,
        pre: separatorContextHash(noFinalNewline),
      };
      const stale = installed.replace(
        /<!-- gno-agents block v\d+ sha256:[0-9a-f]{16} sep:nl pre:[0-9a-f]{8} —[^>]*-->[\s\S]*?(?=\n<!-- gno:agents:end -->)/,
        `<!-- gno-agents block v0 sha256:${hashBlockBody("old body", separator)} sep:nl pre:${separator.pre} — stale -->\nold body`
      );
      expect(stale).not.toBe(installed);
      await Bun.write(CODEX_FILE, stale);

      await installAgents(
        { target: "codex", homeDir: FAKE_HOME, json: true },
        "update"
      );
      expect(await Bun.file(CODEX_FILE).text()).toMatch(
        / sep:nl pre:[0-9a-f]{8} —/
      );

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe(noFinalNewline);
    });

    test("uninstall keeps line structure when content follows a sep:nl block", async () => {
      // Mid-file sep:nl block: the install-added newline now terminates the
      // preceding line, so consuming it would merge lines — keep it.
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "# My rules");
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const installed = await Bun.file(CODEX_FILE).text();
      await Bun.write(CODEX_FILE, `${installed}# After\n`);

      await uninstallAgents({
        target: "codex",
        homeDir: FAKE_HOME,
        json: true,
      });
      expect(await Bun.file(CODEX_FILE).text()).toBe("# My rules\n# After\n");
    });

    test("verify reports ok for a sep:nl-stamped install", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, "# My rules");
      await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      stdoutOutput = [];

      await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
      const report = JSON.parse(stdoutOutput.join(""));
      expect(report.results[0].status).toBe("ok");
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
