import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path have no Bun utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSchemaVersion, migrations, runMigrations } from "../../src/store";
import {
  authorizeClipperGrant,
  claimClipperIdempotency,
  completeClipperIdempotency,
  createClipperGrant,
  inspectClipperIdempotency,
  revokeClipperGrant,
} from "../../src/store/sqlite/clipper-store";
import { safeRm } from "../helpers/cleanup";

const ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const OTHER_ORIGIN = `chrome-extension://${"b".repeat(32)}`;
const TOKEN_HASH = "c".repeat(64);
const KEY_HASH = "d".repeat(64);
const RETRY_KEY_HASH = "3".repeat(64);
const REQUEST_DIGEST = "e".repeat(64);
const CREATED_AT_MS = 1_000;
const EXPIRES_AT_MS = 10_000;
const PLAN = {
  collection: "notes",
  relPath: "clips/article.md",
  collisionPolicyResult: "created" as const,
  contentHash: "1".repeat(64),
  clipIdentity: "2".repeat(64),
};

describe("browser clipper security store", () => {
  let root = "";
  let dbPath = "";
  let db: Database;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-clipper-store-"));
    dbPath = join(root, "index.sqlite");
    db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    expect(runMigrations(db, migrations, "unicode61").ok).toBeTrue();
  });

  afterEach(async () => {
    db.close();
    await safeRm(root);
  });

  const createGrant = () =>
    createClipperGrant(db, {
      id: "grant-1",
      tokenHash: TOKEN_HASH,
      origin: ORIGIN,
      createdAtMs: CREATED_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
    });

  test("upgrades v19 atomically with closed grant and idempotency tables", () => {
    const freshPath = join(root, "upgrade.sqlite");
    const upgradeDb = new Database(freshPath);
    upgradeDb.exec("PRAGMA foreign_keys = ON");
    try {
      expect(
        runMigrations(upgradeDb, migrations.slice(0, 19), "unicode61").ok
      ).toBeTrue();
      expect(getSchemaVersion(upgradeDb)).toBe(19);
      const result = runMigrations(upgradeDb, migrations, "unicode61");
      expect(result.ok).toBeTrue();
      if (result.ok) expect(result.value.applied).toEqual([20, 21]);
      expect(getSchemaVersion(upgradeDb)).toBe(21);
      expect(
        upgradeDb
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'clipper_%'
             ORDER BY name`
          )
          .all()
          .map(({ name }) => name)
      ).toEqual(["clipper_capture_idempotency", "clipper_grants"]);
      expect(
        upgradeDb
          .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
          .all()
      ).toEqual([]);
    } finally {
      upgradeDb.close();
    }
  });

  test("persists only hashed, exact-origin-bound, expiring grants", () => {
    expect(createGrant().status).toBe("created");
    expect(createGrant().status).toBe("duplicate");
    expect(
      createClipperGrant(db, {
        id: "grant-1",
        tokenHash: "f".repeat(64),
        origin: ORIGIN,
        createdAtMs: CREATED_AT_MS,
        expiresAtMs: EXPIRES_AT_MS,
      }).status
    ).toBe("conflict");

    const raw = db
      .query<{ token_hash: string; origin: string; scope: string }, []>(
        "SELECT token_hash, origin, scope FROM clipper_grants"
      )
      .get();
    expect(raw).toEqual({
      token_hash: TOKEN_HASH,
      origin: ORIGIN,
      scope: "capture",
    });
    expect(JSON.stringify(raw)).not.toContain("plaintext-secret");

    expect(authorizeClipperGrant(db, TOKEN_HASH, OTHER_ORIGIN, 2_000)).toEqual({
      status: "unauthorized",
    });
    expect(
      authorizeClipperGrant(db, TOKEN_HASH, ORIGIN, EXPIRES_AT_MS)
    ).toEqual({ status: "expired" });
    const authorized = authorizeClipperGrant(db, TOKEN_HASH, ORIGIN, 2_000);
    expect(authorized.status).toBe("authorized");
    if (authorized.status === "authorized") {
      expect("tokenHash" in authorized.grant).toBeFalse();
    }
    expect(
      authorizeClipperGrant(db, TOKEN_HASH, ORIGIN, CREATED_AT_MS - 1)
    ).toEqual({ status: "unauthorized" });
    expect(() =>
      createClipperGrant(db, {
        id: "grant-bad",
        tokenHash: "1".repeat(64),
        origin: "https://example.com",
        createdAtMs: CREATED_AT_MS,
        expiresAtMs: EXPIRES_AT_MS,
      })
    ).toThrow("exact chrome-extension origin");
    expect(() =>
      db.run(
        `INSERT INTO clipper_grants (
           id, token_hash, origin, scope, created_at_ms, expires_at_ms
         ) VALUES ('raw-invalid', ?, 'chrome-extension://invalid', 'capture', 1, 2)`,
        ["1".repeat(64)]
      )
    ).toThrow();
  });

  test("retains revocation across database restart", () => {
    expect(createGrant().status).toBe("created");
    expect(revokeClipperGrant(db, "grant-1", 3_000).status).toBe("revoked");
    expect(revokeClipperGrant(db, "grant-1", 4_000).status).toBe(
      "already_revoked"
    );

    db.close();
    db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    expect(authorizeClipperGrant(db, TOKEN_HASH, ORIGIN, 5_000)).toEqual({
      status: "revoked",
    });
  });

  test("claims once, rejects drift, and replays the completed response", () => {
    expect(createGrant().status).toBe("created");
    const claim = {
      grantId: "grant-1",
      keyHash: KEY_HASH,
      requestDigest: REQUEST_DIGEST,
      plan: PLAN,
      nowMs: 2_000,
    };
    expect(claimClipperIdempotency(db, claim)).toEqual({ status: "claimed" });
    expect(claimClipperIdempotency(db, claim)).toEqual({
      status: "pending",
      pending: {
        requestDigest: REQUEST_DIGEST,
        plan: PLAN,
        createdAtMs: 2_000,
      },
    });
    expect(
      claimClipperIdempotency(db, {
        ...claim,
        requestDigest: "f".repeat(64),
      })
    ).toEqual({ status: "conflict" });
    expect(
      claimClipperIdempotency(db, {
        ...claim,
        keyHash: RETRY_KEY_HASH,
        plan: { ...PLAN, relPath: "clips/drift.md" },
      })
    ).toEqual({ status: "conflict" });

    db.close();
    db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const pending = {
      requestDigest: REQUEST_DIGEST,
      plan: PLAN,
      createdAtMs: 2_000,
    };
    expect(
      inspectClipperIdempotency(db, {
        grantId: "grant-1",
        keyHash: RETRY_KEY_HASH,
        requestDigest: REQUEST_DIGEST,
      })
    ).toEqual({ status: "pending", pending });
    expect(
      claimClipperIdempotency(db, {
        ...claim,
        keyHash: RETRY_KEY_HASH,
      })
    ).toEqual({ status: "pending", pending });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM clipper_capture_idempotency"
        )
        .get()
    ).toEqual({ count: 1 });

    const responseJson = JSON.stringify({
      collisionPolicyResult: "created",
      relPath: "clips/article.md",
    });
    const completed = completeClipperIdempotency(db, {
      grantId: "grant-1",
      keyHash: RETRY_KEY_HASH,
      requestDigest: REQUEST_DIGEST,
      responseJson,
      statusCode: 202,
      nowMs: 3_000,
    });
    expect(completed.status).toBe("completed");
    expect(claimClipperIdempotency(db, claim)).toEqual({
      status: "replay",
      replay: {
        requestDigest: REQUEST_DIGEST,
        plan: PLAN,
        createdAtMs: 2_000,
        statusCode: 202,
        responseJson,
        completedAtMs: 3_000,
      },
    });
    expect(
      completeClipperIdempotency(db, {
        grantId: "grant-1",
        keyHash: KEY_HASH,
        requestDigest: REQUEST_DIGEST,
        responseJson,
        statusCode: 202,
        nowMs: 4_000,
      }).status
    ).toBe("replay");
    expect(
      completeClipperIdempotency(db, {
        grantId: "grant-1",
        keyHash: KEY_HASH,
        requestDigest: REQUEST_DIGEST,
        responseJson: "{}",
        statusCode: 200,
        nowMs: 4_000,
      })
    ).toEqual({ status: "conflict" });
  });

  test("fails closed for inactive grants and cascades idempotency rows", () => {
    expect(createGrant().status).toBe("created");
    expect(
      claimClipperIdempotency(db, {
        grantId: "missing",
        keyHash: KEY_HASH,
        requestDigest: REQUEST_DIGEST,
        plan: PLAN,
        nowMs: 2_000,
      })
    ).toEqual({ status: "grant_inactive" });
    expect(
      claimClipperIdempotency(db, {
        grantId: "grant-1",
        keyHash: KEY_HASH,
        requestDigest: REQUEST_DIGEST,
        plan: PLAN,
        nowMs: EXPIRES_AT_MS,
      })
    ).toEqual({ status: "grant_inactive" });
    expect(
      claimClipperIdempotency(db, {
        grantId: "grant-1",
        keyHash: KEY_HASH,
        requestDigest: REQUEST_DIGEST,
        plan: PLAN,
        nowMs: 2_000,
      })
    ).toEqual({ status: "claimed" });
    db.run("DELETE FROM clipper_grants WHERE id = 'grant-1'");
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM clipper_capture_idempotency"
        )
        .get()
    ).toEqual({ count: 0 });
  });
});
