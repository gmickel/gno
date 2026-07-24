import { describe, expect, test } from "bun:test";

import {
  isExpectedResidentShutdownExit,
  isValidPackedWarmModelReuse,
  type ResidentStatus,
  waitForStatus,
} from "../../scripts/package-smoke-resident-support";

type ModelStatus = ResidentStatus["models"];

function models(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    activeLeases: 0,
    leaseAcquisitions: 0,
    leaseReleases: 0,
    loadedModels: 1,
    loadAttempts: 1,
    loadSuccesses: 1,
    loadFailures: 0,
    inflightLoads: 0,
    ...overrides,
  };
}

describe("packed resident shutdown exits", () => {
  test("accepts the platform-specific signal status", () => {
    expect(isExpectedResidentShutdownExit("linux", 143)).toBe(true);
    expect(isExpectedResidentShutdownExit("darwin", 143)).toBe(true);
    expect(isExpectedResidentShutdownExit("win32", 130)).toBe(true);
  });

  test("rejects unrelated nonzero statuses", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const exitCode of [1, 2, 126, 127, 137]) {
        expect(isExpectedResidentShutdownExit(platform, exitCode)).toBe(false);
      }
    }
    expect(isExpectedResidentShutdownExit("linux", 130)).toBe(false);
    expect(isExpectedResidentShutdownExit("win32", 143)).toBe(false);
  });

  test("reports process output immediately when startup exits", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "console.log('resident stdout'); console.error('resident stderr'); process.exit(2)",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const startedAt = performance.now();
    const startupError = await waitForStatus("http://127.0.0.1:1", "serve", {
      child,
      stdout: new Response(child.stdout).text(),
      stderr: new Response(child.stderr).text(),
    }).catch((error: unknown) => error);

    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toContain(
      "exited 2 before listener readiness"
    );
    expect((startupError as Error).message).toContain("resident stdout");
    expect((startupError as Error).message).toContain("resident stderr");
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});

describe("packed warm model reuse validation", () => {
  test("accepts recovered prior load failure when settled", () => {
    const before = models({
      leaseAcquisitions: 2,
      leaseReleases: 2,
      loadAttempts: 2,
      loadSuccesses: 1,
      loadFailures: 1,
      loadedModels: 1,
    });
    const after = models({
      leaseAcquisitions: 6,
      leaseReleases: 6,
      loadAttempts: 2,
      loadSuccesses: 1,
      loadFailures: 1,
      loadedModels: 1,
    });
    expect(isValidPackedWarmModelReuse(before, after, 4)).toBe(true);
  });

  const recoveredBefore = models({
    leaseAcquisitions: 2,
    leaseReleases: 2,
    loadAttempts: 2,
    loadSuccesses: 1,
    loadFailures: 1,
  });
  const recoveredAfter = models({
    leaseAcquisitions: 6,
    leaseReleases: 6,
    loadAttempts: 2,
    loadSuccesses: 1,
    loadFailures: 1,
  });
  const rejectedCases: {
    name: string;
    before: ModelStatus;
    after: ModelStatus;
  }[] = [
    {
      name: "no successful loaded model",
      before: models({
        loadedModels: 0,
        loadAttempts: 1,
        loadSuccesses: 0,
        loadFailures: 1,
      }),
      after: recoveredAfter,
    },
    {
      name: "inconsistent load accounting",
      before: models({
        loadAttempts: 3,
        loadSuccesses: 1,
        loadFailures: 1,
      }),
      after: recoveredAfter,
    },
    {
      name: "unsettled or unbalanced pre-state",
      before: models({
        activeLeases: 1,
        leaseAcquisitions: 2,
        leaseReleases: 1,
      }),
      after: recoveredAfter,
    },
    {
      name: "new load failure during reuse",
      before: recoveredBefore,
      after: {
        ...recoveredAfter,
        loadAttempts: 3,
        loadFailures: 2,
      },
    },
    {
      name: "wrong request lease count",
      before: recoveredBefore,
      after: {
        ...recoveredAfter,
        leaseAcquisitions: 5,
        leaseReleases: 5,
      },
    },
    {
      name: "unreleased request lease",
      before: recoveredBefore,
      after: { ...recoveredAfter, leaseReleases: 5 },
    },
    {
      name: "leftover active or inflight work",
      before: recoveredBefore,
      after: { ...recoveredAfter, activeLeases: 1, inflightLoads: 1 },
    },
  ];

  for (const rejectedCase of rejectedCases) {
    test(`rejects ${rejectedCase.name}`, () => {
      expect(
        isValidPackedWarmModelReuse(rejectedCase.before, rejectedCase.after, 4)
      ).toBe(false);
    });
  }
});
