import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  installAgents,
  uninstallAgents,
  verifyAgents,
} from "../../../src/cli/commands/agents/commands";
import { resetGlobals } from "../../../src/cli/program";
import { safeRm } from "../../helpers/cleanup";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const TEST_DIR = join(import.meta.dir, ".temp-agents-schema-tests");
const FAKE_HOME = join(TEST_DIR, "home");
const CODEX_FILE = join(FAKE_HOME, ".codex/AGENTS.md");

let stdoutOutput: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const mockWrite = (chunk: string | Uint8Array): boolean => {
  stdoutOutput.push(String(chunk));
  return true;
};

function takeReceipt(): unknown {
  const receipt: unknown = JSON.parse(stdoutOutput.join(""));
  stdoutOutput = [];
  return receipt;
}

describe("agents receipt schemas", () => {
  let mutationSchema: object;
  let verifySchema: object;

  beforeAll(async () => {
    mutationSchema = await loadSchema("agents-mutation");
    verifySchema = await loadSchema("agents-verify");
  });

  beforeEach(async () => {
    process.stdout.write = mockWrite as typeof process.stdout.write;
    stdoutOutput = [];
    resetGlobals();
    await safeRm(TEST_DIR);
    for (const dir of [".claude", ".codex", ".grok"]) {
      await mkdir(join(FAKE_HOME, dir), { recursive: true });
    }
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await safeRm(TEST_DIR);
  });

  test("live install / update / dry-run / uninstall receipts match agents-mutation", async () => {
    await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
    const install = takeReceipt() as {
      command: string;
      results: { action: string; via?: string }[];
    };
    expect(assertValid(install, mutationSchema)).toBe(true);
    expect(install.command).toBe("install");
    // The grok import chain produces a covered row with via.
    expect(install.results.some((r) => r.action === "covered" && r.via)).toBe(
      true
    );

    await installAgents(
      { target: "all", homeDir: FAKE_HOME, json: true },
      "update"
    );
    const update = takeReceipt() as { command: string };
    expect(assertValid(update, mutationSchema)).toBe(true);
    expect(update.command).toBe("update");

    await uninstallAgents({
      target: "codex",
      homeDir: FAKE_HOME,
      json: true,
      dryRun: true,
    });
    const dryRun = takeReceipt() as { dryRun: boolean; diffs?: string[] };
    expect(assertValid(dryRun, mutationSchema)).toBe(true);
    expect(dryRun.dryRun).toBe(true);
    expect(Array.isArray(dryRun.diffs)).toBe(true);

    await uninstallAgents({ target: "all", homeDir: FAKE_HOME, json: true });
    const uninstall = takeReceipt() as { command: string };
    expect(assertValid(uninstall, mutationSchema)).toBe(true);
    expect(uninstall.command).toBe("uninstall");
  });

  test("live verify receipts (ok and failing) match agents-verify", async () => {
    await installAgents({ target: "all", homeDir: FAKE_HOME, json: true });
    stdoutOutput = [];

    await verifyAgents({ target: "all", homeDir: FAKE_HOME, json: true });
    const okReceipt = takeReceipt() as {
      ok: boolean;
      results: { status: string; via?: string }[];
    };
    expect(assertValid(okReceipt, verifySchema)).toBe(true);
    expect(okReceipt.ok).toBe(true);
    expect(okReceipt.results.some((r) => r.status === "covered" && r.via)).toBe(
      true
    );

    // Tamper inside the markers → outdated (hash mismatch) → verify throws
    // after emitting the receipt.
    const content = await Bun.file(CODEX_FILE).text();
    await Bun.write(CODEX_FILE, content.replace("GNO", "TAMPERED"));
    let threw = false;
    try {
      await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const badReceipt = takeReceipt() as {
      ok: boolean;
      results: { status: string }[];
    };
    expect(assertValid(badReceipt, verifySchema)).toBe(true);
    expect(badReceipt.ok).toBe(false);
    expect(badReceipt.results.some((r) => r.status === "outdated")).toBe(true);
  });

  test("verify receipt for a legacy v0-stamped block stays schema-valid", async () => {
    // The `outdated` migration scenario `agents update` supports: a stamp from
    // an earlier release reads v0. The per-row blockVersion must be allowed to
    // report 0 (the release-level blockVersion stays >= 1).
    await installAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
    stdoutOutput = [];
    const content = await Bun.file(CODEX_FILE).text();
    await Bun.write(
      CODEX_FILE,
      content.replace(/gno-agents block v\d+ /, "gno-agents block v0 ")
    );
    let threw = false;
    try {
      await verifyAgents({ target: "codex", homeDir: FAKE_HOME, json: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const legacy = takeReceipt() as {
      blockVersion: number;
      results: { target: string; status: string; blockVersion?: number }[];
    };
    expect(assertValid(legacy, verifySchema)).toBe(true);
    expect(legacy.blockVersion).toBeGreaterThanOrEqual(1);
    const codex = legacy.results.find((r) => r.target === "codex");
    expect(codex?.status).toBe("outdated");
    expect(codex?.blockVersion).toBe(0);
  });

  test("rejects a mutation receipt with an unknown action", () => {
    const receipt = {
      command: "install",
      blockVersion: 1,
      dryRun: false,
      results: [
        {
          target: "claude",
          label: "Claude Code",
          path: "/home/user/.claude/CLAUDE.md",
          action: "exploded",
          detected: true,
        },
      ],
    };
    expect(assertInvalid(receipt, mutationSchema)).toBe(true);
  });

  test("rejects diffs on a non-dry-run mutation receipt", () => {
    const receipt = {
      command: "uninstall",
      blockVersion: 1,
      dryRun: false,
      results: [],
      diffs: ["--- a\n+++ b"],
    };
    expect(assertInvalid(receipt, mutationSchema)).toBe(true);
  });

  test("rejects a covered row without via", () => {
    const receipt = {
      command: "verify",
      blockVersion: 1,
      ok: true,
      results: [
        {
          target: "grok",
          label: "Grok Build",
          path: "/home/user/.grok/AGENTS.md",
          status: "covered",
          detected: true,
        },
      ],
    };
    expect(assertInvalid(receipt, verifySchema)).toBe(true);
  });

  test("rejects arbitrary fields on receipt rows", () => {
    const receipt = {
      command: "verify",
      blockVersion: 1,
      ok: true,
      results: [
        {
          target: "claude",
          label: "Claude Code",
          path: "/home/user/.claude/CLAUDE.md",
          status: "ok",
          detected: true,
          blockVersion: 1,
          hashOk: true,
          rawFileContent: "must not cross the receipt boundary",
        },
      ],
    };
    expect(assertInvalid(receipt, verifySchema)).toBe(true);
  });
});
