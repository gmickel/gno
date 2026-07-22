import { describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory structure operations; Bun has no equivalents.
import { mkdtemp, rm } from "node:fs/promises";
// node:os and node:path provide temporary/path helpers; Bun has no equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAgenticCli,
  writeBenchmarkArtifacts,
} from "../../../evals/agentic/cli";
import { parseAgenticCliOptions } from "../../../evals/agentic/cli-options";
import { FixtureAgentFactory } from "../../../evals/agentic/fixture-agent";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { receiptFixture } from "./fixtures";

describe("agentic benchmark CLI", () => {
  test("parses stable defaults and normalizes lifecycle order", () => {
    const options = parseAgenticCliOptions([
      "--lifecycle",
      "warm,cold",
      "--timeout-ms=9000",
    ]);
    expect(options.adapterIds).toEqual(["gno-mcp", "lexical", "capsule"]);
    expect(options.lifecycles).toEqual(["cold", "warm"]);
    expect(options.agent).toBe("fixture");
    expect(options.timeoutMs).toBe(9000);
  });

  test("rejects empty duplicate and unknown values before preparation", () => {
    expect(() =>
      parseAgenticCliOptions(["--adapter", "gno-mcp,gno-mcp"])
    ).toThrow();
    expect(() => parseAgenticCliOptions(["--task="])).toThrow();
    expect(() => parseAgenticCliOptions(["--adapter", "not-real"])).toThrow();
    expect(() => parseAgenticCliOptions(["--wat"])).toThrow();
  });

  test("refuses filtered writes before running an adapter", async () => {
    let runs = 0;
    const exit = await runAgenticCli(
      ["--adapter", "lexical", "--task", "t0a1b2c3", "--write"],
      {
        runBenchmark: async () => {
          runs += 1;
          throw new Error("must not run");
        },
        stdout: { write: () => true },
        stderr: { write: () => true },
      }
    );
    expect(exit).toBe(2);
    expect(runs).toBe(0);
  });

  test("requested unavailable qmd stays in a full harness-error report", async () => {
    const fixture = await loadAgenticFixture();
    const receipt = receiptFixture(undefined, {
      taskId: "t0a1b2c3",
      adapterId: "qmd",
      trialId: "fixture-01",
      seed: 0,
      lifecycle: "cold",
      agentId: "fixture-agent-v1",
      calls: [],
      agentCalls: 0,
      backendInvocations: 0,
      modelVisibleUtf8Bytes: 0,
      finalEnvelope: null,
      stopReason: "error",
      failure: {
        class: "harness_error",
        code: "adapter_preparation_failed",
        redactedMessage: null,
      },
    });
    let output = "";
    const exit = await runAgenticCli(
      ["--adapter", "qmd", "--task", "t0a1b2c3", "--lifecycle", "cold"],
      {
        loadFixture: async () => fixture,
        createAgentFactory: () => new FixtureAgentFactory(),
        runBenchmark: async () => ({
          receipts: [receipt],
          preparations: [],
          canonicalFingerprint: "0".repeat(64),
        }),
        stdout: {
          write: (chunk) => {
            output += String(chunk);
            return true;
          },
        },
        stderr: { write: () => true },
      }
    );
    expect(exit).toBe(2);
    expect(output).toContain("Attempted/scored/successful: 1/0/0");
    expect(output).toContain("qmd/t0a1b2c3/fixture-01/cold");
  });

  test("formats and atomically replaces one four-file artifact set", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-agentic-artifacts-"));
    const target = join(root, "lane");
    const artifacts = {
      reportJson: '{"value":1}\n',
      canonicalJson: '{"value":1}\n',
      observationsJson: '{"value":1}\n',
      reportMarkdown: "# Report\n",
    };
    try {
      await writeBenchmarkArtifacts(target, artifacts);
      expect(await Bun.file(join(target, "report.json")).text()).toBe(
        '{ "value": 1 }\n'
      );
      await writeBenchmarkArtifacts(target, {
        ...artifacts,
        reportJson: '{"value":2}\n',
      });
      expect(await Bun.file(join(target, "report.json")).text()).toContain(
        '"value": 2'
      );
      expect(
        await Bun.file(join(target, "canonical.json")).exists()
      ).toBeTrue();
      expect(
        await Bun.file(join(target, "observations.json")).exists()
      ).toBeTrue();
      expect(await Bun.file(join(target, "report.md")).exists()).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
