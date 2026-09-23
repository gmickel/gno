import { expect, test } from "bun:test";
// Bun has no directory lifecycle, chmod, or realpath APIs.
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os"; // Bun has no OS temporary directory API.
import { join } from "node:path"; // Bun has no path helpers.

import {
  privateCapturePath,
  windowsProcessCommand,
} from "../../../evals/acceptance/windows-observation";

test("capture privacy accepts owned inherited evidence and refuses broader read access", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-private-capture-"))
  );
  try {
    await privateCapturePath(root, true);
    const path = join(root, "evidence ' with spaces.json");
    // Keep the native owner chosen for this fresh file (token Owner may differ
    // from User under elevation); only its inherited DACL establishes privacy.
    await Bun.write(path, "synthetic");
    if (process.platform !== "win32") await chmod(path, 0o600);
    await expect(privateCapturePath(path)).resolves.toBeUndefined();
    if (process.platform === "win32") {
      await expect(privateCapturePath(root, true)).rejects.toThrow("empty");
      const grant = Bun.spawnSync(
        ["icacls.exe", path, "/grant", "*S-1-1-0:R"],
        { timeout: 10000, maxBuffer: 65536 }
      );
      expect(grant.exitCode).toBe(0);
    } else await chmod(path, 0o644);
    await expect(privateCapturePath(path)).rejects.toThrow(/private|ACL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("Windows process observation uses fixed script and validates PID data", () => {
  const one = windowsProcessCommand(["ps", "-o", "pid=,rss=", "-p", "123"]);
  const two = windowsProcessCommand(["ps", "-o", "pid=,rss=", "-p", "456"]);
  expect(one.cmd).toEqual(two.cmd);
  expect(one.env.GNO_QA_PROCESS_IDS).toBe("123");
  expect(one.env.GNO_QA_PROCESS_FIELDS).toBe("rss");
  expect(() => windowsProcessCommand(["ps", "-p", "1; exit 0"])).toThrow(
    "Invalid observed PIDs"
  );
});

test("private evidence setup completes in an IPC child with the native worker environment", async () => {
  const { nativeWorkerEnvironment } =
    await import("../../../src/llm/native-worker/runtime-config");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-private-child-"))
  );
  const helper = Bun.fileURLToPath(
    new URL("../../../evals/acceptance/windows-observation.ts", import.meta.url)
  );
  let reported = false;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
      import {privateCapturePath} from ${JSON.stringify(helper)};
      await privateCapturePath(${JSON.stringify(root)}, true);
      process.send("private", () => process.disconnect());
    `,
    ],
    {
      env: nativeWorkerEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
      ipc(message) {
        if (message === "private") reported = true;
      },
    }
  );
  try {
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr, reported }).toEqual({
      code: 0,
      stderr: "",
      reported: true,
    });
    await privateCapturePath(root);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
