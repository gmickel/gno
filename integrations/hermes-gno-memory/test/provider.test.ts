/**
 * Deterministic unit suite for the Hermes GNO memory provider.
 *
 * Drives the Python provider through Hermes's lifecycle (harness.py) against a
 * faked `gno` subprocess (fake_gno.py). Asserts the exact CLI flag mapping,
 * the failure modes a session must survive (timeout, malformed JSON, below-min
 * version, missing binary), and the ambient-store negative (sync_turn never
 * invokes `gno remember`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"; // filesystem structure ops (no Bun equivalent)
import { tmpdir } from "node:os"; // no Bun os utils
import { join } from "node:path"; // no Bun path utils

const HERE = import.meta.dir;
const PYTHON = Bun.which("python3") ?? Bun.which("python");
const FAKE_GNO = join(HERE, "fake_gno.py");
const HARNESS = join(HERE, "harness.py");
const MIN_VERSION = "1.41.0";
const FACT_URI = "gno://memory/facts/2026-09-03/mem-10e4745c90d3b7ec.md";
const FACT_HASH = "a".repeat(64);

type Step = Record<string, unknown> & { op: string };
type Result = Record<string, any>;

interface Fixture {
  home: string;
  log: string;
  gnoPath: string;
}

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(
  config: Record<string, unknown> = {},
  opts: { missingBinary?: boolean } = {}
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "hermes-gno-"));
  cleanups.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(join(home, "gno"), { recursive: true });
  await mkdir(bin, { recursive: true });
  const gnoPath = join(bin, "gno");
  if (!opts.missingBinary) {
    await writeFile(
      gnoPath,
      `#!/bin/sh\nexec "${PYTHON}" "${FAKE_GNO}" "$@"\n`
    );
    await chmod(gnoPath, 0o755);
  }
  const log = join(root, "gno-calls.log");
  const merged = {
    scopes: "project:gno, family",
    collection: "memory",
    caller: "hermes:ivan",
    gno_path: gnoPath,
    timeout_seconds: 2,
    max_facts: 4,
    max_tokens: 256,
    ...config,
  };
  await writeFile(join(home, "gno", "config.json"), JSON.stringify(merged));
  return { home, log, gnoPath };
}

async function drive(
  fx: Fixture,
  steps: Step[],
  env: Record<string, string> = {},
  scenario: Record<string, unknown> = {}
): Promise<Result[]> {
  const payload = JSON.stringify({
    hermes_home: fx.home,
    session_id: "sess-initial",
    agent_context: "primary",
    steps,
    ...scenario,
  });
  const proc = Bun.spawn([PYTHON as string, HARNESS, payload], {
    env: {
      ...process.env,
      HERMES_HOME: fx.home,
      FAKE_GNO_LOG: fx.log,
      FAKE_GNO_MODE: "ok",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`harness exited ${code}: ${stderr}`);
  return JSON.parse(stdout) as Result[];
}

async function logLines(fx: Fixture): Promise<unknown[]> {
  const raw = await readFile(fx.log, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

/** Every gno argv the fake saw (the receipt sidecar lines are objects, not argv). */
async function calls(fx: Fixture): Promise<string[][]> {
  return (await logLines(fx)).filter((line): line is string[] =>
    Array.isArray(line)
  );
}

interface ReceiptSeen {
  receipt: Record<string, unknown>;
  path: string;
  mode: string;
}

/** What `gno remember --receipt` found in the receipt file while it ran. */
async function receiptsSeen(fx: Fixture): Promise<ReceiptSeen[]> {
  return (await logLines(fx)).filter(
    (line): line is ReceiptSeen =>
      !Array.isArray(line) && typeof line === "object" && line !== null
  );
}

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx === -1 ? undefined : argv[idx + 1];
}

function flags(argv: string[], name: string): string[] {
  return argv.flatMap((arg, idx) =>
    arg === name ? [argv[idx + 1] as string] : []
  );
}

describe.skipIf(!PYTHON)("hermes gno memory provider", () => {
  test("prefetch maps the turn query to gno recall --json with config scopes and session identity", async () => {
    const fx = await fixture();
    const [, pre] = await drive(fx, [
      { op: "initialize" },
      {
        op: "prefetch",
        query: "which branch do we deploy from?",
        session_id: "sess-turn",
      },
    ]);
    expect(pre?.text).toContain("Deploys go out from the main branch only.");
    expect(pre?.text).toContain(FACT_URI);
    expect(pre?.count).toBe(1);

    const [version, recall] = await calls(fx);
    expect(version).toEqual(["--version"]);
    expect(recall?.slice(0, 2)).toEqual([
      "recall",
      "which branch do we deploy from?",
    ]);
    expect(flags(recall as string[], "--scope")).toEqual([
      "project:gno",
      "family",
    ]);
    expect(flag(recall as string[], "--collection")).toBe("memory");
    expect(flag(recall as string[], "--max-facts")).toBe("4");
    expect(flag(recall as string[], "--max-tokens")).toBe("256");
    expect(flag(recall as string[], "--caller")).toBe("hermes:ivan");
    expect(flag(recall as string[], "--session")).toBe("sess-turn");
    expect(recall).toContain("--json");
  });

  test("empty recall injects nothing and reports no recall status", async () => {
    const fx = await fixture();
    const [, pre] = await drive(
      fx,
      [{ op: "initialize" }, { op: "prefetch", query: "anything" }],
      {
        FAKE_GNO_MODE: "empty",
      }
    );
    expect(pre?.text).toBe("");
    expect(pre?.count).toBeNull();
  });

  test("remember tool maps add and supersede inputs; scopes never come from tool args", async () => {
    const fx = await fixture();
    const [, added, superseded] = await drive(fx, [
      { op: "initialize" },
      {
        op: "tool",
        args: {
          text: "Deploys go out from main.",
          decision: "add",
          source: "release sync",
          scopes: ["evil"],
        },
      },
      {
        op: "tool",
        args: {
          text: "Deploys go out from release/*.",
          decision: "supersede",
          predecessor_uri: FACT_URI,
          predecessor_hash: FACT_HASH,
        },
      },
    ]);
    expect(added?.result.outcome).toBe("added");
    expect(added?.result.record.uri).toBe(FACT_URI);
    expect(superseded?.result.outcome).toBe("superseded");
    expect(superseded?.result.record.supersedes).toEqual([FACT_URI]);

    const [, addCall, supersedeCall] = await calls(fx);
    expect(addCall?.slice(0, 2)).toEqual([
      "remember",
      "Deploys go out from main.",
    ]);
    expect(flags(addCall as string[], "--scope")).toEqual([
      "project:gno",
      "family",
    ]);
    expect(addCall).toContain("--add");
    expect(addCall).not.toContain("--supersede");
    expect(flag(addCall as string[], "--source")).toBe("release sync");
    expect(flag(addCall as string[], "--caller")).toBe("hermes:ivan");
    expect(flag(addCall as string[], "--session")).toBe("sess-initial");
    expect(addCall).not.toContain("evil");
    expect(flag(supersedeCall as string[], "--supersede")).toBe(FACT_URI);
    expect(flag(supersedeCall as string[], "--predecessor-hash")).toBe(
      FACT_HASH
    );
    expect(supersedeCall).not.toContain("--add");
    // No recall happened this session, so there is no receipt to present.
    expect(addCall).not.toContain("--receipt");
    expect(supersedeCall).not.toContain("--receipt");
    expect(await receiptsSeen(fx)).toEqual([]);
  });

  test("remember forwards the session's latest recall receipt via --receipt in a private temp file", async () => {
    const fx = await fixture();
    const [, pre, added] = await drive(fx, [
      { op: "initialize" },
      { op: "prefetch", query: "deploy branch" },
      {
        op: "tool",
        args: { text: "Deploys go out from main.", decision: "add" },
      },
    ]);
    expect(pre?.count).toBe(1);
    expect(added?.result.outcome).toBe("added");

    const [, , addCall] = await calls(fx);
    const receiptPath = flag(addCall as string[], "--receipt");
    expect(receiptPath).toMatch(/hermes-gno-receipt-.*\.json$/);
    const [seen] = await receiptsSeen(fx);
    expect(seen?.path).toBe(receiptPath);
    expect(seen?.mode).toBe("0o600");
    expect(seen?.receipt).toMatchObject({
      caller: "hermes:ivan",
      session: "sess-initial",
      digest: "c".repeat(64),
      spanHashes: [FACT_HASH],
    });
    // The temp file lives only for the remember call.
    expect(await Bun.file(receiptPath as string).exists()).toBe(false);
  });

  test("an empty recall still yields a receipt; a session switch drops it", async () => {
    const fx = await fixture();
    await drive(
      fx,
      [
        { op: "initialize" },
        { op: "prefetch", query: "anything" },
        { op: "tool", args: { text: "x", decision: "add" } },
        { op: "switch", session_id: "sess-2" },
        { op: "tool", args: { text: "y", decision: "add" } },
      ],
      { FAKE_GNO_MODE: "empty" }
    );
    const [, , withReceipt, afterSwitch] = await calls(fx);
    expect(flag(withReceipt as string[], "--receipt")).toBeDefined();
    expect(afterSwitch).not.toContain("--receipt");
    const [seen] = await receiptsSeen(fx);
    expect(seen?.receipt).toMatchObject({ spanHashes: [], memoryIds: [] });
  });

  test("remember without a decision proposes only: no --add/--supersede, candidates returned", async () => {
    const fx = await fixture();
    const [, proposed] = await drive(fx, [
      { op: "initialize" },
      { op: "tool", args: { text: "Deploys from main." } },
    ]);
    expect(proposed?.result.outcome).toBe("candidates");
    expect(proposed?.result.candidates[0].uri).toBe(FACT_URI);
    expect(proposed?.result.hint).toContain("decision='add'");
    const [, call] = await calls(fx);
    expect(call).not.toContain("--add");
    expect(call).not.toContain("--supersede");
  });

  test.each([
    [{ text: "" }, "text is required"],
    [{ text: "x", decision: "forget" }, "decision must be one of"],
    [
      { text: "x", decision: "supersede", predecessor_uri: FACT_URI },
      "predecessor_uri and predecessor_hash",
    ],
  ])(
    "invalid remember args %j are rejected before any gno call",
    async (args, message) => {
      const fx = await fixture();
      const [, res] = await drive(fx, [
        { op: "initialize" },
        { op: "tool", args },
      ]);
      expect(res?.result.error).toContain(message);
      expect((await calls(fx)).map((c) => c[0])).toEqual(["--version"]);
    }
  );

  test("sync_turn performs no GNO writes (ambient-store negative)", async () => {
    const fx = await fixture();
    await drive(fx, [
      { op: "initialize" },
      { op: "prefetch", query: "deploy branch" },
      {
        op: "sync_turn",
        user: "please remember we deploy from main",
        assistant: "noted",
      },
      { op: "sync_turn", user: "and staging from develop", assistant: "ok" },
      { op: "sync_turn", user: "third turn", assistant: "sure" },
    ]);
    const commands = (await calls(fx)).map((c) => c[0]);
    expect(commands).toEqual(["--version", "recall"]);
    expect(commands).not.toContain("remember");
  });

  test.each([
    ["timeout", "gno_timeout"],
    ["malformed", "gno_malformed_json"],
    ["fail", "gno_command_failed"],
  ])(
    "gno %s: prefetch degrades to empty and the tool reports kind %s",
    async (mode, kind) => {
      const fx = await fixture({ timeout_seconds: 1 });
      const [, pre, tool] = await drive(
        fx,
        [
          { op: "initialize" },
          { op: "prefetch", query: "deploy" },
          { op: "tool", args: { text: "x", decision: "add" } },
        ],
        { FAKE_GNO_MODE: mode }
      );
      expect(pre?.text).toBe("");
      expect(pre?.count).toBeNull();
      expect(tool?.result.kind).toBe(kind);
      expect(typeof tool?.result.error).toBe("string");
      if (mode === "fail")
        expect(tool?.result.memoryCode).toBe("MEMORY_SCOPES_REQUIRED");
    },
    20_000
  );

  test("gno below the pinned minimum disables the provider with a clear error; session continues", async () => {
    const fx = await fixture();
    const [init, prompt, pre, tool] = await drive(
      fx,
      [
        { op: "initialize" },
        { op: "prompt" },
        { op: "prefetch", query: "deploy" },
        { op: "tool", args: { text: "x", decision: "add" } },
      ],
      { FAKE_GNO_VERSION: "1.40.0" }
    );
    expect(init?.active).toBe(false);
    expect(prompt?.prompt).toContain("Unavailable");
    expect(prompt?.prompt).toContain(MIN_VERSION);
    expect(pre?.text).toBe("");
    expect(tool?.result.error).toContain("1.40.0");
    expect(tool?.result.error).toContain(MIN_VERSION);
    expect((await calls(fx)).map((c) => c[0])).toEqual(["--version"]);
  });

  test("gno not found: unavailable reason names the fix, provider stays inert", async () => {
    const fx = await fixture({}, { missingBinary: true });
    const [avail, init, pre, tool] = await drive(fx, [
      { op: "available" },
      { op: "initialize" },
      { op: "prefetch", query: "deploy" },
      { op: "tool", args: { text: "x", decision: "add" } },
    ]);
    expect(avail?.available).toBe(false);
    expect(avail?.reason).toContain("gno binary not found");
    expect(init?.active).toBe(false);
    expect(pre?.text).toBe("");
    expect(tool?.result.error).toContain("GNO memory unavailable");
    expect(await calls(fx)).toEqual([]);
  });

  test("no configured scopes is unavailable and never calls gno", async () => {
    const fx = await fixture({ scopes: "" });
    const [avail, init, tool] = await drive(fx, [
      { op: "available" },
      { op: "initialize" },
      { op: "tool", args: { text: "x", decision: "add" } },
    ]);
    expect(avail?.available).toBe(false);
    expect(avail?.reason).toContain("scope");
    expect(init?.active).toBe(false);
    expect(tool?.result.error).toContain("scopes");
    expect(await calls(fx)).toEqual([]);
  });

  test("session switch rebinds the session identity used by remember", async () => {
    const fx = await fixture();
    await drive(fx, [
      { op: "initialize" },
      { op: "switch", session_id: "sess-after-resume" },
      { op: "tool", args: { text: "x", decision: "add" } },
    ]);
    const [, call] = await calls(fx);
    expect(flag(call as string[], "--session")).toBe("sess-after-resume");
  });

  test("non-primary agent contexts cannot write", async () => {
    const fx = await fixture();
    const [, tool] = await drive(
      fx,
      [
        { op: "initialize" },
        { op: "tool", args: { text: "x", decision: "add" } },
      ],
      {},
      {
        agent_context: "cron",
      }
    );
    expect(tool?.result.error).toContain("disabled");
    expect((await calls(fx)).map((c) => c[0])).toEqual(["--version"]);
  });

  test("tool schema exposes gno_remember with add/supersede inputs and no scope parameter", async () => {
    const fx = await fixture();
    const [, schemas] = await drive(fx, [
      { op: "initialize" },
      { op: "schemas" },
    ]);
    const [schema] = schemas?.schemas ?? [];
    expect(schema.name).toBe("gno_remember");
    expect(Object.keys(schema.parameters.properties).sort()).toEqual(
      [
        "decision",
        "predecessor_hash",
        "predecessor_uri",
        "source",
        "text",
      ].sort()
    );
    expect(schema.parameters.properties.decision.enum).toEqual([
      "propose",
      "add",
      "supersede",
    ]);
    expect(schema.parameters.required).toEqual(["text"]);
  });

  test("save_config persists normalized scopes to $HERMES_HOME/gno/config.json", async () => {
    const fx = await fixture();
    await drive(fx, [
      {
        op: "save_config",
        values: { scopes: " Project:GNO ,ops, project:gno", caller: "bot" },
      },
    ]);
    const saved = JSON.parse(
      await readFile(join(fx.home, "gno", "config.json"), "utf8")
    );
    expect(saved.scopes).toEqual(["project:gno", "ops"]);
    expect(saved.caller).toBe("bot");
    expect(saved.gno_path).toBe(fx.gnoPath);
  });
});
