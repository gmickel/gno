import { beforeEach } from "bun:test";

/**
 * `process.env.X = saved` with `saved === undefined` stores the string
 * "undefined". A later test then resolves that as a relative directory and
 * writes into the repository (fn-201: `undefined/.mcp-write.lock`). Fail the
 * next test instead, so the leaking restore is found where it happens.
 */
const DIRECTORY_VARIABLES = ["GNO_DATA_DIR", "GNO_CONFIG_DIR", "GNO_CACHE_DIR"];

// An inherited "undefined" directory is as dangerous as a leaked one: every
// test would resolve it relative to the repository. Refuse to run at all.
const invalidAtStartup = DIRECTORY_VARIABLES.filter(
  (key) => process.env[key] === "undefined"
);
if (invalidAtStartup.length > 0) {
  throw new Error(
    `${invalidAtStartup.join(", ")} is set to the string "undefined" in the ` +
      "test environment; unset it or point it at a real directory."
  );
}

// Other variables inherited as "undefined" are outside GNO's control; only a
// change made during the run counts as a leak.
const inheritedUndefined = new Set(
  Object.keys(process.env).filter((key) => process.env[key] === "undefined")
);

beforeEach(() => {
  const leaked = Object.keys(process.env).filter(
    (key) => process.env[key] === "undefined" && !inheritedUndefined.has(key)
  );
  if (leaked.length > 0) {
    for (const key of leaked) Reflect.deleteProperty(process.env, key);
    throw new Error(
      `A previous test restored ${leaked.join(", ")} to the string "undefined"; ` +
        "delete the variable when its saved value is undefined."
    );
  }
});
