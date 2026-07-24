import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory lifecycle helpers with no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the platform temporary directory with no Bun equivalent.
import { tmpdir } from "node:os";
// node:path provides path composition with no Bun equivalent.
import { join } from "node:path";

import { contextBuildSurfaceSchema } from "../../src/app/context-surface";
import { parseCliProjectAffinityOptions } from "../../src/cli/options";
import { createProgram } from "../../src/cli/program";
import { createDefaultConfig } from "../../src/config";
import {
  normalizeProjectAffinityValues,
  ProjectAffinityInputError,
  resolveCliProjectAffinity,
  resolveRemoteProjectAffinity,
} from "../../src/core/project-affinity-surface";
import { Mutex, type ToolContext } from "../../src/mcp/context";
import { askInputSchema } from "../../src/mcp/tools/ask";
import {
  queryDiagnoseInputSchema,
  queryInputSchema,
  searchInputSchema,
  vsearchInputSchema,
} from "../../src/mcp/tools/index";
import { handleSearch } from "../../src/mcp/tools/search";
import { safeRm } from "../helpers/cleanup";

const created: string[] = [];

const tempDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "gno-affinity-parity-"));
  created.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => safeRm(path)));
});

describe("project affinity surface parity", () => {
  test("Commander retrieval surfaces preserve default, disable, and repeatable override controls", () => {
    const retrievalCommands = ["search", "vsearch", "query", "ask"];
    const program = createProgram();
    const contextBuild = program.commands
      .find((command) => command.name() === "context")
      ?.commands.find((command) => command.name() === "build");
    const commands = [
      ...retrievalCommands.map((name) =>
        program.commands.find((command) => command.name() === name)
      ),
      contextBuild,
    ];
    for (const command of commands) {
      expect(command).toBeDefined();
      expect(
        command?.options.some((option) => option.long === "--project-root")
      ).toBe(true);
      expect(
        command?.options.some(
          (option) => option.long === "--no-project-affinity"
        )
      ).toBe(true);
    }

    const defaultSearch = createProgram().commands.find(
      (command) => command.name() === "search"
    )!;
    defaultSearch.parseOptions([]);
    expect(parseCliProjectAffinityOptions(defaultSearch.opts())).toEqual({
      projectAffinityDisabled: false,
      projectRoots: [],
    });

    const overriddenSearch = createProgram().commands.find(
      (command) => command.name() === "search"
    )!;
    overriddenSearch.parseOptions([
      "--project-root",
      " /zeta ",
      "--project-root",
      "/alpha",
    ]);
    expect(parseCliProjectAffinityOptions(overriddenSearch.opts())).toEqual({
      projectAffinityDisabled: false,
      projectRoots: ["/alpha", "/zeta"],
    });

    const disabledSearch = createProgram().commands.find(
      (command) => command.name() === "search"
    )!;
    disabledSearch.parseOptions(["--no-project-affinity"]);
    expect(parseCliProjectAffinityOptions(disabledSearch.opts())).toEqual({
      projectAffinityDisabled: true,
      projectRoots: [],
    });
  });

  test("bounds every strict MCP retrieval input to sixteen opaque hints", () => {
    const hints = Array.from({ length: 16 }, (_, index) => `hint-${index}`);
    const tooMany = [...hints, "hint-16"];
    const inputs = [
      [searchInputSchema, { query: "term" }],
      [vsearchInputSchema, { query: "concept" }],
      [queryInputSchema, { query: "question" }],
      [
        queryDiagnoseInputSchema,
        { query: "question", target: "gno://docs/target.md" },
      ],
      [askInputSchema, { query: "question", verify: true }],
      [contextBuildSurfaceSchema, { goal: "goal", budgetTokens: 100 }],
    ] as const;

    for (const [schema, base] of inputs) {
      expect(schema.safeParse({ ...base, projectHints: hints }).success).toBe(
        true
      );
      expect(schema.safeParse({ ...base, projectHints: tooMany }).success).toBe(
        false
      );
    }
  });

  test("normalizes equivalent remote hints identically without reflection or ranking effect", async () => {
    const config = createDefaultConfig();
    config.collections = [
      {
        name: "private",
        path: "/server/private/project",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    const rawHints = [
      "  workspace/zeta  ",
      "workspace/alpha",
      "workspace/zeta",
    ];
    const equivalentHints = ["workspace/alpha", "workspace/zeta"];

    expect(normalizeProjectAffinityValues(rawHints, "project hints")).toEqual(
      equivalentHints
    );

    const first = await resolveRemoteProjectAffinity(config, rawHints);
    const second = await resolveRemoteProjectAffinity(config, equivalentHints);

    expect(first).toEqual(second);
    expect(first?.resolution.matches).toEqual([]);
    expect(first?.resolution.roots).toHaveLength(2);
    expect(
      first?.resolution.roots.every((root) => root.status === "zero")
    ).toBe(true);
    const serialized = JSON.stringify(first);
    for (const privateValue of [
      ...rawHints,
      "/server/private/project",
      "workspace/alpha",
      "workspace/zeta",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  test("uses trusted CLI cwd by default and explicit roots replace it", async () => {
    const root = await tempDirectory();
    const project = join(root, "project");
    const nestedCwd = join(project, "src", "feature");
    const unrelated = join(root, "unrelated");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(nestedCwd, { recursive: true });
    await mkdir(unrelated, { recursive: true });

    const config = createDefaultConfig();
    config.collections = [
      {
        name: "project",
        path: project,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];

    const defaultAffinity = await resolveCliProjectAffinity(config, {
      cwd: nestedCwd,
    });
    expect(defaultAffinity?.resolution.matches).toHaveLength(1);
    expect(defaultAffinity?.resolution.matches[0]).toMatchObject({
      collection: "project",
      source: "cli_cwd",
    });

    const explicitAffinity = await resolveCliProjectAffinity(config, {
      cwd: nestedCwd,
      projectRoots: [unrelated],
    });
    expect(explicitAffinity?.resolution.matches).toEqual([]);
    expect(explicitAffinity?.resolution.roots[0]?.source).toBe("cli_explicit");
  });

  test("keeps absent, disabled, and invalid controls deterministic", async () => {
    const config = createDefaultConfig();
    const configDisabled = createDefaultConfig();
    configDisabled.projectAffinity = {
      contribution: 0.03,
      enabled: false,
    };
    expect(
      await resolveRemoteProjectAffinity(config, undefined)
    ).toBeUndefined();
    expect(await resolveRemoteProjectAffinity(config, [])).toBeUndefined();
    expect(
      await resolveCliProjectAffinity(config, {
        cwd: "/not-probed-when-disabled",
        disabled: true,
      })
    ).toBeUndefined();
    expect(
      await resolveCliProjectAffinity(configDisabled, {
        cwd: "/not-probed-when-config-disabled",
      })
    ).toBeUndefined();

    expect(
      resolveCliProjectAffinity(config, {
        cwd: "/unused",
        disabled: true,
        projectRoots: ["/explicit"],
      })
    ).rejects.toBeInstanceOf(ProjectAffinityInputError);
    expect(() =>
      normalizeProjectAffinityValues(
        Array.from({ length: 17 }, (_, index) => `hint-${index}`),
        "project hints"
      )
    ).toThrow("at most 16");
    expect(() =>
      normalizeProjectAffinityValues(["   "], "project hints")
    ).toThrow("must not contain empty values");
  });

  test("MCP search handler keeps remote hints zero-effect, private, and bounded", async () => {
    const config = createDefaultConfig();
    config.collections = [];
    const store = {
      searchFts: async () => ({ ok: true as const, value: [] }),
      getCollections: async () => ({ ok: true as const, value: [] }),
      getContexts: async () => ({ ok: true as const, value: [] }),
      getChunksBatch: async () => ({ ok: true as const, value: new Map() }),
      getTagsBatch: async () => ({ ok: true as const, value: new Map() }),
      getContent: async () => ({ ok: true as const, value: null }),
    };
    const context = {
      store,
      config,
      collections: [],
      actualConfigPath: "/not-exposed/config.yml",
      indexName: "default",
      toolMutex: new Mutex(),
      jobManager: {},
      serverInstanceId: "test",
      writeLockPath: "/not-exposed/write.lock",
      enableWrite: false,
      isShuttingDown: () => false,
    } as unknown as ToolContext;

    const absent = await handleSearch({ query: "term" }, context);
    const hinted = await handleSearch(
      { query: "term", projectHints: [" private/project "] },
      context
    );
    expect(hinted.isError).not.toBe(true);
    expect(hinted.structuredContent).toEqual(absent.structuredContent);
    expect(JSON.stringify(hinted.structuredContent)).toBe(
      JSON.stringify(absent.structuredContent)
    );
    expect(JSON.stringify(hinted)).not.toContain("private/project");

    const invalid = await handleSearch(
      {
        query: "term",
        projectHints: Array.from(
          { length: 17 },
          (_, index) => `private-${index}`
        ),
      },
      context
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("at most 16");
    expect(invalid.content[0]?.text).not.toContain("private-0");
  });
});
