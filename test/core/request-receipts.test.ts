/**
 * Request ledger contract (fn-170 R2/R3/R5): validation before admission,
 * replay, conflicts, namespace isolation, pending, recovery conflicts,
 * retention tombstones and the hard capacity cap. Side effects are real files.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises temp fixtures and mode checks: no Bun equivalent
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { acquireWriteLock } from "../../src/core/file-lock";
import { atomicCreate } from "../../src/core/file-ops";
import {
  readRequestStatus,
  REQUEST_LEDGER_MAX_ROWS,
  REQUEST_RECEIPT_RETENTION_MS,
  type RequestCheckpoint,
  requestDigest,
  runRequestedWrite,
  validateRequestId,
} from "../../src/core/request-receipts";
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
        publish: () => atomicCreate(path, input.payload),
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
    if (process.platform !== "win32") {
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

  test("a full ledger rejects new admission before any write but still replays", async () => {
    const f = await fixture();
    await writeFile(f, { requestId: "kept", payload: "a" });
    const db = new Database(f.ledgerPath);
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO request_receipts
         (namespace, request_id, operation, digest, status, created_at_ms, updated_at_ms)
       SELECT 'local', 'fill-' || i, 'capture', 'x', 'expired', 0, 0 FROM n`,
      [REQUEST_LEDGER_MAX_ROWS - 1]
    );
    db.close();

    expect(
      await codeOf(writeFile(f, { requestId: "next", payload: "b" }))
    ).toBe("REQUEST_CAPACITY_EXHAUSTED");
    expect(await files(f)).toEqual(["a.txt"]);
    expect(
      (await writeFile(f, { requestId: "kept", payload: "a" })).request.replayed
    ).toBe(true);
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
