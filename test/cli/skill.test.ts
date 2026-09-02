import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { installSkill } from "../../src/cli/commands/skill/install";
import {
  ENV_CODEX_SKILLS_DIR,
  ENV_HERMES_SKILLS_DIR,
  ENV_SKILLS_HOME_OVERRIDE,
  resolveAllPaths,
  resolveSkillPaths,
  validatePathForDeletion,
} from "../../src/cli/commands/skill/paths";
import { showPaths } from "../../src/cli/commands/skill/paths-cmd";
import { showSkill } from "../../src/cli/commands/skill/show";
import { uninstallSkill } from "../../src/cli/commands/skill/uninstall";
import { CliError } from "../../src/cli/errors";
import { resetGlobals } from "../../src/cli/program";
import { safeRm } from "../helpers/cleanup";

// Temp directory for tests
const TEST_DIR = join(import.meta.dir, ".temp-skill-tests");
const FAKE_HOME = join(TEST_DIR, "home");
const FAKE_CWD = join(TEST_DIR, "project");

// Capture stdout output
let stdoutOutput: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const mockWrite = (chunk: string | Uint8Array): boolean => {
  stdoutOutput.push(String(chunk));
  return true;
};

describe("skill CLI commands", () => {
  beforeEach(async () => {
    // Set up mocks
    process.stdout.write = mockWrite as typeof process.stdout.write;
    stdoutOutput = [];
    resetGlobals();

    // Set up temp directories
    await safeRm(TEST_DIR);
    await mkdir(FAKE_HOME, { recursive: true });
    await mkdir(FAKE_CWD, { recursive: true });
  });

  afterEach(async () => {
    // Restore mocks
    process.stdout.write = originalWrite;

    // Clean up temp dir
    await safeRm(TEST_DIR);
  });

  describe("resolveSkillPaths", () => {
    test("resolves project/claude paths", () => {
      const paths = resolveSkillPaths({
        scope: "project",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // base is the .claude directory
      expect(paths.base).toBe(join(FAKE_CWD, ".claude"));
      expect(paths.skillsDir).toBe(join(FAKE_CWD, ".claude", "skills"));
      expect(paths.gnoDir).toBe(join(FAKE_CWD, ".claude", "skills", "gno"));
    });

    test("resolves user/claude paths", () => {
      const paths = resolveSkillPaths({
        scope: "user",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // base is the .claude directory
      expect(paths.base).toBe(join(FAKE_HOME, ".claude"));
      expect(paths.skillsDir).toBe(join(FAKE_HOME, ".claude", "skills"));
      expect(paths.gnoDir).toBe(join(FAKE_HOME, ".claude", "skills", "gno"));
    });

    test("resolves project/codex paths", () => {
      const paths = resolveSkillPaths({
        scope: "project",
        target: "codex",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(join(FAKE_CWD, ".codex", "skills"));
      expect(paths.gnoDir).toBe(join(FAKE_CWD, ".codex", "skills", "gno"));
    });

    test("resolves user/codex paths", () => {
      const paths = resolveSkillPaths({
        scope: "user",
        target: "codex",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(join(FAKE_HOME, ".codex", "skills"));
      expect(paths.gnoDir).toBe(join(FAKE_HOME, ".codex", "skills", "gno"));
    });

    test("resolves user/opencode paths", () => {
      const paths = resolveSkillPaths({
        scope: "user",
        target: "opencode",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(
        join(FAKE_HOME, ".config", "opencode", "skills")
      );
      expect(paths.gnoDir).toBe(
        join(FAKE_HOME, ".config", "opencode", "skills", "gno")
      );
    });

    test("resolves user/openclaw paths", () => {
      const paths = resolveSkillPaths({
        scope: "user",
        target: "openclaw",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(join(FAKE_HOME, ".openclaw", "skills"));
      expect(paths.gnoDir).toBe(join(FAKE_HOME, ".openclaw", "skills", "gno"));
    });

    test("resolves project/hermes paths", () => {
      const paths = resolveSkillPaths({
        scope: "project",
        target: "hermes",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(join(FAKE_CWD, ".hermes", "skills"));
      expect(paths.gnoDir).toBe(join(FAKE_CWD, ".hermes", "skills", "gno"));
    });

    test("resolves user/hermes paths", () => {
      const paths = resolveSkillPaths({
        scope: "user",
        target: "hermes",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(join(FAKE_HOME, ".hermes", "skills"));
      expect(paths.gnoDir).toBe(join(FAKE_HOME, ".hermes", "skills", "gno"));
    });

    test("uses absolute HERMES_SKILLS_DIR override", () => {
      const overrideDir = join(TEST_DIR, "custom-hermes-skills");
      process.env[ENV_HERMES_SKILLS_DIR] = overrideDir;
      try {
        const paths = resolveSkillPaths({
          scope: "user",
          target: "hermes",
          cwd: FAKE_CWD,
          homeDir: FAKE_HOME,
        });

        expect(paths.skillsDir).toBe(overrideDir);
        expect(paths.gnoDir).toBe(join(overrideDir, "gno"));
      } finally {
        delete process.env[ENV_HERMES_SKILLS_DIR];
      }
    });

    test("rejects relative HERMES_SKILLS_DIR override", () => {
      process.env[ENV_HERMES_SKILLS_DIR] = "relative/hermes/skills";
      try {
        expect(() =>
          resolveSkillPaths({
            scope: "user",
            target: "hermes",
            cwd: FAKE_CWD,
            homeDir: FAKE_HOME,
          })
        ).toThrow("HERMES_SKILLS_DIR must be an absolute path");
      } finally {
        delete process.env[ENV_HERMES_SKILLS_DIR];
      }
    });

    // Harness config-dir overrides (CODEX_HOME / CLAUDE_CONFIG_DIR): user
    // scope resolves under the redirected harness so install and the agents
    // installer's skill-state check agree on where the skill lives.
    const withEnv = (
      vars: Record<string, string | undefined>,
      fn: () => void
    ) => {
      const saved: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };

    test("user/codex resolves under CODEX_HOME when set", () => {
      const codexHome = join(TEST_DIR, "custom-codex-home");
      withEnv(
        { CODEX_HOME: codexHome, [ENV_SKILLS_HOME_OVERRIDE]: undefined },
        () => {
          const paths = resolveSkillPaths({ scope: "user", target: "codex" });
          expect(paths.base).toBe(codexHome);
          expect(paths.gnoDir).toBe(join(codexHome, "skills", "gno"));
        }
      );
    });

    test("explicit homeDir suppresses CODEX_HOME (isolation)", () => {
      withEnv({ CODEX_HOME: join(TEST_DIR, "custom-codex-home") }, () => {
        const paths = resolveSkillPaths({
          scope: "user",
          target: "codex",
          homeDir: FAKE_HOME,
        });
        expect(paths.gnoDir).toBe(join(FAKE_HOME, ".codex", "skills", "gno"));
      });
    });

    test("CODEX_SKILLS_DIR wins over CODEX_HOME", () => {
      const skillsDir = join(TEST_DIR, "custom-codex-skills");
      withEnv(
        {
          CODEX_HOME: join(TEST_DIR, "custom-codex-home"),
          [ENV_CODEX_SKILLS_DIR]: skillsDir,
          [ENV_SKILLS_HOME_OVERRIDE]: undefined,
        },
        () => {
          const paths = resolveSkillPaths({ scope: "user", target: "codex" });
          expect(paths.skillsDir).toBe(skillsDir);
        }
      );
    });

    test("--skills-dir option wins over env and home", () => {
      const skillsDir = join(TEST_DIR, "instance", "skills");
      withEnv(
        {
          CODEX_HOME: join(TEST_DIR, "custom-codex-home"),
          [ENV_CODEX_SKILLS_DIR]: join(TEST_DIR, "env-skills"),
        },
        () => {
          const paths = resolveSkillPaths({
            scope: "user",
            target: "codex",
            homeDir: FAKE_HOME,
            skillsDir,
          });
          expect(paths.skillsDir).toBe(skillsDir);
          expect(paths.gnoDir).toBe(join(skillsDir, "gno"));
        }
      );
      expect(() =>
        resolveSkillPaths({
          scope: "user",
          target: "codex",
          skillsDir: "relative/skills",
        })
      ).toThrow("--skills-dir must be an absolute path");
      // A root-level dir would install `<dir>/gno` once and then fail the
      // deletion depth guard on `--force` and uninstall — refuse it before the
      // first install. A nonexistent path keeps the check host-independent
      // (`/tmp` realpaths to `/private/tmp` on macOS, which is deep enough).
      expect(() =>
        resolveSkillPaths({
          scope: "user",
          target: "codex",
          skillsDir: "/gno-root-level-skills",
        })
      ).toThrow("--skills-dir must be at least two levels below");
    });

    test("a short explicit skills dir is removable when it is the resolved destination", () => {
      // Regression: the total-length heuristic rejected `/tmp/x/skills/gno`
      // even though it is exactly the explicit --skills-dir destination,
      // breaking uninstall and the idempotent --force remediation.
      expect(
        validatePathForDeletion(
          "/tmp/x/skills/gno",
          "/tmp/x",
          "/tmp/x/skills/gno"
        )
      ).toBeNull();
      // Without an explicit destination the heuristic still guards short paths.
      expect(validatePathForDeletion("/tmp/x/skills/gno", "/tmp/x")).toBe(
        "Path is suspiciously short"
      );
      // A near-root destination is refused even when explicit (depth guard).
      expect(validatePathForDeletion("/skills/gno", "/", "/skills/gno")).toBe(
        "Path is too close to the filesystem root"
      );
    });

    test("uninstall honors --skills-dir (portable removal path)", async () => {
      const skillsDir = join(TEST_DIR, "instance", "skills");
      await installSkill({
        scope: "user",
        target: "claude",
        skillsDir,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
        json: true,
      });
      expect(await Bun.file(join(skillsDir, "gno", "SKILL.md")).exists()).toBe(
        true
      );
      stdoutOutput = [];
      await uninstallSkill({
        scope: "user",
        target: "claude",
        skillsDir,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
        json: true,
      });
      expect(await Bun.file(join(skillsDir, "gno", "SKILL.md")).exists()).toBe(
        false
      );
      // Same single-target constraint as install.
      let thrown: unknown;
      try {
        await uninstallSkill({
          scope: "user",
          target: "all",
          skillsDir,
          homeDir: FAKE_HOME,
          cwd: FAKE_CWD,
          json: true,
        });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as CliError).code).toBe("VALIDATION");
    });

    test("a symlinked --skills-dir stays manageable (--force + uninstall)", async () => {
      // `<instance>/skills -> <shared>`: containment must be checked against
      // the resolved skills root, not the lexical parent, or the initial
      // install succeeds while the idempotent --force command and the
      // matching uninstall are refused as "outside expected base".
      const shared = join(TEST_DIR, "shared-skills");
      const instance = join(TEST_DIR, "linked-instance");
      const skillsDir = join(instance, "skills");
      await mkdir(shared, { recursive: true });
      await mkdir(instance, { recursive: true });
      await symlink(shared, skillsDir);
      const base = {
        scope: "user" as const,
        target: "claude" as const,
        skillsDir,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
        json: true,
      };
      await installSkill(base);
      expect(await Bun.file(join(shared, "gno", "SKILL.md")).exists()).toBe(
        true
      );
      stdoutOutput = [];
      await installSkill({ ...base, force: true });
      stdoutOutput = [];
      await uninstallSkill(base);
      expect(await Bun.file(join(shared, "gno", "SKILL.md")).exists()).toBe(
        false
      );
    });

    test("--skills-dir with --target all is rejected as validation", async () => {
      let thrown: unknown;
      try {
        await installSkill({
          scope: "user",
          target: "all",
          skillsDir: join(TEST_DIR, "instance", "skills"),
          homeDir: FAKE_HOME,
          cwd: FAKE_CWD,
          json: true,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe("VALIDATION");
      expect(String(thrown)).toMatch(/single --target/);
    });

    test("rejects relative CODEX_HOME", () => {
      withEnv(
        { CODEX_HOME: "relative/codex", [ENV_SKILLS_HOME_OVERRIDE]: undefined },
        () => {
          expect(() =>
            resolveSkillPaths({ scope: "user", target: "codex" })
          ).toThrow("CODEX_HOME must be an absolute path");
        }
      );
    });
  });

  describe("resolveAllPaths", () => {
    test("returns all 10 combinations for scope=all, target=all", () => {
      const results = resolveAllPaths("all", "all", {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(results).toHaveLength(10);
      const combos = results.map((r) => `${r.scope}/${r.target}`);
      expect(combos).toContain("project/claude");
      expect(combos).toContain("project/codex");
      expect(combos).toContain("project/opencode");
      expect(combos).toContain("project/openclaw");
      expect(combos).toContain("project/hermes");
      expect(combos).toContain("user/claude");
      expect(combos).toContain("user/codex");
      expect(combos).toContain("user/opencode");
      expect(combos).toContain("user/openclaw");
      expect(combos).toContain("user/hermes");
    });

    test("filters by scope", () => {
      const results = resolveAllPaths("project", "all", {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(results).toHaveLength(5);
      expect(results.every((r) => r.scope === "project")).toBe(true);
    });

    test("filters by target", () => {
      const results = resolveAllPaths("all", "claude", {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.target === "claude")).toBe(true);
    });
  });

  describe("validatePathForDeletion", () => {
    test("accepts valid gno skill path", () => {
      const base = "/home/user";
      const destDir = "/home/user/.claude/skills/gno";
      expect(validatePathForDeletion(destDir, base)).toBeNull();
    });

    test("rejects path not ending in /gno", () => {
      const base = "/home/user";
      const destDir = "/home/user/.claude/skills/other";
      const error = validatePathForDeletion(destDir, base);
      expect(error).toContain("gno");
    });

    test("rejects path not under base", () => {
      const base = "/home/user";
      const destDir = "/other/path/.claude/skills/gno";
      const error = validatePathForDeletion(destDir, base);
      expect(error).toContain("base");
    });

    test("rejects path not ending in /skills/gno", () => {
      const base = "/home/user";
      const destDir = "/home/user/gno";
      const error = validatePathForDeletion(destDir, base);
      expect(error).toContain("suffix");
    });

    test("rejects symlinked parent escaping base", async () => {
      const base = join(TEST_DIR, "symlink-base", ".claude");
      const outside = join(TEST_DIR, "outside-skills");
      await mkdir(base, { recursive: true });
      await mkdir(join(outside, "gno"), { recursive: true });
      await symlink(outside, join(base, "skills"));

      const error = validatePathForDeletion(join(base, "skills", "gno"), base);
      expect(error).toContain("resolves outside");
    });
  });

  describe("installSkill", () => {
    test("installs skill to project/claude", async () => {
      await installSkill({
        scope: "project",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const skillDir = join(FAKE_CWD, ".claude", "skills", "gno");
      const files = await readdir(skillDir);
      expect(files).toContain("SKILL.md");
      expect(
        await Bun.file(
          join(skillDir, "recipes", "brain-first-lookup.md")
        ).exists()
      ).toBe(true);
      expect(stdoutOutput.join("")).toContain("Installed");
    });

    test("installs skill to all targets", async () => {
      await installSkill({
        scope: "project",
        target: "all",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const claudeDir = join(FAKE_CWD, ".claude", "skills", "gno");
      const codexDir = join(FAKE_CWD, ".codex", "skills", "gno");
      const hermesDir = join(FAKE_CWD, ".hermes", "skills", "gno");

      expect(await Bun.file(join(claudeDir, "SKILL.md")).exists()).toBe(true);
      expect(await Bun.file(join(codexDir, "SKILL.md")).exists()).toBe(true);
      expect(await Bun.file(join(hermesDir, "SKILL.md")).exists()).toBe(true);
    });

    test("installs and uninstalls skill to user/hermes", async () => {
      await installSkill({
        scope: "user",
        target: "hermes",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const skillDir = join(FAKE_HOME, ".hermes", "skills", "gno");
      expect(await Bun.file(join(skillDir, "SKILL.md")).exists()).toBe(true);

      stdoutOutput = [];
      await uninstallSkill({
        scope: "user",
        target: "hermes",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(await Bun.file(join(skillDir, "SKILL.md")).exists()).toBe(false);
      expect(stdoutOutput.join("")).toContain("Uninstalled");
    });

    test("installs and uninstalls hermes with HERMES_SKILLS_DIR override", async () => {
      const overrideDir = join(TEST_DIR, "hermes-override");
      process.env[ENV_HERMES_SKILLS_DIR] = overrideDir;
      try {
        await installSkill({
          scope: "user",
          target: "hermes",
          cwd: FAKE_CWD,
          homeDir: FAKE_HOME,
        });

        const skillDir = join(overrideDir, "gno");
        expect(await Bun.file(join(skillDir, "SKILL.md")).exists()).toBe(true);

        stdoutOutput = [];
        await uninstallSkill({
          scope: "user",
          target: "hermes",
          cwd: FAKE_CWD,
          homeDir: FAKE_HOME,
        });

        expect(await Bun.file(join(skillDir, "SKILL.md")).exists()).toBe(false);
      } finally {
        delete process.env[ENV_HERMES_SKILLS_DIR];
      }
    });

    test("errors on duplicate without --force", async () => {
      // First install
      await installSkill({
        scope: "project",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Second install should fail
      let error: CliError | undefined;
      try {
        await installSkill({
          scope: "project",
          target: "claude",
          cwd: FAKE_CWD,
          homeDir: FAKE_HOME,
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.message).toContain("already installed");
    });

    test("overwrites with --force", async () => {
      // First install
      await installSkill({
        scope: "project",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Second install with force
      await installSkill({
        scope: "project",
        target: "claude",
        force: true,
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Should succeed
      const skillDir = join(FAKE_CWD, ".claude", "skills", "gno");
      expect(await Bun.file(join(skillDir, "SKILL.md")).exists()).toBe(true);
    });
  });

  describe("uninstallSkill", () => {
    test("uninstalls existing skill", async () => {
      // First install
      await installSkill({
        scope: "project",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Then uninstall
      stdoutOutput = [];
      await uninstallSkill({
        scope: "project",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const skillDir = join(FAKE_CWD, ".claude", "skills", "gno");
      expect(await Bun.file(join(skillDir, "SKILL.md")).exists()).toBe(false);
      expect(stdoutOutput.join("")).toContain("Uninstalled");
    });

    test("errors if skill not found", async () => {
      let error: CliError | undefined;
      try {
        await uninstallSkill({
          scope: "project",
          target: "claude",
          cwd: FAKE_CWD,
          homeDir: FAKE_HOME,
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.message).toContain("not found");
    });
  });

  describe("showSkill", () => {
    test("shows SKILL.md by default", async () => {
      await showSkill({});

      const output = stdoutOutput.join("");
      expect(output).toContain("name: gno");
      expect(output).toContain("description:");
    });

    test("shows specific file", async () => {
      await showSkill({ file: "cli-reference.md" });

      const output = stdoutOutput.join("");
      expect(output).toContain("CLI Reference");
    });

    test("shows nested recipe file", async () => {
      await showSkill({ file: "recipes/brain-first-lookup.md" });

      const output = stdoutOutput.join("");
      expect(output).toContain("Brain-First Lookup");
      expect(output).toContain("recipes/brain-first-lookup.md");
    });

    test("shows all files with --all", async () => {
      await showSkill({ all: true });

      const output = stdoutOutput.join("");
      expect(output).toContain("--- SKILL.md ---");
      expect(output).toContain("--- cli-reference.md ---");
      expect(output).toContain("--- recipes/brain-first-lookup.md ---");
    });

    test("errors on unknown file", async () => {
      let error: CliError | undefined;
      try {
        await showSkill({ file: "nonexistent.md" });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.message).toContain("Unknown file");
    });

    test("rejects unsafe file paths", async () => {
      for (const file of ["../SKILL.md", "/tmp/SKILL.md", "recipes\\x.md"]) {
        let error: CliError | undefined;
        try {
          await showSkill({ file });
        } catch (e) {
          error = e as CliError;
        }

        expect(error).toBeInstanceOf(CliError);
        expect(error?.code).toBe("VALIDATION");
      }
    });
  });

  describe("showPaths", () => {
    test("shows all paths", async () => {
      await showPaths({
        scope: "all",
        target: "all",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const output = stdoutOutput.join("");
      expect(output).toContain("claude/project");
      expect(output).toContain("claude/user");
      expect(output).toContain("codex/project");
      expect(output).toContain("codex/user");
      expect(output).toContain("hermes/project");
      expect(output).toContain("hermes/user");
    });

    test("shows installed status", async () => {
      // Install first
      await installSkill({
        scope: "project",
        target: "claude",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      stdoutOutput = [];
      await showPaths({
        scope: "all",
        target: "all",
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const output = stdoutOutput.join("");
      expect(output).toContain("(installed)");
      expect(output).toContain("(not installed)");
    });
  });
});
