/**
 * Unit/contract tests for source-availability readers and Darwin guard outcomes.
 * One focused case per acceptance/error outcome; injectable I/O (no live providers).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSourceContentReader,
  DARWIN_EACCES,
  DARWIN_EDEADLK,
  DARWIN_ENOENT,
  DARWIN_ELOOP,
  DARWIN_EPERM,
  IOPOL_MATERIALIZE_DATALESS_FILES_OFF,
  IOPOL_SCOPE_PROCESS,
  IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
  LocalSourceContentReader,
  type DarwinFileIoPort,
  type DarwinIoPolicyPort,
  withNoMaterializePolicy,
} from "../../../src/ingestion/source-availability";
import { safeRm } from "../../helpers/cleanup";

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

function filePort(overrides: Partial<DarwinFileIoPort> = {}): DarwinFileIoPort {
  return {
    open: () => 3,
    read: () => 0,
    close: () => 0,
    readErrno: () => 0,
    ...overrides,
  };
}

const supportedPath = () => "icloud-drive" as const;

describe("source availability any mode", () => {
  test("reads local file bytes unchanged via Bun path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-src-avail-any-"));
    try {
      const path = join(dir, "doc.md");
      await writeFile(path, "# hello\n");
      const reader = createSourceContentReader("any");
      expect(reader.mode).toBe("any");
      const result = await reader.readAll(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(new TextDecoder().decode(result.bytes)).toBe("# hello\n");
    } finally {
      await safeRm(dir);
    }
  });
});

describe("source availability local mode — platform fail-closed", () => {
  test.each([
    { platform: "linux" },
    { platform: "win32" },
    { platform: "freebsd" },
  ])("unsupported platform $platform fails closed", async ({ platform }) => {
    const reader = new LocalSourceContentReader({
      platform,
      policy: policyPort(),
      file: filePort(),
    });
    const result = await reader.readAll("/tmp/x");
    expect(result).toMatchObject({
      ok: false,
      code: "SOURCE_AVAILABILITY_UNSUPPORTED",
    });
    if (result.ok) return;
    expect(result.message).toContain(platform);
  });
});

describe("source availability local mode — policy setup", () => {
  test.each([
    {
      name: "policy get failed",
      policy: policyPort({ get: () => -1 }),
      detail: "policy_get_failed",
    },
    {
      name: "policy get threw",
      policy: policyPort({
        get: () => {
          throw new Error("get unavailable");
        },
      }),
      detail: "policy_get_failed",
    },
    {
      name: "policy set failed",
      policy: policyPort({
        get: () => 0,
        set: () => -1,
      }),
      detail: "policy_set_failed",
    },
    {
      name: "policy restore failed",
      policy: (() => {
        let calls = 0;
        return policyPort({
          get: () => 0,
          set: () => {
            calls += 1;
            return calls === 1 ? 0 : -1;
          },
        });
      })(),
      detail: "policy_restore_failed",
    },
    {
      name: "darwin io unavailable",
      policy: null,
      file: null,
      detail: "darwin_io_unavailable",
    },
  ])("policy setup failure: $name", async ({ policy, file, detail }) => {
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policy === undefined ? policyPort() : policy,
      file: file === undefined ? filePort() : file,
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/tmp/x");
    expect(result).toMatchObject({
      ok: false,
      code: "SOURCE_AVAILABILITY_POLICY_FAILED",
    });
    if (result.ok) return;
    expect(result.message).toContain(detail);
  });

  test("withNoMaterializePolicy restores prior value", async () => {
    const stack: number[] = [];
    const port = policyPort({
      get: () => 7,
      set: (_t, _s, policy) => {
        stack.push(policy);
        return 0;
      },
    });
    const result = withNoMaterializePolicy(() => "ok", port);
    expect(result).toEqual({ ok: true, value: "ok" });
    expect(stack[0]).toBe(IOPOL_MATERIALIZE_DATALESS_FILES_OFF);
    expect(stack[1]).toBe(7);
    // Ensure process scope + type constants match smoke harness.
    expect(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES).toBe(3);
    expect(IOPOL_SCOPE_PROCESS).toBe(0);
  });
});

describe("source availability local mode — read errno outcomes", () => {
  test("unsupported filesystem layout fails before guarded open", async () => {
    let opened = false;
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => {
          opened = true;
          return 3;
        },
      }),
      pathSupport: () => "unsupported",
    });
    const result = await reader.readAll("/Volumes/remote/doc.md");
    expect(result).toMatchObject({
      ok: false,
      code: "SOURCE_AVAILABILITY_UNSUPPORTED",
    });
    expect(opened).toBe(false);
  });

  test("EDEADLK open is cloud-placeholder skip (not conversion error)", async () => {
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => -1,
        readErrno: () => DARWIN_EDEADLK,
      }),
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/cloud/only.md");
    expect(result).toMatchObject({
      ok: false,
      code: "CLOUD_PLACEHOLDER",
      errno: DARWIN_EDEADLK,
    });
  });

  test("symlink open is refused as unknown safety", async () => {
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => -1,
        readErrno: () => DARWIN_ELOOP,
      }),
      pathSupport: supportedPath,
    });
    expect(await reader.readAll("/cloud/link.md")).toMatchObject({
      ok: false,
      code: "SOURCE_AVAILABILITY_UNKNOWN",
      errno: DARWIN_ELOOP,
    });
  });

  test("eviction race: mid-read EDEADLK with prior bytes is CLOUD_PARTIAL", async () => {
    let reads = 0;
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => 5,
        read: (fd, buf) => {
          reads += 1;
          if (reads === 1) {
            buf[0] = 0x41;
            buf[1] = 0x42;
            return 2;
          }
          return -1;
        },
        readErrno: () => DARWIN_EDEADLK,
      }),
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/cloud/partial.md");
    expect(result).toMatchObject({
      ok: false,
      code: "CLOUD_PARTIAL",
      errno: DARWIN_EDEADLK,
    });
  });

  test("early EOF before the stat size is a retryable I/O error", async () => {
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => 5,
        read: () => 0,
      }),
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/cloud/partial.md", 12);
    expect(result).toMatchObject({
      ok: false,
      code: "IO_ERROR",
    });
    if (result.ok) return;
    expect(result.message).toContain("short_read expected=12 read=0");
  });

  test.each([
    { errno: DARWIN_EACCES, code: "PERMISSION" as const },
    { errno: DARWIN_EPERM, code: "PERMISSION" as const },
  ])("permissions errno $errno → $code", async ({ errno, code }) => {
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => -1,
        readErrno: () => errno,
      }),
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/secret.md");
    expect(result).toMatchObject({ ok: false, code, errno });
  });

  test("ENOENT maps to NOT_FOUND", async () => {
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => -1,
        readErrno: () => DARWIN_ENOENT,
      }),
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/missing.md");
    expect(result).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
      errno: DARWIN_ENOENT,
    });
  });

  test("unknown errno/safety fails closed as SOURCE_AVAILABILITY_UNKNOWN", async () => {
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => -1,
        readErrno: () => 99,
      }),
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/weird.md");
    expect(result).toMatchObject({
      ok: false,
      code: "SOURCE_AVAILABILITY_UNKNOWN",
      errno: 99,
    });
  });

  test("unknown flags/safety probe fails closed without open", async () => {
    let opened = false;
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => {
          opened = true;
          return 3;
        },
      }),
      pathSupport: supportedPath,
      safetyProbe: () => ({
        ok: false,
        code: "SOURCE_AVAILABILITY_UNKNOWN",
        message: "unknown st_flags bits",
      }),
    });
    const result = await reader.readAll("/flagged.md");
    expect(result).toMatchObject({
      ok: false,
      code: "SOURCE_AVAILABILITY_UNKNOWN",
    });
    expect(opened).toBe(false);
  });

  test("successful guarded read returns bytes", async () => {
    const payload = new TextEncoder().encode("local-content");
    let offset = 0;
    const reader = new LocalSourceContentReader({
      platform: "darwin",
      policy: policyPort(),
      file: filePort({
        open: () => 7,
        read: (_fd, buf) => {
          if (offset >= payload.byteLength) return 0;
          const n = Math.min(buf.byteLength, payload.byteLength - offset);
          buf.set(payload.subarray(offset, offset + n));
          offset += n;
          return n;
        },
      }),
      pathSupport: supportedPath,
    });
    const result = await reader.readAll("/local.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.bytes)).toBe("local-content");
  });
});

describe("createSourceContentReader factory", () => {
  afterEach(() => {
    // no shared cache mutations in these cases
  });

  test("any factory ignores local deps", async () => {
    const reader = createSourceContentReader("any", {
      platform: "linux",
      policy: null,
      file: null,
    });
    expect(reader.mode).toBe("any");
  });

  test("local factory uses provided platform", async () => {
    const reader = createSourceContentReader("local", { platform: "linux" });
    const result = await reader.readAll("/x");
    expect(result).toMatchObject({
      ok: false,
      code: "SOURCE_AVAILABILITY_UNSUPPORTED",
    });
  });
});
