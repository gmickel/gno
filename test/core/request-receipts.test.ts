/**
 * Request ledger contract (fn-170 R2/R3/R5): validation before admission,
 * replay, conflicts, namespace isolation, pending, recovery conflicts,
 * retention tombstones and the hard capacity cap. Side effects are real files.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises temp fixtures and mode checks: no Bun equivalent
import { mkdir, mkdtemp, readdir, rename, stat } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { acquireWriteLock } from "../../src/core/file-lock";
import { atomicCreate } from "../../src/core/file-ops";
import {
  type PrivateDirAcl,
  readRequestStatus,
  REQUEST_LEDGER_MAX_ROWS,
  REQUEST_RECEIPT_RETENTION_MS,
  type RequestCheckpoint,
  requestDigest,
  runRequestedWrite,
  securePrivateLedgerDir,
  validateRequestId,
} from "../../src/core/request-receipts";
import {
  isOwnerOnlyDescriptor,
  windowsDirectoryDescriptor,
  windowsPrivatePath,
} from "../../src/core/windows-private-path";
import { safeRm } from "../helpers/cleanup";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await safeRm(root);
});

interface Fixture {
  root: string;
  out: string;
  ledgerPath: string;
  lockPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "gno-receipts-"));
  roots.push(root);
  await mkdir(join(root, "out"));
  return {
    root,
    out: join(root, "out"),
    ledgerPath: join(root, "write-receipts", "index.sqlite"),
    lockPath: join(root, ".mcp-write.lock"),
  };
}

/** A minimal durable write: one file named by the payload. */
function writeFile(
  f: Fixture,
  input: {
    requestId: string;
    payload: string;
    namespace?: string;
    now?: number;
    lockWaitMs?: number;
    reject?: boolean;
    failPublish?: boolean;
    checkpoint?: (stage: RequestCheckpoint) => void;
  }
) {
  const path = join(f.out, `${input.payload}.txt`);
  return runRequestedWrite<{ path: string }, { path: string }>({
    ledgerPath: f.ledgerPath,
    namespace: input.namespace ?? "local",
    requestId: input.requestId,
    operation: "capture",
    digest: requestDigest("capture", { payload: input.payload }),
    lockPath: f.lockPath,
    lockWaitMs: input.lockWaitMs ?? 5_000,
    now: input.now === undefined ? undefined : () => input.now as number,
    checkpoint: input.checkpoint,
    prepare: async () => {
      if (input.reject) throw new Error("stale predecessor");
      return {
        plan: { path },
        publish: async () => {
          if (input.failPublish) throw new Error("disk full");
          await atomicCreate(path, input.payload);
        },
      };
    },
    inspect: async (plan) => {
      const file = Bun.file(plan.path);
      if (!(await file.exists())) return "absent";
      return (await file.text()) === input.payload ? "published" : "unexpected";
    },
    finish: async (plan) => ({ path: plan.path }),
    resultRef: (result) => ({ uri: `file:${result.path}` }),
  });
}

const files = async (f: Fixture): Promise<string[]> =>
  (await readdir(f.out)).sort();

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

const crashAt =
  (stage: RequestCheckpoint) =>
  (at: RequestCheckpoint): void => {
    if (at === stage) throw new Error("simulated crash");
  };

describe("request ID validation", () => {
  test.each([
    ["empty", ""],
    ["too long", "a".repeat(129)],
    ["leading punctuation", "-abc"],
    ["whitespace", "has space"],
    ["non-ASCII", "réq"],
    ["not a string", 42],
  ])("rejects %s before admission", async (_label, requestId) => {
    const f = await fixture();
    expect(() => validateRequestId(requestId)).toThrow(
      expect.objectContaining({ code: "REQUEST_ID_INVALID" })
    );
    expect(
      await codeOf(
        writeFile(f, { requestId: requestId as string, payload: "a" })
      )
    ).toBe("REQUEST_ID_INVALID");
    expect(await files(f)).toEqual([]);
  });

  test("accepts UUIDs and the documented alphabet up to 128 characters", () => {
    for (const id of [crypto.randomUUID(), "A1._:-x", "a".repeat(128)]) {
      expect(validateRequestId(id)).toBe(id);
    }
  });
});

describe("admission and replay", () => {
  test("a repeated request replays without writing again", async () => {
    const f = await fixture();
    const first = await writeFile(f, { requestId: "r1", payload: "a" });
    const again = await writeFile(f, { requestId: "r1", payload: "a" });
    expect(first.request.replayed).toBe(false);
    expect(again).toEqual({
      result: first.result,
      request: { ...first.request, replayed: true },
    });
    expect(await files(f)).toEqual(["a.txt"]);
  });

  test("the same ID with a different payload conflicts and writes nothing", async () => {
    const f = await fixture();
    await writeFile(f, { requestId: "r1", payload: "a" });
    expect(await codeOf(writeFile(f, { requestId: "r1", payload: "b" }))).toBe(
      "REQUEST_ID_CONFLICT"
    );
    expect(await files(f)).toEqual(["a.txt"]);
  });

  test("a rejection before admission leaves no receipt", async () => {
    const f = await fixture();
    expect(
      await codeOf(
        writeFile(f, { requestId: "r1", payload: "a", reject: true })
      )
    ).toBe("Error: stale predecessor");
    const status = await readRequestStatus({
      ledgerPath: f.ledgerPath,
      namespace: "local",
      requestId: "r1",
    });
    expect(status.status).toBe("not_found");
    expect(await files(f)).toEqual([]);
  });

  test("namespaces never see or collide with each other's requests", async () => {
    const f = await fixture();
    await writeFile(f, { requestId: "shared", payload: "a", namespace: "A" });
    expect(
      await readRequestStatus({
        ledgerPath: f.ledgerPath,
        namespace: "B",
        requestId: "shared",
      })
    ).toEqual({ requestId: "shared", status: "not_found" });
    // A different payload under B is B's own new request, not a conflict probe.
    const other = await writeFile(f, {
      requestId: "shared",
      payload: "b",
      namespace: "B",
    });
    expect(other.request.replayed).toBe(false);
    expect(await files(f)).toEqual(["a.txt", "b.txt"]);
  });

  test("status is a content-free pointer in a private ledger", async () => {
    const f = await fixture();
    await writeFile(f, { requestId: "r1", payload: "secret-body" });
    const status = await readRequestStatus({
      ledgerPath: f.ledgerPath,
      namespace: "local",
      requestId: "r1",
    });
    expect(status).toMatchObject({
      requestId: "r1",
      status: "committed",
      operation: "capture",
      result: { uri: `file:${join(f.out, "secret-body.txt")}` },
    });
    expect(Object.keys(status).sort()).toEqual([
      "createdAt",
      "operation",
      "requestId",
      "result",
      "status",
      "updatedAt",
    ]);
    if (process.platform === "win32") {
      // Throws unless the ledger grants only the current user access.
      await windowsPrivatePath(f.ledgerPath);
    } else {
      expect((await stat(f.ledgerPath)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("interrupted requests", () => {
  test("a pending request held by a live writer reports pending", async () => {
    const f = await fixture();
    await codeOf(
      writeFile(f, {
        requestId: "r1",
        payload: "a",
        checkpoint: crashAt("published"),
      })
    );
    const lease = await acquireWriteLock(f.lockPath, 1_000);
    try {
      expect(
        await codeOf(
          writeFile(f, { requestId: "r1", payload: "a", lockWaitMs: 200 })
        )
      ).toBe("REQUEST_PENDING");
    } finally {
      await lease?.release();
    }
    expect(
      (await writeFile(f, { requestId: "r1", payload: "a" })).request.replayed
    ).toBe(false);
    expect(await files(f)).toEqual(["a.txt"]);
  });

  test.each([
    [
      "an interrupted request later rejected",
      async (f: Fixture) => {
        await codeOf(
          writeFile(f, {
            requestId: "r1",
            payload: "a",
            checkpoint: crashAt("admitted"),
          })
        );
        return codeOf(
          writeFile(f, { requestId: "r1", payload: "a", reject: true })
        );
      },
      "Error: stale predecessor",
    ],
    [
      "a publication that wrote nothing",
      (f: Fixture) =>
        codeOf(
          writeFile(f, { requestId: "r1", payload: "a", failPublish: true })
        ),
      "Error: disk full",
    ],
  ])("%s leaves no receipt behind", async (_label, attempt, error) => {
    const f = await fixture();
    expect(await attempt(f)).toBe(error);
    expect(
      (
        await readRequestStatus({
          ledgerPath: f.ledgerPath,
          namespace: "local",
          requestId: "r1",
        })
      ).status
    ).toBe("not_found");
    expect(await files(f)).toEqual([]);
  });

  test("a target changed after publication is a recovery conflict, never overwritten", async () => {
    const f = await fixture();
    await codeOf(
      writeFile(f, {
        requestId: "r1",
        payload: "a",
        checkpoint: crashAt("published"),
      })
    );
    await Bun.write(join(f.out, "a.txt"), "edited by someone else");
    expect(await codeOf(writeFile(f, { requestId: "r1", payload: "a" }))).toBe(
      "REQUEST_RECOVERY_CONFLICT"
    );
    expect(await Bun.file(join(f.out, "a.txt")).text()).toBe(
      "edited by someone else"
    );
  });
});

describe("retention and capacity", () => {
  test("expired receipts compact to tombstones that refuse reuse", async () => {
    const f = await fixture();
    const t0 = Date.now();
    await writeFile(f, { requestId: "old", payload: "a", now: t0 });
    // Admission of a later request compacts receipts past retention.
    await writeFile(f, {
      requestId: "new",
      payload: "b",
      now: t0 + REQUEST_RECEIPT_RETENTION_MS + 1,
    });

    for (const payload of ["a", "c"]) {
      expect(await codeOf(writeFile(f, { requestId: "old", payload }))).toBe(
        "REQUEST_EXPIRED"
      );
    }
    expect(
      await readRequestStatus({
        ledgerPath: f.ledgerPath,
        namespace: "local",
        requestId: "old",
      })
    ).toMatchObject({ status: "expired", operation: "capture" });
    const db = new Database(f.ledgerPath, { readonly: true });
    const row = db
      .query(
        "SELECT digest, plan_json, result_json, ref_json FROM request_receipts WHERE request_id = 'old'"
      )
      .get() as Record<string, string | null>;
    db.close();
    expect(row).toEqual({
      digest: requestDigest("capture", { payload: "a" }),
      plan_json: null,
      result_json: null,
      ref_json: null,
    });
    expect(await files(f)).toEqual(["a.txt", "b.txt"]);
  });

  test("a full ledger rejects new admission before any write, still compacts, still replays", async () => {
    const f = await fixture();
    const old = Date.now() - REQUEST_RECEIPT_RETENTION_MS - 1;
    await writeFile(f, { requestId: "kept", payload: "a" });
    // Admitted "in the past", so nothing has compacted it yet.
    await writeFile(f, { requestId: "old", payload: "o", now: old });
    const db = new Database(f.ledgerPath);
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO request_receipts
         (namespace, request_id, operation, digest, status, created_at_ms, updated_at_ms)
       SELECT 'local', 'fill-' || i, 'capture', 'x', 'expired', 0, 0 FROM n`,
      [REQUEST_LEDGER_MAX_ROWS - 2]
    );
    db.close();

    expect(
      await codeOf(writeFile(f, { requestId: "next", payload: "b" }))
    ).toBe("REQUEST_CAPACITY_EXHAUSTED");
    expect(await files(f)).toEqual(["a.txt", "o.txt"]);
    const check = new Database(f.ledgerPath, { readonly: true });
    const compacted = check
      .query(
        "SELECT status, result_json FROM request_receipts WHERE request_id = 'old'"
      )
      .get();
    check.close();
    expect(compacted).toEqual({ status: "expired", result_json: null });
    expect(
      (await writeFile(f, { requestId: "kept", payload: "a" })).request.replayed
    ).toBe(true);
  });

  test("a receipt past retention reads as expired before any compaction", async () => {
    const f = await fixture();
    const old = Date.now() - REQUEST_RECEIPT_RETENTION_MS - 1;
    await writeFile(f, { requestId: "old", payload: "a", now: old });
    expect(
      await readRequestStatus({
        ledgerPath: f.ledgerPath,
        namespace: "local",
        requestId: "old",
      })
    ).toMatchObject({ status: "expired" });
    expect(await codeOf(writeFile(f, { requestId: "old", payload: "a" }))).toBe(
      "REQUEST_EXPIRED"
    );
  });

  test("an unavailable ledger fails before any write", async () => {
    const f = await fixture();
    await mkdir(f.ledgerPath, { recursive: true });
    expect(await codeOf(writeFile(f, { requestId: "r1", payload: "a" }))).toBe(
      "REQUEST_LEDGER_UNAVAILABLE"
    );
    expect(await files(f)).toEqual([]);
  });
});

// ─── Windows ledger directory verification (fn-191) ─────────────────────────

/** S-1-5-<rid> as SID bytes. */
const sid = (rid: number): number[] => [1, 1, 0, 0, 0, 0, 0, 5, rid, 0, 0, 0];
const USER = sid(1001);
const OTHER = sid(11); // Authenticated Users
const FULL = 0x1f_01_ff;

interface Ace {
  type: number;
  mask: number;
  sid: number[];
}

/** Self-relative security descriptor: owner, then a DACL (or none). */
function descriptor(owner: number[], aces: Ace[] | null): Uint8Array {
  const ace = (a: Ace): number[] => {
    const size = 8 + a.sid.length;
    return [
      a.type,
      0,
      size & 0xff,
      size >> 8,
      ...new Uint8Array(new Uint32Array([a.mask]).buffer),
      ...a.sid,
    ];
  };
  const body = (aces ?? []).flatMap(ace);
  const acl = aces
    ? [
        2,
        0,
        (8 + body.length) & 0xff,
        (8 + body.length) >> 8,
        aces.length,
        0,
        0,
        0,
        ...body,
      ]
    : [];
  const u32 = (n: number): number[] => [
    ...new Uint8Array(new Uint32Array([n]).buffer),
  ];
  const daclOffset = aces ? 20 + owner.length : 0;
  return new Uint8Array([
    1,
    0,
    0x04, // SE_DACL_PRESENT
    0x80, // SE_SELF_RELATIVE
    ...u32(20),
    ...u32(0),
    ...u32(0),
    ...u32(daclOffset),
    ...owner,
    ...acl,
  ]);
}

const OWNER_ONLY = descriptor(USER, [{ type: 0, mask: FULL, sid: USER }]);

/** Injected PowerShell check: counts spawns; `refuse` simulates a failed check. */
function fakeAcl(): {
  acl: PrivateDirAcl;
  state: { descriptor: Uint8Array; spawns: number; refuse: boolean };
} {
  const state = { descriptor: OWNER_ONLY, spawns: 0, refuse: false };
  return {
    state,
    acl: {
      verify: async () => {
        state.spawns += 1;
        if (state.refuse)
          throw new Error("Private ACL permits another principal");
      },
      descriptor: () => state.descriptor,
    },
  };
}

describe("ledger directory verification", () => {
  test.each([
    ["owner-only full control", OWNER_ONLY, true],
    [
      "owner-only plus a deny entry",
      descriptor(USER, [
        { type: 1, mask: FULL, sid: OTHER },
        { type: 0, mask: FULL, sid: USER },
      ]),
      true,
    ],
    [
      "another principal allowed",
      descriptor(USER, [
        { type: 0, mask: FULL, sid: USER },
        { type: 0, mask: 0x1_20_89, sid: OTHER },
      ]),
      false,
    ],
    [
      "owner is not the allowed principal",
      descriptor(OTHER, [{ type: 0, mask: FULL, sid: USER }]),
      false,
    ],
    [
      "no full control",
      descriptor(USER, [{ type: 0, mask: 0x1_20_89, sid: USER }]),
      false,
    ],
    [
      "unknown entry type",
      descriptor(USER, [
        { type: 0, mask: FULL, sid: USER },
        { type: 5, mask: FULL, sid: USER },
      ]),
      false,
    ],
    ["null DACL (everyone)", descriptor(USER, null), false],
    ["truncated", OWNER_ONLY.slice(0, OWNER_ONLY.length - 1), false],
  ])("owner-only descriptor: %s", (_name, bytes, expected) => {
    expect(isOwnerOnlyDescriptor(bytes)).toBe(expected);
  });

  test("first open verifies and records; later opens skip the process", async () => {
    const f = await fixture();
    const dir = join(f.root, "write-receipts");
    await mkdir(dir);
    const { acl, state } = fakeAcl();
    await securePrivateLedgerDir(dir, true, acl);
    await securePrivateLedgerDir(dir, false, acl);
    await securePrivateLedgerDir(dir, false, acl);
    expect(state.spawns).toBe(1);
  });

  test.each(["permissions changed", "directory replaced"] as const)(
    "%s: the check runs again and a refusal blocks the open",
    async (change) => {
      const f = await fixture();
      const dir = join(f.root, "write-receipts");
      await mkdir(dir);
      const { acl, state } = fakeAcl();
      await securePrivateLedgerDir(dir, true, acl);
      if (change === "permissions changed") {
        // Still owner-only by the parser, so only the recorded digest differs.
        state.descriptor = descriptor(USER, [
          { type: 1, mask: FULL, sid: OTHER },
          { type: 0, mask: FULL, sid: USER },
        ]);
      } else {
        // Same descriptor bytes and a copied marker, but a different directory.
        const marker = await Bun.file(join(dir, ".owner-only-verified")).text();
        await rename(dir, `${dir}.old`);
        await mkdir(dir);
        await Bun.write(join(dir, ".owner-only-verified"), marker);
      }
      state.refuse = true;
      await expect(securePrivateLedgerDir(dir, false, acl)).rejects.toThrow(
        "another principal"
      );
      expect(state.spawns).toBe(2);
    }
  );

  test.if(process.platform === "win32")(
    "Windows: real DACL is recorded, reused, and a grant is refused",
    async () => {
      const f = await fixture();
      const dir = join(f.root, "write-receipts");
      await mkdir(dir);
      let spawns = 0;
      const acl: PrivateDirAcl = {
        verify: async (path, create) => {
          spawns += 1;
          await windowsPrivatePath(path, create);
        },
        descriptor: windowsDirectoryDescriptor,
      };
      await securePrivateLedgerDir(dir, true, acl);
      await securePrivateLedgerDir(dir, false, acl);
      expect(spawns).toBe(1);
      const grant = Bun.spawnSync([
        "icacls",
        dir,
        "/grant",
        "*S-1-5-11:(OI)(CI)R",
      ]);
      expect(grant.exitCode).toBe(0);
      await expect(securePrivateLedgerDir(dir, false, acl)).rejects.toThrow(
        "another principal"
      );
      expect(spawns).toBe(2);
    },
    30_000
  );
});
