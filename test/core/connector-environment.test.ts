import { expect, test } from "bun:test";

import { normalizeConnectorWorkspaceEnvironment } from "../../src/core/connector-environment";

test("connector workspace environment accepts only audited absolute roots", () => {
  expect(normalizeConnectorWorkspaceEnvironment(undefined)).toEqual({});
  expect(
    normalizeConnectorWorkspaceEnvironment({
      GNO_DATA_DIR: "/srv/gno/data",
      GNO_CACHE_DIR: "/srv/gno/cache",
    })
  ).toEqual({
    GNO_DATA_DIR: "/srv/gno/data",
    GNO_CACHE_DIR: "/srv/gno/cache",
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
