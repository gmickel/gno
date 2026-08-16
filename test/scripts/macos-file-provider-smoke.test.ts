import { describe, expect, test } from "bun:test";
// node:fs/promises — temp fixture dirs and symlinks for focused tests; no Bun equivalent
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANY_REGRESSION_THRESHOLD_PERCENT,
  assertFixtureBasename,
  classifyGuardedReadErrno,
  classifyProviderRootShape,
  compareAgainstThreshold,
  createDedicatedFixture,
  DARWIN_EDEADLK,
  HELP_TEXT,
  instrumentDirectoryAvailability,
  LOCAL_OVERHEAD_THRESHOLD_PERCENT,
  main,
  parseArgs,
  percentOverhead,
  PRE_IMPLEMENTATION_BASELINE,
  redactToken,
  requireDarwin,
  resolveProviderRoot,
  runAllLocalBenchmark,
  runMatrixRow,
  runProbe,
  SAMPLE_COUNT,
  summarizeSamples,
  WARMUP_COUNT,
  withNoMaterializePolicy,
  type IoPolicyPort,
} from "../../scripts/macos-file-provider-smoke";
import {
  createDirectoryAvailability,
  memoizeDirectoryAvailability,
} from "../../src/ingestion/source-availability";
import { FileWalker } from "../../src/ingestion/walker";
import { safeRm } from "../helpers/cleanup";

describe("macos-file-provider-smoke help and flags", () => {
  test.each([
    { argv: ["--help"], command: "help" },
    { argv: ["-h"], command: "help" },
    { argv: [], command: "help" },
  ])("parses help argv %#", ({ argv, command }) => {
    expect(parseArgs(argv).command).toBe(command);
    expect(HELP_TEXT).toContain("process (0)");
    expect(HELP_TEXT).toContain("thread scope");
    expect(HELP_TEXT).toContain("SF_DATALESS");
    expect(HELP_TEXT).toContain("immediate");
    expect(HELP_TEXT).toContain("Aggregation roots");
  });

  test.each([
    { argv: ["validate-root", "--wat", "x"], message: "unknown flag" },
    {
      argv: ["validate-root", "positional"],
      message: "unknown positional",
    },
    {
      argv: ["create-fixture", "--root"],
      message: "missing value",
    },
  ])("rejects bad flags %#", ({ argv, message }) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  test("main --help exits 0", async () => {
    expect(await main(["--help"])).toBe(0);
  });

  test("main unknown command exits nonzero", async () => {
    expect(await main(["nope"])).toBe(2);
  });
});

describe("macos-file-provider-smoke refusals", () => {
  test.each([
    { platform: "linux" },
    { platform: "win32" },
    { platform: "freebsd" },
  ])("refuses non-Darwin %#", ({ platform }) => {
    expect(() => requireDarwin(platform)).toThrow("non-Darwin");
  });

  test.each([
    { id: "../escape", message: "separators or traversal" },
    { id: "GNO-fn118-smoke-a/b", message: "separators or traversal" },
    { id: "not-a-fixture", message: "basename pattern" },
    { id: "GNO-fn118-smoke-", message: "basename pattern" },
  ])("refuses unsafe fixture id %#", ({ id, message }) => {
    expect(() => assertFixtureBasename(id)).toThrow(message);
  });

  test("refuses missing root", () =>
    expect(resolveProviderRoot("")).rejects.toThrow("explicitly supplied"));

  test("refuses nonexistent root", () =>
    expect(
      resolveProviderRoot(
        join(
          process.env.HOME ?? "/nonexistent-home",
          "Library",
          "CloudStorage",
          "GoogleDrive-fn118-definitely-missing",
          "My Drive"
        )
      )
    ).rejects.toThrow("does not exist"));

  test("create-fixture dry-run refuses pre-existing child", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-root-"));
    try {
      const id = "GNO-fn118-smoke-alpha";
      await mkdir(join(parent, id));
      let message = "";
      try {
        await createDedicatedFixture(parent, id, true);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("pre-existing");
    } finally {
      await safeRm(parent);
    }
  });

  test("refuses an arbitrary writable directory as a provider root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-unsafe-root-"));
    try {
      let message = "";
      try {
        await resolveProviderRoot(parent);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("expected an installed");
    } finally {
      await safeRm(parent);
    }
  });

  test.each([
    {
      path: "/home/Library/CloudStorage/GoogleDrive-account/My Drive",
      provider: "google",
    },
    {
      path: "/home/Library/CloudStorage/OneDrive-SharedLibraries-tenant/library-a",
      provider: "onedrive",
    },
    {
      path: "/home/Library/Mobile Documents/com~apple~CloudDocs",
      provider: "icloud",
    },
    { path: "/", provider: null },
    { path: "/home/Library/CloudStorage/GoogleDrive-account", provider: null },
    {
      path: "/home/Library/CloudStorage/OneDrive-SharedLibraries-tenant",
      provider: null,
    },
    {
      path: "/home/Library/CloudStorage/OneDrive-SharedLibraries-tenant/library-a/descendant",
      provider: null,
    },
    {
      path: "/home/Library/CloudStorage/OneDrive-tenant/library-a",
      provider: null,
    },
    {
      path: "/home/Library/CloudStorage/OneDrive-SharedLibraries-tenant/GNO-fn118-smoke-fake-root",
      provider: null,
    },
  ])("classifies only exact provider-root shapes %#", ({ path, provider }) => {
    expect(classifyProviderRootShape(path, "/home")).toBe(provider);
  });

  test("validates an immediate OneDrive library and rejects its symlink sibling", async () => {
    const home = await mkdtemp(join(tmpdir(), "gno-fn118-home-"));
    try {
      const domain = join(
        home,
        "Library",
        "CloudStorage",
        "OneDrive-SharedLibraries-tenant"
      );
      const library = join(domain, "library-a");
      const outside = join(home, "outside");
      await mkdir(library, { recursive: true });
      await mkdir(outside);
      expect(await resolveProviderRoot(library, home)).toMatchObject({
        provider: "onedrive",
      });

      const escaped = join(domain, "library-escape");
      await symlink(outside, escaped);
      expect(resolveProviderRoot(escaped, home)).rejects.toThrow(
        "symlink roots are refused"
      );
    } finally {
      await safeRm(home);
    }
  });

  test("rejects traversal even when it resolves to an installed library", async () => {
    const home = await mkdtemp(join(tmpdir(), "gno-fn118-home-"));
    try {
      const domain = join(
        home,
        "Library",
        "CloudStorage",
        "OneDrive-SharedLibraries-tenant"
      );
      const library = join(domain, "library-a");
      await mkdir(library, { recursive: true });
      expect(
        resolveProviderRoot(`${domain}/unused/../library-a`, home)
      ).rejects.toThrow("traversal segments are refused");
    } finally {
      await safeRm(home);
    }
  });

  test("rejects missing and non-directory OneDrive library roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "gno-fn118-home-"));
    try {
      const domain = join(
        home,
        "Library",
        "CloudStorage",
        "OneDrive-SharedLibraries-tenant"
      );
      await mkdir(domain, { recursive: true });
      expect(
        resolveProviderRoot(join(domain, "missing-lib"), home)
      ).rejects.toThrow("does not exist");

      const fileRoot = join(domain, "library-file");
      await Bun.write(fileRoot, "not-a-dir");
      expect(resolveProviderRoot(fileRoot, home)).rejects.toThrow(
        "must be a directory"
      );
    } finally {
      await safeRm(home);
    }
  });
});

describe("macos-file-provider-smoke stats and redaction", () => {
  test("deterministic sample summary", () => {
    const summary = summarizeSamples([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(summary.rawMs).toHaveLength(9);
    expect(summary.medianMs).toBe(50);
    expect(summary.minMs).toBe(10);
    expect(summary.maxMs).toBe(90);
    expect(summary.p95Ms).toBe(90);
    expect(summary.stddevMs).toBeGreaterThan(0);
  });

  test("redaction uses sha256 and leaks no path", () => {
    const path = "/Users/someone/Library/CloudStorage/secret-drive/notes";
    const token = redactToken(path);
    expect(token.startsWith("sha256:")).toBe(true);
    expect(token).not.toContain("Users");
    expect(token).not.toContain("CloudStorage");
    expect(token).not.toContain("secret");
    expect(JSON.stringify({ root: token })).not.toContain(path);
  });
});

describe("macos-file-provider-smoke probe targeting", () => {
  test("observes the exact matrix target rather than the first fixture file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-target-"));
    try {
      const id = "GNO-fn118-smoke-target";
      await createDedicatedFixture(parent, id, false);
      const fixtureRoot = join(parent, id);
      const targetPath = join(fixtureRoot, "race-target.md");
      const observer = {
        kind: "darwin-ffi-lstat-st_flags" as const,
        intermediateDirectoryCaveat: "test",
        observe: (path: string) => ({
          ok: true,
          dataless: path === targetPath,
          stFlags: path === targetPath ? 0x4000_0000 : 0,
          errno: null,
        }),
      };
      const result = await runProbe({
        fixtureRoot,
        probe: "metadata",
        targetPath,
        observer,
      });
      expect(result.before).toMatchObject({ dataless: true });
      expect(result.after).toMatchObject({ dataless: true });
    } finally {
      await safeRm(parent);
    }
  });

  test("race row blocks unless the host provides a state-transition window", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-race-"));
    try {
      const id = "GNO-fn118-smoke-race";
      await createDedicatedFixture(parent, id, false);
      const observer = {
        kind: "darwin-ffi-lstat-st_flags" as const,
        intermediateDirectoryCaveat: "test",
        observe: () => ({
          ok: true,
          dataless: false,
          stFlags: 0,
          errno: null,
        }),
      };
      const result = await runMatrixRow({
        fixtureRoot: join(parent, id),
        provider: "icloud",
        row: "classification-to-read-race",
        observer,
      });
      expect(result).toMatchObject({
        verdict: "BLOCKED",
        reason: "race_delay_required_for_host_state_transition",
      });
    } finally {
      await safeRm(parent);
    }
  });

  test("cached-unpinned runs independent probes when the host prepared a local target", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-cached-"));
    try {
      const id = "GNO-fn118-smoke-cached";
      await createDedicatedFixture(parent, id, false);
      const observer = {
        kind: "darwin-ffi-lstat-st_flags" as const,
        intermediateDirectoryCaveat: "test",
        observe: () => ({
          ok: true,
          dataless: false,
          stFlags: 0,
          errno: null,
        }),
      };
      const policy: IoPolicyPort = {
        get: () => 0,
        set: () => 0,
        readErrno: () => 0,
      };
      const result = await runMatrixRow({
        fixtureRoot: join(parent, id),
        provider: "onedrive",
        row: "cached-unpinned",
        observer,
        policy,
      });
      expect(result).toMatchObject({
        verdict: "PASS",
        row: "cached-unpinned",
      });
      expect((result.probes as unknown[]).length).toBe(3);
    } finally {
      await safeRm(parent);
    }
  });

  test.each([
    {
      row: "pinned-offline" as const,
      verdict: "BLOCKED",
      reason: "provider_offline_state_not_safely_induced",
    },
    {
      row: "partial-content" as const,
      verdict: "NOT AVAILABLE",
      reason: "no_safe_partial_range_control",
    },
  ])("records an explicit unclaimed provider state %#", async (expected) => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-unclaimed-"));
    try {
      const id = "GNO-fn118-smoke-unclaimed";
      await createDedicatedFixture(parent, id, false);
      const result = await runMatrixRow({
        fixtureRoot: join(parent, id),
        provider: "onedrive",
        row: expected.row,
        observer: {
          kind: "darwin-ffi-lstat-st_flags",
          intermediateDirectoryCaveat: "test",
          observe: () => ({
            ok: true,
            dataless: false,
            stFlags: 0,
            errno: null,
          }),
        },
      });
      expect(result).toMatchObject(expected);
    } finally {
      await safeRm(parent);
    }
  });
});

describe("macos-file-provider-smoke policy and EDEADLK", () => {
  test.each([
    { errno: DARWIN_EDEADLK, expected: "EDEADLK" as const },
    { errno: 11, expected: "EDEADLK" as const },
    { errno: 5, expected: "OTHER" as const },
    { errno: 0, expected: "OTHER" as const },
  ])("classifies errno %#", ({ errno, expected }) => {
    expect(classifyGuardedReadErrno(errno)).toBe(expected);
  });

  test("policy failure fails closed and restores", async () => {
    const calls: string[] = [];
    const port: IoPolicyPort = {
      get: () => {
        calls.push("get");
        return -1;
      },
      set: () => {
        calls.push("set");
        return 0;
      },
      readErrno: () => 0,
    };
    const result = await withNoMaterializePolicy(async () => "nope", port);
    expect(result).toEqual({ ok: false, error: "policy_get_failed" });
    expect(calls).toEqual(["get"]);
  });

  test("policy restores prior value after run", async () => {
    const stack: number[] = [];
    const port: IoPolicyPort = {
      get: () => 7,
      set: (_t, _s, policy) => {
        stack.push(policy);
        return 0;
      },
      readErrno: () => 0,
    };
    const result = await withNoMaterializePolicy(async () => "ok", port);
    expect(result).toEqual({ ok: true, value: "ok" });
    expect(stack[0]).toBe(1); // OFF
    expect(stack[1]).toBe(7); // restored prior
  });

  test("policy restoration failure fails closed", async () => {
    let calls = 0;
    const port: IoPolicyPort = {
      get: () => 0,
      set: () => {
        calls += 1;
        return calls === 1 ? 0 : -1;
      },
      readErrno: () => 0,
    };
    expect(await withNoMaterializePolicy(async () => "ok", port)).toEqual({
      ok: false,
      error: "policy_restore_failed",
    });
  });
});

describe("macos-file-provider-smoke benchmark threshold math", () => {
  test("percentOverhead and compareAgainstThreshold are exact", () => {
    expect(percentOverhead(82.8422, 71.8915)).toBe(15.2323);
    expect(percentOverhead(71.8915, 0)).toBeNull();

    const fail = compareAgainstThreshold(82.8422, 71.8915, 10);
    expect(fail.passes).toBe(false);
    expect(fail.status).toBe("fail");
    expect(fail.overheadPercent).toBe(15.2323);

    const passAny = compareAgainstThreshold(
      PRE_IMPLEMENTATION_BASELINE.medianMs * 1.02,
      PRE_IMPLEMENTATION_BASELINE.medianMs,
      ANY_REGRESSION_THRESHOLD_PERCENT
    );
    expect(passAny.passes).toBe(true);
    expect(passAny.status).toBe("pass");

    const passLocal = compareAgainstThreshold(
      100,
      100,
      LOCAL_OVERHEAD_THRESHOLD_PERCENT
    );
    expect(passLocal.passes).toBe(true);
    expect(passLocal.overheadPercent).toBe(0);

    const indeterminate = compareAgainstThreshold(10, 0, 3);
    expect(indeterminate.passes).toBeNull();
    expect(indeterminate.status).toBe("indeterminate");
  });

  test("pre-implementation naive candidate remains the documented reject", () => {
    expect(PRE_IMPLEMENTATION_BASELINE.rejectedNaiveOverheadPercent).toBe(
      15.2323
    );
    expect(PRE_IMPLEMENTATION_BASELINE.medianMs).toBe(71.8915);
    expect(ANY_REGRESSION_THRESHOLD_PERCENT).toBe(3);
    expect(LOCAL_OVERHEAD_THRESHOLD_PERCENT).toBe(10);
  });
});

describe("macos-file-provider-smoke local hierarchical classification", () => {
  test("local mode classifies directories, not every discovered file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-hier-"));
    try {
      const root = join(parent, "corpus");
      await mkdir(join(root, "a", "b"), { recursive: true });
      await mkdir(join(root, "c"), { recursive: true });
      const files = [
        join(root, "root.md"),
        join(root, "a", "a1.md"),
        join(root, "a", "a2.md"),
        join(root, "a", "b", "b1.md"),
        join(root, "c", "c1.md"),
        join(root, "c", "c2.md"),
      ];
      await Promise.all(
        files.map((path, index) => Bun.write(path, `hier-${index}\n`))
      );

      const base = createDirectoryAvailability("local", {
        pathSupport: () => "icloud-drive",
      });
      const instrumented = instrumentDirectoryAvailability(base);
      const memoized = memoizeDirectoryAvailability(instrumented.port);
      const walker = new FileWalker();
      const { entries } = await walker.walk({
        root,
        pattern: "**/*",
        include: [],
        exclude: [],
        maxBytes: 1_000_000,
        sourceAvailability: "local",
        directoryAvailability: memoized,
      });

      expect(entries.length).toBe(files.length);
      // Availability work stays proportional to directories. Guarded
      // enumeration adds one revalidation per directory, still not per file.
      expect(instrumented.getUniquePaths()).toBeLessThan(files.length);
      expect(instrumented.getCallCount()).toBeLessThan(files.length * 2);
      expect(instrumented.getUniquePaths()).toBeGreaterThanOrEqual(1);
    } finally {
      await safeRm(parent);
    }
  });
});

describe("macos-file-provider-smoke benchmark shape", () => {
  test("shipped-design protocol and lanes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gno-fn118-bench-"));
    try {
      const id = "GNO-fn118-smoke-benchcorp";
      await createDedicatedFixture(parent, id, false);
      const receipt = await runAllLocalBenchmark({
        corpusRoot: join(parent, id),
      });
      const json = JSON.stringify(receipt);
      expect(json).not.toContain(parent);
      expect(json).not.toContain(id);
      expect(receipt.action).toBe("benchmark-shipped-design");
      expect(receipt.protocol).toMatchObject({
        warmups: WARMUP_COUNT,
        samplesPerLane: SAMPLE_COUNT,
      });
      expect(WARMUP_COUNT).toBe(2);
      expect(SAMPLE_COUNT).toBe(9);
      const lanes = receipt.lanes as Record<
        string,
        { rawMs?: number[]; kind: string }
      >;
      expect(lanes["task1-protocol-any-regression"]?.rawMs?.length).toBe(9);
      expect(lanes["any-discovery-traversal"]?.rawMs?.length).toBe(9);
      expect(lanes["local-discovery-traversal"]?.rawMs?.length).toBe(9);
      expect(lanes["availability-metadata-hierarchical"]?.rawMs?.length).toBe(
        9
      );
      expect(lanes["sniff-read-hash-any"]?.rawMs?.length).toBe(9);
      expect(lanes["sniff-read-hash-local"]?.rawMs?.length).toBe(9);
      expect(lanes.conversion?.kind).toBe("not-applicable");
      expect(lanes.embedding?.kind).toBe("not-applicable");
      // Naive per-file candidate must not be the R6 candidate lane.
      expect(lanes["candidate-discovery-plus-availability"]).toBeUndefined();
      expect(receipt.comparison).toHaveProperty("taskOneProtocolControl");
      expect(receipt.comparison).toHaveProperty(
        "localOverheadVsImplementedAny"
      );
      expect(receipt.comparison).toMatchObject({
        rejectedNaiveCandidate: {
          measured: false,
          preImplementationOverheadPercent: 15.2323,
        },
      });
      expect(receipt.comparison).toHaveProperty(
        "hostMeasurementInsertionPoint"
      );
      expect(receipt.hierarchicalProof).toMatchObject({
        provesHierarchical: true,
      });
      expect(receipt.protocol).toHaveProperty("complete", true);
      expect(receipt.protocol).toMatchObject({
        runOrder: expect.arrayContaining([
          "task1-protocol-any-regression",
          "any-discovery-traversal",
          "local-discovery-traversal",
        ]),
      });
      expect(receipt.environment).toMatchObject({ policyScope: "process" });
      expect(receipt.design).toMatchObject({
        rejectedCandidateOverheadPercent: 15.2323,
      });
    } finally {
      await safeRm(parent);
    }
  });
});
