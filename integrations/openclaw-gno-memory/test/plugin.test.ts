import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises + node:os + node:path: tmp dirs, symlinks, and expected
// path forms for the root-normalization cases (no Bun equivalents).
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type BackendLogger,
  GnoMemoryBackend,
  STALE_RETRY_MS,
} from "../src/backend";
import {
  DEFAULT_PATHS,
  normalizeRoot,
  resolveConfig,
  toCollectionPattern,
} from "../src/config";
import {
  GnoCli,
  GnoCliError,
  MIN_GNO_VERSION,
  versionAtLeast,
  execFileRunner,
} from "../src/gno-cli";
import { createMemoryGetTool, createMemorySearchTool } from "../src/tools";
import {
  INDEX_OK,
  VERSION_OK,
  collectionList,
  failed,
  fakeGno,
  notFound,
  ok,
  searchPayload,
  timedOut,
  type FakeScript,
} from "./fake-gno";

const ROOT = "/sandbox/workspace";
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function rejection(promise: Promise<unknown>): Promise<GnoCliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GnoCliError) return error;
    throw error;
  }
  throw new Error("expected a GnoCliError rejection");
}

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

describe("config", () => {
  test("defaults and brace-union pattern", () => {
    const cfg = resolveConfig(undefined);
    expect(cfg.collection).toBe("openclaw-memory");
    expect(cfg.paths).toEqual([...DEFAULT_PATHS]);
    expect(cfg.syncBeforeSearch).toBe(true);
    expect(cfg.mode).toBe("keyword");
    expect(toCollectionPattern(cfg.paths)).toBe(
      "{MEMORY.md,USER.md,memory/**/*.md}"
    );
    expect(toCollectionPattern(["memory/**/*.md"])).toBe("memory/**/*.md");
  });

  test("explicit values win and the collection name is lowercased", () => {
    const cfg = resolveConfig({
      collection: "OpenClaw-Mem",
      root: ROOT,
      paths: ["memory/**/*.md"],
      gnoArgs: ["--index", "openclaw"],
      syncBeforeSearch: false,
      mode: "hybrid",
      timeoutMs: 5000,
    });
    expect(cfg.collection).toBe("openclaw-mem");
    expect(cfg.root).toBe(ROOT);
    expect(cfg.gnoArgs).toEqual(["--index", "openclaw"]);
    expect(cfg.syncBeforeSearch).toBe(false);
    expect(cfg.mode).toBe("hybrid");
    expect(cfg.timeoutMs).toBe(5000);
  });
});

describe("gno cli bridge", () => {
  test("version pin", () => {
    expect(versionAtLeast("1.41.0")).toBe(true);
    expect(versionAtLeast("1.42.0")).toBe(true);
    expect(versionAtLeast("1.40.9")).toBe(false);
    expect(versionAtLeast("garbage")).toBe(false);
    expect(MIN_GNO_VERSION).toBe("1.41.0");
  });

  test.each([
    ["gno_not_found", { "--version": notFound }],
    ["gno_timeout", { "--version": timedOut }],
    ["gno_version_unsupported", { "--version": ok("1.40.0\n") }],
    ["gno_command_failed", { "--version": failed(1, "", "boom") }],
  ] as const)("ensureVersion reports %s", async (kind, script) => {
    const fake = fakeGno(script);
    const cli = new GnoCli({
      binary: "gno",
      timeoutMs: 10,
      runner: fake.runner,
    });
    const error = await rejection(cli.ensureVersion());
    expect(error.kind).toBe(kind);
  });

  test("runJson classifies malformed output and GNO error envelopes", async () => {
    const fake = fakeGno({
      search: ok("not json"),
      get: failed(
        1,
        JSON.stringify({ error: { code: "NOT_FOUND", message: "no such doc" } })
      ),
    });
    const cli = new GnoCli({
      binary: "gno",
      timeoutMs: 10,
      runner: fake.runner,
      globalArgs: ["--index", "x"],
    });
    const malformed = await rejection(cli.runJson(["search", "q", "--json"]));
    expect(malformed.kind).toBe("gno_malformed_json");
    const envelope = await rejection(
      cli.runJson(["get", "gno://a/b", "--json"])
    );
    expect(envelope.kind).toBe("gno_command_failed");
    expect(envelope.code).toBe("NOT_FOUND");
    expect(envelope.message).toContain("no such doc");
    expect(fake.calls[0]?.args.slice(0, 2)).toEqual(["--index", "x"]);
  });
});

describe("collection provisioning", () => {
  test("registers the workspace memory paths once, with pattern and excludes", async () => {
    const listed: string[] = [
      collectionList([]),
      collectionList([{ name: "openclaw-memory", path: ROOT }]),
    ];
    const { backend, calls, log } = backendWith(
      happyScript({
        "collection list": () => ok(listed.shift() ?? collectionList([])),
        "collection add": ok(
          'Collection "openclaw-memory" added successfully\n'
        ),
      })
    );
    const first = await backend.ensureCollection(ROOT);
    expect(first).toEqual({ root: ROOT, created: true });
    const add = calls.find(
      (c) => c.args[0] === "collection" && c.args[1] === "add"
    );
    expect(add?.args).toEqual([
      "collection",
      "add",
      ROOT,
      "--name",
      "openclaw-memory",
      "--pattern",
      "{MEMORY.md,USER.md,memory/**/*.md}",
      "--exclude",
      ".git,node_modules,.openclaw,.state",
    ]);
    expect(
      log.lines.some((l) =>
        l.startsWith("info gno-memory: registered collection")
      )
    ).toBe(true);
    const second = await backend.ensureCollection(ROOT);
    expect(second.created).toBe(false);
    expect(calls.filter((c) => c.args[1] === "add")).toHaveLength(1);
  });

  test("refuses a same-name collection rooted elsewhere", async () => {
    const { backend } = backendWith(
      happyScript({
        "collection list": ok(
          collectionList([{ name: "openclaw-memory", path: "/elsewhere" }])
        ),
      })
    );
    const error = await rejection(backend.ensureCollection(ROOT));
    expect(error.kind).toBe("gno_command_failed");
    expect(error.message).toContain("/elsewhere");
  });

  test("an uninitialized GNO is a clear error, not a silent add", async () => {
    const { backend, calls } = backendWith(
      happyScript({
        "collection list": failed(
          1,
          JSON.stringify({
            error: {
              code: "RUNTIME",
              message: "Config file not found: /x/index.yml",
            },
          })
        ),
      })
    );
    const error = await rejection(backend.ensureCollection(ROOT));
    expect(error.kind).toBe("gno_command_failed");
    expect(error.message).toContain("Config file not found");
    expect(error.message).toContain("gno init");
    expect(calls.some((c) => c.args[1] === "add")).toBe(false);
  });

  test.each([
    ["~/ws", join(homedir(), "ws")],
    ["relative/ws", resolve("relative/ws")],
    ["/sandbox/workspace/", ROOT],
    ["/sandbox//workspace/./", ROOT],
  ])(
    "root %s normalizes to %s and matches GNO's stored absolute path",
    async (configured, canonical) => {
      expect(normalizeRoot(configured)).toBe(canonical);
      // GNO reports the expanded absolute path; config/workspace carry the raw form.
      const { backend, calls } = backendWith(
        happyScript({
          "collection list": ok(
            collectionList([{ name: "openclaw-memory", path: canonical }])
          ),
        }),
        { root: configured }
      );
      expect(await backend.ensureCollection(undefined)).toEqual({
        root: canonical,
        created: false,
      });
      expect(calls.some((c) => c.args[1] === "add")).toBe(false);
      expect((await backend.status(undefined)).registered).toBe(true);
      // The same raw form as OpenClaw's workspaceDir, with no config root.
      const viaWorkspace = backendWith(
        happyScript({
          "collection list": ok(
            collectionList([{ name: "openclaw-memory", path: canonical }])
          ),
        })
      );
      expect(
        (await viaWorkspace.backend.ensureCollection(configured)).root
      ).toBe(canonical);
    }
  );

  test("a GNO-reported root in raw form compares equal after normalization", async () => {
    const { backend } = backendWith(
      happyScript({
        "collection list": ok(
          collectionList([{ name: "openclaw-memory", path: "~/ws/" }])
        ),
      }),
      { root: join(homedir(), "ws") }
    );
    expect((await backend.ensureCollection(undefined)).created).toBe(false);
    expect((await backend.status(undefined)).registered).toBe(true);
  });

  test("an existing root resolves through symlinks on both sides", async () => {
    const base = await mkdtemp(join(tmpdir(), "gno-memory-root-"));
    tmpDirs.push(base);
    const real = join(base, "real");
    const link = join(base, "link");
    await Bun.write(join(real, ".keep"), "");
    await symlink(real, link);
    const canonical = normalizeRoot(real);
    expect(normalizeRoot(`${link}/`)).toBe(canonical);
    const { backend } = backendWith(
      happyScript({
        "collection list": ok(
          collectionList([{ name: "openclaw-memory", path: link }])
        ),
      }),
      { root: real }
    );
    expect(await backend.ensureCollection(undefined)).toEqual({
      root: canonical,
      created: false,
    });
  });

  test("needs a root from config or the OpenClaw workspace", async () => {
    const { backend } = backendWith(happyScript());
    const error = await rejection(backend.ensureCollection(undefined));
    expect(error.message).toContain("no workspace root");
    const configured = backendWith(happyScript(), { root: ROOT });
    expect(await configured.backend.ensureCollection(undefined)).toEqual({
      root: ROOT,
      created: false,
    });
  });
});

describe("search", () => {
  test("syncs before searching and returns cited hits", async () => {
    const { backend, calls, log } = backendWith(happyScript());
    const outcome = await backend.search("teal heron", {
      workspaceDir: ROOT,
      maxResults: 3,
    });
    const subcommands = calls.map((c) => c.args[0]);
    expect(subcommands).toEqual(["--version", "collection", "index", "search"]);
    expect(calls[2]?.args).toEqual([
      "index",
      "openclaw-memory",
      "--no-embed",
      "--json",
      "--lock-wait",
      "10s",
    ]);
    expect(calls[3]?.args).toEqual([
      "search",
      "teal heron",
      "-n",
      "3",
      "-c",
      "openclaw-memory",
      "--json",
    ]);
    expect(outcome.synced).toBe(true);
    expect(outcome.stale).toBeNull();
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.citation).toBe(
      "gno://openclaw-memory/memory/2026-09-01.md#L3 (hash aaaaaaaaaaaa)"
    );
    expect(outcome.results[0]?.path).toBe("memory/2026-09-01.md");
    expect(log.lines).toContain(
      'info gno-memory: index sync ok for "openclaw-memory" (added 1, updated 0, removed 0)'
    );
  });

  test("hybrid mode and syncBeforeSearch=false change the argv, not the shape", async () => {
    const { backend, calls } = backendWith(
      happyScript({ query: ok(searchPayload()) }),
      {
        mode: "hybrid",
        syncBeforeSearch: false,
      }
    );
    const outcome = await backend.search("q", { workspaceDir: ROOT });
    expect(calls.map((c) => c.args[0])).toEqual([
      "--version",
      "collection",
      "query",
    ]);
    expect(calls[2]?.args).toEqual([
      "query",
      "q",
      "--fast",
      "-n",
      "8",
      "-c",
      "openclaw-memory",
      "--json",
    ]);
    expect(outcome.synced).toBe(false);
    expect(outcome.results).toHaveLength(1);
  });

  test("a failed sync marks the index stale, logs it, and still serves results", async () => {
    const indexOutcomes = [timedOut, ok(INDEX_OK)];
    const { backend, log } = backendWith(
      happyScript({ index: () => indexOutcomes.shift() ?? ok(INDEX_OK) })
    );
    const outcome = await backend.search("q", { workspaceDir: ROOT });
    expect(outcome.synced).toBe(false);
    expect(outcome.stale?.kind).toBe("gno_timeout");
    expect(outcome.warning).toContain("memory index may be stale");
    expect(outcome.results).toHaveLength(1);
    expect(
      log.lines.some((l) =>
        l.startsWith("warn gno-memory: index sync failed (gno_timeout)")
      )
    ).toBe(true);
    await backend.sync(ROOT);
    expect(backend.staleState).toBeNull();
  });

  test("in watch mode a stale flag ages out: the next search after STALE_RETRY_MS re-probes", async () => {
    let clock = Date.parse("2026-09-03T10:00:00.000Z");
    const indexOutcomes = [timedOut, timedOut, ok(INDEX_OK)];
    const log = logger();
    const fake = fakeGno(
      happyScript({ index: () => indexOutcomes.shift() ?? ok(INDEX_OK) })
    );
    const backend = new GnoMemoryBackend(
      resolveConfig({ syncBeforeSearch: false }),
      log,
      fake.runner,
      () => clock
    );
    const indexCalls = () => fake.calls.filter((c) => c.args[0] === "index");
    expect(await backend.sync(ROOT)).toBe(false);
    expect(backend.staleState?.at).toBe("2026-09-03T10:00:00.000Z");

    // Not yet due: the flag rides on the search, no re-probe.
    clock += STALE_RETRY_MS - 1;
    let outcome = await backend.search("q", { workspaceDir: ROOT });
    expect(outcome.synced).toBe(false);
    expect(outcome.stale?.at).toBe("2026-09-03T10:00:00.000Z");
    expect(indexCalls()).toHaveLength(1);

    // Due: a failed re-probe keeps the flag, refreshes `at`, restarts the clock.
    clock += 1;
    outcome = await backend.search("q", { workspaceDir: ROOT });
    expect(outcome.synced).toBe(false);
    expect(outcome.stale?.at).toBe("2026-09-03T10:05:00.000Z");
    expect(indexCalls()).toHaveLength(2);
    outcome = await backend.search("q", { workspaceDir: ROOT });
    expect(indexCalls()).toHaveLength(2);

    // Due again: a successful re-probe clears the flag.
    clock += STALE_RETRY_MS;
    outcome = await backend.search("q", { workspaceDir: ROOT });
    expect(outcome.synced).toBe(true);
    expect(outcome.stale).toBeNull();
    expect(outcome.warning).toBeUndefined();
    expect(indexCalls()).toHaveLength(3);
    expect((await backend.status(ROOT)).lastSyncAt).toBe(
      "2026-09-03T10:10:00.000Z"
    );
    outcome = await backend.search("q", { workspaceDir: ROOT });
    expect(indexCalls()).toHaveLength(3);
  });
});

describe("tools", () => {
  test("memory_search returns text with citations and structured details", async () => {
    const { backend, log } = backendWith(happyScript());
    const tool = createMemorySearchTool(backend, log, { workspaceDir: ROOT });
    expect(tool.name).toBe("memory_search");
    expect(tool.parameters).toMatchObject({ required: ["query"] });
    const result = await tool.execute("call-1", { query: "teal heron" });
    expect(result.content[0]?.text).toContain("teal-heron-19");
    expect(result.content[0]?.text).toContain(
      "Source: gno://openclaw-memory/memory/2026-09-01.md#L3"
    );
    expect(result.details).toMatchObject({
      stale: false,
      synced: true,
      mode: "bm25",
    });
  });

  test.each([
    ["gno_not_found", { "--version": notFound }],
    ["gno_version_unsupported", { "--version": ok("1.40.0") }],
    ["gno_timeout", { search: timedOut }],
    ["gno_malformed_json", { search: ok("<html>") }],
  ] as const)(
    "memory_search degrades to disabled on %s",
    async (kind, overrides) => {
      const { backend, log } = backendWith(happyScript(overrides));
      const tool = createMemorySearchTool(backend, log, { workspaceDir: ROOT });
      const result = await tool.execute("call-2", { query: "q" });
      expect(result.details).toMatchObject({ disabled: true, error: { kind } });
      expect(result.content[0]?.text).toContain(`Memory unavailable (${kind})`);
      expect(
        log.lines.some((l) =>
          l.startsWith(`error gno-memory: memory_search unavailable (${kind})`)
        )
      ).toBe(true);
    }
  );

  test("memory_get maps a relative path onto the collection URI", async () => {
    const payload = JSON.stringify({
      uri: "gno://openclaw-memory/memory/2026-09-01.md",
      content: "- Seeded this workspace",
      totalLines: 4,
      source: { relPath: "memory/2026-09-01.md", sourceHash: "b".repeat(64) },
    });
    const { backend, calls, log } = backendWith(
      happyScript({ get: ok(payload) })
    );
    const tool = createMemoryGetTool(backend, log, { workspaceDir: ROOT });
    const result = await tool.execute("call-3", {
      path: "memory/2026-09-01.md",
      from: 1,
      lines: 2,
    });
    const get = calls.find((c) => c.args[0] === "get");
    expect(get?.args).toEqual([
      "get",
      "gno://openclaw-memory/memory/2026-09-01.md",
      "--json",
      "--from",
      "1",
      "--limit",
      "2",
    ]);
    expect(result.details).toMatchObject({
      status: "ok",
      totalLines: 4,
      path: "memory/2026-09-01.md",
    });
    expect(result.content[0]?.text).toContain("Seeded this workspace");
  });
});

describe("execFileRunner spawn failures", () => {
  test("a non-executable binary reports the spawn error, not exit null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-memory-runner-"));
    try {
      const binary = join(dir, "not-executable");
      await Bun.write(binary, "#!/bin/sh\necho hi\n");
      const result = await execFileRunner(binary, ["--version"], {
        timeoutMs: 5000,
      });
      expect(result.code).toBe(1);
      expect(result.notFound).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toMatch(/EACCES|spawn/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
