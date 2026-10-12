import { expect, test } from "bun:test";
// node:path — no Bun path utils.
import { dirname } from "node:path";
// node:url — file URL conversion has no Bun equivalent.
import { pathToFileURL } from "node:url";

import { moduleDir, modulePath } from "../../src/core/module-path";

test("module path and directory follow Bun's import.meta when set", () => {
  expect(modulePath(import.meta)).toBe(import.meta.path);
  expect(moduleDir(import.meta)).toBe(import.meta.dir);
  const compiled = {
    url: "file:///$bunfs/root/gno",
    path: "/$bunfs/root/gno",
    dir: "/$bunfs/root",
  };
  expect(modulePath(compiled)).toBe("/$bunfs/root/gno");
  expect(moduleDir(compiled)).toBe("/$bunfs/root");
});

test("module path and directory fall back to import.meta.url outside Bun", () => {
  // Module runners such as the eval runner set only import.meta.url.
  const url = pathToFileURL(import.meta.path).href;
  expect(modulePath({ url })).toBe(import.meta.path);
  expect(moduleDir({ url })).toBe(dirname(import.meta.path));
});
