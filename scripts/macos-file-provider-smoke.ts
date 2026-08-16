/**
 * Non-production macOS File Provider smoke + all-local scan benchmark CLI.
 * Provider-neutral; never infers across providers. No src/ / production changes.
 */

// node:os — temp/home helpers; no Bun equivalent
import { homedir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import {
  runAllLocalBenchmark,
  runOwnedLocalBenchmark,
} from "./macos-file-provider-smoke-benchmark";
import {
  assertFixtureBasename,
  FIXTURE_BASENAME_RE,
  MATRIX_ROWS,
  type MatrixRow,
  type ProbeKind,
  type ProviderLabel,
  redactToken,
  requireDarwin,
  resolveFixtureChild,
  resolveProviderRoot,
} from "./macos-file-provider-smoke-lib";
import {
  createDedicatedFixture,
  runMatrixRow,
  runProbe,
} from "./macos-file-provider-smoke-ops";

export {
  assertFixtureBasename,
  classifyGuardedReadErrno,
  classifyProviderRootShape,
  DARWIN_EDEADLK,
  FIXTURE_BASENAME_RE,
  IOPOL_SCOPE_PROCESS,
  IOPOL_SCOPE_THREAD,
  loadAvailabilityObserver,
  loadIoPolicyPort,
  MATRIX_ROWS,
  redactToken,
  requireDarwin,
  resetDarwinCachesForTests,
  resolveFixtureChild,
  resolveProviderRoot,
  SF_DATALESS,
  withNoMaterializePolicy,
} from "./macos-file-provider-smoke-lib";
export type { IoPolicyPort } from "./macos-file-provider-smoke-lib";
export {
  ANY_REGRESSION_THRESHOLD_PERCENT,
  compareAgainstThreshold,
  instrumentDirectoryAvailability,
  LOCAL_OVERHEAD_THRESHOLD_PERCENT,
  percentOverhead,
  PRE_IMPLEMENTATION_BASELINE,
  runAllLocalBenchmark,
  runOwnedLocalBenchmark,
  runShippedDesignBenchmark,
  SAMPLE_COUNT,
  summarizeSamples,
  WARMUP_COUNT,
} from "./macos-file-provider-smoke-benchmark";
export {
  createDedicatedFixture,
  runMatrixRow,
  runProbe,
} from "./macos-file-provider-smoke-ops";

export async function buildCleanupPlan(
  rootReal: string,
  fixtureId: string
): Promise<Record<string, unknown>> {
  await resolveFixtureChild(rootReal, fixtureId, { mustExist: true });
  const trash = join(homedir(), ".Trash");
  return {
    action: "cleanup-plan",
    dryRun: true,
    root: redactToken(rootReal),
    fixtureId: redactToken(fixtureId),
    validatedChildOnly: true,
    preferTrash: true,
    trashDirExists: await Bun.file(trash)
      .exists()
      .catch(() => false),
    plan: [
      {
        step: "verify-child-basename",
        ok: FIXTURE_BASENAME_RE.test(fixtureId),
      },
      {
        step: "move-exact-child-to-trash",
        note: "host moves only the validated fixture child; harness does not broad-delete",
        destinationHint: redactToken(trash),
      },
    ],
  };
}

export const HELP_TEXT = `macos-file-provider-smoke — non-production File Provider harness (TN3150)

Usage:
  bun scripts/macos-file-provider-smoke.ts --help
  bun scripts/macos-file-provider-smoke.ts validate-root --root <provider-root>
  bun scripts/macos-file-provider-smoke.ts create-fixture --root <provider-root> --fixture-id <GNO-fn118-smoke-...> [--dry-run]
  bun scripts/macos-file-provider-smoke.ts probe --root <provider-root> --fixture-id <id> [--probe metadata|traversal|guarded-read]
  bun scripts/macos-file-provider-smoke.ts matrix --root <provider-root> --fixture-id <id> --provider <google|icloud|onedrive> [--row <row>] [--race-delay-ms <ms>]
  bun scripts/macos-file-provider-smoke.ts benchmark --root <provider-root> --fixture-id <id> --provider <google|icloud|onedrive> --provider-version <version>
  bun scripts/macos-file-provider-smoke.ts benchmark-local --corpus-files <1000..10000>
      # shipped any|local hierarchical design (2 warmups + 9 samples/lane)
  bun scripts/macos-file-provider-smoke.ts cleanup-plan --root <provider-root> --fixture-id <id>

Safety:
  Darwin-only for all commands except --help. Unknown flags → nonzero exit.
  Root must be the exact installed Google My Drive, iCloud Drive, or an immediate
  library root inside a OneDrive SharedLibraries domain. Aggregation roots,
  arbitrary descendants, symlink roots, and arbitrary writable directories are refused.
  Fixture basename must match GNO-fn118-smoke-* (no separators/traversal).
  Mutating create refuses pre-existing fixture paths; operates only inside the new child.
  JSON redacts fixture IDs and provider roots as SHA-256; no source bytes or user names.

Policy (TN3150):
  IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES=3 with IOPOL_MATERIALIZE_DATALESS_FILES_OFF=1.
  Scope: process (0), not thread (1) — async Bun reads may escape thread scope in this
  isolated smoke process. Prior policy is always restored. Fail-closed on setup failure.
  Content I/O on dataless files is classified distinctly as EDEADLK when errno=11.

Observer:
  darwin-ffi-lstat-st_flags (SF_DATALESS=0x40000000). Caveat: stat can materialize
  intermediate dataless folders (TN3150). No source-byte reads for classification.

Matrix rows (independent; no cross-provider inference):
  local | pinned-offline | cached-unpinned | cloud-only | nested-dataless-directory
  | partial-content | classification-to-read-race
`;

export function parseArgs(argv: readonly string[]): {
  command: string;
  flags: Map<string, string | boolean>;
} {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", flags: new Map() };
  }
  const command = argv[0] ?? "help";
  const flags = new Map<string, string | boolean>();
  const known = new Set([
    "--root",
    "--fixture-id",
    "--provider",
    "--probe",
    "--dry-run",
    "--row",
    "--provider-version",
    "--race-delay-ms",
    "--corpus-files",
  ]);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      throw new Error(`unknown positional argument: ${token}`);
    }
    if (token === "--dry-run") {
      flags.set("--dry-run", true);
      continue;
    }
    if (!known.has(token)) {
      throw new Error(`unknown flag: ${token}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${token}`);
    }
    flags.set(token, value);
    i += 1;
  }
  return { command, flags };
}

function parseProvider(value: string | boolean | undefined): ProviderLabel {
  if (value === "google" || value === "icloud" || value === "onedrive") {
    return value;
  }
  throw new Error("invalid --provider (expected google|icloud|onedrive)");
}

function parseProviderVersion(value: string | boolean | undefined): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)
  ) {
    throw new Error("invalid --provider-version");
  }
  return value;
}

function parseRaceDelay(
  value: string | boolean | undefined
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("invalid --race-delay-ms");
  }
  const delay = Number(value);
  if (!Number.isSafeInteger(delay) || delay < 1 || delay > 60_000) {
    throw new Error("invalid --race-delay-ms (expected 1..60000)");
  }
  return delay;
}

function parseCorpusFiles(value: string | boolean | undefined): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("invalid --corpus-files (expected 1000..10000)");
  }
  const fileCount = Number(value);
  if (
    !Number.isSafeInteger(fileCount) ||
    fileCount < 1_000 ||
    fileCount > 10_000
  ) {
    throw new Error("invalid --corpus-files (expected 1000..10000)");
  }
  return fileCount;
}

async function collectEnvironment(): Promise<Record<string, unknown>> {
  const osVersion = (await Bun.$`sw_vers -productVersion`.quiet())
    .text()
    .trim();
  const osBuild = (await Bun.$`sw_vers -buildVersion`.quiet()).text().trim();
  const hardware = (await Bun.$`sysctl -n machdep.cpu.brand_string`.quiet())
    .text()
    .trim();
  const packageJson = (await Bun.file(
    new URL("../package.json", import.meta.url)
  ).json()) as { version?: unknown };
  return {
    osVersion,
    osBuild,
    hardware,
    gnoVersion:
      typeof packageJson.version === "string" ? packageJson.version : "unknown",
    capturedAt: new Date().toISOString(),
    betaOs: true,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function main(argv: string[]): Promise<number> {
  let parsed: { command: string; flags: Map<string, string | boolean> };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (parsed.command === "help") {
    console.log(HELP_TEXT);
    return 0;
  }

  const knownCommands = new Set([
    "validate-root",
    "create-fixture",
    "probe",
    "matrix",
    "benchmark",
    "benchmark-local",
    "cleanup-plan",
  ]);
  if (!knownCommands.has(parsed.command)) {
    console.error(`unknown command: ${parsed.command}`);
    return 2;
  }

  try {
    requireDarwin();

    if (parsed.command === "benchmark-local") {
      printJson(
        await runOwnedLocalBenchmark({
          fileCount: parseCorpusFiles(parsed.flags.get("--corpus-files")),
          environment: await collectEnvironment(),
        })
      );
      return 0;
    }

    const rootArg = parsed.flags.get("--root");
    if (typeof rootArg !== "string") {
      throw new Error("unsafe root: --root must be explicitly supplied");
    }
    const resolvedRoot = await resolveProviderRoot(rootArg);
    const rootReal = resolvedRoot.realPath;

    if (parsed.command === "validate-root") {
      printJson({
        action: "validate-root",
        ok: true,
        root: redactToken(rootReal),
        provider: resolvedRoot.provider,
        platform: process.platform,
      });
      return 0;
    }

    const fixtureId = parsed.flags.get("--fixture-id");
    if (typeof fixtureId !== "string") {
      throw new Error("missing --fixture-id");
    }
    assertFixtureBasename(fixtureId);

    if (parsed.command === "create-fixture") {
      printJson(
        await createDedicatedFixture(
          rootReal,
          fixtureId,
          parsed.flags.get("--dry-run") === true
        )
      );
      return 0;
    }

    if (parsed.command === "cleanup-plan") {
      printJson(await buildCleanupPlan(rootReal, fixtureId));
      return 0;
    }

    const fixtureRoot = await resolveFixtureChild(rootReal, fixtureId, {
      mustExist: true,
    });

    if (parsed.command === "probe") {
      const probeFlag = parsed.flags.get("--probe");
      const probe =
        typeof probeFlag === "string" ? (probeFlag as ProbeKind) : "metadata";
      if (!["metadata", "traversal", "guarded-read"].includes(probe)) {
        throw new Error(`unknown probe: ${probe}`);
      }
      printJson(await runProbe({ fixtureRoot, probe }));
      return 0;
    }

    if (parsed.command === "matrix") {
      const provider = parseProvider(parsed.flags.get("--provider"));
      if (provider !== resolvedRoot.provider) {
        throw new Error("--provider does not match validated provider root");
      }
      const raceDelayMs = parseRaceDelay(parsed.flags.get("--race-delay-ms"));
      const rowFlag = parsed.flags.get("--row");
      const rows: MatrixRow[] =
        typeof rowFlag === "string" ? [rowFlag as MatrixRow] : [...MATRIX_ROWS];
      for (const row of rows) {
        if (!(MATRIX_ROWS as readonly string[]).includes(row)) {
          throw new Error(`unknown matrix row: ${row}`);
        }
      }
      const results = [];
      for (const row of rows) {
        results.push(
          await runMatrixRow({ fixtureRoot, row, provider, raceDelayMs })
        );
      }
      printJson({
        action: "matrix",
        root: redactToken(rootReal),
        fixtureId: redactToken(fixtureId),
        provider,
        results,
      });
      return 0;
    }

    const provider = parseProvider(parsed.flags.get("--provider"));
    if (provider !== resolvedRoot.provider) {
      throw new Error("--provider does not match validated provider root");
    }
    const providerVersion = parseProviderVersion(
      parsed.flags.get("--provider-version")
    );
    printJson(
      await runAllLocalBenchmark({
        corpusRoot: fixtureRoot,
        provider: { label: provider, version: providerVersion },
        environment: await collectEnvironment(),
      })
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
