import { expect, test } from "bun:test";
// node:path provides platform-native fixture paths; Bun has no path API.
import { join } from "node:path";

import { normalizeConnectorWorkspaceEnvironment } from "../../src/core/connector-environment";

test("connector workspace environment accepts only audited absolute roots", () => {
  expect(normalizeConnectorWorkspaceEnvironment(undefined)).toEqual({});
  expect(
    normalizeConnectorWorkspaceEnvironment({
      GNO_DATA_DIR: join(import.meta.dir, "data"),
      GNO_CACHE_DIR: join(import.meta.dir, "cache"),
    })
  ).toEqual({
    GNO_DATA_DIR: join(import.meta.dir, "data"),
    GNO_CACHE_DIR: join(import.meta.dir, "cache"),
  });

  for (const environment of [
    { PATH: "/tmp/bin" },
    { GNO_CONFIG_DIR: "/tmp/config" },
    { GNO_DATA_DIR: "relative/data" },
    { GNO_CACHE_DIR: "../cache" },
    { GNO_DATA_DIR: "/tmp/data\nspoof" },
    { GNO_CACHE_DIR: "/tmp/cache\0spoof" },
    { GNO_DATA_DIR: "" },
    { GNO_DATA_DIR: 42 },
  ]) {
    expect(normalizeConnectorWorkspaceEnvironment(environment)).toBeNull();
  }
});
