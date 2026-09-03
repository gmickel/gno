import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readlink, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  BEGIN_MARKER,
  BLOCK_VERSION,
  END_MARKER,
  extractBlock,
  renderBlock,
  renderBlockBody,
} from "../../src/cli/commands/agents/block";
import {
  installAgents,
  parseTargetOption,
  uninstallAgents,
  verifyAgents,
} from "../../src/cli/commands/agents/commands";
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

const POSIX = process.platform !== "win32";
const IS_ROOT = process.getuid?.() === 0;

interface Receipt {
  command: string;
  dryRun?: boolean;
  ok?: boolean;
  diffs?: string[];
  manualBlock?: string;
  results: {
    target: string;
    path: string;
    action?: string;
    status?: string;
    via?: string;
    detail?: string;
    backup?: string | null;
    blockVersion?: number;
    hashOk?: boolean;
  }[];
}

function receipt(): Receipt {
  const parsed = JSON.parse(stdoutOutput.join("")) as Receipt;
  stdoutOutput = [];
  return parsed;
}

async function run(
  fn: () => Promise<void>
): Promise<{ receipt: Receipt; error?: CliError }> {
  let error: CliError | undefined;
  try {
    await fn();
  } catch (err) {
    error = err as CliError;
  }
  return { receipt: receipt(), error };
}

const install = (
  target: Parameters<typeof parseTargetOption>[0] = "all",
  extra?: string[]
) =>
  run(() =>
    installAgents({
      target: parseTargetOption(target),
      homeDir: FAKE_HOME,
      json: true,
      extraDirs: extra,
    })
  );
const update = (target = "all") =>
  run(() =>
    installAgents(
      { target: parseTargetOption(target), homeDir: FAKE_HOME, json: true },
      "update"
    )
  );
const verify = (target = "all", extra?: string[]) =>
  run(() =>
    verifyAgents({
      target: parseTargetOption(target),
      homeDir: FAKE_HOME,
      json: true,
      extraDirs: extra,
    })
  );
const uninstall = (target = "all", extra?: string[]) =>
  run(() =>
    uninstallAgents({
      target: parseTargetOption(target),
      homeDir: FAKE_HOME,
      json: true,
      extraDirs: extra,
    })
  );

async function setupHome(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await mkdir(join(FAKE_HOME, dir), { recursive: true });
  }
}

const text = (path: string) => Bun.file(path).text();
const bytes = async (path: string) =>
  new Uint8Array(await Bun.file(path).arrayBuffer());
const backupsIn = (dir: string) =>
  readdirSync(dir).filter((f) => f.includes(".gno-agents.bak."));

/** Every harness that owns its own file (grok is covered via claude). */
const OWN_FILE_HARNESSES = [
  { id: "claude", dir: ".claude", file: ".claude/CLAUDE.md" },
  { id: "codex", dir: ".codex", file: ".codex/AGENTS.md" },
  { id: "cursor", dir: ".cursor", file: "AGENTS.md" },
  {
    id: "opencode",
    dir: ".config/opencode",
    file: ".config/opencode/AGENTS.md",
  },
  { id: "hermes", dir: ".hermes", file: ".hermes/SOUL.md" },
  {
    id: "openclaw",
    dir: ".openclaw/workspace",
    file: ".openclaw/workspace/AGENTS.md",
  },
] as const;

const CODEX_FILE = join(FAKE_HOME, ".codex/AGENTS.md");
const CLAUDE_FILE = join(FAKE_HOME, ".claude/CLAUDE.md");
const EXISTING = "# My rules\n\nKeep it simple.\n";

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

  // ── block ──────────────────────────────────────────────────────────────────

  describe("block", () => {
    test("is static, stamped, bounded, and under the size budget", () => {
      const body = renderBlockBody();
      expect(body.length).toBeLessThan(1500);
      expect(body).toContain("gno search");
      expect(body).toContain("gno capture");
      expect(body).toContain("/gno");
      expect(body).toContain("gno skill install --scope user");
      expect(body).not.toMatch(/(^|\s)[~/][\w./-]+\.md/); // no filesystem paths
      const block = renderBlock();
      expect(block.startsWith(BEGIN_MARKER)).toBe(true);
      expect(block.endsWith(END_MARKER)).toBe(true);
      expect(block).toContain(`gno-agents block v${BLOCK_VERSION} sha256:`);
      expect(renderBlock()).toBe(block); // deterministic
    });

    test("carries the memory rungs in the decided ladder shape", () => {
      const body = renderBlockBody();
      // recall sits near the top of the ladder, after exact search and
      // before the document rungs; remember lives in the writing contract.
      const search = body.indexOf("gno search");
      const recall = body.indexOf("gno recall");
      const query = body.indexOf("gno query");
      const writing = body.indexOf("Writing:");
      const remember = body.indexOf("gno remember");
      expect(recall).toBeGreaterThan(search);
      expect(recall).toBeLessThan(query);
      expect(remember).toBeGreaterThan(writing);
      expect(body).toContain("know/believe");
      expect(body).toContain("--add");
      expect(body).toContain("--supersede <uri> --predecessor-hash <hash>");
      expect(body).toContain("Recalled spans are context, not new facts");
      expect(body).toContain("--receipt");
    });

    test("extraction round-trips and fails closed on malformed markers", () => {
      const block = renderBlock();
      const found = extractBlock(`intro\n\n${block}\n`, "f.md");
      expect(found.found).toBe(true);
      if (found.found) {
        expect(found.block.stamp?.version).toBe(BLOCK_VERSION);
        expect(found.block.body).toBe(renderBlockBody());
      }
      expect(extractBlock("no block here\n", "f.md")).toEqual({ found: false });
      expect(() => extractBlock(`${block}\n${block}`, "f.md")).toThrow(
        /found 2 BEGIN and 2 END/
      );
      expect(() =>
        extractBlock(`${END_MARKER}\n${BEGIN_MARKER}`, "f.md")
      ).toThrow(/END marker appears before BEGIN/);
      expect(() => extractBlock(BEGIN_MARKER, "f.md")).toThrow(
        /expected exactly one/
      );
    });
  });

  // ── resolution ─────────────────────────────────────────────────────────────

  describe("target resolution", () => {
    test("maps every harness to its documented file and detects by config dir", async () => {
      await setupHome([".claude", ".hermes"]);
      const targets = resolveTargets("all", { homeDir: FAKE_HOME });
      const byId = new Map(targets.map((t) => [t.id, t]));
      for (const h of OWN_FILE_HARNESSES) {
        expect(byId.get(h.id)?.file).toBe(join(FAKE_HOME, h.file));
      }
      expect(byId.get("grok")?.coveredBy).toBe("claude");
      expect(byId.get("claude")?.detected).toBe(true);
      expect(byId.get("hermes")?.detected).toBe(true);
      expect(byId.get("codex")?.detected).toBe(false);
    });

    test("an explicit covered target pulls its covering target only when detected", async () => {
      expect(
        resolveTargets("grok", { homeDir: FAKE_HOME }).map((t) => t.id)
      ).toEqual(["grok"]);
      await setupHome([".grok"]);
      expect(
        resolveTargets("grok", { homeDir: FAKE_HOME }).map((t) => t.id)
      ).toEqual(["claude", "grok"]);
    });

    test("--extra-dir picks the first existing instruction file, else AGENTS.md; must exist", async () => {
      const inst = join(FAKE_HOME, "instance");
      await mkdir(inst, { recursive: true });
      expect(
        resolveTargets("all", { homeDir: FAKE_HOME, extraDirs: [inst] }).at(-1)
          ?.file
      ).toBe(join(inst, "AGENTS.md"));
      await Bun.write(join(inst, "SOUL.md"), "soul\n");
      expect(
        resolveTargets("all", { homeDir: FAKE_HOME, extraDirs: [inst] }).at(-1)
          ?.file
      ).toBe(join(inst, "SOUL.md"));
      await Bun.write(join(inst, "CLAUDE.md"), "claude\n");
      expect(
        resolveTargets("all", { homeDir: FAKE_HOME, extraDirs: [inst] }).at(-1)
          ?.file
      ).toBe(join(inst, "CLAUDE.md"));
      expect(() =>
        resolveTargets("all", {
          homeDir: FAKE_HOME,
          extraDirs: [join(FAKE_HOME, "nope")],
        })
      ).toThrow(CliError);
    });

    test("honors CLAUDE_CONFIG_DIR unless a home override isolates the run", () => {
      const saved = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = join(TEST_DIR, "redirected-claude");
      try {
        const redirected = resolveTargets("claude").find(
          (t) => t.id === "claude"
        );
        expect(redirected?.file).toBe(
          join(TEST_DIR, "redirected-claude", "CLAUDE.md")
        );
        const isolated = resolveTargets("claude", { homeDir: FAKE_HOME })[0];
        expect(isolated?.file).toBe(CLAUDE_FILE);
        process.env.CLAUDE_CONFIG_DIR = "relative/dir";
        expect(() => resolveTargets("claude")).toThrow(
          /must be an absolute path/
        );
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = saved;
      }
    });

    test("rejects unknown targets", () => {
      expect(() => parseTargetOption("emacs")).toThrow(CliError);
      expect(parseTargetOption("codex")).toBe("codex");
    });
  });

  // ── lifecycle ──────────────────────────────────────────────────────────────

  describe("install → verify → update → uninstall", () => {
    test("every harness: fresh install, idempotent re-run, verify ok, byte-identical uninstall", async () => {
      await setupHome(OWN_FILE_HARNESSES.map((h) => h.dir));
      for (const h of OWN_FILE_HARNESSES) {
        await Bun.write(join(FAKE_HOME, h.file), EXISTING);
      }

      const first = await install();
      expect(first.error).toBeUndefined();
      for (const h of OWN_FILE_HARNESSES) {
        const row = first.receipt.results.find((r) => r.target === h.id);
        expect(row?.action).toBe("install");
        expect(typeof row?.backup).toBe("string");
        const content = await text(join(FAKE_HOME, h.file));
        expect(content).toBe(`${EXISTING}\n${renderBlock()}\n`);
      }

      const second = await install();
      expect(second.error).toBeUndefined();
      for (const h of OWN_FILE_HARNESSES) {
        expect(
          second.receipt.results.find((r) => r.target === h.id)?.action
        ).toBe("current");
        expect(
          backupsIn(dirname(join(FAKE_HOME, h.file))).length
        ).toBeLessThanOrEqual(1);
      }

      const check = await verify();
      expect(check.error).toBeUndefined();
      expect(check.receipt.ok).toBe(true);
      for (const h of OWN_FILE_HARNESSES) {
        const row = check.receipt.results.find((r) => r.target === h.id);
        expect(row?.status).toBe("ok");
        expect(row?.blockVersion).toBe(BLOCK_VERSION);
        expect(row?.hashOk).toBe(true);
      }

      const removed = await uninstall();
      expect(removed.error).toBeUndefined();
      for (const h of OWN_FILE_HARNESSES) {
        expect(
          removed.receipt.results.find((r) => r.target === h.id)?.action
        ).toBe("remove");
        expect(await text(join(FAKE_HOME, h.file))).toBe(EXISTING);
      }
      const gone = await uninstall();
      expect(
        gone.receipt.results.find((r) => r.target === "codex")?.action
      ).toBe("absent");
    });

    test("creates the file when absent, installs into an empty file, and handles a missing final newline", async () => {
      await setupHome([".codex", ".claude", ".hermes"]);
      await Bun.write(CLAUDE_FILE, "");
      await Bun.write(join(FAKE_HOME, ".hermes/SOUL.md"), "no newline at end");

      const r = await install();
      expect(r.error).toBeUndefined();
      expect(
        r.receipt.results.find((x) => x.target === "codex")?.backup
      ).toBeNull();
      expect(await text(CODEX_FILE)).toBe(`${renderBlock()}\n`);
      expect(await text(CLAUDE_FILE)).toBe(`${renderBlock()}\n`);
      expect(await text(join(FAKE_HOME, ".hermes/SOUL.md"))).toBe(
        `no newline at end\n\n${renderBlock()}\n`
      );

      await uninstall();
      expect(await text(CODEX_FILE)).toBe("");
      expect(await text(CLAUDE_FILE)).toBe("");
      // The newline install had to add stays; everything else is original.
      expect(await text(join(FAKE_HOME, ".hermes/SOUL.md"))).toBe(
        "no newline at end\n"
      );
    });

    test("update migrates an older block version in place and verify reports it beforehand", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING);
      await install();
      const current = await text(CODEX_FILE);
      await Bun.write(
        CODEX_FILE,
        current.replace(
          `gno-agents block v${BLOCK_VERSION} `,
          "gno-agents block v1 "
        )
      );

      const stale = await verify();
      expect(stale.error?.code).toBe("VALIDATION");
      const row = stale.receipt.results.find((r) => r.target === "codex");
      expect(row?.status).toBe("outdated");
      expect(row?.blockVersion).toBe(1);
      expect(row?.hashOk).toBe(true);

      const migrated = await update();
      expect(
        migrated.receipt.results.find((r) => r.target === "codex")?.action
      ).toBe("update");
      expect(await text(CODEX_FILE)).toBe(current);
      expect((await verify()).receipt.ok).toBe(true);
    });

    test("grok is covered via claude: one block, covered rows on install and verify", async () => {
      await setupHome([".claude", ".grok"]);
      const r = await install();
      const grok = r.receipt.results.find((x) => x.target === "grok");
      expect(grok?.action).toBe("covered");
      expect(grok?.via).toBe("claude");
      expect(grok?.path).toBe(CLAUDE_FILE); // the file grok actually reads
      expect(existsSync(join(FAKE_HOME, ".grok/AGENTS.md"))).toBe(false);
      expect(await text(CLAUDE_FILE)).toContain(BEGIN_MARKER);
      const v = await verify("grok");
      expect(v.receipt.ok).toBe(true);
      expect(v.receipt.results.map((x) => [x.target, x.status])).toEqual([
        ["claude", "ok"],
        ["grok", "covered"],
      ]);
    });

    test("--extra-dir instances are installed, verified, and uninstalled like harnesses", async () => {
      const inst = join(FAKE_HOME, "instances", "work-cli");
      await mkdir(inst, { recursive: true });
      await Bun.write(join(inst, "CLAUDE.md"), EXISTING);
      const r = await install("all", [inst]);
      const row = r.receipt.results.find((x) => x.target === "extra-dir");
      expect(row?.action).toBe("install");
      expect(row?.path).toBe(join(inst, "CLAUDE.md"));
      expect((await verify("all", [inst])).receipt.ok).toBe(true);
      await uninstall("all", [inst]);
      expect(await text(join(inst, "CLAUDE.md"))).toBe(EXISTING);
    });
  });

  // ── file handling ──────────────────────────────────────────────────────────

  describe("file handling", () => {
    test("writes through a symlinked instruction file once and preserves the link", async () => {
      await setupHome([".codex", ".config/opencode", "shared"]);
      const shared = join(FAKE_HOME, "shared", "AGENTS.md");
      await Bun.write(shared, EXISTING);
      await symlink(shared, CODEX_FILE);
      await symlink(shared, join(FAKE_HOME, ".config/opencode/AGENTS.md"));

      const r = await install();
      const actions = new Map(r.receipt.results.map((x) => [x.target, x]));
      expect(actions.get("codex")?.action).toBe("install");
      expect(actions.get("opencode")?.action).toBe("covered");
      expect(actions.get("opencode")?.detail).toMatch(/same file/);
      expect(await readlink(CODEX_FILE)).toBe(shared);
      expect((await stat(shared)).isFile()).toBe(true);
      expect(await text(shared)).toBe(`${EXISTING}\n${renderBlock()}\n`);
      expect(backupsIn(join(FAKE_HOME, "shared"))).toHaveLength(1);
      expect(backupsIn(join(FAKE_HOME, ".codex"))).toHaveLength(0);

      const v = await verify();
      expect(
        v.receipt.results.find((x) => x.target === "opencode")?.status
      ).toBe("covered");
    });

    test("preserves a UTF-8 BOM and CRLF content outside the markers", async () => {
      await setupHome([".codex"]);
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const body = new TextEncoder().encode("# Rules\r\n\r\nline\r\n");
      await Bun.write(CODEX_FILE, new Uint8Array([...bom, ...body]));

      await install();
      const after = await bytes(CODEX_FILE);
      expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder().decode(after.subarray(3))).toBe(
        `# Rules\r\n\r\nline\r\n\n${renderBlock()}\n`
      );
      expect((await verify()).receipt.ok).toBe(true);
      await uninstall();
      expect([...(await bytes(CODEX_FILE))]).toEqual([...bom, ...body]);
    });

    test("refuses a non-UTF-8 file: error row, nothing written, block printed for manual use", async () => {
      await setupHome([".codex", ".claude"]);
      const original = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]);
      await Bun.write(CODEX_FILE, original);

      const r = await install();
      expect(r.error?.code).toBe("VALIDATION");
      const codex = r.receipt.results.find((x) => x.target === "codex");
      expect(codex?.action).toBe("error");
      expect(codex?.detail).toMatch(/not valid UTF-8/);
      expect([...(await bytes(CODEX_FILE))]).toEqual([...original]);
      expect(r.receipt.manualBlock).toBe(renderBlock());
      // Other targets still proceed.
      expect(r.receipt.results.find((x) => x.target === "claude")?.action).toBe(
        "install"
      );
    });

    test("backups keep the source file's permission mode", async () => {
      if (!POSIX) {
        return;
      }
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING);
      await chmod(CODEX_FILE, 0o600);
      const r = await install("codex");
      const backup = r.receipt.results[0]?.backup as string;
      expect((await stat(backup)).mode & 0o777).toBe(0o600);
      expect((await stat(CODEX_FILE)).mode & 0o777).toBe(0o600);
    });
  });

  // ── failure paths ──────────────────────────────────────────────────────────

  describe("failure paths", () => {
    test("malformed markers: error row, file untouched, exit 1, block printed for manual use", async () => {
      await setupHome([".codex"]);
      const broken = `${EXISTING}\n${BEGIN_MARKER}\nno end marker\n`;
      await Bun.write(CODEX_FILE, broken);

      const r = await install();
      expect(r.error?.code).toBe("VALIDATION");
      const row = r.receipt.results.find((x) => x.target === "codex");
      expect(row?.action).toBe("error");
      expect(row?.detail).toMatch(/Malformed GNO agents markers/);
      expect(await text(CODEX_FILE)).toBe(broken);
      expect(backupsIn(join(FAKE_HOME, ".codex"))).toHaveLength(0);
      expect(r.receipt.manualBlock).toBe(renderBlock());

      // Human output carries the block too.
      let thrown = false;
      try {
        await installAgents({
          target: "codex",
          homeDir: FAKE_HOME,
          json: false,
        });
      } catch {
        thrown = true;
      }
      expect(thrown).toBe(true);
      const human = stdoutOutput.join("");
      stdoutOutput = [];
      expect(human).toContain("Could not apply the block to:");
      expect(human).toContain(BEGIN_MARKER);

      const v = await verify();
      expect(v.error?.code).toBe("VALIDATION");
      expect(v.receipt.results.find((x) => x.target === "codex")?.status).toBe(
        "malformed"
      );
    });

    test("unwritable target: error row, exit 2, block printed; readable-but-unwritable verify still works", async () => {
      if (!POSIX || IS_ROOT) {
        return;
      }
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING);
      await chmod(join(FAKE_HOME, ".codex"), 0o500);
      try {
        const r = await install();
        expect(r.error?.code).toBe("RUNTIME");
        expect(
          r.receipt.results.find((x) => x.target === "codex")?.action
        ).toBe("error");
        expect(r.receipt.manualBlock).toBe(renderBlock());
        expect(await text(CODEX_FILE)).toBe(EXISTING);
        const v = await verify();
        expect(
          v.receipt.results.find((x) => x.target === "codex")?.status
        ).toBe("missing");
      } finally {
        await chmod(join(FAKE_HOME, ".codex"), 0o700);
      }
    });

    test("verify reports missing file, missing block, tampered body, and exit codes", async () => {
      await setupHome([".codex", ".claude"]);
      let v = await verify();
      expect(v.error?.code).toBe("VALIDATION");
      expect(
        v.receipt.results.find((x) => x.target === "codex")?.detail
      ).toMatch(/not found/);

      await Bun.write(CODEX_FILE, EXISTING);
      v = await verify("codex");
      expect(v.receipt.results[0]?.status).toBe("missing");
      expect(v.receipt.results[0]?.detail).toMatch(/no GNO agents block/);

      await install("codex");
      const content = await text(CODEX_FILE);
      await Bun.write(
        CODEX_FILE,
        content.replace("Cite with gno://", "Cite with http://")
      );
      v = await verify("codex");
      expect(v.receipt.results[0]?.status).toBe("outdated");
      expect(v.receipt.results[0]?.hashOk).toBe(false);
      expect(v.receipt.results[0]?.detail).toMatch(/edited inside markers/);

      // update repairs the tamper
      expect((await update("codex")).receipt.results[0]?.action).toBe("update");
      expect((await verify("codex")).receipt.ok).toBe(true);

      // a block with no stamp line is reported as such, not as a hash mismatch
      const stamped = await text(CODEX_FILE);
      await Bun.write(
        CODEX_FILE,
        stamped.replace(/<!-- gno-agents block v\d+ [^\n]*\n/, "")
      );
      v = await verify("codex");
      expect(v.receipt.results[0]?.status).toBe("outdated");
      expect(v.receipt.results[0]?.detail).toMatch(/no valid stamp line/);
    });

    test("not-detected harnesses are skipped and never fabricated", async () => {
      await setupHome([".codex"]);
      const r = await install();
      const skipped = r.receipt.results.filter(
        (x) => x.action === "not-detected"
      );
      expect(skipped.map((x) => x.target).sort()).toEqual(
        ["claude", "cursor", "grok", "hermes", "openclaw", "opencode"].sort()
      );
      expect(existsSync(CLAUDE_FILE)).toBe(false);
      expect(existsSync(join(FAKE_HOME, "AGENTS.md"))).toBe(false);
    });
  });

  // ── dry run ────────────────────────────────────────────────────────────────

  describe("dry run", () => {
    test("reports the diff and writes nothing", async () => {
      await setupHome([".codex"]);
      await Bun.write(CODEX_FILE, EXISTING);
      const r = await run(() =>
        installAgents({
          target: "codex",
          homeDir: FAKE_HOME,
          json: true,
          dryRun: true,
        })
      );
      expect(r.error).toBeUndefined();
      expect(r.receipt.dryRun).toBe(true);
      expect(r.receipt.results[0]?.action).toBe("install");
      expect(r.receipt.results[0]?.backup).toBeNull();
      expect(r.receipt.diffs?.[0]).toContain(`+${BEGIN_MARKER}`);
      expect(await text(CODEX_FILE)).toBe(EXISTING);
      expect(backupsIn(join(FAKE_HOME, ".codex"))).toHaveLength(0);
    });
  });
});
