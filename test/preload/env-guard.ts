import { beforeEach } from "bun:test";

/**
 * `process.env.X = saved` with `saved === undefined` stores the string
 * "undefined". A later test then resolves that as a relative directory and
 * writes into the repository (fn-201: `undefined/.mcp-write.lock`). Fail the
 * next test instead, so the leaking restore is found where it happens.
 */
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
