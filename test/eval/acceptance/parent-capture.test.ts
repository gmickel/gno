import { expect, test } from "bun:test";
// Bun has no temporary-directory lifecycle or canonicalization APIs.
import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os"; // Bun has no OS temp-directory API.
import { join } from "node:path"; // Bun has no path helpers.

import { installParentCapture } from "../../../evals/acceptance/parent-capture";

test("selected pipeline attachment captures direct-surface metadata without tracing and restores property hook", async () => {
  const { attachSearchResultsTraceMetadata } =
    await import("../../../src/pipeline/trace-metadata");
  const { SEARCH_RESULTS_TRACE_METADATA } =
    await import("../../../src/pipeline/types");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-pipeline-attachment-"))
  );
  const original = Object.defineProperty;
  const capture = await installParentCapture("direct-surface", [], root);
  try {
    capture.begin();
    const result = {
      results: [],
      meta: {
        query: "exact",
        mode: "hybrid" as const,
        totalResults: 0,
        vectorsUsed: false,
      },
    };
    const trace = {
      capabilityOutcomes: [
        {
          capability: "semantic_search",
          status: "failed" as const,
          reasonCode: "vector_error",
        },
      ],
      fallbackCodes: ["vector_error"],
    };
    Object.defineProperty(
      {},
      Symbol(SEARCH_RESULTS_TRACE_METADATA.description),
      { value: trace }
    );
    expect(capture.capture.searchResults).toEqual([]);
    expect(attachSearchResultsTraceMetadata(result, trace)).toBe(result);
    expect(
      Object.getOwnPropertyDescriptor(result, SEARCH_RESULTS_TRACE_METADATA)
        ?.enumerable
    ).toBe(false);
    const observed = capture.finish();
    expect(observed.searchResults).toEqual([
      {
        source: "src/pipeline/trace-metadata.ts",
        method: "attachSearchResultsTraceMetadata",
        result: structuredClone(result),
        trace,
      },
    ]);
    expect(
      observed.searchResults?.[0]?.trace?.capabilityOutcomes[0]?.status
    ).toBe("failed");
  } finally {
    capture.restore();
    expect(Object.defineProperty).toBe(original);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([0, 7])(
  "RSS exit race retains raw absence and only recognizes successful owned exit: %s",
  async (exitCode) => {
    const { OwnedResources } =
      await import("../../../evals/acceptance/resources");
    const scope = new OwnedResources();
    const spawn = Bun.spawn;
    const owner = spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `process.on('message',()=>process.exit(${exitCode}));setInterval(()=>{},1000)`,
      ],
      { stdout: "ignore", stderr: "ignore", ipc() {} }
    );
    scope.own(owner);
    let injected = false;
    Bun.spawn = ((command: unknown, ...args: unknown[]) => {
      if (
        Array.isArray(command) &&
        command[0] === "ps" &&
        command[2] === "pid=,rss=" &&
        !injected
      ) {
        injected = true;
        owner.send("finish");
        // Delay only this real ps invocation until the owned program exits,
        // reproducing the race between the liveness check and OS RSS read.
        return spawn(
          [
            process.execPath,
            "--no-env-file",
            "-e",
            `await Bun.sleep(100);const p=Bun.spawn(${JSON.stringify(["ps", "-o", "pid=,rss=", "-p", String(owner.pid)])},{stdout:'inherit',stderr:'ignore'});process.exit(await p.exited)`,
          ],
          { stdout: "pipe", stderr: "ignore" }
        );
      }
      return Reflect.apply(spawn, Bun, [command, ...args]);
    }) as typeof Bun.spawn;
    try {
      await scope.sample();
      expect(injected).toBe(true);
      const sample = scope.samples[0]!;
      expect(sample.rssBytes).toBeNull();
      if (exitCode === 0) {
        expect(sample.errors).toEqual([]);
        expect(sample.exitedDuringSample).toEqual({
          pids: [owner.pid],
          rssExitCode: 1,
          rssOutput: "",
          absenceExitCode: 1,
          absenceOutput: "",
        });
      } else {
        expect(sample.errors.join(" ")).toContain("RSS sample unavailable");
        expect(sample.exitedDuringSample).toBeUndefined();
      }
    } finally {
      Bun.spawn = spawn;
      await scope.close();
    }
  }
);

test("atomic child ledger growth bypasses BunFile cached length; only missing files are absent", async () => {
  const { readChildEventLedger } =
    await import("../../../evals/acceptance/surface-adapter");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-ledger-rename-"))
  );
  const path = join(root, "children.json");
  try {
    expect(await readChildEventLedger(path)).toBeNull();
    const identity = {
      runId: "ledger",
      token: crypto.randomUUID(),
      parentPid: process.pid,
      pid: process.pid + 1,
      generation: 1,
      entry: "/selected/entry.ts",
    };
    const first = [{ identity, event: "birth" as const }];
    const second = [
      ...first,
      { identity, event: "exit" as const, exitCode: 0 },
    ];
    await Bun.write(path, JSON.stringify(first));
    const stale = Bun.file(path);
    expect(await stale.exists()).toBe(true);
    const cachedLength = stale.size;
    await Bun.write(`${path}.next`, JSON.stringify(second));
    await rename(`${path}.next`, path);
    // Reproduce the old handle's cached-length condition with real atomic rename.
    expect(cachedLength).toBeLessThan(JSON.stringify(second).length);
    expect(await readChildEventLedger(path)).toEqual(second);
    await Bun.write(`${path}.next`, "{");
    await rename(`${path}.next`, path);
    expect(
      await readChildEventLedger(path).catch((error: unknown) => error)
    ).toBeInstanceOf(SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
