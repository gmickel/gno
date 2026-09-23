import { expect, test } from "bun:test";
// Bun has no temporary-directory creation API or OS/path helpers.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeRm } from "../helpers/cleanup";

type Workflow = {
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};

for (const [workflowPath, job, step] of [
  [".github/workflows/ci.yml", "test-windows", "Test"],
  [".github/workflows/publish.yml", "test", "Test (Windows)"],
]) {
  test(`${workflowPath} Windows command runs numbered and unnumbered files`, async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(workflowPath!).text()
    ) as Workflow;
    const command = workflow.jobs[job!]?.steps.find(
      (item) => item.name === step
    )?.run;
    expect(command).toBeDefined();
    const args = command!.trim().split(/\s+/);
    expect(args.slice(0, 2)).toEqual(["bun", "test"]);
    const root = await mkdtemp(join(tmpdir(), "gno-windows-test-scope-"));
    try {
      for (const name of ["number1.test.ts", "unnumbered.test.ts"]) {
        await Bun.write(
          join(root, name),
          'import {test,expect} from "bun:test"; test("included",()=>expect(true).toBe(true));\n'
        );
      }
      const result = Bun.spawnSync([process.execPath, ...args.slice(1)], {
        cwd: root,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode).toBe(0);
      expect(output).toContain("2 pass");
      expect(output).toContain("Ran 2 tests across 2 files");
    } finally {
      await safeRm(root);
    }
  });
}
