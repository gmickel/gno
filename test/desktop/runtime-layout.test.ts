import { describe, expect, test } from "bun:test";

import {
  getBundledBunPath,
  getPackagedRuntimeDir,
  getPackagedRuntimeEntrypoint,
  getResourcesFolder,
} from "../../desktop/electrobun-shell/src/shared/runtime-layout";

describe("desktop runtime layout helpers", () => {
  test("resolves packaged runtime paths inside Resources/app", () => {
    expect(getPackagedRuntimeDir("/App/Contents/Resources")).toBe(
      "/App/Contents/Resources/app/gno-runtime"
    );
    expect(getPackagedRuntimeEntrypoint("/App/Contents/Resources")).toBe(
      "/App/Contents/Resources/app/gno-runtime/src/index.ts"
    );
  });

  test("resolves bundled bun binary path for macOS and Windows", () => {
    expect(getBundledBunPath("/App/Contents/MacOS/launcher", "darwin")).toBe(
      "/App/Contents/MacOS/bun"
    );
    expect(getBundledBunPath("C:\\GNO\\launcher.exe", "win32")).toBe(
      "C:\\GNO\\bun.exe"
    );
  });

  test("resolves resources folder from packaged exec path", () => {
    expect(getResourcesFolder("/App/Contents/MacOS/launcher", "darwin")).toBe(
      "/App/Contents/Resources"
    );
    expect(getResourcesFolder("C:\\GNO\\launcher.exe", "win32")).toBe(
      "C:\\GNO\\resources"
    );
  });
});
