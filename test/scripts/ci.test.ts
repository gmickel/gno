import { describe, expect, test } from "bun:test";

import { checkResults, selectJobs } from "../../.github/scripts/ci";

const outputs = {
  core: "true",
  clipper: "true",
  windows: "true",
  latest: "false",
};
const green = () => ({
  changes: { result: "success", outputs: { ...outputs } },
  lint: { result: "success" },
  test: { result: "success" },
  "watcher-cross-platform": { result: "success" },
  "test-windows": { result: "success" },
  "clipper-e2e": { result: "success" },
});

describe("CI relevance", () => {
  test("unknown files and missing diffs retain full coverage", () => {
    for (const paths of [
      null,
      ["new-build.config"],
      ["package.json"],
      ["bun.lock"],
    ]) {
      expect(selectJobs(paths, "pull_request")).toEqual({
        core: true,
        clipper: true,
        windows: true,
        latest: false,
      });
    }
  });
  test("documentation skips runtime checks but labels still select Windows", () => {
    expect(
      selectJobs(
        ["README.md", "docs/CLI.md", ".flow/tasks/task.md"],
        "pull_request"
      )
    ).toEqual({ core: false, clipper: false, windows: false, latest: false });
    expect(
      selectJobs(["README.md"], "pull_request", ["test-windows"]).windows
    ).toBe(true);
  });
  test("runtime Markdown and extension changes cannot masquerade as documentation", () => {
    for (const path of [
      "assets/skill/SKILL.md",
      "browser-extension/README.md",
      "test/fixtures/sample.md",
    ]) {
      expect(selectJobs([path], "pull_request").core).toBe(true);
    }
  });
  test("clipper relevant dependencies include capture, web, converters and packaging", () => {
    for (const path of [
      "src/core/capture.ts",
      "src/serve/routes/api.ts",
      "src/ingestion/sync.ts",
      "src/converters/pdf.ts",
      "scripts/package-smoke.ts",
      "browser-extension/src/main.ts",
    ]) {
      expect(selectJobs([path], "pull_request").clipper).toBe(true);
    }
    expect(selectJobs(["src/llm/adapter.ts"], "pull_request").clipper).toBe(
      false
    );
    expect(selectJobs(["src/llm/adapter.ts"], "pull_request").windows).toBe(
      true
    );
  });
  test("weekly/manual always exercise latest and main always covers Windows", () => {
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(selectJobs([], event)).toEqual({
        core: true,
        clipper: true,
        windows: true,
        latest: true,
      });
    }
    expect(selectJobs([], "push").windows).toBe(true);
  });
});

describe("CI aggregate", () => {
  test("accepts all and only selected successful jobs", () =>
    expect(() => checkResults(green())).not.toThrow());
  test("rejects failed/cancelled/skipped/missing selected jobs", () => {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      const needs = green();
      needs.test.result = result;
      expect(() => checkResults(needs)).toThrow();
    }
    expect(() => checkResults({})).toThrow();
  });
  test("classifier failures, absent outputs, and unexpectedly skipped lint fail closed", () => {
    const needs = green();
    needs.changes.result = "failure";
    expect(() => checkResults(needs)).toThrow();
    needs.changes.result = "success";
    needs.changes.outputs.core = "";
    expect(() => checkResults(needs)).toThrow();
    const missingLint = green();
    missingLint.lint.result = "skipped";
    expect(() => checkResults(missingLint)).toThrow();
  });
});

describe("release and workflow safety", () => {
  test("publication depends on every coordinated artifact and consumes the tested archive", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(
        new URL("../../.github/workflows/publish.yml", import.meta.url)
      ).text()
    ) as {
      concurrency: { "cancel-in-progress": boolean };
      jobs: Record<
        string,
        {
          needs?: string[];
          steps: {
            name?: string;
            run?: string;
            with?: Record<string, string>;
          }[];
        }
      >;
    };
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs.publish?.needs).toEqual([
      "pack-test",
      "package-windows-desktop",
      "package-macos-desktop",
    ]);
    const publishing = workflow.jobs.publish?.steps
      .map((step) => step.run ?? "")
      .join("\n");
    expect(publishing).toContain("sha256sum --check package.tgz.sha256");
    expect(publishing).toContain("npm publish ./npm-artifact/package.tgz");
    expect(publishing).not.toMatch(/(?:bun|npm) (?:install|pack)|build:css/);
    expect(
      workflow.jobs["pack-test"]?.steps.find(
        (step) => step.with?.name === "npm-package"
      )?.with?.["if-no-files-found"]
    ).toBe("error");
    expect(
      workflow.jobs["package-macos-desktop"]?.steps.some(
        (step) => step.name === "Launch-test signed macOS desktop release"
      )
    ).toBe(true);
  });
});
