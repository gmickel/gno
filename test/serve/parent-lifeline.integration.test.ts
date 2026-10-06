/**
 * fn-207 R1: a `gno serve` started with the stdin parent lifeline (as the
 * desktop shell starts it) exits when its launcher is SIGKILLed, instead of
 * continuing to hold the owner lock and port. Without the opt-in it keeps
 * running, so `nohup gno serve` is unaffected.
 */

import { afterEach, expect, test } from "bun:test";
// node:fs/promises — mkdir/mkdtemp are directory-structure ops
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os — tmpdir has no Bun equivalent
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join, resolve } from "node:path";

import { safeRm } from "../helpers/cleanup";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];
const pids: number[] = [];

afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const root of roots.splice(0)) await safeRm(root);
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function launch(lifeline: boolean) {
  const root = await mkdtemp(join(tmpdir(), "gno-lifeline-"));
  roots.push(root);
  await mkdir(join(root, "notes"), { recursive: true });
  await Bun.write(join(root, "notes", "a.md"), "# A\n");
  const port = 41_000 + Math.floor(Math.random() * 2_000);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: root,
    GNO_CONFIG_DIR: join(root, "config"),
    GNO_DATA_DIR: join(root, "data"),
    GNO_CACHE_DIR: join(root, "cache"),
    GNO_OFFLINE: "1",
  };
  const init = Bun.spawnSync({
    cmd: [process.execPath, "src/index.ts", "init", join(root, "notes")],
    cwd: REPO_ROOT,
    env,
  });
  expect(init.exitCode).toBe(0);
  if (lifeline) env.GNO_PARENT_LIFELINE = "stdin";
  else delete env.GNO_PARENT_LIFELINE;
  // Stand-in launcher: the desktop shell's spawn shape, holding the stdin pipe.
  const script = `const p = Bun.spawn({ cmd: [process.execPath, "src/index.ts", "serve", "--port", "${port}"], cwd: ${JSON.stringify(REPO_ROOT)}, stdin: "pipe", stdout: "ignore", stderr: "ignore" }); console.log(p.pid); await Bun.sleep(600000);`;
  const launcher = Bun.spawn({
    cmd: [process.execPath, "-e", script],
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  pids.push(launcher.pid);
  const first = await launcher.stdout.getReader().read();
  const servePid = Number(new TextDecoder().decode(first.value).trim());
  pids.push(servePid);
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = await fetch(`http://127.0.0.1:${port}/api/status`)
      .then((res) => res.ok)
      .catch(() => false);
    if (!ready) await Bun.sleep(200);
  }
  expect(ready).toBe(true);
  return { launcher, servePid, port };
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(100);
  return !alive(pid);
}

test("serve exits when its lifeline launcher is SIGKILLed", async () => {
  const { launcher, servePid, port } = await launch(true);
  launcher.kill("SIGKILL");
  await launcher.exited;
  expect(await waitGone(servePid, 10_000)).toBe(true);
  // The port is free again for the next app start.
  const reachable = await fetch(`http://127.0.0.1:${port}/api/status`)
    .then(() => true)
    .catch(() => false);
  expect(reachable).toBe(false);
}, 60_000);

// Windows ends a killed launcher's children with it, so there is nothing to
// keep running there.
test.skipIf(process.platform === "win32")(
  "serve without the lifeline keeps running when its launcher dies",
  async () => {
    const { launcher, servePid } = await launch(false);
    launcher.kill("SIGKILL");
    await launcher.exited;
    expect(await waitGone(servePid, 2_000)).toBe(false);
  },
  60_000
);
