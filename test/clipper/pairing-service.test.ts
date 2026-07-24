import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ClipperPairingService } from "../../src/serve/clipper-pairing";
import { migration } from "../../src/store/migrations/020-browser-clipper-security";

const ORIGIN = `chrome-extension://${"b".repeat(32)}`;

describe("browser clipper pairing service", () => {
  let db: Database;
  let nowMs: number;
  let randomOffset: number;
  let service: ClipperPairingService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migration.up(db, "unicode61");
    nowMs = Date.parse("2026-07-24T10:00:00.000Z");
    randomOffset = 0;
    service = new ClipperPairingService(db, {
      now: () => nowMs,
      randomBytes: (length) => {
        const bytes = Uint8Array.from(
          { length },
          (_, index) => (randomOffset + index) % 256
        );
        randomOffset += length;
        return bytes;
      },
    });
  });

  afterEach(() => db.close());

  test("uses high-entropy pair and grant tokens, then delivers once", () => {
    const started = service.start(ORIGIN);
    expect(started.pairId).toMatch(/^[a-f0-9]{64}$/);
    expect(started.pairingCode).toMatch(/^\d{8}$/);
    expect(service.approve(started.pairId, started.pairingCode)).toMatchObject({
      status: "approved",
      origin: ORIGIN,
    });

    const delivered = service.poll(started.pairId, ORIGIN);
    expect(delivered.status).toBe("approved");
    if (delivered.status !== "approved") throw new Error("Expected grant");
    expect(delivered.grantToken).toMatch(/^[a-f0-9]{64}$/);
    expect(service.poll(started.pairId, ORIGIN)).toEqual({
      status: "consumed",
    });

    const stored = db
      .query<{ token_hash: string; origin: string }, []>(
        "SELECT token_hash, origin FROM clipper_grants"
      )
      .get();
    expect(stored?.origin).toBe(ORIGIN);
    expect(stored?.token_hash).not.toBe(delivered.grantToken);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name LIKE '%pair%'"
        )
        .all()
    ).toEqual([]);
  });

  test("bounds approval guesses and loses unfinished pairs on restart", () => {
    const guessed = service.start(ORIGIN);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(service.approve(guessed.pairId, "99999999")).toEqual({
        status: "invalid_code",
      });
    }
    expect(service.approve(guessed.pairId, guessed.pairingCode)).toEqual({
      status: "not_found",
    });

    const unfinished = service.start(ORIGIN);
    const restarted = new ClipperPairingService(db);
    expect(restarted.poll(unfinished.pairId, ORIGIN)).toEqual({
      status: "not_found",
    });
  });

  test("keeps persisted grants and revocation across service restart", () => {
    const started = service.start(ORIGIN);
    service.approve(started.pairId, started.pairingCode);
    const delivered = service.poll(started.pairId, ORIGIN);
    if (delivered.status !== "approved") throw new Error("Expected grant");

    const restarted = new ClipperPairingService(db, { now: () => nowMs });
    const authorized = restarted.authorize(delivered.grantToken, ORIGIN);
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") throw new Error("Expected grant");
    expect(restarted.revoke(authorized.grant).status).toBe("revoked");
    expect(
      new ClipperPairingService(db, { now: () => nowMs }).authorize(
        delivered.grantToken,
        ORIGIN
      ).status
    ).toBe("revoked");
  });

  test("expires pairs and binds preview tickets to grant and payload", () => {
    const started = service.start(ORIGIN);
    nowMs += 5 * 60 * 1000;
    expect(service.poll(started.pairId, ORIGIN)).toEqual({
      status: "expired",
    });

    service.issuePreview("grant-a", "digest", "payload-a");
    expect(service.verifyPreview("grant-a", "digest", "payload-a")).toBe(
      "matched"
    );
    expect(service.verifyPreview("grant-b", "digest", "payload-a")).toBe(
      "missing"
    );
    expect(service.verifyPreview("grant-a", "digest", "payload-b")).toBe(
      "mismatch"
    );
  });
});
