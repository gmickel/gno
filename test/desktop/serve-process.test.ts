/**
 * fn-207 R1: the desktop shell starts serve with a stdin lifeline and stops
 * it by SIGTERM, waiting and escalating to SIGKILL when it overruns.
 */

import { expect, test } from "bun:test";

import {
  startServeProcess,
  stopServeProcess,
} from "../../desktop/electrobun-shell/src/bun/serve-process";

const script = (body: string): string[] => [process.execPath, "-e", body];

test("serve gets the lifeline opt-in and sees EOF when the pipe closes", async () => {
  const child = startServeProcess({
    cmd: script(
      `await new Response(Bun.stdin.stream()).text(); process.exit(process.env.GNO_PARENT_LIFELINE === "stdin" ? 7 : 1);`
    ),
    stdio: "ignore",
  });
  await Bun.sleep(200);
  expect(child.exitCode).toBeNull();
  // Closing the shell's end stands in for the shell dying.
  await child.stdin.end();
  expect(await child.exited).toBe(7);
});

test("a serve that exits on SIGTERM is stopped without escalation", async () => {
  const child = startServeProcess({
    cmd: script(`setInterval(() => {}, 1000);`),
    stdio: "ignore",
  });
  await Bun.sleep(200);
  expect(await stopServeProcess(child, 5_000)).toBe("terminated");
  expect(child.signalCode).toBe("SIGTERM");
});

test("a serve that overruns its grace period is SIGKILLed", async () => {
  const child = startServeProcess({
    cmd: script(
      `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`
    ),
    stdio: "ignore",
  });
  await Bun.sleep(300);
  const started = Date.now();
  expect(await stopServeProcess(child, 500)).toBe("killed");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(child.signalCode).toBe("SIGKILL");
});

test("stopping an already-exited serve is a no-op", async () => {
  const child = startServeProcess({ cmd: script(""), stdio: "ignore" });
  await child.exited;
  expect(await stopServeProcess(child, 500)).toBe("already-exited");
});
