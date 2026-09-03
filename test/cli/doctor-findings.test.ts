import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";

import { getIndexDbPath } from "../../src/app/constants";
import { checkFindingsPass } from "../../src/cli/commands/doctor";
import {
  createPendingFindingsRunState,
  findingsRunStatePath,
  writeFindingsRunState,
} from "../../src/core/findings-run-state";
import { safeRm } from "../helpers/cleanup";

const ENV_KEYS = ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"] as const;
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gno-doctor-findings-"));
  await mkdir(join(dir, "data"), { recursive: true });
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    const prior = process.env[key];
    if (prior !== undefined) envSnapshot[key] = prior;
  }
  process.env.GNO_CONFIG_DIR = join(dir, "config");
  process.env.GNO_DATA_DIR = join(dir, "data");
  process.env.GNO_CACHE_DIR = join(dir, "cache");
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const prior = envSnapshot[key];
    if (prior === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prior;
  }
  await safeRm(dir);
});

const config = (findings?: Config["findings"]): Config => ({
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [
    { name: "findings", path: "/x", pattern: "**/*", include: [], exclude: [] },
  ],
  contexts: [],
  findings,
});

const enabled = { enabled: true, cadence: "1h", collection: "findings" };

describe("doctor findings pass check", () => {
  test("disabled is ok; misconfigured is error", async () => {
    expect(await checkFindingsPass(config())).toMatchObject({
      name: "findings-pass",
      status: "ok",
    });
    const bad = await checkFindingsPass(
      config({ enabled: true, cadence: "1h" })
    );
    expect(bad.status).toBe("error");
    expect(bad.details?.[0]).toContain("findings.collection is not set");
  });

  test("enabled without recorded state warns; each persisted state maps to a status", async () => {
    const none = await checkFindingsPass(config(enabled));
    expect(none.status).toBe("warn");
    expect(none.message).toContain("no run state recorded");

    const statePath = findingsRunStatePath(getIndexDbPath());
    const base = createPendingFindingsRunState(
      {
        collection: config().collections[0]!,
        cadence: "1h",
        cadenceMs: 3_600_000,
      },
      new Date()
    );
    const cases = [
      { lastOutcome: "success", expected: "ok" },
      { lastOutcome: "skipped_lease", expected: "warn" },
      { lastOutcome: "failed", expected: "error" },
    ] as const;
    for (const { lastOutcome, expected } of cases) {
      await writeFindingsRunState(statePath, {
        ...base,
        lastOutcome,
        lastRunAt: "2026-09-03T10:00:00.000Z",
        error: lastOutcome === "success" ? null : "why",
      });
      const check = await checkFindingsPass(config(enabled));
      expect(check.status).toBe(expected);
      expect(check.message).toStartWith(
        `${lastOutcome} (every 1h into "findings")`
      );
      expect(check.details).toContain("last run: 2026-09-03T10:00:00.000Z");
    }

    await writeFindingsRunState(statePath, {
      ...base,
      lastOutcome: "success",
      nextDueAt: "2020-01-01T00:00:00.000Z",
    });
    const overdue = await checkFindingsPass(config(enabled));
    expect(overdue.status).toBe("warn");
    expect(overdue.message).toStartWith("overdue");
  });
});
