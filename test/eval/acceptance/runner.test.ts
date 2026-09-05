import { expect, test } from "bun:test";

import type { AcceptanceRecord } from "../../../evals/acceptance/records";

import {
  ACCEPTANCE_SCHEMA_VERSION,
  acceptanceManifestFingerprint,
  type AcceptanceManifest,
} from "../../../evals/acceptance/manifest";
import {
  distribution,
  summarizeReport,
  type PairedReport,
} from "../../../evals/acceptance/report";
import { OwnedResources } from "../../../evals/acceptance/resources";
import {
  runPairedAcceptance,
  type AcceptanceSessionFactory,
} from "../../../evals/acceptance/runner";

function fixture() {
  const hash = "a".repeat(64);
  const baseline: AcceptanceManifest = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    role: "baseline",
    identity: {
      commit: "a".repeat(40),
      indexId: "before",
      indexSha256: hash,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: "test",
    fixtures: [{ path: "test", sha256: hash }],
    models: [],
    cases: [
      {
        caseId: "one",
        fixtureSha256: hash,
        surface: "sdk",
        preset: "test",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  };
  const candidate = structuredClone(baseline);
  candidate.role = "candidate";
  const record = (manifest: AcceptanceManifest): AcceptanceRecord => ({
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    manifestSha256: acceptanceManifestFingerprint(manifest),
    caseId: "one",
    deterministic: {
      scope: {},
      results: [],
      citations: [],
      modelInputs: [],
      semanticState: {
        status: "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: null,
      },
    },
    generatedAnswer: "valid answer",
    transport: {},
  });
  return { baseline, candidate, record };
}

function factories(change?: (record: AcceptanceRecord) => void) {
  const data = fixture();
  const children: Bun.Subprocess[] = [];
  const calls: number[] = [];
  const create = (manifest: AcceptanceManifest): AcceptanceSessionFactory => ({
    open(scope) {
      const child = Bun.spawn(
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { stdout: "ignore", stderr: "ignore" }
      );
      scope.own(child);
      children.push(child);
      let count = 0;
      return Promise.resolve({
        processId: child.pid,
        modelState: () => Promise.resolve(count > 0),
        run() {
          count++;
          calls.push(count);
          const record = data.record(manifest);
          change?.(record);
          return Promise.resolve({
            record,
            coverage: "complete" as const,
            reasons: [],
          });
        },
        close: () => Promise.resolve(),
      });
    },
  });
  return {
    ...data,
    children,
    calls,
    factories: {
      baseline: create(data.baseline),
      candidate: create(data.candidate),
    },
  };
}

test("lifecycle screens retain owned sessions for primer and idle, complete timing, seed/order and raw samples", async () => {
  const f = factories();
  let tick = 0;
  const report = await runPairedAcceptance({
    ...f,
    observations: 2,
    seed: 2,
    idleMs: 1,
    clock: () => (tick += 10),
  });
  expect(report.status).toBe("inconclusive");
  expect(report.samples).toHaveLength(16);
  expect(
    report.samples
      .filter((row) => row.state === "fresh-process")
      .every((row) => row.durationMs === 30)
  ).toBe(true);
  expect(
    report.samples
      .filter((row) => row.state !== "fresh-process")
      .every((row) => row.durationMs === 10)
  ).toBe(true);
  expect(report.samples[0]?.order).toEqual(["baseline", "candidate"]);
  expect(report.samples[2]?.order).toEqual(["candidate", "baseline"]);
  expect(
    report.samples
      .filter((row) => row.state === "post-idle")
      .every((row) => row.beforeIdle?.rssBytes && row.afterIdle?.rssBytes)
  ).toBe(true);
  expect(f.calls.filter((n) => n === 2)).toHaveLength(8);
  expect(
    f.children.every(
      (child) => child.exitCode !== null || child.signalCode !== null
    )
  ).toBe(true);
});

test("equal empty answers and equal hidden fallbacks fail before performance summaries", async () => {
  for (const change of [
    (record: AcceptanceRecord) => {
      record.generatedAnswer = " ";
    },
    (record: AcceptanceRecord) => {
      record.deterministic.semanticState.fallbacks = ["lexical"];
    },
  ]) {
    const f = factories(change);
    const report = await runPairedAcceptance({
      ...f,
      observations: 1,
      seed: 1,
      strata: ["fresh-process"],
    });
    expect(report.status).toBe("quality-failed");
    expect(report.summaries).toEqual([]);
    expect(
      f.children.every(
        (child) => child.exitCode !== null || child.signalCode !== null
      )
    ).toBe(true);
  }
});

test("clock failure and missing owned resource process are explicit incomplete observations", async () => {
  const f = factories();
  const clock = await runPairedAcceptance({
    ...f,
    observations: 1,
    seed: 1,
    strata: ["fresh-process"],
    clock: () => Number.NaN,
  });
  expect(clock.status).toBe("incomplete");
  expect(
    clock.samples.every((row) =>
      row.errors.some((error) => error.includes("Clock"))
    )
  ).toBe(true);
  const scope = new OwnedResources();
  await scope.sample();
  await scope.close();
  expect(scope.errors).toHaveLength(1);
  expect(scope.samples[0]?.rssBytes).toBeNull();
});

test("timeout kills only owned children and prevents late registration leaks", async () => {
  const f = fixture();
  const children: Bun.Subprocess[] = [];
  const factory: AcceptanceSessionFactory = {
    open(scope) {
      const child = Bun.spawn(
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { stdout: "ignore", stderr: "ignore" }
      );
      scope.own(child);
      children.push(child);
      return new Promise(() => {});
    },
  };
  const report = await runPairedAcceptance({
    ...f,
    factories: { baseline: factory, candidate: factory },
    observations: 1,
    strata: ["fresh-process"],
    seed: 0,
    timeoutMs: 20,
  });
  expect(report.status).toBe("incomplete");
  expect(
    children.every(
      (child) => child.exitCode !== null || child.signalCode !== null
    )
  ).toBe(true);
  const scope = new OwnedResources();
  await scope.close();
  const late = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" }
  );
  expect(() => scope.own(late)).toThrow("closed");
  await late.exited;
  expect(late.signalCode).toBe("SIGKILL");
});

test("percentiles retain slower tails and require 100 observations for empirical p99", () => {
  expect(
    distribution(Array.from({ length: 30 }, (_, i) => i + 1))
  ).toMatchObject({ count: 30, p50: 15, p95: 29, p99: null, max: 30 });
  expect(
    distribution(Array.from({ length: 100 }, (_, i) => i + 1))
  ).toMatchObject({ p99: 99, p99Label: "empirical" });
});

test("30 valid paired observations screen; noisy samples and missing pairs are inconclusive", async () => {
  const f = factories();
  const small = await runPairedAcceptance({
    ...f,
    observations: 1,
    seed: 4,
    strata: ["fresh-process"],
  });
  const samples = small.samples;
  const report = (): PairedReport => ({
    ...small,
    summaries: [],
    samples: Array.from({ length: 30 }, (_, block) =>
      samples.map((row) => ({ ...row, block, durationMs: 10 }))
    ).flat(),
  });
  expect(summarizeReport(report(), ["fresh-process"], 30).status).toBe(
    "screened"
  );
  const noisy = report();
  for (const sample of noisy.samples)
    if (sample.block > 25) sample.durationMs = 100;
  expect(summarizeReport(noisy, ["fresh-process"], 30).status).toBe(
    "inconclusive"
  );
  const missing = report();
  missing.samples.pop();
  expect(summarizeReport(missing, ["fresh-process"], 30).status).toBe(
    "inconclusive"
  );
});

test("unobserved or falsely cold model state cannot produce a lifecycle screen", async () => {
  for (const observed of [null, true]) {
    const f = factories();
    const original = f.factories.baseline.open.bind(f.factories.baseline);
    f.factories.baseline.open = async (scope) => ({
      ...(await original(scope)),
      modelState: () => Promise.resolve(observed),
    });
    const report = await runPairedAcceptance({
      ...f,
      observations: 1,
      seed: 7,
      strata: ["resident-model-cold"],
    });
    expect(report.status).toBe("incomplete");
    expect(
      report.samples.find((row) => row.side === "baseline")?.errors.length
    ).toBeGreaterThan(0);
    expect(report.summaries).toHaveLength(0);
  }
});

test("declared overlap runs two owned sessions and compares background evidence before speed summaries", async () => {
  for (const corruptBackground of [false, true]) {
    const f = factories();
    f.baseline.cases[0]!.configuration.backgroundCaseId = "one";
    f.candidate.cases[0]!.configuration.backgroundCaseId = "one";
    for (const side of ["baseline", "candidate"] as const) {
      const original = f.factories[side].open.bind(f.factories[side]);
      let opened = 0;
      f.factories[side].open = async (scope) => {
        const session = await original(scope);
        const background = opened++ % 2 === 0;
        return {
          ...session,
          async run(caseId) {
            await Bun.sleep(20);
            const result = await session.run(caseId);
            if (corruptBackground && side === "candidate" && background)
              result.record.deterministic.scope = { leaked: true };
            return result;
          },
        };
      };
    }
    const report = await runPairedAcceptance({
      ...f,
      observations: 1,
      seed: 0,
      strata: ["fresh-process"],
    });
    expect(report.status).toBe(
      corruptBackground ? "quality-failed" : "inconclusive"
    );
    expect(
      report.samples.every((row) => (row.overlap?.overlappingMs ?? 0) > 0)
    ).toBe(true);
    expect(
      report.samples.every((row) =>
        row.resources.some((sample) => sample.pids.length === 2)
      )
    ).toBe(true);
    if (corruptBackground)
      expect(
        report.comparisons[0]?.result.failures.some((failure) =>
          failure.field.startsWith("background.")
        )
      ).toBe(true);
    expect(
      f.children.every(
        (child) => child.exitCode !== null || child.signalCode !== null
      )
    ).toBe(true);
  }
});
