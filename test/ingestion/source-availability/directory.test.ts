/**
 * Directory-boundary availability classification (amortized, injectable).
 */

import { describe, expect, test } from "bun:test";

import {
  AnyDirectoryAvailability,
  findUnprovenAvailabilityPrefix,
  LocalDirectoryAvailability,
  memoizeDirectoryAvailability,
  relPathUnderAnyPrefix,
  relPathUnderPrefix,
  type DarwinIoPolicyPort,
  type DarwinStatPort,
  SF_DATALESS,
} from "../../../src/ingestion/source-availability";

function policyPort(
  overrides: Partial<DarwinIoPolicyPort> = {}
): DarwinIoPolicyPort {
  return {
    get: () => 0,
    set: () => 0,
    readErrno: () => 0,
    ...overrides,
  };
}

describe("directory availability any mode", () => {
  test("always reports available", async () => {
    const port = new AnyDirectoryAvailability();
    expect(await port.classify("/any/path")).toEqual({ kind: "available" });
  });
});

describe("directory availability local mode", () => {
  test.each([{ platform: "linux" }, { platform: "win32" }])(
    "unsupported platform $platform fails closed",
    async ({ platform }) => {
      const port = new LocalDirectoryAvailability({
        platform,
        policy: policyPort(),
        stat: { lstatFlags: () => ({ ok: true, stFlags: 0 }) },
      });
      const result = await port.classify("/tmp/x");
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.code).toBe("SOURCE_AVAILABILITY_UNSUPPORTED");
    }
  );

  test("SF_DATALESS directory is dataless skip", async () => {
    const port = new LocalDirectoryAvailability({
      platform: "darwin",
      policy: policyPort(),
      stat: {
        lstatFlags: () => ({ ok: true, stFlags: SF_DATALESS }),
      },
      pathSupport: () => "icloud-drive",
    });
    const result = await port.classify(
      "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/d"
    );
    expect(result).toMatchObject({
      kind: "dataless",
      code: "DATALESS_DIRECTORY",
    });
  });

  test("non-dataless directory is available", async () => {
    const port = new LocalDirectoryAvailability({
      platform: "darwin",
      policy: policyPort(),
      stat: { lstatFlags: () => ({ ok: true, stFlags: 0 }) },
      pathSupport: () => "google-drive",
    });
    expect(
      await port.classify(
        "/Users/x/Library/CloudStorage/GoogleDrive-a/My Drive"
      )
    ).toEqual({
      kind: "available",
    });
  });

  test("policy failure fails closed", async () => {
    const port = new LocalDirectoryAvailability({
      platform: "darwin",
      policy: policyPort({ get: () => -1 }),
      stat: { lstatFlags: () => ({ ok: true, stFlags: 0 }) },
      pathSupport: () => "icloud-drive",
    });
    const result = await port.classify(
      "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/d"
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.code).toBe("SOURCE_AVAILABILITY_POLICY_FAILED");
  });
});

describe("prefix helpers", () => {
  test("relPathUnderPrefix matches exact and descendants", () => {
    expect(relPathUnderPrefix("cloud/nested/a.md", "cloud/nested")).toBe(true);
    expect(relPathUnderPrefix("cloud/nested", "cloud/nested")).toBe(true);
    expect(relPathUnderPrefix("cloud/other.md", "cloud/nested")).toBe(false);
    expect(relPathUnderAnyPrefix("a/b.md", ["", "x"])).toBe(true);
  });

  test("memoizes shared ancestors within one targeted batch", async () => {
    let calls = 0;
    const cached = memoizeDirectoryAvailability({
      mode: "local",
      classify: async () => {
        calls += 1;
        return { kind: "available" };
      },
    });
    await findUnprovenAvailabilityPrefix("/root", "a/one.md", cached);
    await findUnprovenAvailabilityPrefix("/root", "a/two.md", cached);
    expect(calls).toBe(2);
  });

  test("findUnprovenAvailabilityPrefix returns first blocked ancestor", async () => {
    const calls: string[] = [];
    // Injectable double via LocalDirectoryAvailability.
    const port = new LocalDirectoryAvailability({
      platform: "darwin",
      policy: policyPort(),
      pathSupport: () => "icloud-drive",
      stat: {
        lstatFlags: (absPath: string) => {
          calls.push(absPath);
          if (absPath.endsWith("/cloud")) {
            return { ok: true, stFlags: SF_DATALESS };
          }
          return { ok: true, stFlags: 0 };
        },
      } satisfies DarwinStatPort,
    });
    const found = await findUnprovenAvailabilityPrefix(
      "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/root",
      "cloud/nested/doc.md",
      port
    );
    expect(found?.code).toBe("DATALESS_DIRECTORY");
    expect(found?.relPath).toBe("cloud");
    // Root + cloud classified; nested not reached after cloud dataless.
    expect(calls.length).toBe(2);
  });
});
