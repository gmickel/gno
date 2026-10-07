import { expect, test } from "bun:test";

import pkg from "../../package.json";
import {
  BUN_ENGINE_RANGE,
  BUN_FLOOR,
  bunFloorWarning,
  bunMeetsFloor,
} from "../../src/app/bun-runtime";

test("the floor comes from engines.bun", () => {
  expect(BUN_ENGINE_RANGE).toBe(pkg.engines.bun);
  expect(BUN_FLOOR).toBe("1.4.1");
});

test("a Bun below the floor gets a one-line warning naming both versions", () => {
  const warning = bunFloorWarning("serve", "1.3.11");
  expect(warning).toContain("gno serve");
  expect(warning).toContain("Bun 1.3.11");
  expect(warning).toContain("1.4.1");
  expect(warning?.includes("\n")).toBe(false);
  expect(bunMeetsFloor("1.4.0")).toBe(false);
});

test("the floor and newer runtimes start silently", () => {
  expect(bunFloorWarning("mcp", "1.4.1")).toBeNull();
  expect(bunFloorWarning("daemon", "1.4.2")).toBeNull();
  expect(bunMeetsFloor("1.5.0")).toBe(true);
});

test("CI's oldest Bun is the floor", async () => {
  const ci = await Bun.file(
    new URL("../../.github/workflows/ci.yml", import.meta.url)
  ).text();
  const matrix = /bun: \$\{\{ fromJSON\(.*'\["([\d.]+)"/.exec(ci)?.[1];
  expect(matrix).toBe(BUN_FLOOR);
});
