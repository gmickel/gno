import { describe, expect, test } from "bun:test";

import plugin, { buildPromptSection, register, type PluginApi } from "../index";
import { GnoMemoryBackend, type BackendLogger } from "../src/backend";
import {
  CLI_COMMAND,
  type CommandLike,
  registerGnoMemoryCli,
} from "../src/cli";
import { resolveConfig } from "../src/config";
import {
  INDEX_OK,
  SEARCH_HIT,
  VERSION_OK,
  collectionList,
  fakeGno,
  ok,
  searchPayload,
  type FakeScript,
} from "./fake-gno";

const ROOT = "/sandbox/workspace";

function logger(): BackendLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

function happyScript(overrides: FakeScript = {}): FakeScript {
  return {
    "--version": VERSION_OK,
    "collection list": ok(
      collectionList([{ name: "openclaw-memory", path: ROOT }])
    ),
    index: ok(INDEX_OK),
    search: ok(searchPayload()),
    ...overrides,
  };
}

function backendWith(script: FakeScript, config: Record<string, unknown> = {}) {
  const log = logger();
  const fake = fakeGno(script);
  const backend = new GnoMemoryBackend(resolveConfig(config), log, fake.runner);
  return { backend, log, calls: fake.calls };
}

describe("plugin entry", () => {
  test("registers the memory capability, both tools, the CLI, and an init service", async () => {
    const registered: Record<string, unknown> = {};
    const fake = fakeGno(happyScript());
    const log = logger();
    const api: PluginApi = {
      pluginConfig: { root: ROOT },
      logger: log,
      registerMemoryCapability: (capability) => {
        registered.capability = capability;
      },
      registerTool: (factory, opts) => {
        registered[`tool:${opts?.names?.[0]}`] = factory({
          workspaceDir: ROOT,
        });
      },
      registerCli: (_registrar, opts) => {
        registered.cli = opts?.descriptors;
      },
      registerService: (service) => {
        registered.service = service;
      },
    };
    register(api);
    expect(plugin.kind).toBe("memory");
    expect(plugin.id).toBe("gno-memory");
    expect(registered.capability).toMatchObject({
      deterministicRecallToolName: "memory_search",
    });
    expect(registered["tool:memory_search"]).toMatchObject({
      name: "memory_search",
    });
    expect(registered["tool:memory_get"]).toMatchObject({ name: "memory_get" });
    expect(registered.cli).toMatchObject([CLI_COMMAND]);
    const descriptor = (
      registered.cli as { machineOutput: (p: { argv: string[] }) => boolean }[]
    )[0]!;
    expect(
      descriptor.machineOutput({
        argv: ["gno-memory", "search", "q", "--json"],
      })
    ).toBe(true);
    expect(
      descriptor.machineOutput({ argv: ["gno-memory", "search", "q"] })
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(
      buildPromptSection({
        availableTools: new Set(["memory_search", "memory_get"]),
      })[0]
    ).toBe("## Memory Recall");
    expect(buildPromptSection({ availableTools: new Set() })).toEqual([]);
  });

  test("the CLI namespace registers search/get/status/sync and prints hits", async () => {
    const registeredNames: string[] = [];
    const actions: Record<
      string,
      (...args: unknown[]) => Promise<void> | void
    > = {};
    let current = "";
    const command: CommandLike = {
      command(name) {
        current = name;
        registeredNames.push(name);
        return command;
      },
      description: () => command,
      argument: () => command,
      option: () => command,
      action(handler) {
        actions[current] = handler;
        return command;
      },
    };
    const { backend, log, calls } = backendWith(happyScript());
    const out: string[] = [];
    registerGnoMemoryCli({ program: command, workspaceDir: ROOT }, backend, {
      write: (text) => {
        out.push(text);
      },
      fail: (message) => {
        throw new Error(message);
      },
    });
    expect(registeredNames).toEqual([
      "gno-memory",
      "search",
      "get",
      "status",
      "sync",
    ]);
    await actions.search?.("teal heron", { json: true });
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({
      synced: true,
      results: [{ uri: SEARCH_HIT.uri }],
    });
    await actions.search?.("teal heron", { json: true, minScore: "0.5" });
    expect(calls.at(-1)?.args).toContain("--min-score");
    expect(calls.at(-1)?.args).toContain("0.5");
    const callsBeforeBad = calls.length;
    for (const bad of ["abc", "", "1.5", "-0.1", "Infinity"]) {
      let failure = "";
      try {
        await actions.search?.("teal heron", { json: true, minScore: bad });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toBe(
        `gno-memory: --min-score must be a number between 0 and 1 (got ${JSON.stringify(bad)})`
      );
    }
    expect(calls).toHaveLength(callsBeforeBad);
    await actions.status?.({});
    expect(out.at(-1)).toContain(
      "collection openclaw-memory -> /sandbox/workspace"
    );
    expect(out.at(-1)).toContain("registered");
    expect(log.lines.length).toBeGreaterThan(0);
  });
});
